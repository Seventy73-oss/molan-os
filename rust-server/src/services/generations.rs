//! Generations begin / cancel / complete / demote — mirrors Node engine generation APIs.

use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::manuscripts::sync_book_conn;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerationStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl GenerationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Running,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GenerationRow {
    pub id: String,
    pub book_id: String,
    pub scene: String,
    pub status: GenerationStatus,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub result_revision_id: Option<String>,
    pub base_revision_id: Option<String>,
}

fn row_from_db(
    id: String,
    book_id: String,
    scene: String,
    status: String,
    result_json: Option<String>,
    error: Option<String>,
    result_revision_id: Option<String>,
    base_revision_id: Option<String>,
) -> GenerationRow {
    GenerationRow {
        id,
        book_id,
        scene,
        status: GenerationStatus::parse(&status),
        result: result_json.and_then(|s| serde_json::from_str(&s).ok()),
        error,
        result_revision_id,
        base_revision_id,
    }
}

fn generation_json(row: &GenerationRow) -> Value {
    json!({
        "id": row.id,
        "bookId": row.book_id,
        "scene": row.scene,
        "status": row.status.as_str(),
        "result": row.result,
        "error": row.error,
        "resultRevisionId": row.result_revision_id,
        "baseRevisionId": row.base_revision_id,
    })
}

pub fn get_generation(db: &Db, id: &str) -> AppResult<Option<GenerationRow>> {
    db.with_conn(|conn| {
        let row = conn
            .query_row(
                r#"SELECT id, book_id, scene, status, result_json, error, result_revision_id, base_revision_id
                   FROM generations WHERE id = ?1"#,
                params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                        r.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(|(id, book_id, scene, status, rj, err, rr, br)| {
            row_from_db(id, book_id, scene, status, rj, err, rr, br)
        }))
    })
}

pub fn begin_generation(
    db: &Db,
    id: &str,
    book_id: &str,
    scene: &str,
    chapter_number: Option<i64>,
    chapter_id: Option<&str>,
    base_revision_id: Option<&str>,
) -> AppResult<Value> {
    if let Some(existing) = get_generation(db, id)? {
        return Ok(json!({
            "reused": true,
            "status": existing.status.as_str(),
            "result": existing.result,
            "error": existing.error,
            "resultRevisionId": existing.result_revision_id,
        }));
    }
    let ts = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO generations
                (id, book_id, scene, chapter_id, chapter_number, status, base_revision_id, result_revision_id, result_json, error, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, NULL, NULL, NULL, ?7, ?7)"#,
            params![
                id,
                book_id,
                scene,
                chapter_id,
                chapter_number,
                base_revision_id,
                ts
            ],
        )?;
        Ok(())
    })?;
    Ok(json!({ "reused": false, "status": "running" }))
}

pub fn link_generation_result_revision(db: &Db, generation_id: &str, revision_id: &str) -> AppResult<()> {
    let ts = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            r#"UPDATE generations SET result_revision_id = COALESCE(result_revision_id, ?1), updated_at = ?2
               WHERE id = ?3"#,
            params![revision_id, ts, generation_id],
        )?;
        Ok(())
    })
}

