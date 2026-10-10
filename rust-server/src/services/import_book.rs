//! ZIP import/export with validate-then-commit + per-book phys backup.
//! Parity with Node importBook.ts / manuscripts export.

use base64::Engine;
use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::schema::{migrate_sqlite, sqlite_schema};
use crate::services::books::{CreateBookInput, create_book, get_book_payload, must_book};
use crate::services::manuscripts::{book_dir, sanitize_title, sync_book};
use crate::services::revisions::{OnConflict, SaveRevisionInput, save_revision};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;
use zip::ZipArchive;
use zip::write::FileOptions;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportConflict {
    NewBook,
    Overwrite,
    Skip,
}

impl ImportConflict {
    pub fn parse(s: &str) -> Self {
        match s {
            "overwrite" => Self::Overwrite,
            "skip" => Self::Skip,
            _ => Self::NewBook,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NewBook => "new_book",
            Self::Overwrite => "overwrite",
            Self::Skip => "skip",
        }
    }
}

fn import_recovery_dir(db: &Db) -> PathBuf {
    db.root.join("data").join("import-recovery")
}

fn recovery_file(db: &Db, book_id: &str) -> PathBuf {
    import_recovery_dir(db).join(format!("{book_id}.json"))
}

fn physical_backup_db_path(db: &Db, book_id: &str) -> PathBuf {
    import_recovery_dir(db).join(format!("{book_id}.book.phys.sqlite"))
}

fn physical_pending_marker(db: &Db, book_id: &str) -> PathBuf {
    import_recovery_dir(db).join(format!("{book_id}.book.phys.pending"))
}

fn read_if(path: &Path) -> Option<String> {
    if path.is_file() {
        fs::read_to_string(path).ok()
    } else {
        None
    }
}

fn field_of(text: &str, label: &str) -> String {
    let re = regex::Regex::new(&format!(r"(?m)^{label}：(.+)$")).ok();
    re.and_then(|r| r.captures(text))
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .unwrap_or_default()
}

fn parse_chapter_dirs(root: &Path) -> AppResult<Vec<(i64, String, PathBuf)>> {
    let mut out = Vec::new();
    let re = regex::Regex::new(r"^(\d{1,3})-(.+)$").unwrap();
    for entry in fs::read_dir(root).map_err(|e| AppError::BadRequest(format!("导入目录无效：{e}")))? {
        let entry = entry.map_err(|e| AppError::BadRequest(e.to_string()))?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(c) = re.captures(&name) {
            let number: i64 = c.get(1).unwrap().as_str().parse().unwrap_or(0);
            let title = c.get(2).unwrap().as_str().trim();
            let title = if title.is_empty() {
                format!("第{number}章")
            } else {
                title.to_string()
            };
            out.push((number, title, entry.path()));
        }
    }
    out.sort_by_key(|(n, _, _)| *n);
    Ok(out)
}

fn find_book_root(extracted: &Path) -> PathBuf {
    let Ok(entries) = fs::read_dir(extracted) else {
        return extracted.to_path_buf();
    };
    let mut dirs = Vec::new();
    let mut files = 0usize;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            dirs.push(e.path());
        } else if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            files += 1;
        }
    }
    if dirs.len() == 1 && files == 0 {
        dirs.remove(0)
    } else {
        extracted.to_path_buf()
    }
}

fn find_book_by_title(conn: &Connection, title: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM books WHERE title = ?1 ORDER BY created_at DESC LIMIT 1",
            params![title],
            |r| r.get(0),
        )
        .optional()?)
}

