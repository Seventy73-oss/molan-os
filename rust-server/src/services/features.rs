//! progress / search / bible / review — parity with Node features.ts.

use crate::db::{Db, now_iso};
use crate::services::story_state::snapshot_bible_card;
use crate::error::{AppError, AppResult};
use crate::services::books::{book_progress, must_book};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

pub fn get_book_progress(db: &Db, book_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| book_progress(conn, book_id))
}

const KIND_TITLE: &[(&str, &str)] = &[
    ("book_profile", "档案"),
    ("book_outline", "全书大纲"),
    ("chapter_outline", "细纲"),
    ("chapter_body", "正文"),
    ("review_report", "审核"),
    ("chapter_memory", "记忆"),
];

fn kind_title(kind: &str) -> &str {
    KIND_TITLE.iter().find(|(k, _)| *k == kind).map(|(_, t)| *t).unwrap_or(kind)
}

pub fn search_book(db: &Db, book_id: &str, query: &str) -> AppResult<Vec<Value>> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let q = query.trim();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let mut hits = Vec::new();
        let mut ch_stmt =
            conn.prepare("SELECT number, title FROM chapters WHERE book_id = ?1 ORDER BY number")?;
        let chapters: Vec<(i64, String)> = ch_stmt
            .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (number, title) in &chapters {
            let label = format!("第{number}章");
            if title.contains(q) || label.contains(q) {
                hits.push(json!({
                    "kind": "chapter_title",
                    "chapterNumber": number,
                    "chapterTitle": title,
                    "title": format!("第 {number} 章 · {title}"),
                    "snippet": title,
                    "index": title.find(q).map(|i| i as i64).unwrap_or(-1),
                }));
            }
        }
        let mut art_stmt = conn.prepare(
            r#"SELECT a.kind, c.number AS chapter_number, c.title AS chapter_title, r.body AS body
               FROM artifacts a
               JOIN artifact_revisions r ON r.id = a.current_revision_id
               LEFT JOIN chapters c ON c.id = a.chapter_id
               WHERE a.book_id = ?1"#,
        )?;
        let rows: Vec<(String, Option<i64>, Option<String>, String)> = art_stmt
            .query_map(params![book_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<String>>(3)?.unwrap_or_default()))
            })?
            .collect::<Result<_, _>>()?;
        for (kind, chapter_number, chapter_title, body) in rows {
            let mut from = 0usize;
            let mut guard = 0;
            while guard < 8 {
                let Some(index) = body[from..].find(q).map(|i| from + i) else { break };
                let start = index.saturating_sub(24);
                let end = (index + q.len() + 36).min(body.len());
                let mut snippet: String = body[start..end].chars().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
                if start > 0 { snippet = format!("…{snippet}"); }
                if end < body.len() { snippet = format!("{snippet}…"); }
                let label = kind_title(&kind);
                let title = if let Some(n) = chapter_number {
                    format!("第 {n} 章 · {label}")
                } else {
                    label.to_string()
                };
                hits.push(json!({
                    "kind": kind,
                    "chapterNumber": chapter_number,
                    "chapterTitle": chapter_title,
                    "title": title,
                    "snippet": snippet,
                    "index": index as i64,
                }));
                from = index + q.len().max(1);
                guard += 1;
            }
        }
        hits.truncate(60);
        Ok(hits)
    })
}

fn map_card(row: (String, String, String, String, String, String, i64, String, String)) -> Value {
    json!({
        "id": row.0,
        "bookId": row.1,
        "kind": row.2,
        "name": row.3,
        "summary": row.4,
        "details": row.5,
        "sortOrder": row.6,
        "createdAt": row.7,
        "updatedAt": row.8,
    })
}

pub fn list_bible_cards(db: &Db, book_id: &str) -> AppResult<Vec<Value>> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let mut stmt = conn.prepare(
            "SELECT id, book_id, kind, name, summary, details, sort_order, created_at, updated_at
             FROM bible_cards WHERE book_id = ?1 ORDER BY kind, sort_order ASC, created_at ASC",
        )?;
        let rows: Vec<_> = stmt
            .query_map(params![book_id], |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                    r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows.into_iter().map(map_card).collect())
    })
}

