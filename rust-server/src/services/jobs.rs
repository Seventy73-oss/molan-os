//! writing_jobs CRUD + SQLite lease + tick — parity with Node engine/jobs.

use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::books::must_book;
use crate::services::engine::{ExecuteSceneInput, artifact_body, execute_scene};
use crate::services::memory::wait_memory_extract;
use crate::services::revisions::OnConflict;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

pub const DEFAULT_LEASE_TTL_MS: i64 = 120_000;

pub const SQLITE_ACQUIRE_SQL: &str = r#"UPDATE writing_jobs SET lease_owner = ?1, lease_until = ?2
       WHERE id = ?3
         AND status = 'running'
         AND (lease_until IS NULL OR lease_until < ?4 OR lease_owner = ?5)"#;

pub const SQLITE_RELEASE_SQL: &str =
    r#"UPDATE writing_jobs SET lease_owner = NULL, lease_until = NULL
     WHERE id = ?1 AND lease_owner = ?2"#;

fn lease_until_iso(ttl_ms: i64) -> String {
    let ms = chrono::Utc::now().timestamp_millis() + ttl_ms;
    let secs = ms / 1000;
    let nsecs = ((ms % 1000) * 1_000_000) as u32;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, nsecs)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_job_log(raw: Option<&str>) -> Vec<Value> {
    let parsed: Value = serde_json::from_str(raw.unwrap_or("[]")).unwrap_or(json!([]));
    match parsed {
        Value::Array(a) => a.into_iter().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect(),
        _ => vec![],
    }
}

fn append_job_log(conn: &rusqlite::Connection, id: &str, stage: &str, chapter: i64, message: &str) -> AppResult<()> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT log_json FROM writing_jobs WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    let mut log = parse_job_log(raw.as_deref());
    log.push(json!({
        "at": now_iso(),
        "stage": stage,
        "chapter": chapter,
        "message": message,
    }));
    if log.len() > 40 {
        log = log.split_off(log.len() - 40);
    }
    conn.execute(
        "UPDATE writing_jobs SET log_json = ?1 WHERE id = ?2",
        params![serde_json::to_string(&log).unwrap_or_else(|_| "[]".into()), id],
    )?;
    Ok(())
}

fn job_json_row(conn: &rusqlite::Connection, id: &str) -> AppResult<Value> {
    let row = conn.query_row(
        "SELECT id, book_id, status, from_chapter, to_chapter, current_chapter, current_stage, error, created_at,
                auto_review, max_retries, retry_count, log_json, lease_owner, lease_until
         FROM writing_jobs WHERE id = ?1",
        params![id],
        |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "bookId": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
                "fromChapter": r.get::<_, i64>(3)?,
                "toChapter": r.get::<_, i64>(4)?,
                "currentChapter": r.get::<_, i64>(5)?,
                "currentStage": r.get::<_, String>(6)?,
                "error": r.get::<_, Option<String>>(7)?,
                "createdAt": r.get::<_, String>(8)?,
                "autoReview": r.get::<_, i64>(9)? == 1,
                "maxRetries": r.get::<_, i64>(10)?,
                "retryCount": r.get::<_, i64>(11)?,
                "log": parse_job_log(r.get::<_, Option<String>>(12)?.as_deref()),
                "leaseOwner": r.get::<_, Option<String>>(13)?,
                "leaseUntil": r.get::<_, Option<String>>(14)?,
            }))
        },
    ).optional()?.ok_or_else(|| AppError::NotFound("没有这个任务".into()))?;
    Ok(row)
}

pub fn list_jobs(db: &Db, book_id: &str) -> AppResult<Vec<Value>> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let mut stmt = conn.prepare(
            "SELECT id FROM writing_jobs WHERE book_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 20",
        )?;
        let ids: Vec<String> = stmt
            .query_map(params![book_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            out.push(job_json_row(conn, &id)?);
        }
        Ok(out)
    })
}

pub fn get_job(db: &Db, id: &str) -> AppResult<Value> {
    db.with_conn(|conn| job_json_row(conn, id))
}

