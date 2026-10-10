//! G4: self-contained story pack (manuscript + story + provenance) export / validate-then-commit import.
//! Import always creates a new book with remapped IDs. No multi-agent / graph.

use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::books::{CreateBookInput, create_book, must_book};
use crate::services::context::preview_context;
use crate::services::manuscripts::{sanitize_title, sync_book};
use crate::services::story::{chapter_story_status_by_number, get_book_head};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use uuid::Uuid;
use zip::ZipArchive;
use zip::write::FileOptions;

pub const STORY_PACK_FORMAT: &str = "molan.story-pack/v1";
pub const STORY_PACK_VERSION: i64 = 1;

fn sha256_bytes(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn column_names(stmt: &rusqlite::Statement<'_>) -> Vec<String> {
    (0..stmt.column_count())
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect()
}

fn row_to_json(r: &rusqlite::Row<'_>, names: &[String]) -> rusqlite::Result<Value> {
    let mut map = Map::new();
    for (i, name) in names.iter().enumerate() {
        let v: Value = match r.get_ref(i)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(n) => json!(n),
            rusqlite::types::ValueRef::Real(n) => json!(n),
            rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t).to_string()),
            rusqlite::types::ValueRef::Blob(b) => {
                json!(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    b
                ))
            }
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

fn select_one(conn: &Connection, sql: &str, bind: &str) -> AppResult<Option<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names = column_names(&stmt);
    Ok(stmt
        .query_row(params![bind], |r| row_to_json(r, &names))
        .optional()?)
}

fn write_json(dir: &Path, rel: &str, data: &Value) -> AppResult<(String, usize, String)> {
    let full = dir.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(data).map_err(|e| AppError::Other(e.into()))?;
    fs::write(&full, &text)?;
    Ok((rel.replace('\\', "/"), text.len(), sha256_bytes(text.as_bytes())))
}

fn write_text(dir: &Path, rel: &str, text: &str) -> AppResult<(String, usize, String)> {
    let full = dir.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&full, text)?;
    Ok((rel.replace('\\', "/"), text.len(), sha256_bytes(text.as_bytes())))
}

fn zip_dir(source: &Path, zip_path: &Path) -> AppResult<()> {
    let file = File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    fn walk(
        zip: &mut zip::ZipWriter<File>,
        opts: FileOptions,
        dir: &Path,
        root: &Path,
    ) -> AppResult<()> {
        let mut entries: Vec<_> = fs::read_dir(dir)?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                walk(zip, opts, &path, root)?;
            } else if path.is_file() {
                let rel = path.strip_prefix(root).unwrap_or(&path);
                let arc = rel.to_string_lossy().replace('\\', "/");
                zip.start_file(arc, opts)
                    .map_err(|e| AppError::Other(anyhow::anyhow!("zip: {e}")))?;
                zip.write_all(&fs::read(&path)?)?;
            }
        }
        Ok(())
    }
    walk(&mut zip, opts, source, source)?;
    zip.finish()
        .map_err(|e| AppError::Other(anyhow::anyhow!("zip finish: {e}")))?;
    Ok(())
}

fn collect_payload(conn: &Connection, book_id: &str, include_secrets: bool) -> AppResult<Value> {
    must_book(conn, book_id)?;
    let book = select_one(conn, "SELECT * FROM books WHERE id = ?1", book_id)?
        .ok_or_else(|| AppError::NotFound("书不存在".into()))?;
    let chapters = select_all(conn, "SELECT * FROM chapters WHERE book_id = ?1 ORDER BY number", book_id)?;
    let artifacts = select_all(conn, "SELECT * FROM artifacts WHERE book_id = ?1", book_id)?;
    let mut revisions = Vec::new();
    for a in &artifacts {
        let id = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        revisions.extend(select_all(
            conn,
            "SELECT * FROM artifact_revisions WHERE artifact_id = ?1",
            id,
        )?);
    }
    let bible = select_all(conn, "SELECT * FROM bible_cards WHERE book_id = ?1", book_id)?;
    let hooks = select_all(conn, "SELECT * FROM hook_marks WHERE book_id = ?1", book_id)?;
    let head = select_one(conn, "SELECT * FROM story_book_heads WHERE book_id = ?1", book_id)?
        .unwrap_or_else(|| {
            json!({
                "book_id": book_id,
                "story_epoch": 0,
                "fact_set_version": 0,
                "protocol_version": 1,
                "updated_at": now_iso(),
            })
        });
    let publications = select_all(conn, "SELECT * FROM chapter_publications WHERE book_id = ?1", book_id)?;
    let fact_sets = select_all(conn, "SELECT * FROM story_fact_sets WHERE book_id = ?1", book_id)?;
    let mut facts = select_all(conn, "SELECT * FROM story_facts WHERE book_id = ?1", book_id)?;
    if !include_secrets {
        facts.retain(|f| f.get("audience").and_then(|v| v.as_str()).unwrap_or("author") != "author");
    }
    let proposals = select_all(
        conn,
        "SELECT * FROM memory_proposals WHERE book_id = ?1 AND status IN ('accepted','proposed','stale','rejected')",
        book_id,
    )?;
    let hook_events = select_all(conn, "SELECT * FROM hook_events WHERE book_id = ?1", book_id)?;
    let mut knowledge = select_all(conn, "SELECT * FROM story_knowledge_events WHERE book_id = ?1", book_id)?;
    if !include_secrets {
        knowledge.retain(|e| e.get("audience").and_then(|v| v.as_str()).unwrap_or("") != "author");
    }
    let bible_revs = select_all(conn, "SELECT * FROM bible_card_revisions WHERE book_id = ?1", book_id)?;
    let op_results = select_all(conn, "SELECT * FROM story_operation_results WHERE book_id = ?1", book_id)?;

    // Ensure publication body revisions present
    let mut have: std::collections::HashSet<String> = revisions
        .iter()
        .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    for p in &publications {
        if let Some(rid) = p.get("body_revision_id").and_then(|v| v.as_str()) {
            if !have.contains(rid) {
                if let Some(row) = select_one(conn, "SELECT * FROM artifact_revisions WHERE id = ?1", rid)? {
                    have.insert(rid.to_string());
                    revisions.push(row);
                }
            }
        }
    }

    Ok(json!({
        "book": book,
        "chapters": chapters,
        "artifacts": artifacts,
        "revisions": revisions,
        "bible": bible,
        "hooks": hooks,
        "head": head,
        "publications": publications,
        "factSets": fact_sets,
        "facts": facts,
        "proposals": proposals,
        "hookEvents": hook_events,
        "knowledgeEvents": knowledge,
        "bibleRevs": bible_revs,
        "opResults": op_results,
        "includeSecrets": include_secrets,
    }))
}

