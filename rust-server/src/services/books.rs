use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookJson {
    pub id: String,
    pub title: String,
    pub genre: String,
    pub logline: String,
    pub style: String,
    pub target_chapters: i64,
    pub words_per_chapter: i64,
    pub created_at: String,
    pub chapter_count: i64,
    pub drafted_count: i64,
    pub words: i64,
    pub target_words: i64,
}

#[derive(Debug)]
pub(crate) struct BookRow {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) genre: String,
    pub(crate) logline: String,
    pub(crate) style: String,
    pub(crate) target_chapters: i64,
    pub(crate) words_per_chapter: i64,
    pub(crate) created_at: String,
}

fn count_chars(text: &str) -> i64 {
    text.chars().filter(|c| !c.is_whitespace()).count() as i64
}

pub fn book_progress(conn: &rusqlite::Connection, book_id: &str) -> AppResult<Value> {
    let book = must_book(conn, book_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, number, title, status FROM chapters WHERE book_id = ?1 ORDER BY number",
    )?;
    let chapters: Vec<(String, i64, String, String)> = stmt
        .query_map(params![book_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?;

    let mut body_stmt = conn.prepare(
        r#"SELECT c.number AS number, r.body AS body
         FROM chapters c
         LEFT JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = 'chapter_body'
         LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE c.book_id = ?1
         ORDER BY c.number"#,
    )?;
    let bodies: Vec<(i64, Option<String>)> = body_stmt
        .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let by_num: std::collections::HashMap<i64, i64> = bodies
        .into_iter()
        .map(|(n, b)| (n, count_chars(b.as_deref().unwrap_or(""))))
        .collect();

    let chapter_rows: Vec<Value> = chapters
        .iter()
        .map(|(_, number, title, status)| {
            json!({
                "number": number,
                "title": title,
                "status": status,
                "words": by_num.get(number).copied().unwrap_or(0),
                "target": book.words_per_chapter,
            })
        })
        .collect();
    let words: i64 = chapter_rows
        .iter()
        .map(|c| c.get("words").and_then(|v| v.as_i64()).unwrap_or(0))
        .sum();
    let drafted_count = chapters
        .iter()
        .filter(|(_, _, _, s)| s == "drafted" || s == "reviewed")
        .count() as i64;
    Ok(json!({
        "chapterCount": chapters.len() as i64,
        "draftedCount": drafted_count,
        "words": words,
        "targetWords": book.target_chapters * book.words_per_chapter,
        "targetChapters": book.target_chapters,
        "wordsPerChapter": book.words_per_chapter,
        "chapters": chapter_rows,
    }))
}

fn book_json(
    row: &BookRow,
    chapter_count: i64,
    drafted_count: i64,
    words: i64,
    target_words: i64,
) -> BookJson {
    BookJson {
        id: row.id.clone(),
        title: row.title.clone(),
        genre: row.genre.clone(),
        logline: row.logline.clone(),
        style: row.style.clone(),
        target_chapters: row.target_chapters,
        words_per_chapter: row.words_per_chapter,
        created_at: row.created_at.clone(),
        chapter_count,
        drafted_count,
        words,
        target_words,
    }
}

pub(crate) fn must_book(conn: &rusqlite::Connection, id: &str) -> AppResult<BookRow> {
    conn.query_row(
        "SELECT id, title, genre, logline, style, target_chapters, words_per_chapter, created_at
         FROM books WHERE id = ?1",
        params![id],
        |r| {
            Ok(BookRow {
                id: r.get(0)?,
                title: r.get(1)?,
                genre: r.get(2)?,
                logline: r.get(3)?,
                style: r.get(4)?,
                target_chapters: r.get(5)?,
                words_per_chapter: r.get(6)?,
                created_at: r.get(7)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("没有这本书".into()))
}

pub fn list_books(db: &Db) -> AppResult<Vec<BookJson>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            r#"SELECT b.id, b.title, b.genre, b.logline, b.style, b.target_chapters, b.words_per_chapter, b.created_at,
              (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
              (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id AND c.status IN ('drafted','reviewed')) AS drafted_count
             FROM books b
             ORDER BY b.created_at DESC"#,
        )?;
        let rows: Vec<(BookRow, i64, i64)> = stmt
            .query_map([], |r| {
                Ok((
                    BookRow {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        genre: r.get(2)?,
                        logline: r.get(3)?,
                        style: r.get(4)?,
                        target_chapters: r.get(5)?,
                        words_per_chapter: r.get(6)?,
                        created_at: r.get(7)?,
                    },
                    r.get(8)?,
                    r.get(9)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        let mut out = Vec::with_capacity(rows.len());
        for (row, chapter_count, drafted_count) in rows {
            let progress = book_progress(conn, &row.id)?;
            let words = progress.get("words").and_then(|v| v.as_i64()).unwrap_or(0);
            let target_words = progress
                .get("targetWords")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            out.push(book_json(
                &row,
                chapter_count,
                drafted_count,
                words,
                target_words,
            ));
        }
        Ok(out)
    })
    
}

pub fn get_book_payload(db: &Db, id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        let book = must_book(conn, id)?;
        let progress = book_progress(conn, id)?;
        let mut ch_stmt = conn.prepare(
            "SELECT id, number, title, status FROM chapters WHERE book_id = ?1 ORDER BY number",
        )?;
        let chapters: Vec<Value> = ch_stmt
            .query_map(params![id], |r| {
                let number: i64 = r.get(1)?;
                let words = progress
                    .get("chapters")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| {
                        arr.iter()
                            .find(|c| c.get("number").and_then(|n| n.as_i64()) == Some(number))
                            .and_then(|c| c.get("words").and_then(|w| w.as_i64()))
                    })
                    .unwrap_or(0);
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "number": number,
                    "title": r.get::<_, String>(2)?,
                    "status": r.get::<_, String>(3)?,
                    "words": words,
                }))
            })?
            .collect::<Result<_, _>>()?;

        let mut art_stmt = conn.prepare(
            r#"SELECT a.id, a.kind, a.chapter_id, a.current_revision_id, c.number AS chapter_number,
                    r.revision, r.body, r.source, r.model, r.skill_ids, r.scene, r.created_at
             FROM artifacts a
             LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
             LEFT JOIN chapters c ON c.id = a.chapter_id
             WHERE a.book_id = ?1"#,
        )?;
        let artifacts: Vec<Value> = art_stmt
            .query_map(params![id], |r| {
                let skill_ids: Option<String> = r.get(9)?;
                let skill_ids_val: Value = skill_ids
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_else(|| json!([]));
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "chapterId": r.get::<_, Option<String>>(2)?,
                    "chapterNumber": r.get::<_, Option<i64>>(4)?,
                    "revision": r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    "revisionId": r.get::<_, Option<String>>(3)?,
                    "body": r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    "source": r.get::<_, Option<String>>(7)?,
                    "model": r.get::<_, Option<String>>(8)?,
                    "skillIds": skill_ids_val,
                    "scene": r.get::<_, Option<String>>(10)?,
                    "createdAt": r.get::<_, Option<String>>(11)?,
                }))
            })?
            .collect::<Result<_, _>>()?;

        let chapter_count = chapters.len() as i64;
        let drafted_count = progress
            .get("draftedCount")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let words = progress.get("words").and_then(|v| v.as_i64()).unwrap_or(0);
        let target_words = progress
            .get("targetWords")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        Ok(json!({
            "book": book_json(&book, chapter_count, drafted_count, words, target_words),
            "progress": progress,
            "chapters": chapters,
            "artifacts": artifacts,
        }))
    })
    
}