fn wipe_book_content(conn: &Connection, book_id: &str) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT id FROM artifacts WHERE book_id = ?1")?;
    let ids: Vec<String> = stmt
        .query_map(params![book_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in ids {
        conn.execute("DELETE FROM artifact_revisions WHERE artifact_id = ?1", params![id])?;
    }
    conn.execute("DELETE FROM artifacts WHERE book_id = ?1", params![book_id])?;
    conn.execute("DELETE FROM chapters WHERE book_id = ?1", params![book_id])?;
    conn.execute("DELETE FROM messages WHERE book_id = ?1", params![book_id])?;
    conn.execute("DELETE FROM bible_cards WHERE book_id = ?1", params![book_id])?;
    conn.execute("DELETE FROM hook_marks WHERE book_id = ?1", params![book_id])?;
    conn.execute("DELETE FROM context_snapshots WHERE book_id = ?1", params![book_id])?;
    Ok(())
}

fn snapshot_book(conn: &Connection, book_id: &str) -> AppResult<Value> {
    let book: Value = {
        let mut stmt = conn.prepare("SELECT * FROM books WHERE id = ?1")?;
        let names = column_names(&stmt);
        let row = stmt.query_row(params![book_id], |r| row_to_json(r, &names))?;
        row
    };
    let arts = select_all(conn, "SELECT id FROM artifacts WHERE book_id = ?1", book_id)?;
    let mut revs = Vec::new();
    for a in arts {
        let id = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        revs.extend(select_all(
            conn,
            "SELECT * FROM artifact_revisions WHERE artifact_id = ?1",
            id,
        )?);
    }
    Ok(json!({
        "book": book,
        "chapters": select_all(conn, "SELECT * FROM chapters WHERE book_id = ?1", book_id)?,
        "artifacts": select_all(conn, "SELECT * FROM artifacts WHERE book_id = ?1", book_id)?,
        "revisions": revs,
        "messages": select_all(conn, "SELECT * FROM messages WHERE book_id = ?1", book_id)?,
        "bible": select_all(conn, "SELECT * FROM bible_cards WHERE book_id = ?1", book_id)?,
        "hooks": select_all(conn, "SELECT * FROM hook_marks WHERE book_id = ?1", book_id)?,
        "jobs": select_all(conn, "SELECT * FROM writing_jobs WHERE book_id = ?1", book_id)?,
    }))
}

fn column_names(stmt: &rusqlite::Statement<'_>) -> Vec<String> {
    (0..stmt.column_count())
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect()
}

fn row_to_json(r: &rusqlite::Row<'_>, names: &[String]) -> rusqlite::Result<Value> {
    let mut map = serde_json::Map::new();
    for (i, name) in names.iter().enumerate() {
        let v: Value = match r.get_ref(i)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(n) => json!(n),
            rusqlite::types::ValueRef::Real(n) => json!(n),
            rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t).to_string()),
            rusqlite::types::ValueRef::Blob(b) => json!(base64::engine::general_purpose::STANDARD.encode(b)),
        };
        map.insert(name.clone(), v);
    }
    Ok(Value::Object(map))
}

fn select_all(conn: &Connection, sql: &str, bind: &str) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names = column_names(&stmt);
    let rows = stmt
        .query_map(params![bind], |r| row_to_json(r, &names))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn write_durable_snapshot(db: &Db, snap: &Value) -> AppResult<()> {
    let book_id = snap
        .get("book")
        .and_then(|b| b.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("snapshot missing book.id".into()))?;
    let dir = import_recovery_dir(db);
    fs::create_dir_all(&dir)?;
    let final_path = recovery_file(db, book_id);
    let tmp = dir.join(format!(".{book_id}.{}.tmp", std::process::id()));
    let payload = serde_json::to_vec_pretty(snap).map_err(|e| AppError::Other(e.into()))?;
    {
        let mut f = File::create(&tmp)?;
        f.write_all(&payload)?;
        let _ = f.sync_all();
    }
    fs::rename(&tmp, &final_path)?;
    Ok(())
}

fn clear_durable_snapshot(db: &Db, book_id: &str) {
    let _ = fs::remove_file(recovery_file(db, book_id));
}