pub fn create_bible_card(
    db: &Db,
    book_id: &str,
    kind: &str,
    name: &str,
    summary: &str,
    details: &str,
) -> AppResult<Value> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("要有名称".into()));
    }
    let kind = if kind.trim().is_empty() { "character" } else { kind.trim() };
    let id = Uuid::new_v4().to_string();
    let ts = now_iso();
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let max: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM bible_cards WHERE book_id = ?1 AND kind = ?2",
            params![book_id, kind],
            |r| r.get(0),
        )?;
        conn.execute(
            r#"INSERT INTO bible_cards (id, book_id, kind, name, summary, details, sort_order, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            params![id, book_id, kind, name, summary.trim(), details.trim(), max + 1, ts, ts],
        )?;
        let _ = snapshot_bible_card(conn, &id, book_id, kind, name, summary.trim(), details.trim());
        let row = conn.query_row(
            "SELECT id, book_id, kind, name, summary, details, sort_order, created_at, updated_at FROM bible_cards WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        )?;
        Ok(map_card(row))
    })
}

pub fn update_bible_card(
    db: &Db,
    book_id: &str,
    card_id: &str,
    kind: Option<&str>,
    name: Option<&str>,
    summary: Option<&str>,
    details: Option<&str>,
    sort_order: Option<i64>,
) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let existing: Option<(String, String, String, String, i64)> = conn
            .query_row(
                "SELECT kind, name, summary, details, sort_order FROM bible_cards WHERE id = ?1 AND book_id = ?2",
                params![card_id, book_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((ek, ename, esum, edet, eso)) = existing else {
            return Err(AppError::NotFound("没有这张设定卡".into()));
        };
        let kind = kind.map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(&ek).to_string();
        let name = name.map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(&ename).to_string();
        if name.is_empty() {
            return Err(AppError::BadRequest("要有名称".into()));
        }
        let summary = summary.unwrap_or(&esum);
        let details = details.unwrap_or(&edet);
        let sort_order = sort_order.unwrap_or(eso);
        conn.execute(
            "UPDATE bible_cards SET kind = ?1, name = ?2, summary = ?3, details = ?4, sort_order = ?5, updated_at = ?6 WHERE id = ?7",
            params![kind, name, summary, details, sort_order, now_iso(), card_id],
        )?;
        let _ = snapshot_bible_card(conn, card_id, book_id, &kind, &name, summary, details);
        let row = conn.query_row(
            "SELECT id, book_id, kind, name, summary, details, sort_order, created_at, updated_at FROM bible_cards WHERE id = ?1",
            params![card_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        )?;
        Ok(map_card(row))
    })
}

pub fn delete_bible_card(db: &Db, book_id: &str, card_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let n = conn.execute(
            "DELETE FROM bible_cards WHERE id = ?1 AND book_id = ?2",
            params![card_id, book_id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("没有这张设定卡".into()));
        }
        Ok(json!({ "ok": true }))
    })
}

pub fn parse_review_issues(body: &str) -> Vec<Value> {
    let mut issues = Vec::new();
    for block in body.replace("\r\n", "\n").replace('\r', "\n").split("\n\n") {
        let block = block.trim();
        let Some(caps) = regex::Regex::new(r"(?s)^(\d+)\.\s*\[([^\]]+)\]\s*(.+)$")
            .ok()
            .and_then(|re| re.captures(block))
        else {
            continue;
        };
        let text = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("");
        let cite = regex::Regex::new(r"「([^」]{1,80})」")
            .ok()
            .and_then(|re| re.captures(text))
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
            .unwrap_or_default();
        issues.push(json!({
            "index": caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok()).unwrap_or(0),
            "type": caps.get(2).map(|m| m.as_str()).unwrap_or(""),
            "cite": cite,
            "text": text,
        }));
    }
    issues
}

pub fn review_issues(db: &Db, book_id: &str, chapter_number: i64) -> AppResult<Value> {
    let payload = crate::services::books::get_book_payload(db, book_id)?;
    let body = payload
        .get("artifacts")
        .and_then(|a| a.as_array())
        .into_iter()
        .flatten()
        .find(|a| {
            a.get("kind").and_then(|v| v.as_str()) == Some("review_report")
                && a.get("chapterNumber").and_then(|v| v.as_i64()) == Some(chapter_number)
        })
        .and_then(|a| a.get("body").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    Ok(json!({
        "chapterNumber": chapter_number,
        "issues": parse_review_issues(&body),
        "body": body,
    }))
}