pub fn peek_previous_revision_id(db: &Db, revision_id: Option<&str>) -> AppResult<Option<String>> {
    let Some(revision_id) = revision_id else {
        return Ok(None);
    };
    db.with_conn(|conn| {
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT artifact_id, revision FROM artifact_revisions WHERE id = ?1",
                params![revision_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((artifact_id, revision_num)) = row else {
            return Ok(None);
        };
        let prev: Option<String> = conn
            .query_row(
                r#"SELECT id FROM artifact_revisions
                   WHERE artifact_id = ?1 AND revision < ?2
                   ORDER BY revision DESC LIMIT 1"#,
                params![artifact_id, revision_num],
                |r| r.get(0),
            )
            .optional()?;
        Ok(prev)
    })
}

pub fn demote_cancelled_result_revision(db: &Db, revision_id: &str) -> AppResult<Value> {
    let project_root = db.root.clone();
    db.with_conn(|conn| {
        let row: Option<(String, i64, String, Option<String>, String)> = conn
            .query_row(
                r#"SELECT r.id, r.revision, r.artifact_id, a.current_revision_id, a.book_id
                   FROM artifact_revisions r
                   JOIN artifacts a ON a.id = r.artifact_id
                   WHERE r.id = ?1"#,
                params![revision_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((_rid, revision_num, artifact_id, current_id, book_id)) = row else {
            return Ok(json!({
                "demoted": false,
                "orphanRevisionId": null,
                "restoredRevisionId": null,
                "artifactId": null,
            }));
        };
        conn.execute(
            "UPDATE artifact_revisions SET source = 'agent_cancelled' WHERE id = ?1",
            params![revision_id],
        )?;
        if current_id.as_deref() != Some(revision_id) {
            return Ok(json!({
                "demoted": false,
                "orphanRevisionId": revision_id,
                "restoredRevisionId": current_id,
                "artifactId": artifact_id,
            }));
        }
        let prev: Option<String> = conn
            .query_row(
                r#"SELECT id FROM artifact_revisions
                   WHERE artifact_id = ?1 AND revision < ?2
                   ORDER BY revision DESC LIMIT 1"#,
                params![artifact_id, revision_num],
                |r| r.get(0),
            )
            .optional()?;
        conn.execute(
            "UPDATE artifacts SET current_revision_id = ?1 WHERE id = ?2",
            params![prev, artifact_id],
        )?;
        let _ = sync_book_conn(conn, &project_root, &book_id);
        Ok(json!({
            "demoted": true,
            "orphanRevisionId": revision_id,
            "restoredRevisionId": prev,
            "artifactId": artifact_id,
        }))
    })
}

pub fn complete_generation(
    db: &Db,
    id: &str,
    status: GenerationStatus,
    result_revision_id: Option<&str>,
    result: Option<&Value>,
    error: Option<&str>,
) -> AppResult<Option<GenerationRow>> {
    if let Some(existing) = get_generation(db, id)? {
        if existing.status == GenerationStatus::Cancelled
            && (status == GenerationStatus::Completed || status == GenerationStatus::Failed)
        {
            return Ok(Some(existing));
        }
    }
    let ts = now_iso();
    let result_json = result.map(|v| v.to_string());
    db.with_conn(|conn| {
        conn.execute(
            r#"UPDATE generations SET status = ?1, result_revision_id = COALESCE(?2, result_revision_id),
                result_json = COALESCE(?3, result_json), error = ?4, updated_at = ?5 WHERE id = ?6"#,
            params![
                status.as_str(),
                result_revision_id,
                result_json,
                error,
                ts,
                id
            ],
        )?;
        Ok(())
    })?;
    get_generation(db, id)
}

pub fn cancel_generation(db: &Db, id: &str) -> AppResult<Value> {
    let row = get_generation(db, id)?
        .ok_or_else(|| AppError::NotFound("生成记录不存在".into()))?;

    if row.status == GenerationStatus::Completed || row.status == GenerationStatus::Failed {
        let previous = peek_previous_revision_id(db, row.result_revision_id.as_deref())?;
        let accepted = row.status == GenerationStatus::Completed;
        let mut out = generation_json(&row);
        out.as_object_mut().unwrap().insert("revert".into(), json!(null));
        out.as_object_mut()
            .unwrap()
            .insert("alreadyTerminal".into(), json!(true));
        out.as_object_mut()
            .unwrap()
            .insert("accepted".into(), json!(accepted));
        out.as_object_mut()
            .unwrap()
            .insert("previousRevisionId".into(), json!(previous));
        out.as_object_mut().unwrap().insert(
            "note".into(),
            json!(if accepted {
                "生成已完成，结果已保留；停止不会撤回。可在版本历史还原上一版。"
            } else {
                "生成已失败结束；停止不会改动稿面。"
            }),
        );
        return Ok(out);
    }

    if row.status == GenerationStatus::Cancelled {
        let revert = if let Some(ref rr) = row.result_revision_id {
            Some(demote_cancelled_result_revision(db, rr)?)
        } else {
            None
        };
        let after = get_generation(db, id)?.unwrap();
        let previous = peek_previous_revision_id(db, row.result_revision_id.as_deref())?;
        let demoted = revert
            .as_ref()
            .and_then(|v| v.get("demoted").and_then(|d| d.as_bool()))
            .unwrap_or(false);
        let mut out = generation_json(&after);
        out.as_object_mut()
            .unwrap()
            .insert("revert".into(), json!(revert));
        out.as_object_mut()
            .unwrap()
            .insert("alreadyTerminal".into(), json!(true));
        out.as_object_mut()
            .unwrap()
            .insert("accepted".into(), json!(false));
        out.as_object_mut()
            .unwrap()
            .insert("previousRevisionId".into(), json!(previous));
        out.as_object_mut().unwrap().insert(
            "note".into(),
            json!(if demoted {
                "已取消（已退回上一版修订）"
            } else {
                "生成已取消。"
            }),
        );
        return Ok(out);
    }

    complete_generation(
        db,
        id,
        GenerationStatus::Cancelled,
        None,
        None,
        Some("已取消"),
    )?;
    let after = get_generation(db, id)?.unwrap();
    let revert = if let Some(ref rr) = after.result_revision_id {
        Some(demote_cancelled_result_revision(db, rr)?)
    } else {
        None
    };
    let demoted = revert
        .as_ref()
        .and_then(|v| v.get("demoted").and_then(|d| d.as_bool()))
        .unwrap_or(false);
    if demoted {
        let ts = now_iso();
        let result = json!({
            "cancelRevert": revert,
            "note": "取消前已写入的修订已退回上一版；该次结果保留在版本历史（来源 agent_cancelled），可手动还原。",
        });
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE generations SET result_json = ?1, error = ?2, updated_at = ?3 WHERE id = ?4",
                params![
                    result.to_string(),
                    "已取消（已退回上一版修订）",
                    ts,
                    id
                ],
            )?;
            Ok(())
        })?;
    }
    let final_row = get_generation(db, id)?.unwrap();
    let previous = peek_previous_revision_id(db, after.result_revision_id.as_deref())?;
    let mut out = generation_json(&final_row);
    out.as_object_mut()
        .unwrap()
        .insert("revert".into(), json!(revert));
    out.as_object_mut()
        .unwrap()
        .insert("alreadyTerminal".into(), json!(false));
    out.as_object_mut()
        .unwrap()
        .insert("accepted".into(), json!(false));
    out.as_object_mut()
        .unwrap()
        .insert("previousRevisionId".into(), json!(previous));
    out.as_object_mut().unwrap().insert(
        "note".into(),
        json!(if demoted {
            "取消前已写入的修订已退回上一版；该次结果保留在版本历史（来源 agent_cancelled），可手动还原。"
        } else {
            "已取消。"
        }),
    );
    Ok(out)
}

/// Public helper: create a generation stub for later stream/chat wiring.
pub fn begin_stub(db: &Db, body: &Value) -> AppResult<Value> {
    let id = body
        .get("id")
        .or_else(|| body.get("generationId"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("缺少 generation id".into()))?;
    let book_id = body
        .get("bookId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("缺少 bookId".into()))?;
    let scene = body
        .get("scene")
        .and_then(|v| v.as_str())
        .unwrap_or("chat");
    let chapter_number = body.get("chapterNumber").and_then(|v| v.as_i64());
    let chapter_id = body.get("chapterId").and_then(|v| v.as_str());
    let base = body.get("baseRevisionId").and_then(|v| v.as_str());
    begin_generation(db, id, book_id, scene, chapter_number, chapter_id, base)
}