fn write_physical_sqlite_backup(db: &Db, book_id: &str) -> AppResult<Option<PathBuf>> {
    let snap = db.with_conn(|conn| {
        must_book(conn, book_id)?;
        snapshot_book(conn, book_id)
    })?;
    let dir = import_recovery_dir(db);
    fs::create_dir_all(&dir)?;
    let dest = physical_backup_db_path(db, book_id);
    let _ = fs::remove_file(&dest);
    let dump = Connection::open(&dest)?;
    dump.execute_batch(sqlite_schema())?;
    let _ = migrate_sqlite(&dump);
    insert_json_rows(&dump, "books", &[snap.get("book").cloned().unwrap_or(Value::Null)])?;
    insert_json_rows(&dump, "chapters", snap.get("chapters").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
    // artifacts without current first
    let arts = snap.get("artifacts").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let arts_cleared: Vec<Value> = arts
        .iter()
        .map(|a| {
            let mut o = a.clone();
            if let Some(m) = o.as_object_mut() {
                m.insert("current_revision_id".into(), Value::Null);
            }
            o
        })
        .collect();
    insert_json_rows(&dump, "artifacts", &arts_cleared)?;
    insert_json_rows(
        &dump,
        "artifact_revisions",
        snap.get("revisions").and_then(|v| v.as_array()).unwrap_or(&vec![]),
    )?;
    for a in &arts {
        if let (Some(id), Some(cur)) = (
            a.get("id").and_then(|v| v.as_str()),
            a.get("current_revision_id").and_then(|v| v.as_str()),
        ) {
            dump.execute(
                "UPDATE artifacts SET current_revision_id = ?1 WHERE id = ?2",
                params![cur, id],
            )?;
        }
    }
    insert_json_rows(&dump, "messages", snap.get("messages").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
    insert_json_rows(&dump, "bible_cards", snap.get("bible").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
    insert_json_rows(&dump, "hook_marks", snap.get("hooks").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
    insert_json_rows(&dump, "writing_jobs", snap.get("jobs").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
    let _ = dump.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    drop(dump);
    let marker = physical_pending_marker(db, book_id);
    fs::write(
        &marker,
        serde_json::to_vec_pretty(&json!({
            "bookId": book_id,
            "dest": dest.display().to_string(),
            "kind": "per-book",
            "at": now_iso(),
        }))
        .unwrap_or_default(),
    )?;
    Ok(Some(dest))
}

fn clear_physical_sqlite_backup(db: &Db, book_id: &str) {
    for p in [
        physical_backup_db_path(db, book_id),
        physical_pending_marker(db, book_id),
    ] {
        let _ = fs::remove_file(p);
    }
}

fn insert_json_rows(conn: &Connection, table: &str, rows: &[Value]) -> AppResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    for row in rows {
        let Some(obj) = row.as_object() else { continue };
        let cols: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
        if cols.is_empty() {
            continue;
        }
        let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "INSERT OR REPLACE INTO {table} ({}) VALUES ({})",
            cols.join(","),
            placeholders.join(",")
        );
        let mut stmt = conn.prepare(&sql)?;
        let values: Vec<rusqlite::types::Value> = cols
            .iter()
            .map(|c| json_to_sql(obj.get(*c).unwrap_or(&Value::Null)))
            .collect();
        stmt.execute(rusqlite::params_from_iter(values))?;
    }
    Ok(())
}

fn json_to_sql(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                rusqlite::types::Value::Real(f)
            } else {
                rusqlite::types::Value::Null
            }
        }
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

fn restore_book_snapshot(db: &Db, snap: &Value) -> AppResult<()> {
    let book_id = snap
        .get("book")
        .and_then(|b| b.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("snapshot missing book.id".into()))?
        .to_string();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        wipe_book_content(&tx, &book_id)?;
        tx.execute("DELETE FROM writing_jobs WHERE book_id = ?1", params![book_id])?;
        let book = snap.get("book").cloned().unwrap_or(Value::Null);
        tx.execute(
            "UPDATE books SET title = ?1, genre = ?2, logline = ?3, style = ?4, target_chapters = ?5, words_per_chapter = ?6 WHERE id = ?7",
            params![
                book.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                book.get("genre").and_then(|v| v.as_str()).unwrap_or(""),
                book.get("logline").and_then(|v| v.as_str()).unwrap_or(""),
                book.get("style").and_then(|v| v.as_str()).unwrap_or(""),
                book.get("target_chapters").and_then(|v| v.as_i64()).unwrap_or(12),
                book.get("words_per_chapter").and_then(|v| v.as_i64()).unwrap_or(2000),
                book_id,
            ],
        )?;
        insert_json_rows(&tx, "chapters", snap.get("chapters").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
        let arts = snap.get("artifacts").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let arts_cleared: Vec<Value> = arts
            .iter()
            .map(|a| {
                let mut o = a.clone();
                if let Some(m) = o.as_object_mut() {
                    m.insert("current_revision_id".into(), Value::Null);
                }
                o
            })
            .collect();
        insert_json_rows(&tx, "artifacts", &arts_cleared)?;
        insert_json_rows(
            &tx,
            "artifact_revisions",
            snap.get("revisions").and_then(|v| v.as_array()).unwrap_or(&vec![]),
        )?;
        for a in &arts {
            if let (Some(id), cur) = (
                a.get("id").and_then(|v| v.as_str()),
                a.get("current_revision_id"),
            ) {
                let cur_s = cur.and_then(|v| v.as_str());
                tx.execute(
                    "UPDATE artifacts SET current_revision_id = ?1 WHERE id = ?2",
                    params![cur_s, id],
                )?;
            }
        }
        insert_json_rows(&tx, "messages", snap.get("messages").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
        insert_json_rows(&tx, "bible_cards", snap.get("bible").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
        insert_json_rows(&tx, "hook_marks", snap.get("hooks").and_then(|v| v.as_array()).unwrap_or(&vec![]))?;
        let jobs = snap.get("jobs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let jobs: Vec<Value> = jobs
            .into_iter()
            .map(|mut j| {
                if j.get("status").and_then(|v| v.as_str()) == Some("running") {
                    if let Some(m) = j.as_object_mut() {
                        m.insert("status".into(), json!("paused"));
                    }
                }
                j
            })
            .collect();
        insert_json_rows(&tx, "writing_jobs", &jobs)?;
        tx.commit()?;
        Ok(())
    })?;
    let _ = sync_book(db, &book_id);
    Ok(())
}

fn safe_zip_path(dest: &Path, name: &str) -> AppResult<PathBuf> {
    let name = name.replace('\\', "/");
    if name.is_empty() || name.starts_with('/') || name.starts_with("__MACOSX/") || name.ends_with('/') {
        return Err(AppError::BadRequest("zip 条目无效".into()));
    }
    if name.len() > 1 && name.as_bytes().get(1) == Some(&b':') {
        return Err(AppError::BadRequest("zip absolute path refused".into()));
    }
    let path = Path::new(&name);
    if path.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir)) {
        return Err(AppError::BadRequest("zip slip".into()));
    }
    let target = dest.join(path);
    let canon_dest = fs::canonicalize(dest).unwrap_or_else(|_| dest.to_path_buf());
    // ensure parent exists for relative check
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let canon_target = {
        let mut acc = canon_dest.clone();
        for c in path.components() {
            match c {
                Component::Normal(s) => acc.push(s),
                _ => return Err(AppError::BadRequest("zip slip".into())),
            }
        }
        acc
    };
    if !canon_target.starts_with(&canon_dest) {
        return Err(AppError::BadRequest("zip slip".into()));
    }
    Ok(target)
}

fn unzip_buffer(buffer: &[u8], dest: &Path) -> AppResult<()> {
    fs::create_dir_all(dest)?;
    let cursor = std::io::Cursor::new(buffer);
    let mut archive = ZipArchive::new(cursor).map_err(|e| AppError::BadRequest(format!("无效 zip：{e}")))?;
    let max_entries: usize = std::env::var("MOLAN_IMPORT_MAX_ENTRIES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4000);
    let max_total: u64 = std::env::var("MOLAN_IMPORT_MAX_TOTAL_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(80 * 1024 * 1024);
    let max_file: u64 = std::env::var("MOLAN_IMPORT_MAX_FILE_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8 * 1024 * 1024);
    let max_ratio: f64 = std::env::var("MOLAN_IMPORT_MAX_RATIO")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200.0);
    let mut entries = 0usize;
    let mut total: u64 = 0;
    let mut compressed_total: u64 = 0;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| AppError::BadRequest(format!("zip 读取失败：{e}")))?;
        let name = file.name().replace('\\', "/");
        if name.is_empty() || name.starts_with("__MACOSX/") || name.ends_with('/') {
            continue;
        }
        if file.unix_mode().map(|m| (m & 0o170000) == 0o120000).unwrap_or(false) {
            return Err(AppError::BadRequest("zip symlink refused".into()));
        }
        let target = safe_zip_path(dest, &name)?;
        entries += 1;
        if entries > max_entries {
            return Err(AppError::BadRequest("zip too many entries".into()));
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|e| AppError::BadRequest(format!("zip 解压失败：{e}")))?;
        if data.len() as u64 > max_file {
            return Err(AppError::BadRequest("zip file too large".into()));
        }
        total += data.len() as u64;
        compressed_total += file.compressed_size().max(1);
        if total > max_total {
            return Err(AppError::BadRequest("zip uncompressed too large".into()));
        }
        if compressed_total > 0 && (total as f64 / compressed_total as f64) > max_ratio {
            return Err(AppError::BadRequest("zip bomb ratio".into()));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, data)?;
    }
    Ok(())
}

pub fn import_book_from_zip_buffer(
    db: &Db,
    buffer: &[u8],
    conflict: ImportConflict,
    title_override: Option<&str>,
) -> AppResult<Value> {
    let tmp = std::env::temp_dir().join(format!("molan-import-dir-{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp)?;
    let result = (|| {
        unzip_buffer(buffer, &tmp)?;
        let root = find_book_root(&tmp);
        import_book_from_folder(db, &root, conflict, title_override)
    })();
    let _ = fs::remove_dir_all(&tmp);
    result
}

pub fn import_book_from_folder(
    db: &Db,
    folder: &Path,
    conflict: ImportConflict,
    title_override: Option<&str>,
) -> AppResult<Value> {
    if !folder.is_dir() {
        return Err(AppError::BadRequest("导入目录无效".into()));
    }
    let profile = read_if(&folder.join("00-档案.md")).unwrap_or_default();
    let outline = read_if(&folder.join("00-全书大纲.md")).unwrap_or_default();
    let chapter_dirs = parse_chapter_dirs(folder)?;
    let folder_name = sanitize_title(
        folder
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("导入书稿"),
    );
    let title = title_override
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let t = field_of(&profile, "书名");
            if t.is_empty() { None } else { Some(t) }
        })
        .unwrap_or_else(|| {
            if folder_name.is_empty() {
                "导入书稿".into()
            } else {
                folder_name
            }
        });
    let genre = field_of(&profile, "题材");
    let logline = field_of(&profile, "简介");
    let style = field_of(&profile, "文风");
    let target_from = field_of(&profile, "目标章数").parse::<i64>().ok();
    let words_from = field_of(&profile, "每章字数").parse::<i64>().ok();
    let chapter_count = chapter_dirs
        .len()
        .max(target_from.unwrap_or(0).max(0) as usize)
        .max(1);
    if chapter_dirs.len() > 500 {
        return Err(AppError::BadRequest("章节过多，拒绝导入".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for (n, _, _) in &chapter_dirs {
        if *n < 1 {
            return Err(AppError::BadRequest(format!("非法章号：{n}")));
        }
        if !seen.insert(*n) {
            return Err(AppError::BadRequest(format!("重复章号：{n}")));
        }
    }

    // Validate-then-commit: preload ALL chapter files BEFORE any DB wipe.
    let mut preloaded = Vec::new();
    for (number, ch_title, dir) in &chapter_dirs {
        let mut files = Vec::new();
        for (file, kind) in [
            ("细纲.md", "chapter_outline"),
            ("正文.md", "chapter_body"),
            ("审核.md", "review_report"),
            ("记忆.md", "chapter_memory"),
        ] {
            let body = match read_if(&dir.join(file)) {
                Some(b) => b,
                None => continue,
            };
            if body.trim().is_empty() && kind != "chapter_body" {
                continue;
            }
            files.push((
                kind.to_string(),
                body,
                format!("{}/{}", dir.file_name().and_then(|n| n.to_str()).unwrap_or(""), file),
            ));
        }
        preloaded.push((*number, ch_title.clone(), files));
    }

    let existing_id = db.with_conn(|conn| find_book_by_title(conn, &title))?;
    if let Some(ref eid) = existing_id {
        if conflict == ImportConflict::Skip {
            let chapters: i64 = db.with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM chapters WHERE book_id = ?1",
                    params![eid],
                    |r| r.get(0),
                )?)
            })?;
            return Ok(json!({
                "bookId": eid,
                "title": title,
                "conflict": conflict.as_str(),
                "reused": true,
                "skipped": true,
                "imported": [],
                "chapters": chapters,
            }));
        }
    }

    let mut overwrite_snapshot: Option<Value> = None;
    if let Some(ref eid) = existing_id {
        if conflict == ImportConflict::Overwrite {
            let snap = db.with_conn(|conn| snapshot_book(conn, eid))?;
            write_durable_snapshot(db, &snap)?;
            let _ = write_physical_sqlite_backup(db, eid)?;
            overwrite_snapshot = Some(snap);
        }
    }

    let import_inner = || -> AppResult<Value> {
        let mut imported = Vec::new();
        let (book_id, reused) = if let Some(ref eid) = existing_id {
            if conflict == ImportConflict::Overwrite {
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE writing_jobs SET status = 'cancelled', error = COALESCE(error, '导入覆盖前取消') WHERE book_id = ?1 AND status IN ('running', 'paused', 'error')",
                        params![eid],
                    )?;
                    wipe_book_content(conn, eid)?;
                    if std::env::var("MOLAN_IMPORT_FAIL_AFTER_WIPE").ok().as_deref() == Some("1") {
                        return Err(AppError::Other(anyhow::anyhow!("injected import failure after wipe")));
                    }
                    let words = words_from.filter(|w| *w > 0).unwrap_or(2000);
                    conn.execute(
                        "UPDATE books SET title = ?1, genre = COALESCE(NULLIF(?2, ''), genre), logline = COALESCE(NULLIF(?3, ''), logline), style = COALESCE(NULLIF(?4, ''), style), target_chapters = ?5, words_per_chapter = ?6 WHERE id = ?7",
                        params![title, genre, logline, style, chapter_count as i64, words, eid],
                    )?;
                    for i in 1..=chapter_count as i64 {
                        let t = chapter_dirs
                            .iter()
                            .find(|(n, _, _)| *n == i)
                            .map(|(_, t, _)| t.clone())
                            .unwrap_or_else(|| format!("第{i}章"));
                        conn.execute(
                            "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?1, ?2, ?3, ?4, 'empty')",
                            params![Uuid::new_v4().to_string(), eid, i, t],
                        )?;
                    }
                    Ok(())
                })?;
                (eid.clone(), true)
            } else {
                // new_book with title collision
                let final_title = format!(
                    "{title}（导入 {}）",
                    chrono::Local::now().format("%Y/%m/%d %H:%M:%S")
                );
                let (payload, _) = create_book(
                    db,
                    CreateBookInput {
                        title: final_title,
                        genre: genre.clone(),
                        logline: logline.clone(),
                        style: style.clone(),
                        target_chapters: Some(chapter_count as i64),
                        words_per_chapter: Some(words_from.filter(|w| *w > 0).unwrap_or(2000)),
                        idempotency_key: None,
                    },
                )?;
                let bid = payload
                    .get("book")
                    .and_then(|b| b.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap()
                    .to_string();
                for i in 1..=chapter_count as i64 {
                    let t = chapter_dirs
                        .iter()
                        .find(|(n, _, _)| *n == i)
                        .map(|(_, t, _)| t.clone())
                        .unwrap_or_else(|| format!("第{i}章"));
                    db.with_conn(|conn| {
                        conn.execute(
                            "UPDATE chapters SET title = ?1 WHERE book_id = ?2 AND number = ?3",
                            params![t, bid, i],
                        )?;
                        Ok(())
                    })?;
                }
                (bid, false)
            }
        } else {
            let (payload, _) = create_book(
                db,
                CreateBookInput {
                    title: title.clone(),
                    genre: genre.clone(),
                    logline: logline.clone(),
                    style: style.clone(),
                    target_chapters: Some(chapter_count as i64),
                    words_per_chapter: Some(words_from.filter(|w| *w > 0).unwrap_or(2000)),
                    idempotency_key: None,
                },
            )?;
            let bid = payload
                .get("book")
                .and_then(|b| b.get("id"))
                .and_then(|v| v.as_str())
                .unwrap()
                .to_string();
            for i in 1..=chapter_count as i64 {
                let t = chapter_dirs
                    .iter()
                    .find(|(n, _, _)| *n == i)
                    .map(|(_, t, _)| t.clone())
                    .unwrap_or_else(|| format!("第{i}章"));
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE chapters SET title = ?1 WHERE book_id = ?2 AND number = ?3",
                        params![t, bid, i],
                    )?;
                    Ok(())
                })?;
            }
            (bid, false)
        };

        if profile.trim().len() > 0 {
            save_revision(
                db,
                SaveRevisionInput {
                    book_id: book_id.clone(),
                    kind: "book_profile".into(),
                    chapter_number: None,
                    chapter_id: None,
                    body: profile.clone(),
                    source: "human".into(),
                    model: Some("import".into()),
                    skill_ids: vec![],
                    scene: Some("topic".into()),
                    expected_revision_id: None,
                    as_candidate: false,
                    on_conflict: OnConflict::Candidate,
                    source_revision_id: None,
                    skip_memory: true,
                },
            )?;
            imported.push(json!({ "kind": "book_profile", "chapterNumber": null, "path": "00-档案.md" }));
        }
        if outline.trim().len() > 0 {
            save_revision(
                db,
                SaveRevisionInput {
                    book_id: book_id.clone(),
                    kind: "book_outline".into(),
                    chapter_number: None,
                    chapter_id: None,
                    body: outline.clone(),
                    source: "human".into(),
                    model: Some("import".into()),
                    skill_ids: vec![],
                    scene: Some("outline".into()),
                    expected_revision_id: None,
                    as_candidate: false,
                    on_conflict: OnConflict::Candidate,
                    source_revision_id: None,
                    skip_memory: true,
                },
            )?;
            imported.push(json!({ "kind": "book_outline", "chapterNumber": null, "path": "00-全书大纲.md" }));
        }

        for (number, ch_title, files) in &preloaded {
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE chapters SET title = ?1 WHERE book_id = ?2 AND number = ?3",
                    params![ch_title, book_id, number],
                )?;
                Ok(())
            })?;
            for (kind, body, path) in files {
                let scene = match kind.as_str() {
                    "chapter_body" => "chapter_body",
                    "chapter_outline" => "chapter_outline",
                    "review_report" => "review",
                    _ => "memory_extract",
                };
                save_revision(
                    db,
                    SaveRevisionInput {
                        book_id: book_id.clone(),
                        kind: kind.clone(),
                        chapter_number: Some(*number),
                        chapter_id: None,
                        body: body.clone(),
                        source: "human".into(),
                        model: Some("import".into()),
                        skill_ids: vec![],
                        scene: Some(scene.into()),
                        expected_revision_id: None,
                        as_candidate: false,
                        on_conflict: OnConflict::Candidate,
                        source_revision_id: None,
                        skip_memory: true,
                    },
                )?;
                imported.push(json!({ "kind": kind, "chapterNumber": number, "path": path }));
            }
        }

        let resolved_title: String = db.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT title FROM books WHERE id = ?1",
                    params![book_id],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| title.clone()))
        })?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE books SET title = ?1, genre = COALESCE(NULLIF(?2, ''), genre), logline = COALESCE(NULLIF(?3, ''), logline), style = COALESCE(NULLIF(?4, ''), style) WHERE id = ?5",
                params![resolved_title, genre, logline, style, book_id],
            )?;
            Ok(())
        })?;
        let _ = sync_book(db, &book_id);
        let payload = get_book_payload(db, &book_id)?;
        Ok(json!({
            "bookId": book_id,
            "title": payload.get("book").and_then(|b| b.get("title")).cloned().unwrap_or(json!(resolved_title)),
            "conflict": conflict.as_str(),
            "reused": reused,
            "skipped": false,
            "imported": imported,
            "chapters": payload.get("chapters").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0),
        }))
    };

    match import_inner() {
        Ok(v) => {
            if let Some(snap) = overwrite_snapshot {
                if let Some(bid) = snap.get("book").and_then(|b| b.get("id")).and_then(|v| v.as_str()) {
                    clear_durable_snapshot(db, bid);
                    clear_physical_sqlite_backup(db, bid);
                }
            }
            Ok(v)
        }
        Err(e) => {
            if let Some(snap) = overwrite_snapshot {
                let bid = snap
                    .get("book")
                    .and_then(|b| b.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let restore_ok = restore_book_snapshot(db, &snap).is_ok();
                if restore_ok {
                    clear_durable_snapshot(db, &bid);
                    clear_physical_sqlite_backup(db, &bid);
                    return Err(AppError::Other(anyhow::anyhow!(
                        "覆盖导入失败，已尝试回滚原书：{e}"
                    )));
                }
                return Err(AppError::Other(anyhow::anyhow!(
                    "覆盖导入失败且逻辑回滚未完成；请保留 data/import-recovery/{bid}.json 与 {bid}.book.phys.sqlite，重启将尝试按书物理恢复：{e}"
                )));
            }
            Err(e)
        }
    }
}

