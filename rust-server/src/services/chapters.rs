//! Chapter CRUD — mirrors Node addChapter / renameChapter / deleteChapter.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::books::{get_book_payload, must_book};
use crate::services::manuscripts::{sync_book, wipe_chapter_dirs};
use rusqlite::params;
use serde_json::Value;
use uuid::Uuid;

pub fn add_chapter(db: &Db, book_id: &str, title: Option<&str>) -> AppResult<Value> {
    db.with_conn(|conn| {
        let _ = must_book(conn, book_id)?;
        let n: i64 = conn.query_row(
            "SELECT COALESCE(MAX(number), 0) FROM chapters WHERE book_id = ?1",
            params![book_id],
            |r| r.get(0),
        )?;
        let number = n + 1;
        let ch_title = title
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("第{number}章"));
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?1, ?2, ?3, ?4, 'empty')",
            params![id, book_id, number, ch_title],
        )?;
        conn.execute(
            "UPDATE books SET target_chapters = ?1 WHERE id = ?2",
            params![number, book_id],
        )?;
        Ok(())
    })?;
    let payload = get_book_payload(db, book_id)?;
    if let Err(e) = sync_book(db, book_id) { tracing::error!("manuscript sync failed: {e}"); }
    Ok(payload)
}

pub fn rename_chapter(db: &Db, book_id: &str, number: i64, title: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        let _ = must_book(conn, book_id)?;
        let chapter_id: Option<String> = conn
            .query_row(
                "SELECT id FROM chapters WHERE book_id = ?1 AND number = ?2",
                params![book_id, number],
                |r| r.get(0),
            )
            .ok();
        let chapter_id =
            chapter_id.ok_or_else(|| AppError::NotFound(format!("没有第 {number} 章")))?;
        let next = {
            let t = title.trim();
            if t.is_empty() {
                format!("第{number}章")
            } else {
                t.to_string()
            }
        };
        conn.execute(
            "UPDATE chapters SET title = ?1 WHERE id = ?2",
            params![next, chapter_id],
        )?;
        Ok(())
    })?;
    if let Err(e) = sync_book(db, book_id) { tracing::error!("manuscript sync failed: {e}"); }
    get_book_payload(db, book_id)
}

pub fn delete_chapter(db: &Db, book_id: &str, number: i64) -> AppResult<Value> {
    db.with_conn(|conn| {
        let _ = must_book(conn, book_id)?;
        let chapter: Option<(String, i64)> = conn
            .query_row(
                "SELECT id, number FROM chapters WHERE book_id = ?1 AND number = ?2",
                params![book_id, number],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        let (chapter_id, _) =
            chapter.ok_or_else(|| AppError::NotFound(format!("没有第 {number} 章")))?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM chapters WHERE book_id = ?1",
            params![book_id],
            |r| r.get(0),
        )?;
        if count <= 1 {
            return Err(AppError::BadRequest("至少保留一章".into()));
        }

        let tx = conn.unchecked_transaction()?;
        let arts: Vec<String> = {
            let mut s = tx.prepare(
                "SELECT id FROM artifacts WHERE book_id = ?1 AND chapter_id = ?2",
            )?;
            let rows = s.query_map(params![book_id, chapter_id], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for art_id in arts {
            tx.execute(
                "DELETE FROM artifact_revisions WHERE artifact_id = ?1",
                params![art_id],
            )?;
            tx.execute("DELETE FROM artifacts WHERE id = ?1", params![art_id])?;
        }
        tx.execute("DELETE FROM chapters WHERE id = ?1", params![chapter_id])?;

        let higher: Vec<(String, i64)> = {
            let mut s = tx.prepare(
                "SELECT id, number FROM chapters WHERE book_id = ?1 AND number > ?2 ORDER BY number ASC",
            )?;
            let rows = s.query_map(params![book_id, number], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (id, num) in &higher {
            tx.execute(
                "UPDATE chapters SET number = ?1 WHERE id = ?2",
                params![-num, id],
            )?;
        }
        for (id, num) in &higher {
            tx.execute(
                "UPDATE chapters SET number = ?1 WHERE id = ?2",
                params![num - 1, id],
            )?;
        }
        let left: i64 = tx.query_row(
            "SELECT COUNT(*) FROM chapters WHERE book_id = ?1",
            params![book_id],
            |r| r.get(0),
        )?;
        tx.execute(
            "UPDATE books SET target_chapters = ?1 WHERE id = ?2",
            params![left, book_id],
        )?;
        tx.commit()?;
        Ok(())
    })?;
    wipe_chapter_dirs(db, book_id);
    if let Err(e) = sync_book(db, book_id) { tracing::error!("manuscript sync failed: {e}"); }
    get_book_payload(db, book_id)
}