pub fn export_story_pack_zip(
    db: &Db,
    book_id: &str,
    include_secrets: bool,
) -> AppResult<(String, Vec<u8>, Value)> {
    let payload = db.with_conn(|conn| collect_payload(conn, book_id, include_secrets))?;
    let title = payload
        .get("book")
        .and_then(|b| b.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("untitled")
        .to_string();
    let tmp = std::env::temp_dir().join(format!("molan-sp-{}-{}", book_id, Uuid::new_v4()));
    fs::create_dir_all(&tmp)?;

    let built = (|| -> AppResult<(String, Vec<u8>, Value)> {
        let mut file_metas: Vec<(String, usize, String)> = Vec::new();
        macro_rules! rec {
            ($e:expr) => {{
                file_metas.push($e?);
            }};
        }
        rec!(write_json(&tmp, "manuscript/book.json", payload.get("book").unwrap_or(&Value::Null)));
        rec!(write_json(&tmp, "manuscript/chapters.json", payload.get("chapters").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "manuscript/artifacts.json", payload.get("artifacts").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "manuscript/revisions.json", payload.get("revisions").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "manuscript/bible_cards.json", payload.get("bible").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "manuscript/hook_marks.json", payload.get("hooks").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "story/book_head.json", payload.get("head").unwrap_or(&Value::Null)));
        rec!(write_json(&tmp, "story/publications.json", payload.get("publications").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "story/fact_sets.json", payload.get("factSets").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "story/facts.json", payload.get("facts").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "story/proposals.json", payload.get("proposals").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "story/hook_events.json", payload.get("hookEvents").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "story/knowledge_events.json", payload.get("knowledgeEvents").unwrap_or(&json!([]))));
        rec!(write_json(&tmp, "story/bible_card_revisions.json", payload.get("bibleRevs").unwrap_or(&json!([]))));
        rec!(write_json(
            &tmp,
            "provenance/schema.json",
            &json!({
                "format": STORY_PACK_FORMAT,
                "packageVersion": STORY_PACK_VERSION,
                "extractor": "molan.story-pack",
                "includeSecrets": include_secrets,
            }),
        ));
        rec!(write_json(
            &tmp,
            "provenance/approvals.json",
            &json!({
                "operationResults": payload.get("opResults").unwrap_or(&json!([])),
                "note": "作者审批与幂等结果；导入时书 ID 会重映射",
            }),
        ));
        rec!(write_json(
            &tmp,
            "provenance/id_map.json",
            &json!({ "sourceBookId": book_id, "note": "导入时生成新 ID" }),
        ));
        let chapters = payload.get("chapters").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let pubs = payload.get("publications").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let facts_n = payload.get("facts").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let epoch = payload
            .get("head")
            .and_then(|h| h.get("story_epoch"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let view = format!(
            "# {title}\n\n导出格式：{STORY_PACK_FORMAT}\n故事 epoch：{epoch}\n章节：{} · 定稿：{pubs} · 事实：{facts_n}\n含作者秘密：{}\n\n本目录为可读派生视图；权威状态在 manuscript/ 与 story/。\n",
            chapters.len(),
            if include_secrets { "是" } else { "否" }
        );
        rec!(write_text(&tmp, "views/README.md", &view));
        let chapter_lines: String = chapters
            .iter()
            .map(|c| {
                format!(
                    "- 第{}章 {}",
                    c.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
                    c.get("title").and_then(|v| v.as_str()).unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        rec!(write_text(
            &tmp,
            "views/chapters.md",
            &format!("# 章目\n\n{chapter_lines}\n"),
        ));

        let mut files = Map::new();
        for meta in &file_metas {
            files.insert(meta.0.clone(), json!({ "sha256": meta.2, "bytes": meta.1 }));
        }
        let manifest = json!({
            "format": STORY_PACK_FORMAT,
            "packageVersion": STORY_PACK_VERSION,
            "exportedAt": now_iso(),
            "sourceBookId": book_id,
            "title": title,
            "storyEpoch": epoch,
            "includeSecrets": include_secrets,
            "counts": {
                "chapters": chapters.len(),
                "publications": pubs,
                "facts": facts_n,
            },
            "files": Value::Object(files),
            "note": "自包含故事包：导入默认成新书并重映射 ID；不含 API Key",
        });
        let man_text = serde_json::to_string_pretty(&manifest).map_err(|e| AppError::Other(e.into()))?;
        fs::write(tmp.join("manifest.json"), &man_text)?;
        let _ = sync_book(db, book_id);
        let zip_path = std::env::temp_dir().join(format!("molan-sp-out-{}.zip", Uuid::new_v4()));
        zip_dir(&tmp, &zip_path)?;
        let buffer = fs::read(&zip_path)?;
        let _ = fs::remove_file(&zip_path);
        let safe = sanitize_title(&title);
        Ok((format!("{safe}.story-pack.zip"), buffer, manifest))
    })();

    let _ = fs::remove_dir_all(&tmp);
    built
}

fn read_json_file(root: &Path, rel: &str) -> AppResult<Value> {
    let full = root.join(rel);
    if !full.is_file() {
        return Err(AppError::BadRequest(format!("故事包缺少文件：{rel}")));
    }
    let text = fs::read_to_string(&full)?;
    serde_json::from_str(&text).map_err(|_| AppError::BadRequest(format!("故事包 JSON 无效：{rel}")))
}

fn assert_book_owned(rows: &[Value], book_id: &str, label: &str) -> AppResult<()> {
    for row in rows {
        if let Some(bid) = row.get("book_id").and_then(|v| v.as_str()) {
            if bid != book_id {
                return Err(AppError::BadRequest(format!("跨书来源引用被拒绝（{label}）")));
            }
        }
    }
    Ok(())
}

pub fn validate_story_pack_dir(root: &Path) -> AppResult<Value> {
    let manifest_path = root.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(AppError::BadRequest("非法故事包：缺少 manifest.json".into()));
    }
    let manifest: Value = serde_json::from_str(&fs::read_to_string(&manifest_path)?)
        .map_err(|_| AppError::BadRequest("manifest.json 无效".into()))?;
    if manifest.get("format").and_then(|v| v.as_str()) != Some(STORY_PACK_FORMAT) {
        return Err(AppError::BadRequest(format!(
            "不支持的故事包格式：{}",
            manifest.get("format").and_then(|v| v.as_str()).unwrap_or("?")
        )));
    }
    if manifest.get("packageVersion").and_then(|v| v.as_i64()) != Some(STORY_PACK_VERSION) {
        return Err(AppError::BadRequest("不支持的故事包版本".into()));
    }
    let source_book_id = manifest
        .get("sourceBookId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("manifest 缺少 sourceBookId".into()))?
        .to_string();

    if let Some(files) = manifest.get("files").and_then(|v| v.as_object()) {
        for (rel, meta) in files {
            if rel.contains("..") || Path::new(rel).is_absolute() {
                return Err(AppError::BadRequest("非法故事包：manifest 路径非法".into()));
            }
            let full = root.join(rel);
            if !full.is_file() {
                return Err(AppError::BadRequest(format!("故事包文件缺失：{rel}")));
            }
            let buf = fs::read(&full)?;
            if let Some(bytes) = meta.get("bytes").and_then(|v| v.as_u64()) {
                if buf.len() as u64 != bytes {
                    return Err(AppError::BadRequest(format!("故事包文件大小不匹配：{rel}")));
                }
            }
            if let Some(hash) = meta.get("sha256").and_then(|v| v.as_str()) {
                if sha256_bytes(&buf) != hash {
                    return Err(AppError::BadRequest(format!("故事包文件 hash 不匹配：{rel}")));
                }
            }
        }
    }

    let book = read_json_file(root, "manuscript/book.json")?;
    if book.get("id").and_then(|v| v.as_str()) != Some(source_book_id.as_str()) {
        return Err(AppError::BadRequest(
            "manuscript/book.json 与 manifest.sourceBookId 不一致".into(),
        ));
    }
    let chapters = read_json_file(root, "manuscript/chapters.json")?;
    let artifacts = read_json_file(root, "manuscript/artifacts.json")?;
    let revisions = read_json_file(root, "manuscript/revisions.json")?;
    let bible = read_json_file(root, "manuscript/bible_cards.json")?;
    let hooks = read_json_file(root, "manuscript/hook_marks.json")?;
    let head = read_json_file(root, "story/book_head.json")?;
    let publications = read_json_file(root, "story/publications.json")?;
    let fact_sets = read_json_file(root, "story/fact_sets.json")?;
    let facts = read_json_file(root, "story/facts.json")?;
    let proposals = read_json_file(root, "story/proposals.json")?;
    let hook_events = read_json_file(root, "story/hook_events.json")?;
    let knowledge = read_json_file(root, "story/knowledge_events.json")?;
    let bible_revs = read_json_file(root, "story/bible_card_revisions.json")?;
    let _schema = read_json_file(root, "provenance/schema.json")?;
    let _approvals = read_json_file(root, "provenance/approvals.json")?;

    let as_arr = |v: &Value, label: &str| -> AppResult<Vec<Value>> {
        v.as_array()
            .cloned()
            .ok_or_else(|| AppError::BadRequest(format!("故事包数组字段类型错误：{label}")))
    };
    let chapters_a = as_arr(&chapters, "chapters")?;
    let artifacts_a = as_arr(&artifacts, "artifacts")?;
    let revisions_a = as_arr(&revisions, "revisions")?;
    let bible_a = as_arr(&bible, "bible")?;
    let hooks_a = as_arr(&hooks, "hooks")?;
    let pubs_a = as_arr(&publications, "publications")?;
    let fact_sets_a = as_arr(&fact_sets, "fact_sets")?;
    let facts_a = as_arr(&facts, "facts")?;
    let proposals_a = as_arr(&proposals, "proposals")?;
    let hook_events_a = as_arr(&hook_events, "hook_events")?;
    let knowledge_a = as_arr(&knowledge, "knowledge")?;
    let bible_revs_a = as_arr(&bible_revs, "bible_revs")?;

    assert_book_owned(&chapters_a, &source_book_id, "chapters")?;
    assert_book_owned(&artifacts_a, &source_book_id, "artifacts")?;
    assert_book_owned(&bible_a, &source_book_id, "bible_cards")?;
    assert_book_owned(&hooks_a, &source_book_id, "hook_marks")?;
    assert_book_owned(&pubs_a, &source_book_id, "publications")?;
    assert_book_owned(&fact_sets_a, &source_book_id, "fact_sets")?;
    assert_book_owned(&facts_a, &source_book_id, "facts")?;
    assert_book_owned(&proposals_a, &source_book_id, "proposals")?;
    assert_book_owned(&hook_events_a, &source_book_id, "hook_events")?;
    assert_book_owned(&knowledge_a, &source_book_id, "knowledge_events")?;
    if head.get("book_id").and_then(|v| v.as_str()) != Some(source_book_id.as_str()) {
        return Err(AppError::BadRequest("跨书来源引用被拒绝（book_head）".into()));
    }

    let chapter_ids: std::collections::HashSet<_> = chapters_a
        .iter()
        .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let art_ids: std::collections::HashSet<_> = artifacts_a
        .iter()
        .filter_map(|a| a.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let rev_ids: std::collections::HashSet<_> = revisions_a
        .iter()
        .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    for r in &revisions_a {
        let aid = r.get("artifact_id").and_then(|v| v.as_str()).unwrap_or("");
        if !art_ids.contains(aid) {
            return Err(AppError::BadRequest("修订引用了包外 artifact".into()));
        }
    }
    for p in &pubs_a {
        let cid = p.get("chapter_id").and_then(|v| v.as_str()).unwrap_or("");
        let rid = p.get("body_revision_id").and_then(|v| v.as_str()).unwrap_or("");
        if !chapter_ids.contains(cid) {
            return Err(AppError::BadRequest("定稿引用了包外章节".into()));
        }
        if !rev_ids.contains(rid) {
            return Err(AppError::BadRequest("定稿引用了包外修订（正文不自包含）".into()));
        }
    }
    for f in &facts_a {
        if let Some(sid) = f.get("source_revision_id").and_then(|v| v.as_str()) {
            if !sid.is_empty() && !rev_ids.contains(sid) {
                return Err(AppError::BadRequest("事实引用了包外修订".into()));
            }
        }
    }

    Ok(json!({
        "manifest": manifest,
        "sourceBookId": source_book_id,
        "book": book,
        "chapters": chapters_a,
        "artifacts": artifacts_a,
        "revisions": revisions_a,
        "bible": bible_a,
        "hooks": hooks_a,
        "head": head,
        "publications": pubs_a,
        "factSets": fact_sets_a,
        "facts": facts_a,
        "proposals": proposals_a,
        "hookEvents": hook_events_a,
        "knowledgeEvents": knowledge_a,
        "bibleRevs": bible_revs_a,
    }))
}

fn safe_extract_zip(zip_path: &Path, dest: &Path) -> AppResult<()> {
    fs::create_dir_all(dest)?;
    let file = File::open(zip_path)?;
    let mut archive = ZipArchive::new(file).map_err(|e| AppError::BadRequest(format!("ZIP 无效：{e}")))?;
    let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let max_entries = 4000usize;
    let max_total = 80 * 1024 * 1024usize;
    let max_file = 8 * 1024 * 1024usize;
    let mut total = 0usize;
    if archive.len() > max_entries {
        return Err(AppError::BadRequest("非法 ZIP：条目超限".into()));
    }
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| AppError::BadRequest(format!("ZIP 读取失败：{e}")))?;
        let name = file.name().replace('\\', "/");
        if name.is_empty() || name.starts_with("__MACOSX/") || name.ends_with('/') {
            continue;
        }
        if name.starts_with('/') || name.contains("..") {
            return Err(AppError::BadRequest("非法 ZIP：路径穿越或符号链接被拒绝".into()));
        }
        let outpath = dest.join(&name);
        let parent = outpath.parent().unwrap_or(&dest);
        fs::create_dir_all(parent)?;
        // Ensure resolved path stays under dest
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        if data.len() > max_file {
            return Err(AppError::BadRequest("非法 ZIP：体积或条目超限".into()));
        }
        total += data.len();
        if total > max_total {
            return Err(AppError::BadRequest("非法 ZIP：体积或条目超限".into()));
        }
        // Check after write path
        let canonical_parent = parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf());
        if !canonical_parent.starts_with(&dest) {
            return Err(AppError::BadRequest("非法 ZIP：路径穿越或符号链接被拒绝".into()));
        }
        fs::write(&outpath, &data)?;
    }
    Ok(())
}

fn remap(map: &mut HashMap<String, String>, old: Option<&str>) -> Option<String> {
    let old = old?;
    if old.is_empty() {
        return None;
    }
    Some(
        map.entry(old.to_string())
            .or_insert_with(|| Uuid::new_v4().to_string())
            .clone(),
    )
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn i64_field(v: &Value, key: &str, default: i64) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(default)
}

pub fn import_story_pack_from_zip_buffer(
    db: &Db,
    buffer: &[u8],
    title_override: Option<&str>,
) -> AppResult<Value> {
    let tmp_zip = std::env::temp_dir().join(format!("molan-sp-in-{}.zip", Uuid::new_v4()));
    let tmp_dir = std::env::temp_dir().join(format!("molan-sp-ex-{}", Uuid::new_v4()));
    fs::write(&tmp_zip, buffer)?;
    fs::create_dir_all(&tmp_dir)?;
    let cleanup = || {
        let _ = fs::remove_file(&tmp_zip);
        let _ = fs::remove_dir_all(&tmp_dir);
    };
    let result = (|| -> AppResult<Value> {
        safe_extract_zip(&tmp_zip, &tmp_dir)?;
        let mut root = tmp_dir.clone();
        if let Ok(entries) = fs::read_dir(&tmp_dir) {
            let tops: Vec<_> = entries
                .flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .collect();
            if tops.len() == 1 && tops[0].path().is_dir() {
                let cand = tops[0].path();
                if cand.join("manifest.json").is_file() {
                    root = cand;
                }
            }
        }
        let validated = validate_story_pack_dir(&root)?;
        let source_book_id = validated
            .get("sourceBookId")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();
        let src_book = validated.get("book").cloned().unwrap_or(Value::Null);
        let title = title_override
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                format!(
                    "{}（故事包）",
                    src_book
                        .get("title")
                        .and_then(|v| v.as_str())
                        .or_else(|| validated.get("manifest").and_then(|m| m.get("title")).and_then(|v| v.as_str()))
                        .unwrap_or("导入书")
                )
            });

        let (created, _) = create_book(
            db,
            CreateBookInput {
                title: title.clone(),
                genre: src_book.get("genre").and_then(|v| v.as_str()).unwrap_or("").into(),
                logline: src_book.get("logline").and_then(|v| v.as_str()).unwrap_or("").into(),
                style: src_book.get("style").and_then(|v| v.as_str()).unwrap_or("").into(),
                target_chapters: Some(i64_field(&src_book, "target_chapters", 12)),
                words_per_chapter: Some(i64_field(&src_book, "words_per_chapter", 2000)),
                idempotency_key: None,
            },
        )?;
        let live_book_id = created
            .get("book")
            .and_then(|b| b.get("id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other(anyhow::anyhow!("create_book missing id")))?
            .to_string();

        let mut id_map: HashMap<String, String> = HashMap::new();
        id_map.insert(source_book_id.clone(), live_book_id.clone());

        db.with_conn(|conn| {
            // wipe defaults
            let art_ids: Vec<String> = {
                let mut stmt = conn.prepare("SELECT id FROM artifacts WHERE book_id = ?1")?;
                let rows = stmt
                    .query_map(params![live_book_id], |r| r.get(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for id in art_ids {
                conn.execute("DELETE FROM artifact_revisions WHERE artifact_id = ?1", params![id])?;
            }
            for sql in [
                "DELETE FROM artifacts WHERE book_id = ?1",
                "DELETE FROM chapters WHERE book_id = ?1",
                "DELETE FROM bible_cards WHERE book_id = ?1",
                "DELETE FROM hook_marks WHERE book_id = ?1",
                "DELETE FROM messages WHERE book_id = ?1",
                "DELETE FROM context_snapshots WHERE book_id = ?1",
                "DELETE FROM story_book_heads WHERE book_id = ?1",
                "DELETE FROM chapter_publications WHERE book_id = ?1",
                "DELETE FROM memory_proposals WHERE book_id = ?1",
                "DELETE FROM story_fact_sets WHERE book_id = ?1",
                "DELETE FROM story_facts WHERE book_id = ?1",
                "DELETE FROM hook_events WHERE book_id = ?1",
                "DELETE FROM story_knowledge_events WHERE book_id = ?1",
                "DELETE FROM story_operation_results WHERE book_id = ?1",
            ] {
                conn.execute(sql, params![live_book_id])?;
            }

            conn.execute(
                "UPDATE books SET title=?1, genre=?2, logline=?3, style=?4, target_chapters=?5, words_per_chapter=?6 WHERE id=?7",
                params![
                    title,
                    src_book.get("genre").and_then(|v| v.as_str()).unwrap_or(""),
                    src_book.get("logline").and_then(|v| v.as_str()).unwrap_or(""),
                    src_book.get("style").and_then(|v| v.as_str()).unwrap_or(""),
                    i64_field(&src_book, "target_chapters", 12),
                    i64_field(&src_book, "words_per_chapter", 2000),
                    live_book_id,
                ],
            )?;

            for ch in validated.get("chapters").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(ch, "id")).unwrap();
                conn.execute(
                    "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?1,?2,?3,?4,?5)",
                    params![
                        nid,
                        live_book_id,
                        i64_field(ch, "number", 1),
                        str_field(ch, "title").unwrap_or(""),
                        str_field(ch, "status").unwrap_or("empty"),
                    ],
                )?;
            }

            for a in validated.get("artifacts").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(a, "id")).unwrap();
                let ch = remap(&mut id_map, str_field(a, "chapter_id"));
                conn.execute(
                    "INSERT INTO artifacts (id, book_id, kind, chapter_id, current_revision_id) VALUES (?1,?2,?3,?4,NULL)",
                    params![nid, live_book_id, str_field(a, "kind").unwrap_or(""), ch],
                )?;
            }
            for r in validated.get("revisions").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(r, "id")).unwrap();
                let art = remap(&mut id_map, str_field(r, "artifact_id")).unwrap();
                let src = remap(&mut id_map, str_field(r, "source_revision_id"));
                conn.execute(
                    "INSERT INTO artifact_revisions (id, artifact_id, revision, body, source, model, skill_ids, scene, created_at, source_revision_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![
                        nid,
                        art,
                        i64_field(r, "revision", 1),
                        str_field(r, "body").unwrap_or(""),
                        str_field(r, "source").unwrap_or("import"),
                        str_field(r, "model"),
                        str_field(r, "skill_ids").unwrap_or("[]"),
                        str_field(r, "scene").unwrap_or(""),
                        str_field(r, "created_at").unwrap_or(&now_iso()),
                        src,
                    ],
                )?;
            }
            for a in validated.get("artifacts").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                if let Some(cur) = str_field(a, "current_revision_id") {
                    let art = remap(&mut id_map, str_field(a, "id")).unwrap();
                    let cur_id = remap(&mut id_map, Some(cur)).unwrap();
                    conn.execute(
                        "UPDATE artifacts SET current_revision_id = ?1 WHERE id = ?2",
                        params![cur_id, art],
                    )?;
                }
            }

            for b in validated.get("bible").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(b, "id")).unwrap();
                conn.execute(
                    "INSERT INTO bible_cards (id, book_id, kind, name, summary, details, sort_order, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        nid,
                        live_book_id,
                        str_field(b, "kind").unwrap_or("character"),
                        str_field(b, "name").unwrap_or(""),
                        str_field(b, "summary").unwrap_or(""),
                        str_field(b, "details").unwrap_or(""),
                        i64_field(b, "sort_order", 0),
                        str_field(b, "created_at").unwrap_or(&now_iso()),
                        str_field(b, "updated_at").unwrap_or(&now_iso()),
                    ],
                )?;
            }
            for h in validated.get("hooks").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(h, "id")).unwrap();
                conn.execute(
                    "INSERT INTO hook_marks (id, book_id, hook_key, status, recycled_chapter, note, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        nid,
                        live_book_id,
                        str_field(h, "hook_key").unwrap_or(""),
                        str_field(h, "status").unwrap_or("open"),
                        h.get("recycled_chapter").and_then(|v| v.as_i64()),
                        str_field(h, "note").unwrap_or(""),
                        str_field(h, "updated_at").unwrap_or(&now_iso()),
                    ],
                )?;
            }

            let head = validated.get("head").cloned().unwrap_or(json!({}));
            conn.execute(
                "INSERT INTO story_book_heads (book_id, story_epoch, fact_set_version, protocol_version, updated_at)
                 VALUES (?1,?2,?3,?4,?5)",
                params![
                    live_book_id,
                    i64_field(&head, "story_epoch", 0),
                    i64_field(&head, "fact_set_version", 0),
                    i64_field(&head, "protocol_version", 1),
                    str_field(&head, "updated_at").unwrap_or(&now_iso()),
                ],
            )?;

            for p in validated.get("publications").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(p, "id")).unwrap();
                let ch = remap(&mut id_map, str_field(p, "chapter_id")).unwrap();
                let body = remap(&mut id_map, str_field(p, "body_revision_id")).unwrap();
                conn.execute(
                    "INSERT INTO chapter_publications
                     (id, book_id, chapter_id, body_revision_id, publication_version, status, memory_state, accepted_at, accepted_by)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        nid,
                        live_book_id,
                        ch,
                        body,
                        i64_field(p, "publication_version", 1),
                        str_field(p, "status").unwrap_or("active"),
                        str_field(p, "memory_state").unwrap_or("pending"),
                        str_field(p, "accepted_at").unwrap_or(&now_iso()),
                        str_field(p, "accepted_by").unwrap_or("import"),
                    ],
                )?;
            }

            for fs in validated.get("factSets").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(fs, "id")).unwrap();
                let pub_id = remap(&mut id_map, str_field(fs, "publication_id"));
                let src = remap(&mut id_map, str_field(fs, "source_revision_id")).unwrap();
                let prop = remap(&mut id_map, str_field(fs, "proposal_id"));
                conn.execute(
                    "INSERT INTO story_fact_sets
                     (id, book_id, publication_id, source_revision_id, version, status, proposal_id, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        nid,
                        live_book_id,
                        pub_id,
                        src,
                        i64_field(fs, "version", 1),
                        str_field(fs, "status").unwrap_or("active"),
                        prop,
                        str_field(fs, "created_at").unwrap_or(&now_iso()),
                    ],
                )?;
            }

            for f in validated.get("facts").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(f, "id")).unwrap();
                let set_id = remap(&mut id_map, str_field(f, "fact_set_id")).unwrap();
                let src = remap(&mut id_map, str_field(f, "source_revision_id")).unwrap();
                let pub_id = remap(&mut id_map, str_field(f, "publication_id"));
                let char_id = remap(&mut id_map, str_field(f, "character_id"));
                let mut subject = str_field(f, "subject").unwrap_or("").to_string();
                if let Some(mapped) = id_map.get(&subject) {
                    subject = mapped.clone();
                }
                conn.execute(
                    "INSERT INTO story_facts
                     (id, fact_set_id, book_id, subject, predicate, value_json, evidence_quote, source_revision_id,
                      publication_id, effective_from_chapter, status, created_at, kind, audience, character_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                    params![
                        nid,
                        set_id,
                        live_book_id,
                        subject,
                        str_field(f, "predicate").unwrap_or(""),
                        str_field(f, "value_json").unwrap_or("{}"),
                        str_field(f, "evidence_quote").unwrap_or(""),
                        src,
                        pub_id,
                        f.get("effective_from_chapter").and_then(|v| v.as_i64()),
                        str_field(f, "status").unwrap_or("active"),
                        str_field(f, "created_at").unwrap_or(&now_iso()),
                        str_field(f, "kind").unwrap_or("generic"),
                        str_field(f, "audience").unwrap_or("author"),
                        char_id,
                    ],
                )?;
            }

            for p in validated.get("proposals").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(p, "id")).unwrap();
                let ch = remap(&mut id_map, str_field(p, "chapter_id")).unwrap();
                let pub_id = remap(&mut id_map, str_field(p, "publication_id"));
                let src = remap(&mut id_map, str_field(p, "source_revision_id")).unwrap();
                conn.execute(
                    "INSERT INTO memory_proposals
                     (id, book_id, chapter_id, publication_id, source_revision_id, basis_epoch, schema_version,
                      status, summary, operations_json, decision_json, diagnostics_json, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                    params![
                        nid,
                        live_book_id,
                        ch,
                        pub_id,
                        src,
                        i64_field(p, "basis_epoch", 0),
                        str_field(p, "schema_version").unwrap_or("molan.memory-proposal/v1"),
                        str_field(p, "status").unwrap_or("accepted"),
                        str_field(p, "summary").unwrap_or(""),
                        str_field(p, "operations_json").unwrap_or("[]"),
                        str_field(p, "decision_json"),
                        str_field(p, "diagnostics_json"),
                        str_field(p, "created_at").unwrap_or(&now_iso()),
                        str_field(p, "updated_at").unwrap_or(&now_iso()),
                    ],
                )?;
            }

            for e in validated.get("hookEvents").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(e, "id")).unwrap();
                let pub_id = remap(&mut id_map, str_field(e, "publication_id"));
                let src = remap(&mut id_map, str_field(e, "source_revision_id"));
                conn.execute(
                    "INSERT INTO hook_events
                     (id, book_id, hook_stable_id, event_kind, description, planned_payoff_chapter, effective_chapter,
                      publication_id, source_revision_id, evidence_quote, status, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                    params![
                        nid,
                        live_book_id,
                        str_field(e, "hook_stable_id").unwrap_or(""),
                        str_field(e, "event_kind").or_else(|| str_field(e, "event_type")).unwrap_or("planted"),
                        str_field(e, "description").unwrap_or(""),
                        e.get("planned_payoff_chapter").and_then(|v| v.as_i64()),
                        i64_field(e, "effective_chapter", 1),
                        pub_id,
                        src,
                        str_field(e, "evidence_quote").unwrap_or(""),
                        str_field(e, "status").unwrap_or("active"),
                        str_field(e, "created_at").unwrap_or(&now_iso()),
                    ],
                )?;
            }

            for e in validated.get("knowledgeEvents").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let Some(fid) = str_field(e, "fact_id") else { continue };
                let nid = remap(&mut id_map, str_field(e, "id")).unwrap();
                let fact_id = remap(&mut id_map, Some(fid)).unwrap();
                let char_id = remap(&mut id_map, str_field(e, "character_id"));
                let pub_id = remap(&mut id_map, str_field(e, "publication_id"));
                let src = remap(&mut id_map, str_field(e, "source_revision_id"));
                conn.execute(
                    "INSERT INTO story_knowledge_events
                     (id, book_id, fact_id, audience, character_id, revealed_at_chapter, source_revision_id, publication_id, status, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![
                        nid,
                        live_book_id,
                        fact_id,
                        str_field(e, "audience").unwrap_or("author"),
                        char_id,
                        i64_field(e, "revealed_at_chapter", 1),
                        src,
                        pub_id,
                        str_field(e, "status").unwrap_or("active"),
                        str_field(e, "created_at").unwrap_or(&now_iso()),
                    ],
                )?;
            }

            for r in validated.get("bibleRevs").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
                let nid = remap(&mut id_map, str_field(r, "id")).unwrap();
                let card = remap(&mut id_map, str_field(r, "card_id")).unwrap();
                conn.execute(
                    "INSERT INTO bible_card_revisions
                     (id, card_id, book_id, content_hash, kind, name, summary, details, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        nid,
                        card,
                        live_book_id,
                        str_field(r, "content_hash").unwrap_or(""),
                        str_field(r, "kind").unwrap_or(""),
                        str_field(r, "name").unwrap_or(""),
                        str_field(r, "summary").unwrap_or(""),
                        str_field(r, "details").unwrap_or(""),
                        str_field(r, "created_at").unwrap_or(&now_iso()),
                    ],
                )?;
            }
            Ok(())
        })?;

        let _ = sync_book(db, &live_book_id);
        let id_map_json: Map<String, Value> = id_map
            .into_iter()
            .map(|(k, v)| (k, Value::String(v)))
            .collect();
        Ok(json!({
            "bookId": live_book_id,
            "title": title,
            "idMap": Value::Object(id_map_json),
            "counts": validated.get("manifest").and_then(|m| m.get("counts")).cloned().unwrap_or(json!({})),
        }))
    })();
    cleanup();
    result
}

