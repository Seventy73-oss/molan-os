//! Artifact revisions + CAS — mirrors Node `saveRevision` / features revisions.

use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::books::must_book;
use crate::services::manuscripts::sync_book_conn;
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::OnceLock;
use uuid::Uuid;

fn count_chars(text: &str) -> i64 {
    text.chars().filter(|c| !c.is_whitespace()).count() as i64
}

fn normalize_dialogue_quotes(text: &str) -> String {
    static RE_SPEECH: OnceLock<Regex> = OnceLock::new();
    static RE_LINE: OnceLock<Regex> = OnceLock::new();
    static RE_PARTICLE: OnceLock<Regex> = OnceLock::new();
    let re_speech = RE_SPEECH.get_or_init(|| {
        Regex::new(
            r"(说|道|问|喊|答|叫|骂|笑|回|应|斥|劝|吼|嘀咕|低语)([道了着过]?)\s*[（(]([^（）()]{1,160})[）)]",
        )
        .expect("speech regex")
    });
    let re_line = RE_LINE
        .get_or_init(|| Regex::new(r"(^|\n)\s*[（(]([^（）()\n]{1,160})[）)]\s*").expect("line regex"));
    let re_particle = RE_PARTICLE.get_or_init(|| {
        Regex::new(r"[（(]([^（）()]{0,100}[吗吧啊呢嘛哟呵唉][！？!?。…]?)[）)]").expect("particle regex")
    });
    let mut out = re_speech.replace_all(text, "$1$2“$3”").into_owned();
    out = re_line.replace_all(&out, "$1“$2”").into_owned();
    out = re_particle.replace_all(&out, "“$1”").into_owned();
    out = out.replace('「', "“").replace('」', "”");
    out
}

pub(crate) fn field_of(text: &str, label: &str) -> String {
    let re = Regex::new(&format!(r"(?m)^{label}：(.+)$")).ok();
    re.and_then(|r| {
        r.captures(text)
            .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
    })
    .unwrap_or_default()
}

pub(crate) fn titles_from(text: &str) -> Vec<String> {
    let Some(start) = text.find("章目：") else {
        return vec![];
    };
    let mut titles = Vec::new();
    for line in text[start + "章目：".len()..].split('\n') {
        let re = Regex::new(r"^(\d+)\.\s+(.+)$").unwrap();
        if let Some(c) = re.captures(line) {
            titles.push(c.get(2).unwrap().as_str().trim().to_string());
        } else if !line.trim().is_empty() {
            break;
        }
    }
    titles
}

