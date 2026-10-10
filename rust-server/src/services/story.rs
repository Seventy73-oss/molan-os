//! G2 StoryLedger: publication pointer, memory proposals, epoch, idempotency, invalidate-on-republish.

use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::books::must_book;
use crate::services::revisions::{OnConflict, SaveRevisionInput, current_revision_id_for, save_revision};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const PROTOCOL_VERSION: i64 = 1;
const PROPOSAL_SCHEMA: &str = "molan.memory-proposal/v1";

fn hash_request(v: &Value) -> String {
    let s = serde_json::to_string(v).unwrap_or_default();
    hex::encode(Sha256::digest(s.as_bytes()))
}

fn ensure_book_head(conn: &Connection, book_id: &str) -> AppResult<()> {
    let now = now_iso();
    conn.execute(
        r#"INSERT INTO story_book_heads (book_id, story_epoch, fact_set_version, protocol_version, updated_at)
           VALUES (?1, 0, 0, ?2, ?3)
           ON CONFLICT(book_id) DO NOTHING"#,
        params![book_id, PROTOCOL_VERSION, now],
    )?;
    Ok(())
}

pub fn get_book_head(db: &Db, book_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        ensure_book_head(conn, book_id)?;
        let row: (i64, i64, i64, String) = conn.query_row(
            "SELECT story_epoch, fact_set_version, protocol_version, updated_at FROM story_book_heads WHERE book_id = ?1",
            params![book_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        Ok(json!({
            "bookId": book_id,
            "storyEpoch": row.0,
            "factSetVersion": row.1,
            "protocolVersion": row.2,
            "updatedAt": row.3,
        }))
    })
}

fn chapter_row(conn: &Connection, book_id: &str, chapter_id: &str) -> AppResult<(String, i64)> {
    conn.query_row(
        "SELECT id, number FROM chapters WHERE id = ?1 AND book_id = ?2",
        params![chapter_id, book_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("章节不存在".into()))
}

fn chapter_by_number(conn: &Connection, book_id: &str, number: i64) -> AppResult<(String, i64)> {
    conn.query_row(
        "SELECT id, number FROM chapters WHERE book_id = ?1 AND number = ?2",
        params![book_id, number],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("没有第 {number} 章")))
}

/// Verify body revision belongs to this book's chapter_body for the chapter.
fn assert_body_revision(
    conn: &Connection,
    book_id: &str,
    chapter_id: &str,
    body_revision_id: &str,
) -> AppResult<()> {
    let ok: Option<i64> = conn
        .query_row(
            r#"SELECT 1 FROM artifact_revisions r
               JOIN artifacts a ON a.id = r.artifact_id
               WHERE r.id = ?1 AND a.book_id = ?2 AND a.chapter_id = ?3 AND a.kind = 'chapter_body'"#,
            params![body_revision_id, book_id, chapter_id],
            |r| r.get(0),
        )
        .optional()?;
    if ok.is_none() {
        return Err(AppError::BadRequest(
            "bodyRevisionId 不属于本章正文修订".into(),
        ));
    }
    Ok(())
}

fn active_publication(
    conn: &Connection,
    book_id: &str,
    chapter_id: &str,
) -> AppResult<Option<(String, String, i64, String)>> {
    // id, body_revision_id, publication_version, memory_state
    let row = conn
        .query_row(
            r#"SELECT id, body_revision_id, publication_version, memory_state
               FROM chapter_publications
               WHERE book_id = ?1 AND chapter_id = ?2 AND status = 'active'"#,
            params![book_id, chapter_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    Ok(row)
}

fn lookup_idempotency(conn: &Connection, book_id: &str, key: &str) -> AppResult<Option<(String, Value)>> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT request_hash, result_json FROM story_operation_results WHERE book_id = ?1 AND idempotency_key = ?2",
            params![book_id, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(h, j)| {
        let v: Value = serde_json::from_str(&j).unwrap_or(json!({}));
        (h, v)
    }))
}