pub struct CreateBookInput {
    pub title: String,
    pub genre: String,
    pub logline: String,
    pub style: String,
    pub target_chapters: Option<i64>,
    pub words_per_chapter: Option<i64>,
    pub idempotency_key: Option<String>,
}

pub fn create_book(db: &Db, input: CreateBookInput) -> AppResult<(Value, bool)> {
    if let Some(key) = input.idempotency_key.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let hit: Option<String> = db.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT book_id FROM idempotency_keys WHERE key = ?1",
                    params![key],
                    |r| r.get(0),
                )
                .optional()?)
        })?;
        if let Some(book_id) = hit {
            return Ok((get_book_payload(db, &book_id)?, true));
        }
    }

    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::BadRequest("要有书名".into()));
    }
    let count = input
        .target_chapters
        .unwrap_or(12)
        .clamp(1, 48);
    let words = input.words_per_chapter.unwrap_or(2000);
    let id = Uuid::new_v4().to_string();
    let created = now_iso();
    let key = input
        .idempotency_key
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            r#"INSERT INTO books (id, title, genre, logline, style, target_chapters, words_per_chapter, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            params![
                id,
                title,
                input.genre.trim(),
                input.logline.trim(),
                input.style.trim(),
                count,
                words,
                created
            ],
        )?;
        for i in 1..=count {
            let ch_id = Uuid::new_v4().to_string();
            let ch_title = format!("第{i}章");
            tx.execute(
                "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?1, ?2, ?3, ?4, 'empty')",
                params![ch_id, id, i, ch_title],
            )?;
        }
        if let Some(ref k) = key {
            tx.execute(
                "INSERT INTO idempotency_keys (key, book_id, created_at) VALUES (?1, ?2, ?3)",
                params![k, id, created],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;

    Ok((get_book_payload(db, &id)?, false))
}

pub struct UpdateBookInput {
    pub title: Option<String>,
    pub genre: Option<String>,
    pub logline: Option<String>,
    pub style: Option<String>,
    pub target_chapters: Option<i64>,
    pub words_per_chapter: Option<i64>,
    pub confirm_trim: bool,
}

pub fn update_book(db: &Db, book_id: &str, input: UpdateBookInput) -> AppResult<Value> {
    db.with_conn(|conn| {
        let book = must_book(conn, book_id)?;
        let title = input
            .title
            .as_ref()
            .map(|s| s.trim().to_string())
            .unwrap_or(book.title.clone());
        if title.is_empty() {
            return Err(AppError::BadRequest("要有书名".into()));
        }
        let genre = input
            .genre
            .as_ref()
            .map(|s| s.trim().to_string())
            .unwrap_or(book.genre.clone());
        let logline = input
            .logline
            .as_ref()
            .map(|s| s.trim().to_string())
            .unwrap_or(book.logline.clone());
        let style = input
            .style
            .as_ref()
            .map(|s| s.trim().to_string())
            .unwrap_or(book.style.clone());
        let words_per_chapter = input
            .words_per_chapter
            .map(|n| n.clamp(200, 20000))
            .unwrap_or(book.words_per_chapter);
        let mut target_chapters = book.target_chapters;
        if let Some(n) = input.target_chapters {
            target_chapters = n.clamp(1, 48);
        }

        let mut ch_stmt = conn.prepare(
            "SELECT id, number, title, status FROM chapters WHERE book_id = ?1 ORDER BY number",
        )?;
        let chapters: Vec<(String, i64, String, String)> = ch_stmt
            .query_map(params![book_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<Result<_, _>>()?;
        let current_count = chapters.len() as i64;

        if target_chapters > current_count {
            for n in (current_count + 1)..=target_chapters {
                let ch_id = Uuid::new_v4().to_string();
                let ch_title = format!("第{n}章");
                conn.execute(
                    "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?1, ?2, ?3, ?4, 'empty')",
                    params![ch_id, book_id, n, ch_title],
                )?;
            }
        } else if target_chapters < current_count {
            let trailing: Vec<_> = chapters
                .iter()
                .filter(|(_, num, _, _)| *num > target_chapters)
                .collect();
            let mut blocking = Vec::new();
            for (cid, num, _, status) in &trailing {
                if *status != "empty" {
                    blocking.push(*num);
                    continue;
                }
                let mut art = conn.prepare(
                    r#"SELECT r.body AS body FROM artifacts a
                     LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
                     WHERE a.book_id = ?1 AND a.chapter_id = ?2"#,
                )?;
                let has_body = art
                    .query_map(params![book_id, cid], |r| {
                        let body: Option<String> = r.get(0)?;
                        Ok(body.unwrap_or_default().trim().len() > 0)
                    })?
                    .any(|x| x.unwrap_or(false));
                if has_body {
                    blocking.push(*num);
                }
            }
            if !blocking.is_empty() && !input.confirm_trim {
                let nums = blocking
                    .iter()
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
                    .join("、");
                return Err(AppError::Conflict(format!(
                    "缩减到 {target_chapters} 章会丢掉第 {nums} 章已有内容，请确认后重试"
                )));
            }
            let tx = conn.unchecked_transaction()?;
            for (cid, _, _, _) in &trailing {
                let arts: Vec<String> = {
                    let mut s = tx.prepare(
                        "SELECT id FROM artifacts WHERE book_id = ?1 AND chapter_id = ?2",
                    )?;
                    let rows = s.query_map(params![book_id, cid], |r| r.get(0))?;
                    rows.collect::<Result<_, _>>()?
                };
                for art_id in arts {
                    tx.execute(
                        "DELETE FROM artifact_revisions WHERE artifact_id = ?1",
                        params![art_id],
                    )?;
                    tx.execute("DELETE FROM artifacts WHERE id = ?1", params![art_id])?;
                }
                tx.execute("DELETE FROM chapters WHERE id = ?1", params![cid])?;
            }
            tx.commit()?;
        }

        conn.execute(
            r#"UPDATE books SET title = ?1, genre = ?2, logline = ?3, style = ?4,
             target_chapters = ?5, words_per_chapter = ?6 WHERE id = ?7"#,
            params![
                title,
                genre,
                logline,
                style,
                target_chapters,
                words_per_chapter,
                book_id
            ],
        )?;
        Ok(())
    })?;
    get_book_payload(db, book_id)
}

pub fn delete_book(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let _ = must_book(conn, id)?;
        let tx = conn.unchecked_transaction()?;
        let arts: Vec<String> = {
            let mut s = tx.prepare("SELECT id FROM artifacts WHERE book_id = ?1")?;
            let rows = s.query_map(params![id], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for art_id in arts {
            tx.execute(
                "DELETE FROM artifact_revisions WHERE artifact_id = ?1",
                params![art_id],
            )?;
        }
        tx.execute("DELETE FROM artifacts WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM chapters WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM messages WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM bible_cards WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM writing_jobs WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM hook_marks WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM api_usage WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM idempotency_keys WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM books WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    })?;
    // md sync wipe — best-effort, same as Node deleteBookFiles
    let books_dir = db.root.join("data").join("books").join(id);
    let _ = std::fs::remove_dir_all(&books_dir);
    Ok(())
}