/// Startup recovery for interrupted overwrite imports (logical JSON then per-book phys).
pub fn recover_interrupted_imports(db: &Db) -> Value {
    let dir = import_recovery_dir(db);
    let mut restored = Vec::new();
    let mut skipped = Vec::new();
    let mut physical_restored = Vec::new();
    if !dir.is_dir() {
        return json!({ "restored": restored, "skipped": skipped, "physicalRestored": physical_restored });
    }
    // logical JSON first
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.starts_with('.') {
                continue;
            }
            let book_id = name.trim_end_matches(".json").to_string();
            match fs::read_to_string(entry.path()) {
                Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                    Ok(snap) => {
                        let ok_id = snap
                            .get("book")
                            .and_then(|b| b.get("id"))
                            .and_then(|v| v.as_str())
                            == Some(book_id.as_str());
                        if !ok_id {
                            skipped.push(book_id);
                            continue;
                        }
                        match restore_book_snapshot(db, &snap) {
                            Ok(()) => {
                                clear_durable_snapshot(db, &book_id);
                                clear_physical_sqlite_backup(db, &book_id);
                                restored.push(book_id);
                            }
                            Err(_) => skipped.push(book_id),
                        }
                    }
                    Err(_) => skipped.push(book_id),
                },
                Err(_) => skipped.push(book_id),
            }
        }
    }
    // per-book phys pending without JSON
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".book.phys.pending") {
                continue;
            }
            let book_id = name.trim_end_matches(".book.phys.pending").to_string();
            if recovery_file(db, &book_id).exists() {
                skipped.push(book_id);
                continue;
            }
            let phys = physical_backup_db_path(db, &book_id);
            if !phys.exists() {
                let _ = fs::remove_file(entry.path());
                skipped.push(book_id);
                continue;
            }
            match read_per_book_phys(db, &book_id, &phys) {
                Ok(snap) => {
                    if restore_book_snapshot(db, &snap).is_ok() {
                        clear_physical_sqlite_backup(db, &book_id);
                        physical_restored.push(book_id);
                    } else {
                        skipped.push(book_id);
                    }
                }
                Err(_) => skipped.push(book_id),
            }
        }
    }
    json!({ "restored": restored, "skipped": skipped, "physicalRestored": physical_restored })
}

