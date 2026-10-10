//! Chapter hooks — parity with Node hooks.ts.

use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::books::must_book;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

fn count_chars(text: &str) -> usize {
    text.chars().filter(|c| !c.is_whitespace()).count()
}

fn hook_key(from_chapter: i64, text: &str) -> String {
    let norm: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let norm: String = norm.chars().take(120).collect();
    format!("{from_chapter}:{norm}")
}

fn extract_hooks_from_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let re1 = regex::Regex::new(r"^(?:未回收|下一章必须接住|章末钩子|章末留下)[：:]\s*(.+)$").unwrap();
    let re2 = regex::Regex::new(r"^[-*]\s*(?:未回收|钩子)[：:]\s*(.+)$").unwrap();
    for line in text.replace("\r\n", "\n").replace('\r', "\n").lines() {
        if let Some(c) = re1.captures(line).or_else(|| re2.captures(line)) {
            let t = c.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            if t.chars().count() >= 2 {
                out.push(t.to_string());
            }
        }
    }
    out
}

fn significant_tokens(text: &str) -> Vec<String> {
    let raw = regex::Regex::new(r#"[，。！？、；：""''（）【】《》…—\s]+"#)
        .unwrap()
        .replace_all(text, " ");
    let parts: Vec<&str> = raw.split(' ').map(|p| p.trim()).filter(|p| p.chars().count() >= 2).collect();
    let mut tokens = std::collections::BTreeSet::new();
    for p in parts {
        let slice: String = p.chars().take(12).collect();
        if slice.chars().count() >= 2 {
            tokens.insert(slice);
        }
        let chars: Vec<char> = p.chars().collect();
        if chars.iter().any(|c| ('\u{4e00}'..='\u{9fff}').contains(c)) {
            let mut i = 0;
            while i + 1 < chars.len() && tokens.len() < 8 {
                tokens.insert(chars[i..i + 2].iter().collect());
                i += 1;
            }
        }
    }
    tokens.into_iter().take(10).collect()
}

pub fn list_hooks(db: &Db, book_id: &str) -> AppResult<Vec<Value>> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let mut ch_stmt =
            conn.prepare("SELECT number, title FROM chapters WHERE book_id = ?1 ORDER BY number")?;
        let chapters: Vec<(i64, String)> = ch_stmt
            .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let title_of: std::collections::HashMap<i64, String> = chapters.iter().cloned().collect();

        let mut mark_stmt =
            conn.prepare("SELECT hook_key, status, recycled_chapter FROM hook_marks WHERE book_id = ?1")?;
        let marks: Vec<(String, String, Option<i64>)> = mark_stmt
            .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        let mark_map: std::collections::HashMap<_, _> =
            marks.into_iter().map(|m| (m.0.clone(), m)).collect();

        let mut hooks = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for (kind, source) in [("chapter_memory", "memory"), ("chapter_outline", "outline")] {
            let mut stmt = conn.prepare(
                &format!(
                    r#"SELECT c.number AS number, r.body AS body
                       FROM chapters c
                       JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = '{kind}'
                       JOIN artifact_revisions r ON r.id = a.current_revision_id
                       WHERE c.book_id = ?1
                       ORDER BY c.number"#
                ),
            )?;
            let rows: Vec<(i64, String)> = stmt
                .query_map(params![book_id], |r| Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))?
                .collect::<Result<_, _>>()?;
            for (number, body) in rows {
                for text in extract_hooks_from_text(&body) {
                    let key = hook_key(number, &text);
                    if !seen.insert(key.clone()) {
                        continue;
                    }
                    hooks.push(json!({
                        "key": key,
                        "fromChapter": number,
                        "fromTitle": title_of.get(&number).cloned().unwrap_or_else(|| format!("第{number}章")),
                        "text": text,
                        "source": source,
                        "status": "open",
                        "recycledIn": Value::Null,
                        "warning": true,
                    }));
                }
            }
        }

        // later bodies
        let mut later_stmt = conn.prepare(
            r#"SELECT c.number AS number, COALESCE(r.body, '') AS body
               FROM chapters c
               LEFT JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = 'chapter_body'
               LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
               WHERE c.book_id = ?1
               ORDER BY c.number"#,
        )?;
        let all_bodies: Vec<(i64, String)> = later_stmt
            .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;

        for hook in &mut hooks {
            let key = hook.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let from = hook.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(0);
            if let Some((_, status, recycled)) = mark_map.get(&key) {
                if status == "recycled" || status == "marked" {
                    hook["status"] = json!(status);
                    hook["recycledIn"] = json!(recycled);
                    hook["warning"] = json!(false);
                    continue;
                }
            }
            let text = hook.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let tokens = significant_tokens(&text);
            if tokens.is_empty() {
                continue;
            }
            for (num, body) in &all_bodies {
                if *num <= from || count_chars(body) < 20 {
                    continue;
                }
                let hits = tokens.iter().filter(|t| body.contains(t.as_str())).count();
                if hits >= 2.min(tokens.len()) || (tokens.len() == 1 && hits == 1) {
                    hook["status"] = json!("recycled");
                    hook["recycledIn"] = json!(num);
                    hook["warning"] = json!(false);
                    break;
                }
            }
        }

        hooks.sort_by(|a, b| {
            let ca = a.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(0);
            let cb = b.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(0);
            ca.cmp(&cb).then_with(|| {
                let ta = a.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let tb = b.get("text").and_then(|v| v.as_str()).unwrap_or("");
                ta.cmp(tb)
            })
        });
        Ok(hooks)
    })
}