fn apply_derived(conn: &Connection, book_id: &str, kind: &str, scene: Option<&str>, body: &str) {
    let scene = scene.unwrap_or("");
    if scene == "book_setup" || (kind == "book_profile" && scene != "topic") {
        if let Ok(book) = must_book(conn, book_id) {
            let title = field_of(body, "书名");
            let genre = field_of(body, "题材");
            let logline = field_of(body, "简介");
            let style = field_of(body, "文风");
            let _ = conn.execute(
                "UPDATE books SET title = ?1, genre = ?2, logline = ?3, style = ?4 WHERE id = ?5",
                params![
                    if title.is_empty() { book.title } else { title },
                    if genre.is_empty() { book.genre } else { genre },
                    if logline.is_empty() {
                        book.logline
                    } else {
                        logline
                    },
                    if style.is_empty() { book.style } else { style },
                    book_id
                ],
            );
            for (i, chapter_title) in titles_from(body).into_iter().enumerate() {
                let _ = conn.execute(
                    "UPDATE chapters SET title = ?1 WHERE book_id = ?2 AND number = ?3",
                    params![chapter_title, book_id, (i + 1) as i64],
                );
            }
        }
    }
    if kind == "book_outline" {
        let re = Regex::new(r"^(\d+)\.\s+(\S.*?)\s*$").unwrap();
        for line in body.split('\n') {
            if let Some(c) = re.captures(line) {
                let num: i64 = c.get(1).unwrap().as_str().parse().unwrap_or(0);
                let title = c.get(2).unwrap().as_str().trim();
                if num > 0 {
                    let _ = conn.execute(
                        "UPDATE chapters SET title = ?1 WHERE book_id = ?2 AND number = ?3",
                        params![title, book_id, num],
                    );
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct SaveRevisionInput {
    pub book_id: String,
    pub kind: String,
    pub chapter_number: Option<i64>,
    pub chapter_id: Option<String>,
    pub body: String,
    pub source: String,
    pub model: Option<String>,
    pub skill_ids: Vec<String>,
    pub scene: Option<String>,
    pub expected_revision_id: Option<Option<String>>, // None=unset, Some(None)=null, Some(Some)=id
    pub as_candidate: bool,
    pub on_conflict: OnConflict,
    pub source_revision_id: Option<String>,
    pub skip_memory: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnConflict {
    Throw,
    Candidate,
}

pub fn current_revision_id_for(
    conn: &Connection,
    book_id: &str,
    kind: &str,
    chapter_number: Option<i64>,
) -> AppResult<Option<String>> {
    if let Some(n) = chapter_number {
        let id: Option<String> = conn
            .query_row(
                r#"SELECT a.current_revision_id FROM artifacts a
                   LEFT JOIN chapters c ON c.id = a.chapter_id
                   WHERE a.book_id = ?1 AND a.kind = ?2 AND c.number = ?3"#,
                params![book_id, kind, n],
                |r| r.get(0),
            )
            .optional()?;
        return Ok(id);
    }
    let id: Option<String> = conn
        .query_row(
            r#"SELECT current_revision_id FROM artifacts
               WHERE book_id = ?1 AND kind = ?2 AND chapter_id IS NULL"#,
            params![book_id, kind],
            |r| r.get(0),
        )
        .optional()?;
    Ok(id)
}

pub fn save_revision(db: &Db, mut input: SaveRevisionInput) -> AppResult<Value> {
    if input.kind == "chapter_body"
        || input.scene.as_deref() == Some("chapter_body")
        || input.scene.as_deref() == Some("humanize")
    {
        input.body = normalize_dialogue_quotes(&input.body);
    }

    let mut as_candidate = input.as_candidate;
    let mut cas_conflict = false;
    let on_conflict = input.on_conflict;
    let project_root = db.root.clone();

    let saved = db.with_conn(|conn| {
        let _ = must_book(conn, &input.book_id)?;
        let mut chapter_id: Option<String> = None;
        let mut chapter_number: Option<i64> = input.chapter_number;

        if let Some(ref cid) = input.chapter_id {
            let row: Option<(String, i64)> = conn
                .query_row(
                    "SELECT id, number FROM chapters WHERE id = ?1 AND book_id = ?2",
                    params![cid, input.book_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let row = row.ok_or_else(|| AppError::BadRequest("章节不存在或不属于本书".into()))?;
            chapter_id = Some(row.0);
            chapter_number = Some(row.1);
        } else if let Some(n) = input.chapter_number {
            let row: Option<(String, i64)> = conn
                .query_row(
                    "SELECT id, number FROM chapters WHERE book_id = ?1 AND number = ?2",
                    params![input.book_id, n],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let row =
                row.ok_or_else(|| AppError::BadRequest(format!("没有第 {n} 章")))?;
            chapter_id = Some(row.0);
            chapter_number = Some(row.1);
        }

        let tx = conn.unchecked_transaction()?;
        let chapter_key = chapter_id.clone().unwrap_or_default();
        let artifact: Option<(String, Option<String>)> = tx
            .query_row(
                r#"SELECT id, current_revision_id FROM artifacts
                   WHERE book_id = ?1 AND kind = ?2 AND ifnull(chapter_id, '') = ifnull(?3, '')"#,
                params![input.book_id, input.kind, chapter_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let (artifact_id, current_rev) = if let Some(a) = artifact {
            if let Some(ref expected) = input.expected_revision_id {
                let current = a.1.clone();
                if &current != expected {
                    if on_conflict == OnConflict::Candidate {
                        cas_conflict = true;
                        as_candidate = true;
                    } else {
                        return Err(AppError::Conflict(
                            "稿件版本冲突：已有更新的修订，请刷新后重试".into(),
                        ));
                    }
                }
            }
            a
        } else {
            if let Some(Some(_)) = &input.expected_revision_id {
                if on_conflict == OnConflict::Candidate {
                    cas_conflict = true;
                    as_candidate = true;
                } else {
                    return Err(AppError::Conflict(
                        "稿件版本冲突：本地基线已失效（尚无服务端稿）".into(),
                    ));
                }
            }
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO artifacts (id, book_id, chapter_id, kind, current_revision_id) VALUES (?1, ?2, ?3, ?4, NULL)",
                params![id, input.book_id, chapter_id, input.kind],
            )?;
            (id, None)
        };
        let _ = (current_rev, chapter_key);

        let prev: i64 = tx.query_row(
            "SELECT COALESCE(MAX(revision), 0) FROM artifact_revisions WHERE artifact_id = ?1",
            params![artifact_id],
            |r| r.get(0),
        )?;
        let next = prev + 1;
        let rev_id = Uuid::new_v4().to_string();
        let skill_ids_json = serde_json::to_string(&input.skill_ids).unwrap_or_else(|_| "[]".into());
        let created = now_iso();
        tx.execute(
            r#"INSERT INTO artifact_revisions
                (id, artifact_id, revision, body, source, model, skill_ids, scene, created_at, source_revision_id)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            params![
                rev_id,
                artifact_id,
                next,
                input.body,
                input.source,
                input.model,
                skill_ids_json,
                input.scene,
                created,
                input.source_revision_id
            ],
        )?;

        if !as_candidate {
            tx.execute(
                "UPDATE artifacts SET current_revision_id = ?1 WHERE id = ?2",
                params![rev_id, artifact_id],
            )?;
            if let Some(ref cid) = chapter_id {
                if input.kind == "chapter_outline" {
                    tx.execute(
                        "UPDATE chapters SET status = CASE WHEN status = 'empty' THEN 'outlined' ELSE status END WHERE id = ?1",
                        params![cid],
                    )?;
                } else if input.kind == "chapter_body" {
                    tx.execute(
                        "UPDATE chapters SET status = 'drafted' WHERE id = ?1",
                        params![cid],
                    )?;
                } else if input.kind == "review_report" {
                    tx.execute(
                        "UPDATE chapters SET status = 'reviewed' WHERE id = ?1",
                        params![cid],
                    )?;
                }
            }
        }

        if !as_candidate {
            apply_derived(
                &tx,
                &input.book_id,
                &input.kind,
                input.scene.as_deref(),
                &input.body,
            );
        }

        tx.commit()?;

        if !as_candidate {
            if let Err(e) = sync_book_conn(conn, &project_root, &input.book_id) {
                tracing::error!("manuscript sync after save failed: {e}");
            }
        }

        Ok(json!({
            "kind": input.kind,
            "revision": next,
            "revisionId": rev_id,
            "artifactId": artifact_id,
            "chapterId": chapter_id,
            "chapterNumber": chapter_number,
            "current": !as_candidate,
            "conflicted": cas_conflict,
        }))
    })?;

    // After chapter body is saved/generated, quietly refresh chapter memory ledger.
    if !input.skip_memory
        && !input.as_candidate
        && input.kind == "chapter_body"
        && input.chapter_number.is_some()
        && input.body.trim().len() > 0
        && input.model.as_deref() != Some("import")
    {
        let current = saved
            .get("current")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if current {
            let rid = saved
                .get("revisionId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            crate::services::memory::schedule_memory_extract(
                db.clone(),
                input.book_id.clone(),
                input.chapter_number.unwrap(),
                rid,
            );
        }
    }
    Ok(saved)
}

pub fn list_revisions(
    db: &Db,
    book_id: &str,
    kind: &str,
    chapter_number: Option<i64>,
) -> AppResult<Vec<Value>> {
    db.with_conn(|conn| {
        let _ = must_book(conn, book_id)?;
        let chapter_id: Option<String> = if let Some(n) = chapter_number {
            let row: Option<String> = conn
                .query_row(
                    "SELECT id FROM chapters WHERE book_id = ?1 AND number = ?2",
                    params![book_id, n],
                    |r| r.get(0),
                )
                .optional()?;
            if row.is_none() {
                return Err(AppError::BadRequest(format!("没有第 {n} 章")));
            }
            row
        } else {
            None
        };
        let artifact: Option<(String, Option<String>)> = conn
            .query_row(
                r#"SELECT id, current_revision_id FROM artifacts
                   WHERE book_id = ?1 AND kind = ?2 AND ifnull(chapter_id, '') = ifnull(?3, '')"#,
                params![book_id, kind, chapter_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((art_id, current_id)) = artifact else {
            return Ok(vec![]);
        };
        let mut stmt = conn.prepare(
            r#"SELECT id, revision, source, model, scene, created_at, body
               FROM artifact_revisions WHERE artifact_id = ?1 ORDER BY revision DESC"#,
        )?;
        let rows: Vec<Value> = stmt
            .query_map(params![art_id], |r| {
                let id: String = r.get(0)?;
                let body: String = r.get(6)?;
                Ok(json!({
                    "id": id.clone(),
                    "revision": r.get::<_, i64>(1)?,
                    "source": r.get::<_, String>(2)?,
                    "model": r.get::<_, Option<String>>(3)?,
                    "scene": r.get::<_, Option<String>>(4)?,
                    "createdAt": r.get::<_, String>(5)?,
                    "chars": count_chars(&body),
                    "isCurrent": Some(id) == current_id,
                }))
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    })
}

pub fn get_revision_body(db: &Db, book_id: &str, revision_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        let _ = must_book(conn, book_id)?;
        let row: Option<(String, i64, String, String, Option<i64>)> = conn
            .query_row(
                r#"SELECT r.id, r.revision, r.body, a.kind, c.number
                   FROM artifact_revisions r
                   JOIN artifacts a ON a.id = r.artifact_id
                   LEFT JOIN chapters c ON c.id = a.chapter_id
                   WHERE r.id = ?1 AND a.book_id = ?2"#,
                params![revision_id, book_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let (id, revision, body, kind, chapter_number) =
            row.ok_or_else(|| AppError::NotFound("没有这条修订".into()))?;
        Ok(json!({
            "id": id,
            "revision": revision,
            "body": body,
            "kind": kind,
            "chapterNumber": chapter_number,
        }))
    })
}

pub fn restore_revision(db: &Db, book_id: &str, revision_id: &str) -> AppResult<Value> {
    let body = get_revision_body(db, book_id, revision_id)?;
    let kind = body
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let chapter_number = body.get("chapterNumber").and_then(|v| v.as_i64());
    let text = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let saved = save_revision(
        db,
        SaveRevisionInput {
            book_id: book_id.to_string(),
            kind,
            chapter_number,
            chapter_id: None,
            body: text,
            source: "human".into(),
            model: Some("restore".into()),
            skill_ids: vec![],
            scene: None,
            expected_revision_id: None,
            as_candidate: false,
            on_conflict: OnConflict::Throw,
            source_revision_id: None,
            skip_memory: true,
        },
    )?;
    Ok(json!({ "saved": saved, "body": body }))
}

pub fn diff_revisions(
    db: &Db,
    book_id: &str,
    revision_id: &str,
    against_id: Option<&str>,
) -> AppResult<Value> {
    let current = get_revision_body(db, book_id, revision_id)?;
    let kind = current.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let chapter_number = current.get("chapterNumber").and_then(|v| v.as_i64());
    let current_body = current
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let current_rev = current.get("revision").and_then(|v| v.as_i64()).unwrap_or(0);

    let (other_body, other_revision) = if let Some(aid) = against_id {
        let other = get_revision_body(db, book_id, aid)?;
        (
            other
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            other.get("revision").and_then(|v| v.as_i64()),
        )
    } else {
        let meta = list_revisions(db, book_id, kind, chapter_number)?;
        let idx = meta.iter().position(|m| m.get("id").and_then(|v| v.as_str()) == Some(revision_id));
        if let Some(i) = idx {
            if let Some(older) = meta.get(i + 1) {
                let oid = older.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let body = get_revision_body(db, book_id, oid)?;
                (
                    body.get("body")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    body.get("revision").and_then(|v| v.as_i64()),
                )
            } else {
                (String::new(), None)
            }
        } else {
            (String::new(), None)
        }
    };

    let a_owned = other_body.replace("\r\n", "\n").replace('\r', "\n");
    let b_owned = current_body.replace("\r\n", "\n").replace('\r', "\n");
    let a_lines: Vec<&str> = a_owned.split('\n').collect();
    let b_lines: Vec<&str> = b_owned.split('\n').collect();
    let max = a_lines.len().max(b_lines.len());
    let mut hunks = Vec::new();
    for i in 0..max {
        let a = a_lines.get(i).copied();
        let b = b_lines.get(i).copied();
        if a == b {
            if let Some(t) = a {
                hunks.push(json!({ "type": "same", "text": t }));
            }
        } else {
            if let Some(t) = a {
                hunks.push(json!({ "type": "del", "text": t }));
            }
            if let Some(t) = b {
                hunks.push(json!({ "type": "add", "text": t }));
            }
        }
    }
    Ok(json!({
        "kind": kind,
        "chapterNumber": chapter_number,
        "leftRevision": other_revision,
        "rightRevision": current_rev,
        "leftChars": count_chars(&other_body),
        "rightChars": count_chars(&current_body),
        "hunks": hunks,
        "leftBody": other_body,
        "rightBody": current_body,
    }))
}