fn read_per_book_phys(db: &Db, book_id: &str, dump_path: &Path) -> AppResult<Value> {
    let _ = db;
    let dump = Connection::open(dump_path)?;
    let snap = snapshot_book(&dump, book_id)?;
    Ok(snap)
}

fn zip_directory(source_dir: &Path, zip_path: &Path, prefix: &str) -> AppResult<()> {
    let file = File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    fn walk(
        zip: &mut zip::ZipWriter<File>,
        opts: FileOptions,
        dir: &Path,
        root: &Path,
        prefix: &str,
    ) -> AppResult<()> {
        let mut entries: Vec<_> = fs::read_dir(dir)?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                walk(zip, opts, &path, root, prefix)?;
            } else if path.is_file() {
                let rel = path.strip_prefix(root).unwrap_or(&path);
                let arc = if prefix.is_empty() {
                    rel.to_string_lossy().replace('\\', "/")
                } else {
                    format!("{}/{}", prefix, rel.to_string_lossy().replace('\\', "/"))
                };
                zip.start_file(arc, opts)
                    .map_err(|e| AppError::Other(anyhow::anyhow!("zip write: {e}")))?;
                let data = fs::read(&path)?;
                zip.write_all(&data)?;
            }
        }
        Ok(())
    }
    walk(&mut zip, opts, source_dir, source_dir, prefix)?;
    zip.finish()
        .map_err(|e| AppError::Other(anyhow::anyhow!("zip finish: {e}")))?;
    Ok(())
}

