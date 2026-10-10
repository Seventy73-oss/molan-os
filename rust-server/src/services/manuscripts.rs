//! Markdown sync under `data/books/:id` — mirrors Node `server/src/manuscripts.ts`.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension, params};
use std::fs;
use std::path::{Path, PathBuf};

const KIND_FILE: &[(&str, &str)] = &[
    ("book_profile", "00-档案.md"),
    ("book_outline", "00-全书大纲.md"),
    ("chapter_outline", "细纲.md"),
    ("chapter_body", "正文.md"),
    ("review_report", "审核.md"),
    ("chapter_memory", "记忆.md"),
];

fn kind_filename(kind: &str) -> Option<&'static str> {
    KIND_FILE.iter().find(|(k, _)| *k == kind).map(|(_, f)| *f)
}

pub fn books_root(db: &Db) -> PathBuf {
    db.root.join("data").join("books")
}

pub fn book_dir(db: &Db, book_id: &str) -> PathBuf {
    books_root(db).join(book_id)
}

pub fn sanitize_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            _ => c,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_start_matches('.')
        .chars()
        .take(60)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        "未命名".into()
    } else {
        cleaned
    }
}

fn pad(n: i64) -> String {
    format!("{n:02}")
}

fn chapter_folder_name(number: i64, title: &str) -> String {
    format!("{}-{}", pad(number), sanitize_title(title))
}

fn must_book_title(conn: &Connection, id: &str) -> AppResult<String> {
    conn.query_row("SELECT title FROM books WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::NotFound("没有这本书".into()))
}

fn resolve_chapter_dir(root: &Path, number: i64, title: &str) -> PathBuf {
    let _ = fs::create_dir_all(root);
    let wanted = chapter_folder_name(number, title);
    let wanted_path = root.join(&wanted);
    let prefix = format!("{}-", pad(number));
    if let Ok(entries) = fs::read_dir(root) {
        let matches: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with(&prefix))
                    .unwrap_or(false)
            })
            .collect();
        if matches.len() == 1 {
            let from = &matches[0];
            let from_name = from.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if from_name != wanted && !wanted_path.exists() {
                if fs::rename(from, &wanted_path).is_ok() {
                    return wanted_path;
                }
                return from.clone();
            }
        }
    }
    let _ = fs::create_dir_all(&wanted_path);
    wanted_path
}

fn absolute_path(
    conn: &Connection,
    root: &Path,
    book_id: &str,
    kind: &str,
    chapter_number: Option<i64>,
    chapter_title: Option<&str>,
) -> AppResult<PathBuf> {
    let file = kind_filename(kind).ok_or_else(|| AppError::BadRequest("不支持的稿件类型".into()))?;
    if kind == "book_profile" || kind == "book_outline" {
        return Ok(root.join(file));
    }
    let number = chapter_number.ok_or_else(|| AppError::BadRequest("缺少章节".into()))?;
    let title = if let Some(t) = chapter_title {
        t.to_string()
    } else {
        conn.query_row(
            "SELECT title FROM chapters WHERE book_id = ?1 AND number = ?2",
            params![book_id, number],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| format!("第{number}章"))
    };
    let dir = resolve_chapter_dir(root, number, &title);
    Ok(dir.join(file))
}

pub fn write_artifact_file(
    conn: &Connection,
    db_root: &Path,
    book_id: &str,
    kind: &str,
    chapter_number: Option<i64>,
    body: &str,
) -> AppResult<PathBuf> {
    let root = db_root.join("data").join("books").join(book_id);
    let file = absolute_path(conn, &root, book_id, kind, chapter_number, None)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&file, body)?;
    Ok(file)
}

/// Rewrite the whole book folder from the current DB state (DB wins).
pub fn sync_book(db: &Db, book_id: &str) -> AppResult<PathBuf> {
    db.with_conn(|conn| sync_book_conn(conn, &db.root, book_id))
}

pub fn sync_book_conn(conn: &Connection, project_root: &Path, book_id: &str) -> AppResult<PathBuf> {
    let _ = must_book_title(conn, book_id)?;
    let root = project_root.join("data").join("books").join(book_id);
    fs::create_dir_all(&root)?;

    let mut ch_stmt =
        conn.prepare("SELECT number, title FROM chapters WHERE book_id = ?1 ORDER BY number")?;
    let chapters: Vec<(i64, String)> = ch_stmt
        .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;

    for (number, title) in &chapters {
        let dir = resolve_chapter_dir(&root, *number, title);
        for kind in ["chapter_outline", "chapter_body", "review_report", "chapter_memory"] {
            let file = dir.join(kind_filename(kind).unwrap());
            if !file.exists() {
                let _ = fs::write(&file, "");
            }
        }
    }

    let mut art_stmt = conn.prepare(
        r#"SELECT a.kind, r.body, c.number AS chapter_number, c.title AS chapter_title
           FROM artifacts a
           LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
           LEFT JOIN chapters c ON c.id = a.chapter_id
           WHERE a.book_id = ?1"#,
    )?;
    let artifacts: Vec<(String, Option<String>, Option<i64>, Option<String>)> = art_stmt
        .query_map(params![book_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;

    for (kind, body, chapter_number, chapter_title) in artifacts {
        if kind_filename(&kind).is_none() {
            continue;
        }
        let file = absolute_path(
            conn,
            &root,
            book_id,
            &kind,
            chapter_number,
            chapter_title.as_deref(),
        )?;
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&file, body.unwrap_or_default())?;
    }

    for kind in ["book_profile", "book_outline"] {
        let file = root.join(kind_filename(kind).unwrap());
        if !file.exists() {
            let _ = fs::write(&file, "");
        }
    }
    Ok(root)
}

pub fn wipe_chapter_dirs(db: &Db, book_id: &str) {
    let root = book_dir(db, book_id);
    if !root.exists() {
        return;
    }
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && name.len() >= 3
                && name.as_bytes()[0].is_ascii_digit()
                && name.as_bytes()[1].is_ascii_digit()
                && name.as_bytes()[2] == b'-'
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

pub fn delete_book_files(db: &Db, book_id: &str) {
    let root = book_dir(db, book_id);
    let _ = fs::remove_dir_all(root);
}

pub fn sync_all_books(db: &Db) {
    let ids: Vec<String> = match db.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM books")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("list books for sync failed: {e}");
            return;
        }
    };
    for id in ids {
        if let Err(e) = sync_book(db, &id) {
            tracing::error!("sync book {id} failed: {e}");
        }
    }
}