pub fn estimate_context_budget(preview: &Value) -> Value {
    let sections = preview.get("sections").cloned().unwrap_or(json!({}));
    let bible = sections.get("bible").and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0);
    let memories = sections.get("memories").and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0);
    let hooks = sections.get("openHooks").and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0);
    let chars = bible + memories + hooks;
    let approx = ((chars as f64) / 1.5).ceil() as i64;
    let included = preview
        .pointer("/manifest/included")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let excluded = preview
        .pointer("/manifest/excluded")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    json!({
        "charCount": chars,
        "approxTokens": approx,
        "includedCount": included,
        "excludedCount": excluded,
        "tokenizer": "unknown",
        "note": "估算仅供参考，非精确 tokenizer；硬约束超限应报错而非静默截断",
    })
}

pub fn publish_check(db: &Db, book_id: &str, chapter_number: i64) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        Ok(())
    })?;
    let head = get_book_head(db, book_id)?;
    let status = chapter_story_status_by_number(db, book_id, chapter_number)?;
    let preview = preview_context(db, book_id, Some(chapter_number))?;
    let mut checks = Vec::new();

    let has_pub = status.get("publication").map(|p| !p.is_null()).unwrap_or(false);
    checks.push(json!({
        "id": "has_publication",
        "pass": has_pub,
        "level": if has_pub { "info" } else { "blocker" },
        "message": if has_pub { "本章已有活跃定稿" } else { "本章尚无定稿：请先定稿再发布/续写正式线" },
    }));

    let mem_state = status
        .pointer("/publication/memoryState")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mem_ready = mem_state == "ready";
    checks.push(json!({
        "id": "memory_ready",
        "pass": !has_pub || mem_ready,
        "level": if !has_pub { "info" } else if mem_ready { "info" } else { "warning" },
        "message": if !has_pub {
            "无定稿，跳过记忆检查".into()
        } else if mem_ready {
            "定稿记忆已就绪".into()
        } else {
            format!("定稿记忆状态为 {mem_state}：建议提取并批准提案")
        },
    }));

    let diverges = status
        .get("draftDivergesFromPublication")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    checks.push(json!({
        "id": "draft_aligned",
        "pass": !has_pub || !diverges,
        "level": if !has_pub { "info" } else if !diverges { "info" } else { "warning" },
        "message": if !has_pub {
            "无定稿"
        } else if !diverges {
            "当前稿与定稿一致"
        } else {
            "当前草稿与定稿分歧：发布检查仍以定稿为准"
        },
    }));

    let missing = preview
        .get("missing")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    checks.push(json!({
        "id": "context_complete",
        "pass": missing.is_empty(),
        "level": if missing.is_empty() { "info" } else { "warning" },
        "message": if missing.is_empty() {
            "上下文资料齐全".into()
        } else {
            format!("上下文缺口：{}", missing[0].as_str().unwrap_or(""))
        },
    }));

    let open_hooks = preview
        .pointer("/manifest/counts/openHooks")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    checks.push(json!({
        "id": "open_hooks",
        "pass": true,
        "level": if open_hooks > 0 { "warning" } else { "info" },
        "message": if open_hooks > 0 {
            format!("有 {open_hooks} 条未回收钩子")
        } else {
            "无未回收钩子告警".into()
        },
    }));

    let epoch = head.get("storyEpoch").and_then(|v| v.as_i64()).unwrap_or(0);
    checks.push(json!({
        "id": "story_epoch",
        "pass": true,
        "level": "info",
        "message": format!("故事 epoch={epoch}"),
    }));

    let blockers: Vec<String> = checks
        .iter()
        .filter(|c| {
            c.get("pass").and_then(|v| v.as_bool()) == Some(false)
                && c.get("level").and_then(|v| v.as_str()) == Some("blocker")
        })
        .filter_map(|c| c.get("message").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    let warnings: Vec<String> = checks
        .iter()
        .filter(|c| c.get("level").and_then(|v| v.as_str()) == Some("warning"))
        .filter_map(|c| c.get("message").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    let mut preview_with_budget = preview.clone();
    if let Some(obj) = preview_with_budget.as_object_mut() {
        obj.insert("budgetEstimate".into(), estimate_context_budget(&preview));
    }

    Ok(json!({
        "bookId": book_id,
        "chapterNumber": chapter_number,
        "ok": blockers.is_empty(),
        "storyEpoch": epoch,
        "publication": status.get("publication"),
        "draftDivergesFromPublication": diverges,
        "context": {
            "mode": preview.get("mode"),
            "missing": missing,
            "counts": preview.pointer("/manifest/counts"),
            "budgetEstimate": estimate_context_budget(&preview),
        },
        "checks": checks,
        "blockers": blockers,
        "warnings": warnings,
        "note": "发布检查不自动改正文；关系图/多 Agent 不在本阶段范围",
    }))
}