pub fn mark_hook(
    db: &Db,
    book_id: &str,
    hook_key_value: &str,
    status: &str,
    recycled_chapter: Option<i64>,
    note: &str,
) -> AppResult<Option<Value>> {
    if !matches!(status, "open" | "recycled" | "marked") {
        return Err(AppError::BadRequest("状态无效".into()));
    }
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM hook_marks WHERE book_id = ?1 AND hook_key = ?2",
                params![book_id, hook_key_value],
                |r| r.get(0),
            )
            .optional()?;
        let ts = now_iso();
        if let Some(id) = existing {
            conn.execute(
                "UPDATE hook_marks SET status = ?1, recycled_chapter = ?2, note = ?3, updated_at = ?4 WHERE id = ?5",
                params![status, recycled_chapter, note, ts, id],
            )?;
        } else {
            conn.execute(
                r#"INSERT INTO hook_marks (id, book_id, hook_key, status, recycled_chapter, note, updated_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
                params![Uuid::new_v4().to_string(), book_id, hook_key_value, status, recycled_chapter, note, ts],
            )?;
        }
        Ok(())
    })?;
    Ok(list_hooks(db, book_id)?.into_iter().find(|h| h.get("key").and_then(|v| v.as_str()) == Some(hook_key_value)))
}

pub fn format_open_hooks_for_context(
    db: &Db,
    book_id: &str,
    before_chapter: Option<i64>,
) -> AppResult<String> {
    let hooks = list_hooks(db, book_id)?;
    let relevant: Vec<_> = hooks
        .into_iter()
        .filter(|h| {
            let warning = h.get("warning").and_then(|v| v.as_bool()).unwrap_or(false);
            let status = h.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if !(warning || status == "open") {
                return false;
            }
            let from = h.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(0);
            match before_chapter {
                Some(before) => from < before,
                None => true,
            }
        })
        .collect();
    if relevant.is_empty() {
        return Ok(String::new());
    }
    Ok(relevant
        .into_iter()
        .map(|h| {
            let from = h.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(0);
            let text = h.get("text").and_then(|v| v.as_str()).unwrap_or("");
            format!("第{from}章未回收钩子：{text}")
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

pub fn format_open_hooks_for_review(db: &Db, book_id: &str, chapter_number: i64) -> AppResult<String> {
    let hooks = list_hooks(db, book_id)?;
    let open: Vec<_> = hooks
        .into_iter()
        .filter(|h| {
            let from = h.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(0);
            let warning = h.get("warning").and_then(|v| v.as_bool()).unwrap_or(false);
            let status = h.get("status").and_then(|v| v.as_str()).unwrap_or("");
            from < chapter_number && (warning || status == "open")
        })
        .collect();
    if open.is_empty() {
        return Ok(String::new());
    }
    let mut lines = vec!["【跨章未回收钩子 — 请核对本章是否接住】".to_string()];
    for h in open {
        let from = h.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(0);
        let text = h.get("text").and_then(|v| v.as_str()).unwrap_or("");
        lines.push(format!("- 第{from}章：{text}"));
    }
    Ok(lines.join("\n"))
}