fn store_idempotency(conn: &Connection, book_id: &str, key: &str, hash: &str, result: &Value) -> AppResult<()> {
    conn.execute(
        r#"INSERT INTO story_operation_results (book_id, idempotency_key, request_hash, result_json, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)"#,
        params![book_id, key, hash, result.to_string(), now_iso()],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct FinalizeInput {
    pub book_id: String,
    pub chapter_id: String,
    pub body_revision_id: String,
    /// Explicit: None means "expect no prior publication"; Some(id) expects that active id.
    pub expected_publication_id: Option<Option<String>>,
    pub expected_current_revision_id: Option<String>,
    pub expected_story_epoch: Option<i64>,
    pub idempotency_key: String,
    pub accepted_by: String,
}

pub fn finalize_chapter(db: &Db, input: FinalizeInput) -> AppResult<Value> {
    let request_fingerprint = json!({
        "op": "finalize",
        "bookId": input.book_id,
        "chapterId": input.chapter_id,
        "bodyRevisionId": input.body_revision_id,
        "expectedPublicationId": input.expected_publication_id,
        "expectedCurrentRevisionId": input.expected_current_revision_id,
        "expectedStoryEpoch": input.expected_story_epoch,
    });
    let req_hash = hash_request(&request_fingerprint);

    let (result, outbox_id, chapter_number, source_rev) = db.with_conn(|conn| {
        must_book(conn, &input.book_id)?;
        ensure_book_head(conn, &input.book_id)?;
        let (chapter_id, chapter_number) = chapter_row(conn, &input.book_id, &input.chapter_id)?;

        if let Some((prev_hash, prev)) = lookup_idempotency(conn, &input.book_id, &input.idempotency_key)? {
            if prev_hash != req_hash {
                return Err(AppError::Conflict(
                    "IDEMPOTENCY_KEY_REUSED: 同键不同参数".into(),
                ));
            }
            return Ok((prev, None, chapter_number, input.body_revision_id.clone()));
        }

        assert_body_revision(conn, &input.book_id, &chapter_id, &input.body_revision_id)?;

        let current = current_revision_id_for(conn, &input.book_id, "chapter_body", Some(chapter_number))?;
        if let Some(ref expected) = input.expected_current_revision_id {
            if current.as_deref() != Some(expected.as_str()) {
                return Err(AppError::Conflict(
                    "REVISION_CONFLICT: 正文 current 与预期不符".into(),
                ));
            }
        }

        let head: (i64, i64) = conn.query_row(
            "SELECT story_epoch, fact_set_version FROM story_book_heads WHERE book_id = ?1",
            params![input.book_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if let Some(exp) = input.expected_story_epoch {
            if exp != head.0 {
                return Err(AppError::Conflict(
                    "STORY_EPOCH_CONFLICT: 故事版本已变化".into(),
                ));
            }
        }

        let active = active_publication(conn, &input.book_id, &chapter_id)?;
        match &input.expected_publication_id {
            None => {
                return Err(AppError::BadRequest(
                    "expectedPublicationId 必须显式传入（null 表示尚无定稿）".into(),
                ));
            }
            Some(None) => {
                if active.is_some() {
                    return Err(AppError::Conflict(
                        "REVISION_CONFLICT: 已有活跃定稿，请传入 expectedPublicationId".into(),
                    ));
                }
            }
            Some(Some(exp)) => match &active {
                Some((id, _, _, _)) if id == exp => {}
                Some(_) => {
                    return Err(AppError::Conflict(
                        "REVISION_CONFLICT: 活跃定稿与预期不符".into(),
                    ));
                }
                None => {
                    return Err(AppError::Conflict(
                        "REVISION_CONFLICT: 预期有定稿但当前无活跃定稿".into(),
                    ));
                }
            },
        }

        let tx = conn.unchecked_transaction()?;
        let now = now_iso();
        let mut superseded_id: Option<String> = None;
        let next_version = if let Some((old_id, old_body, old_ver, _)) = active {
            if old_body == input.body_revision_id {
                // Same revision re-finalize: treat as idempotent success without bumping if same params already stored
                // Still create new publication version only when body differs; if same body, return existing.
                // Spec: replacing with same body can no-op bump — we supersede and recreate to keep audit trail.
            }
            tx.execute(
                "UPDATE chapter_publications SET status = 'superseded' WHERE id = ?1",
                params![old_id],
            )?;
            // Invalidate facts from old publication
            tx.execute(
                "UPDATE story_facts SET status = 'invalidated' WHERE publication_id = ?1 AND status = 'active'",
                params![old_id],
            )?;
            tx.execute(
                "UPDATE story_fact_sets SET status = 'invalidated' WHERE publication_id = ?1 AND status = 'active'",
                params![old_id],
            )?;
            // Stale open proposals for this chapter
            tx.execute(
                r#"UPDATE memory_proposals SET status = 'stale', updated_at = ?1
                   WHERE book_id = ?2 AND chapter_id = ?3 AND status IN ('queued','extracting','proposed')"#,
                params![now, input.book_id, chapter_id],
            )?;
            superseded_id = Some(old_id);
            old_ver + 1
        } else {
            1
        };

        let pub_id = Uuid::new_v4().to_string();
        tx.execute(
            r#"INSERT INTO chapter_publications
                (id, book_id, chapter_id, body_revision_id, publication_version, status, memory_state, accepted_at, accepted_by)
               VALUES (?1, ?2, ?3, ?4, ?5, 'active', 'pending', ?6, ?7)"#,
            params![
                pub_id,
                input.book_id,
                chapter_id,
                input.body_revision_id,
                next_version,
                now,
                input.accepted_by
            ],
        )?;

        let new_epoch = head.0 + 1;
        tx.execute(
            "UPDATE story_book_heads SET story_epoch = ?1, updated_at = ?2 WHERE book_id = ?3",
            params![new_epoch, now, input.book_id],
        )?;

        let outbox_id = Uuid::new_v4().to_string();
        let dedup = format!("memory_extract:{pub_id}");
        let payload = json!({
            "publicationId": pub_id,
            "chapterId": chapter_id,
            "chapterNumber": chapter_number,
            "bodyRevisionId": input.body_revision_id,
            "basisEpoch": new_epoch,
        });
        // Obsolete prior extract outbox for this chapter
        tx.execute(
            r#"UPDATE story_outbox SET status = 'obsolete', updated_at = ?1
               WHERE book_id = ?2 AND kind = 'memory_extract'
                 AND status IN ('queued','running','retry_wait')
                 AND json_extract(payload_json, '$.chapterId') = ?3"#,
            params![now, input.book_id, chapter_id],
        )?;
        tx.execute(
            r#"INSERT INTO story_outbox
                (id, book_id, dedup_key, kind, payload_json, status, attempt, next_run_at, lease_generation, created_at, updated_at)
               VALUES (?1, ?2, ?3, 'memory_extract', ?4, 'queued', 0, ?5, 0, ?5, ?5)
               ON CONFLICT(book_id, dedup_key) DO UPDATE SET
                 status = 'queued', payload_json = excluded.payload_json, updated_at = excluded.updated_at,
                 next_run_at = excluded.next_run_at, attempt = 0, last_error_code = NULL"#,
            params![outbox_id, input.book_id, dedup, payload.to_string(), now],
        )?;

        let result = json!({
            "publicationId": pub_id,
            "bodyRevisionId": input.body_revision_id,
            "storyEpoch": new_epoch,
            "memoryState": "pending",
            "publicationVersion": next_version,
            "affectedFromChapter": chapter_number,
            "supersededPublicationId": superseded_id,
            "outboxId": outbox_id,
            "chapterId": chapter_id,
            "chapterNumber": chapter_number,
        });
        store_idempotency(&tx, &input.book_id, &input.idempotency_key, &req_hash, &result)?;
        tx.commit()?;
        Ok((result, Some(outbox_id), chapter_number, input.body_revision_id.clone()))
    })?;

    if let Some(_oid) = outbox_id {
        // Spawn extract after commit (model outside TX)
        crate::services::memory::schedule_publication_memory_extract(
            db.clone(),
            input.book_id.clone(),
            chapter_number,
            source_rev,
        );
    }

    Ok(result)
}

pub fn chapter_story_status(db: &Db, book_id: &str, chapter_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        ensure_book_head(conn, book_id)?;
        let (cid, number) = chapter_row(conn, book_id, chapter_id)?;
        let current = current_revision_id_for(conn, book_id, "chapter_body", Some(number))?;
        let active = active_publication(conn, book_id, &cid)?;
        let head: (i64, i64) = conn.query_row(
            "SELECT story_epoch, fact_set_version FROM story_book_heads WHERE book_id = ?1",
            params![book_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let draft_diverges = match (&current, &active) {
            (Some(cur), Some((_, pub_body, _, _))) => cur != pub_body,
            _ => false,
        };
        let proposal: Option<(String, String)> = conn
            .query_row(
                r#"SELECT id, status FROM memory_proposals
                   WHERE book_id = ?1 AND chapter_id = ?2 AND status = 'proposed'
                   ORDER BY created_at DESC LIMIT 1"#,
                params![book_id, cid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(json!({
            "bookId": book_id,
            "chapterId": cid,
            "chapterNumber": number,
            "storyEpoch": head.0,
            "factSetVersion": head.1,
            "currentRevisionId": current,
            "publication": active.as_ref().map(|(id, body, ver, mem)| json!({
                "id": id,
                "bodyRevisionId": body,
                "publicationVersion": ver,
                "memoryState": mem,
                "status": "active",
            })),
            "draftDivergesFromPublication": draft_diverges,
            "openProposal": proposal.map(|(id, st)| json!({ "id": id, "status": st })),
            "mode": if active.is_some() { "published_only" } else { "legacy_current" },
        }))
    })
}

pub fn chapter_story_status_by_number(db: &Db, book_id: &str, number: i64) -> AppResult<Value> {
    let chapter_id = db.with_conn(|conn| {
        must_book(conn, book_id)?;
        Ok(chapter_by_number(conn, book_id, number)?.0)
    })?;
    chapter_story_status(db, book_id, &chapter_id)
}

/// Create a memory proposal from extracted text (does not write chapter_memory).
pub fn create_memory_proposal(
    db: &Db,
    book_id: &str,
    chapter_number: i64,
    source_revision_id: &str,
    summary: &str,
    publication_id: Option<&str>,
    basis_epoch: i64,
) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        ensure_book_head(conn, book_id)?;
        let (chapter_id, _) = chapter_by_number(conn, book_id, chapter_number)?;
        assert_body_revision(conn, book_id, &chapter_id, source_revision_id)?;

        // If publication given, must still be active and match source
        if let Some(pid) = publication_id {
            let row: Option<(String, String, String)> = conn
                .query_row(
                    "SELECT id, body_revision_id, status FROM chapter_publications WHERE id = ?1 AND book_id = ?2",
                    params![pid, book_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((_, body, status)) = row else {
                return Err(AppError::NotFound("定稿不存在".into()));
            };
            if status != "active" || body != source_revision_id {
                return Err(AppError::Conflict(
                    "PROPOSAL_STALE: 定稿已替换或源修订不匹配".into(),
                ));
            }
        }

        let ops = json!([
            {
                "operationId": "op-summary",
                "kind": "summary_update",
                "subjectId": format!("chapter:{chapter_number}"),
                "field": "chapter_summary",
                "proposedValue": { "text": summary },
                "assertionKind": "explicit",
                "evidence": { "quote": summary.chars().take(120).collect::<String>() },
                "requiresAuthorApproval": true
            }
        ]);
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        conn.execute(
            r#"INSERT INTO memory_proposals
                (id, book_id, chapter_id, publication_id, source_revision_id, basis_epoch,
                 schema_version, status, summary, operations_json, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'proposed', ?8, ?9, ?10, ?10)"#,
            params![
                id,
                book_id,
                chapter_id,
                publication_id,
                source_revision_id,
                basis_epoch,
                PROPOSAL_SCHEMA,
                summary,
                ops.to_string(),
                now
            ],
        )?;
        if let Some(pid) = publication_id {
            conn.execute(
                "UPDATE chapter_publications SET memory_state = 'proposed' WHERE id = ?1 AND status = 'active'",
                params![pid],
            )?;
        }
        // Mark matching outbox completed
        if let Some(pid) = publication_id {
            let dedup = format!("memory_extract:{pid}");
            conn.execute(
                "UPDATE story_outbox SET status = 'completed', updated_at = ?1 WHERE book_id = ?2 AND dedup_key = ?3",
                params![now, book_id, dedup],
            )?;
        }
        Ok(json!({
            "id": id,
            "bookId": book_id,
            "chapterId": chapter_id,
            "chapterNumber": chapter_number,
            "publicationId": publication_id,
            "sourceRevisionId": source_revision_id,
            "basisEpoch": basis_epoch,
            "status": "proposed",
            "summary": summary,
            "operations": ops,
        }))
    })
}

pub fn get_proposal(db: &Db, book_id: &str, proposal_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let row: Option<(String, String, Option<String>, String, i64, String, String, String, Option<String>, String)> =
            conn.query_row(
                r#"SELECT id, chapter_id, publication_id, source_revision_id, basis_epoch, status,
                          summary, operations_json, decision_json, created_at
                   FROM memory_proposals WHERE id = ?1 AND book_id = ?2"#,
                params![proposal_id, book_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, chapter_id, pub_id, source, epoch, status, summary, ops, decision, created)) = row else {
            return Err(AppError::NotFound("提案不存在".into()));
        };
        let ops_v: Value = serde_json::from_str(&ops).unwrap_or(json!([]));
        let decision_v: Value = decision
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(json!(null));
        Ok(json!({
            "id": id,
            "bookId": book_id,
            "chapterId": chapter_id,
            "publicationId": pub_id,
            "sourceRevisionId": source,
            "basisEpoch": epoch,
            "status": status,
            "summary": summary,
            "operations": ops_v,
            "decision": decision_v,
            "createdAt": created,
            "schemaVersion": PROPOSAL_SCHEMA,
        }))
    })
}

#[derive(Debug, Clone)]
pub struct ApplyProposalInput {
    pub book_id: String,
    pub proposal_id: String,
    pub accepted_operation_ids: Vec<String>,
    pub expected_source_revision_id: String,
    pub expected_story_epoch: Option<i64>,
    pub idempotency_key: String,
}

pub fn apply_proposal(db: &Db, input: ApplyProposalInput) -> AppResult<Value> {
    let request_fingerprint = json!({
        "op": "apply_proposal",
        "bookId": input.book_id,
        "proposalId": input.proposal_id,
        "acceptedOperationIds": input.accepted_operation_ids,
        "expectedSourceRevisionId": input.expected_source_revision_id,
        "expectedStoryEpoch": input.expected_story_epoch,
    });
    let req_hash = hash_request(&request_fingerprint);

    // First validate and compute summary text to write (outside save_revision TX nesting)
    let prepared = db.with_conn(|conn| {
        must_book(conn, &input.book_id)?;
        ensure_book_head(conn, &input.book_id)?;
        if let Some((prev_hash, prev)) = lookup_idempotency(conn, &input.book_id, &input.idempotency_key)? {
            if prev_hash != req_hash {
                return Err(AppError::Conflict(
                    "IDEMPOTENCY_KEY_REUSED: 同键不同参数".into(),
                ));
            }
            return Ok(Err(prev)); // early idempotent return
        }
        Ok(Ok(()))
    })?;
    if let Err(prev) = prepared {
        return Ok(prev);
    }

    let proposal = get_proposal(db, &input.book_id, &input.proposal_id)?;
    let status = proposal.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if status != "proposed" {
        return Err(AppError::Conflict(format!(
            "PROPOSAL_STALE: 提案状态为 {status}，不能批准"
        )));
    }
    let source = proposal
        .get("sourceRevisionId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if source != input.expected_source_revision_id {
        return Err(AppError::Conflict(
            "PROPOSAL_STALE: 源修订与预期不符".into(),
        ));
    }
    let pub_id = proposal
        .get("publicationId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let chapter_id = proposal
        .get("chapterId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let _basis_epoch = proposal
        .get("basisEpoch")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let ops = proposal.get("operations").cloned().unwrap_or(json!([]));
    let ops_arr = ops.as_array().cloned().unwrap_or_default();

    // Stale if publication no longer active / body changed
    if let Some(ref pid) = pub_id {
        let stale = db.with_conn(|conn| {
            let row: Option<(String, String)> = conn
                .query_row(
                    "SELECT body_revision_id, status FROM chapter_publications WHERE id = ?1",
                    params![pid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            Ok(match row {
                Some((body, st)) if st == "active" && body == source => false,
                _ => true,
            })
        })?;
        if stale {
            let _ = db.with_conn(|conn| {
                conn.execute(
                    "UPDATE memory_proposals SET status = 'stale', updated_at = ?1 WHERE id = ?2",
                    params![now_iso(), input.proposal_id],
                )?;
                Ok(())
            });
            return Err(AppError::Conflict(
                "PROPOSAL_STALE: 定稿已变化".into(),
            ));
        }
    }

    let head = get_book_head(db, &input.book_id)?;
    let epoch = head.get("storyEpoch").and_then(|v| v.as_i64()).unwrap_or(0);
    if let Some(exp) = input.expected_story_epoch {
        if exp != epoch {
            return Err(AppError::Conflict(
                "STORY_EPOCH_CONFLICT: 故事版本已变化".into(),
            ));
        }
    }

    let accepted: Vec<Value> = ops_arr
        .iter()
        .filter(|op| {
            op.get("operationId")
                .and_then(|v| v.as_str())
                .map(|id| input.accepted_operation_ids.iter().any(|a| a == id))
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    if accepted.is_empty() {
        return Err(AppError::BadRequest("未选择任何可接受的操作".into()));
    }

    let mut summary_text = proposal
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    for op in &accepted {
        if op.get("kind").and_then(|v| v.as_str()) == Some("summary_update") {
            if let Some(t) = op
                .pointer("/proposedValue/text")
                .and_then(|v| v.as_str())
            {
                summary_text = t.to_string();
            }
        }
    }

    let chapter_number: i64 = db.with_conn(|conn| {
        let n: i64 = conn.query_row(
            "SELECT number FROM chapters WHERE id = ?1",
            params![chapter_id],
            |r| r.get(0),
        )?;
        Ok(n)
    })?;

    // Write chapter_memory only for accepted summary (formal memory)
    let saved = save_revision(
        db,
        SaveRevisionInput {
            book_id: input.book_id.clone(),
            kind: "chapter_memory".into(),
            chapter_number: Some(chapter_number),
            chapter_id: Some(chapter_id.clone()),
            body: summary_text.clone(),
            source: "story_ledger".into(),
            model: Some("author_accepted".into()),
            skill_ids: vec![],
            scene: Some("memory_extract".into()),
            expected_revision_id: None,
            as_candidate: false,
            on_conflict: OnConflict::Candidate,
            source_revision_id: Some(source.to_string()),
            skip_memory: true,
        },
    )?;

    let result = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let now = now_iso();
        let rejected: Vec<String> = ops_arr
            .iter()
            .filter_map(|op| op.get("operationId").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .filter(|id| !input.accepted_operation_ids.iter().any(|a| a == id))
            .collect();
        let decision = json!({
            "acceptedOperationIds": input.accepted_operation_ids,
            "rejectedOperationIds": rejected,
            "at": now,
        });
        tx.execute(
            r#"UPDATE memory_proposals SET status = 'accepted', decision_json = ?1, updated_at = ?2 WHERE id = ?3"#,
            params![decision.to_string(), now, input.proposal_id],
        )?;

        let fact_set_id = Uuid::new_v4().to_string();
        let prev_ver: i64 = tx.query_row(
            "SELECT fact_set_version FROM story_book_heads WHERE book_id = ?1",
            params![input.book_id],
            |r| r.get(0),
        )?;
        let next_ver = prev_ver + 1;
        tx.execute(
            r#"INSERT INTO story_fact_sets
                (id, book_id, publication_id, source_revision_id, version, status, proposal_id, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7)"#,
            params![
                fact_set_id,
                input.book_id,
                pub_id,
                source,
                next_ver,
                input.proposal_id,
                now
            ],
        )?;
        for op in &accepted {
            let fid = Uuid::new_v4().to_string();
            let subject = op
                .get("subjectId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let predicate = op
                .get("field")
                .or_else(|| op.get("kind"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let value = op.get("proposedValue").cloned().unwrap_or(json!({}));
            let quote = op
                .pointer("/evidence/quote")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            tx.execute(
                r#"INSERT INTO story_facts
                    (id, fact_set_id, book_id, subject, predicate, value_json, evidence_quote,
                     source_revision_id, publication_id, effective_from_chapter, status, created_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11)"#,
                params![
                    fid,
                    fact_set_id,
                    input.book_id,
                    subject,
                    predicate,
                    value.to_string(),
                    quote,
                    source,
                    pub_id,
                    chapter_number,
                    now
                ],
            )?;
        }
        tx.execute(
            "UPDATE story_book_heads SET fact_set_version = ?1, story_epoch = story_epoch + 1, updated_at = ?2 WHERE book_id = ?3",
            params![next_ver, now, input.book_id],
        )?;
        if let Some(ref pid) = pub_id {
            tx.execute(
                "UPDATE chapter_publications SET memory_state = 'ready' WHERE id = ?1",
                params![pid],
            )?;
        }
        let new_epoch: i64 = tx.query_row(
            "SELECT story_epoch FROM story_book_heads WHERE book_id = ?1",
            params![input.book_id],
            |r| r.get(0),
        )?;
        let result = json!({
            "proposalId": input.proposal_id,
            "status": "accepted",
            "factSetId": fact_set_id,
            "factSetVersion": next_ver,
            "storyEpoch": new_epoch,
            "memoryRevisionId": saved.get("revisionId"),
            "acceptedOperationIds": input.accepted_operation_ids,
            "memoryState": "ready",
        });
        store_idempotency(&tx, &input.book_id, &input.idempotency_key, &req_hash, &result)?;
        tx.commit()?;
        Ok(result)
    })?;
    Ok(result)
}

pub fn reject_proposal(
    db: &Db,
    book_id: &str,
    proposal_id: &str,
    reason: Option<&str>,
) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM memory_proposals WHERE id = ?1 AND book_id = ?2",
                params![proposal_id, book_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(st) = status else {
            return Err(AppError::NotFound("提案不存在".into()));
        };
        if st != "proposed" && st != "queued" {
            return Err(AppError::Conflict(format!(
                "PROPOSAL_STALE: 提案状态为 {st}"
            )));
        }
        let now = now_iso();
        let decision = json!({ "rejected": true, "reason": reason, "at": now });
        conn.execute(
            "UPDATE memory_proposals SET status = 'rejected', decision_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![decision.to_string(), now, proposal_id],
        )?;
        let pub_id: Option<String> = conn
            .query_row(
                "SELECT publication_id FROM memory_proposals WHERE id = ?1",
                params![proposal_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        if let Some(pid) = pub_id {
            conn.execute(
                "UPDATE chapter_publications SET memory_state = 'needs_review' WHERE id = ?1 AND status = 'active'",
                params![pid],
            )?;
        }
        Ok(json!({ "proposalId": proposal_id, "status": "rejected" }))
    })
}

/// Active publication body revision for a chapter number, if any.
pub fn active_publication_body_revision(
    conn: &Connection,
    book_id: &str,
    chapter_number: i64,
) -> AppResult<Option<String>> {
    let row: Option<String> = conn
        .query_row(
            r#"SELECT p.body_revision_id
               FROM chapter_publications p
               JOIN chapters c ON c.id = p.chapter_id
               WHERE p.book_id = ?1 AND c.number = ?2 AND p.status = 'active'"#,
            params![book_id, chapter_number],
            |r| r.get(0),
        )
        .optional()?;
    Ok(row)
}

pub fn book_has_any_publication(conn: &Connection, book_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM chapter_publications WHERE book_id = ?1 AND status = 'active' LIMIT 1",
        params![book_id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// Whether auto memory extract on body save should be skipped (formal path owns extract).
pub fn chapter_has_active_publication(conn: &Connection, book_id: &str, chapter_number: i64) -> bool {
    active_publication_body_revision(conn, book_id, chapter_number)
        .ok()
        .flatten()
        .is_some()
}