pub fn create_job(
    db: &Db,
    book_id: &str,
    from_chapter: Option<i64>,
    to_chapter: Option<i64>,
    auto_review: bool,
    max_retries: Option<i64>,
) -> AppResult<Value> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let (from, to, max_r) = db.with_conn(|conn| {
        let book = must_book(conn, book_id)?;
        let from = from_chapter.unwrap_or(1);
        let to = to_chapter.unwrap_or(book.target_chapters);
        let max_r = max_retries.unwrap_or(1).clamp(0, 5);
        let log = json!([{
            "at": &now,
            "stage": "outline",
            "chapter": from,
            "message": "任务已创建",
        }]);
        conn.execute(
            r#"INSERT INTO writing_jobs
              (id, book_id, status, from_chapter, to_chapter, current_chapter, current_stage, error, created_at,
               auto_review, max_retries, retry_count, log_json)
             VALUES (?1, ?2, 'running', ?3, ?4, ?5, 'outline', NULL, ?6, ?7, ?8, 0, ?9)"#,
            params![
                id,
                book_id,
                from,
                to,
                from,
                now,
                if auto_review { 1 } else { 0 },
                max_r,
                serde_json::to_string(&log).unwrap()
            ],
        )?;
        Ok((from, to, max_r))
    })?;
    let _ = (from, to, max_r);
    get_job(db, &id)
}

pub fn try_acquire_job_lease(db: &Db, id: &str, owner: &str, ttl_ms: i64) -> AppResult<bool> {
    let _ = get_job(db, id)?;
    let until = lease_until_iso(ttl_ms);
    let now = now_iso();
    db.with_conn(|conn| {
        let n = conn.execute(
            SQLITE_ACQUIRE_SQL,
            params![owner, until, id, now, owner],
        )?;
        Ok(n > 0)
    })
}

pub fn release_job_lease(db: &Db, id: &str, owner: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(SQLITE_RELEASE_SQL, params![id, owner])?;
        Ok(())
    })
}

pub fn set_job_status(db: &Db, id: &str, status: &str) -> AppResult<Value> {
    if !matches!(status, "paused" | "running" | "done" | "cancelled") {
        return Err(AppError::BadRequest(
            "状态只能是 paused、running、done 或 cancelled".into(),
        ));
    }
    db.with_conn(|conn| {
        let _ = job_json_row(conn, id)?;
        conn.execute(
            "UPDATE writing_jobs SET status = ?1, error = CASE WHEN ?1 = 'running' THEN NULL ELSE error END WHERE id = ?2",
            params![status, id],
        )?;
        let job = job_json_row(conn, id)?;
        let stage = job.get("currentStage").and_then(|v| v.as_str()).unwrap_or("");
        let chapter = job.get("currentChapter").and_then(|v| v.as_i64()).unwrap_or(0);
        let label = match status {
            "paused" => "已暂停（当前阶段结束后停）",
            "running" => "继续运行",
            "cancelled" => "已取消（迟到结果不设为当前稿）",
            _ => "标记完成",
        };
        append_job_log(conn, id, stage, chapter, label)?;
        job_json_row(conn, id)
    })
}

pub fn retry_job(db: &Db, id: &str) -> AppResult<Value> {
    let job = get_job(db, id)?;
    let status = job.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if status != "error" && status != "paused" {
        return Err(AppError::BadRequest("只能重试失败或已暂停的任务".into()));
    }
    let stage = job.get("currentStage").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let chapter = job.get("currentChapter").and_then(|v| v.as_i64()).unwrap_or(0);
    let retry_count = job.get("retryCount").and_then(|v| v.as_i64()).unwrap_or(0);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE writing_jobs SET status = 'running', error = NULL, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?1",
            params![id],
        )?;
        append_job_log(
            conn,
            id,
            &stage,
            chapter,
            &format!("重试第 {} 次", retry_count + 1),
        )?;
        job_json_row(conn, id)
    })
}

fn job_lease_check(db: &Db, id: &str, stage: &str) -> AppResult<&'static str> {
    let fresh = get_job(db, id)?;
    let status = fresh.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let chapter = fresh.get("currentChapter").and_then(|v| v.as_i64()).unwrap_or(0);
    match status {
        "cancelled" => {
            db.with_conn(|conn| append_job_log(conn, id, stage, chapter, "任务已取消，不再推进"))?;
            Ok("stop")
        }
        "done" => Ok("stop"),
        "paused" => {
            db.with_conn(|conn| {
                append_job_log(conn, id, stage, chapter, "任务已暂停，本阶段完成后停留")
            })?;
            Ok("paused")
        }
        _ => Ok("ok"),
    }
}