pub fn export_book_zip(db: &Db, book_id: &str) -> AppResult<(String, Vec<u8>)> {
    let title = db.with_conn(|conn| {
        let t: String = must_book(conn, book_id)?.title;
        Ok(sanitize_title(&t))
    })?;
    sync_book(db, book_id)?;
    let tmp = std::env::temp_dir().join(format!("molan-{book_id}-{}.zip", Uuid::new_v4()));
    zip_directory(&book_dir(db, book_id), &tmp, &title)?;
    let buffer = fs::read(&tmp)?;
    let _ = fs::remove_file(&tmp);
    Ok((format!("{title}.zip"), buffer))
}

pub fn export_chapter_zip(db: &Db, book_id: &str, chapter_number: i64) -> AppResult<(String, Vec<u8>)> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        Ok(())
    })?;
    sync_book(db, book_id)?;
    let (title,): (String,) = db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT title FROM chapters WHERE book_id = ?1 AND number = ?2",
                params![book_id, chapter_number],
                |r| Ok((r.get(0)?,)),
            )
            .optional()?
            .ok_or_else(|| AppError::BadRequest(format!("没有第 {chapter_number} 章")))?)
    })?;
    let folder = format!("{:02}-{}", chapter_number, sanitize_title(&title));
    let dir = book_dir(db, book_id).join(&folder);
    if !dir.is_dir() {
        return Err(AppError::BadRequest(format!("没有第 {chapter_number} 章目录")));
    }
    let tmp = std::env::temp_dir().join(format!("molan-{book_id}-ch{chapter_number}-{}.zip", Uuid::new_v4()));
    zip_directory(&dir, &tmp, &folder)?;
    let buffer = fs::read(&tmp)?;
    let _ = fs::remove_file(&tmp);
    Ok((format!("{folder}.zip"), buffer))
}