fn advance_after_chapter(db: &Db, id: &str) -> AppResult<()> {
    let job = get_job(db, id)?;
    let current = job.get("currentChapter").and_then(|v| v.as_i64()).unwrap_or(0);
    let to = job.get("toChapter").and_then(|v| v.as_i64()).unwrap_or(0);
    db.with_conn(|conn| {
        if current >= to {
            conn.execute(
                "UPDATE writing_jobs SET status = 'done', current_stage = 'done', error = NULL WHERE id = ?1",
                params![id],
            )?;
            append_job_log(conn, id, "done", current, "全部完成")?;
        } else {
            let next = current + 1;
            conn.execute(
                "UPDATE writing_jobs SET current_chapter = ?1, current_stage = 'chapter_outline', error = NULL WHERE id = ?2",
                params![next, id],
            )?;
            append_job_log(
                conn,
                id,
                "chapter_outline",
                next,
                &format!("进入第 {next} 章细纲"),
            )?;
        }
        Ok(())
    })
}

pub async fn tick_job(db: &Db, id: &str) -> AppResult<Value> {
    let job = get_job(db, id)?;
    let status = job.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if matches!(status, "paused" | "done" | "cancelled") {
        return Ok(json!({ "job": job, "advanced": false }));
    }
    let book_id = job.get("bookId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let stage = job.get("currentStage").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let current_chapter = job.get("currentChapter").and_then(|v| v.as_i64()).unwrap_or(1);
    let from_chapter = job.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(1);
    let auto_review = job.get("autoReview").and_then(|v| v.as_bool()).unwrap_or(false);

    let run = async {
        match stage.as_str() {
            "outline" => {
                let existing = db.with_conn(|conn| {
                    Ok(artifact_body(conn, &book_id, "book_outline", None))
                })?;
                if existing.trim().is_empty() {
                    execute_scene(
                        db,
                        ExecuteSceneInput {
                            book_id: book_id.clone(),
                            scene: "outline".into(),
                            chapter_number: None,
                            instruction: "按档案写全书大纲".into(),
                            skill_ids: None,
                            expected_revision_id: None,
                            on_conflict: OnConflict::Candidate,
                            generation_id: None,
                            cancelled: None,
                            job_id: Some(id.to_string()),
                        source_revision_id: None,
                        tools_requested: false,
                    },
                    )
                    .await?;
                    db.with_conn(|conn| {
                        append_job_log(conn, id, "outline", current_chapter, "已生成全书大纲")
                    })?;
                } else {
                    db.with_conn(|conn| {
                        append_job_log(conn, id, "outline", current_chapter, "已有全书大纲，跳过")
                    })?;
                }
                let lease = job_lease_check(db, id, "outline")?;
                if lease == "stop" {
                    return Ok::<Value, AppError>(json!({ "job": get_job(db, id)?, "advanced": false }));
                }
                db.with_conn(|conn| {
                    conn.execute(
                        r#"UPDATE writing_jobs SET current_stage = 'chapter_outline', current_chapter = ?1, error = NULL,
                          status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'running' END WHERE id = ?2"#,
                        params![from_chapter, id],
                    )?;
                    Ok(())
                })?;
            }
            "chapter_outline" => {
                execute_scene(
                    db,
                    ExecuteSceneInput {
                        book_id: book_id.clone(),
                        scene: "chapter_outline".into(),
                        chapter_number: Some(current_chapter),
                        instruction: format!("写第 {current_chapter} 章细纲"),
                        skill_ids: None,
                        expected_revision_id: None,
                        on_conflict: OnConflict::Candidate,
                        generation_id: None,
                        cancelled: None,
                        job_id: Some(id.to_string()),
                        source_revision_id: None,
                        tools_requested: false,
                    },
                )
                .await?;
                db.with_conn(|conn| {
                    append_job_log(
                        conn,
                        id,
                        "chapter_outline",
                        current_chapter,
                        &format!("第 {current_chapter} 章细纲完成"),
                    )
                })?;
                let lease = job_lease_check(db, id, "chapter_outline")?;
                if lease == "stop" {
                    return Ok::<Value, AppError>(json!({ "job": get_job(db, id)?, "advanced": false }));
                }
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE writing_jobs SET current_stage = 'chapter_body', error = NULL WHERE id = ?1",
                        params![id],
                    )?;
                    Ok(())
                })?;
            }
            "chapter_body" => {
                execute_scene(
                    db,
                    ExecuteSceneInput {
                        book_id: book_id.clone(),
                        scene: "chapter_body".into(),
                        chapter_number: Some(current_chapter),
                        instruction: format!("写第 {current_chapter} 章正文"),
                        skill_ids: None,
                        expected_revision_id: None,
                        on_conflict: OnConflict::Candidate,
                        generation_id: None,
                        cancelled: None,
                        job_id: Some(id.to_string()),
                        source_revision_id: None,
                        tools_requested: false,
                    },
                )
                .await?;
                db.with_conn(|conn| {
                    append_job_log(
                        conn,
                        id,
                        "chapter_body",
                        current_chapter,
                        &format!("第 {current_chapter} 章正文完成"),
                    )
                })?;
                let lease = job_lease_check(db, id, "chapter_body")?;
                if lease == "stop" {
                    return Ok::<Value, AppError>(json!({ "job": get_job(db, id)?, "advanced": false }));
                }
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE writing_jobs SET current_stage = 'memory', error = NULL WHERE id = ?1",
                        params![id],
                    )?;
                    Ok(())
                })?;
            }
            "memory" => {
                let ok = wait_memory_extract(db, &book_id, current_chapter, 40_000).await;
                db.with_conn(|conn| {
                    append_job_log(
                        conn,
                        id,
                        "memory",
                        current_chapter,
                        &format!(
                            "第 {current_chapter} 章记忆{}",
                            if ok { "已抽取" } else { "等待超时，继续" }
                        ),
                    )
                })?;
                let lease = job_lease_check(db, id, "memory")?;
                if lease == "stop" {
                    return Ok::<Value, AppError>(json!({ "job": get_job(db, id)?, "advanced": false }));
                }
                if auto_review {
                    db.with_conn(|conn| {
                        conn.execute(
                            "UPDATE writing_jobs SET current_stage = 'review', error = NULL WHERE id = ?1",
                            params![id],
                        )?;
                        Ok(())
                    })?;
                } else {
                    advance_after_chapter(db, id)?;
                }
            }
            "review" => {
                execute_scene(
                    db,
                    ExecuteSceneInput {
                        book_id: book_id.clone(),
                        scene: "review".into(),
                        chapter_number: Some(current_chapter),
                        instruction: format!("审核第 {current_chapter} 章正文，列出问题清单"),
                        skill_ids: None,
                        expected_revision_id: None,
                        on_conflict: OnConflict::Candidate,
                        generation_id: None,
                        cancelled: None,
                        job_id: Some(id.to_string()),
                        source_revision_id: None,
                        tools_requested: false,
                    },
                )
                .await?;
                db.with_conn(|conn| {
                    append_job_log(
                        conn,
                        id,
                        "review",
                        current_chapter,
                        &format!("第 {current_chapter} 章审核完成"),
                    )
                })?;
                let lease = job_lease_check(db, id, "review")?;
                if lease == "stop" {
                    return Ok::<Value, AppError>(json!({ "job": get_job(db, id)?, "advanced": false }));
                }
                advance_after_chapter(db, id)?;
            }
            _ => {
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE writing_jobs SET status = 'done', current_stage = 'done' WHERE id = ?1",
                        params![id],
                    )?;
                    append_job_log(conn, id, "done", current_chapter, "完成")?;
                    Ok(())
                })?;
            }
        }
        let latest = get_job(db, id)?;
        Ok(json!({ "job": latest, "advanced": true }))
    };

    match run.await {
        Ok(v) => Ok(v),
        Err(e) => {
            let message = e.to_string();
            let fresh = get_job(db, id)?;
            let retries = fresh.get("retryCount").and_then(|v| v.as_i64()).unwrap_or(0);
            let max = fresh.get("maxRetries").and_then(|v| v.as_i64()).unwrap_or(1);
            let stage = fresh
                .get("currentStage")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let chapter = fresh.get("currentChapter").and_then(|v| v.as_i64()).unwrap_or(0);
            if retries < max {
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE writing_jobs SET status = 'running', error = NULL, retry_count = ?1 WHERE id = ?2",
                        params![retries + 1, id],
                    )?;
                    append_job_log(
                        conn,
                        id,
                        &stage,
                        chapter,
                        &format!("失败后自动重试 ({}/{})：{message}", retries + 1, max),
                    )?;
                    Ok(())
                })?;
                Ok(json!({ "job": get_job(db, id)?, "advanced": false, "retried": true }))
            } else {
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE writing_jobs SET status = 'error', error = ?1 WHERE id = ?2",
                        params![message, id],
                    )?;
                    append_job_log(conn, id, &stage, chapter, &format!("失败：{message}"))?;
                    Ok(())
                })?;
                Ok(json!({ "job": get_job(db, id)?, "advanced": false }))
            }
        }
    }
}

pub fn pick_running_job_id(db: &Db) -> AppResult<Option<String>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT id FROM writing_jobs WHERE status = 'running' ORDER BY created_at ASC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?)
    })
}