pub fn export_chapter_markdown(
    db: &Db,
    book_id: &str,
    chapter_number: i64,
    kind: &str,
) -> AppResult<(String, Vec<u8>)> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        Ok(())
    })?;
    sync_book(db, book_id)?;
    let title: String = db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT title FROM chapters WHERE book_id = ?1 AND number = ?2",
                params![book_id, chapter_number],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::BadRequest(format!("没有第 {chapter_number} 章")))?)
    })?;
    let file_name = match kind {
        "chapter_outline" => "细纲.md",
        "review_report" => "审核.md",
        "chapter_memory" => "记忆.md",
        _ => "正文.md",
    };
    let folder = format!("{:02}-{}", chapter_number, sanitize_title(&title));
    let path = book_dir(db, book_id).join(&folder).join(file_name);
    let body = if path.is_file() {
        fs::read(&path)?
    } else {
        Vec::new()
    };
    let filename = format!(
        "{:02}-{}-{}",
        chapter_number,
        sanitize_title(&title),
        file_name
    );
    Ok((filename, body))
}

pub fn read_artifact_file(db: &Db, book_id: &str, kind: &str, chapter_number: Option<i64>) -> AppResult<Value> {
    sync_book(db, book_id)?;
    let body = db.with_conn(|conn| {
        must_book(conn, book_id)?;
        Ok(crate::services::engine::artifact_body(conn, book_id, kind, chapter_number))
    })?;
    Ok(json!({
        "kind": kind,
        "chapterNumber": chapter_number,
        "body": body,
        "path": true,
    }))
}
