//! G5: batch memory-ready with approval gates; no unconstrained agent orchestration.
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::books::must_book;
use crate::services::story::{create_memory_proposal, get_book_head};
use crate::services::story_pack::publish_check;
use crate::services::story_state::{list_foreshadowing, story_impact};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchCreateInput {
    pub from_chapter: i64,
    pub to_chapter: i64,
    pub strict_memory_ready: Option<bool>,
    pub auto_extract: Option<bool>,
    pub auto_apply_non_major: Option<bool>,
    pub major_change_requires_approval: Option<bool>,
    pub max_chapters: Option<i64>,
    pub max_model_calls: Option<i64>,
}

fn config_from(input: &BatchCreateInput) -> AppResult<Value> {
    let from = input.from_chapter;
    let to = input.to_chapter;
    if from <= 0 || to < from {
        return Err(AppError::BadRequest("fromChapter/toChapter 无效".into()));
    }
    let max_chapters = input.max_chapters.unwrap_or(50).clamp(1, 200);
    if to - from + 1 > max_chapters {
        return Err(AppError::BadRequest(format!(
            "章节跨度超过 maxChapters={max_chapters}"
        )));
    }
    Ok(json!({
        "fromChapter": from,
        "toChapter": to,
        "strictMemoryReady": input.strict_memory_ready.unwrap_or(true),
        "autoExtract": input.auto_extract.unwrap_or(false),
        "autoApplyNonMajor": input.auto_apply_non_major.unwrap_or(false),
        "majorChangeRequiresApproval": input.major_change_requires_approval.unwrap_or(true),
        "maxChapters": max_chapters,
        "maxModelCalls": input.max_model_calls.unwrap_or(20).clamp(0, 200),
    }))
}

fn is_major_op(op: &Value) -> bool {
    if op.get("requiresAuthorApproval").and_then(|v| v.as_bool()) == Some(true) {
        return true;
    }
    let kind = op.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if kind.starts_with("foreshadow_") || kind == "character_state_change" {
        return true;
    }
    false
}

fn load_row(db: &Db, book_id: &str, batch_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let row: Option<(
            String,
            String,
            String,
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            String,
            String,
            String,
            Option<String>,
            String,
            String,
        )> = conn
            .query_row(
                r#"SELECT id, book_id, kind, status, from_chapter, to_chapter, current_chapter,
                          config_json, progress_json, cost_json, error, created_at, updated_at
                   FROM story_batches WHERE id = ?1 AND book_id = ?2"#,
                params![batch_id, book_id],
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
                        r.get(10)?,
                        r.get(11)?,
                        r.get(12)?,
                    ))
                },
            )
            .optional()?;
        let Some(r) = row else {
            return Err(AppError::NotFound("批量任务不存在".into()));
        };
        let config: Value = serde_json::from_str(&r.7).unwrap_or(json!({}));
        let progress: Value = serde_json::from_str(&r.8).unwrap_or(json!({}));
        let cost: Value = serde_json::from_str(&r.9).unwrap_or(json!({}));
        Ok(json!({
            "id": r.0,
            "bookId": r.1,
            "kind": r.2,
            "status": r.3,
            "fromChapter": r.4,
            "toChapter": r.5,
            "currentChapter": r.6,
            "config": config,
            "progress": progress,
            "cost": cost,
            "error": r.10,
            "createdAt": r.11,
            "updatedAt": r.12,
            "gates": {
                "majorChangeRequiresApproval": config.get("majorChangeRequiresApproval").and_then(|v| v.as_bool()).unwrap_or(true),
                "strictMemoryReady": config.get("strictMemoryReady").and_then(|v| v.as_bool()).unwrap_or(true),
                "autoApplyNonMajor": config.get("autoApplyNonMajor").and_then(|v| v.as_bool()).unwrap_or(false),
                "autoExtract": config.get("autoExtract").and_then(|v| v.as_bool()).unwrap_or(false),
                "unconstrainedAgentOrchestration": false,
                "writesOnlyViaStoryLedger": true,
            }
        }))
    })
}

pub fn create_memory_ready_batch(db: &Db, book_id: &str, input: BatchCreateInput) -> AppResult<Value> {
    let config = config_from(&input)?;
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let progress = json!({
        "items": [],
        "modelCalls": 0,
        "cursorChapter": config.get("fromChapter").cloned().unwrap_or(json!(1)),
        "gate": null,
    });
    let cost = json!({
        "modelCalls": 0,
        "maxModelCalls": config.get("maxModelCalls").cloned().unwrap_or(json!(20)),
    });
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        conn.execute(
            r#"INSERT INTO story_batches
                (id, book_id, kind, status, from_chapter, to_chapter, current_chapter,
                 config_json, progress_json, cost_json, error, created_at, updated_at)
               VALUES (?1, ?2, 'memory_ready', 'queued', ?3, ?4, ?3, ?5, ?6, ?7, NULL, ?8, ?8)"#,
            params![
                id,
                book_id,
                input.from_chapter,
                input.to_chapter,
                config.to_string(),
                progress.to_string(),
                cost.to_string(),
                now,
            ],
        )?;
        Ok(())
    })?;
    load_row(db, book_id, &id)
}

fn chapter_meta(db: &Db, book_id: &str, chapter: i64) -> AppResult<(Option<String>, Option<String>, Option<String>, Option<String>)> {
    db.with_conn(|conn| {
        let ch: Option<String> = conn
            .query_row(
                "SELECT id FROM chapters WHERE book_id = ?1 AND number = ?2",
                params![book_id, chapter],
                |r| r.get(0),
            )
            .optional()?;
        let Some(cid) = ch else {
            return Ok((None, None, None, None));
        };
        let pub_row: Option<(String, String, String)> = conn
            .query_row(
                r#"SELECT id, memory_state, body_revision_id FROM chapter_publications
                   WHERE book_id = ?1 AND chapter_id = ?2 AND status = 'active'"#,
                params![book_id, cid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        Ok(match pub_row {
            Some((pid, mem, body)) => (Some(cid), Some(pid), Some(mem), Some(body)),
            None => (Some(cid), None, None, None),
        })
    })
}

fn open_proposal(db: &Db, book_id: &str, publication_id: &str) -> AppResult<Option<(String, String, String)>> {
    db.with_conn(|conn| {
        conn.query_row(
            r#"SELECT id, status, operations_json FROM memory_proposals
               WHERE book_id = ?1 AND publication_id = ?2 AND status IN ('proposed','extracting','queued')
               ORDER BY created_at DESC LIMIT 1"#,
            params![book_id, publication_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(AppError::from)
    })
}

fn body_snippet(db: &Db, body_revision_id: &str) -> AppResult<String> {
    db.with_conn(|conn| {
        let body: String = conn
            .query_row(
                "SELECT body FROM artifact_revisions WHERE id = ?1",
                params![body_revision_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_default();
        let t = body.trim();
        if t.is_empty() {
            Ok("（空正文）".into())
        } else {
            Ok(t.chars().take(400).collect())
        }
    })
}

fn save_batch(
    db: &Db,
    batch_id: &str,
    status: &str,
    current: Option<i64>,
    progress: &Value,
    cost: &Value,
    error: Option<&str>,
) -> AppResult<()> {
    let now = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            r#"UPDATE story_batches SET status = ?1, current_chapter = COALESCE(?2, current_chapter),
                progress_json = ?3, cost_json = ?4, error = ?5, updated_at = ?6 WHERE id = ?7"#,
            params![
                status,
                current,
                progress.to_string(),
                cost.to_string(),
                error,
                now,
                batch_id
            ],
        )?;
        Ok(())
    })
}

pub fn tick_memory_ready_batch(db: &Db, book_id: &str, batch_id: &str) -> AppResult<Value> {
    let row = load_row(db, book_id, batch_id)?;
    let status = row.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if matches!(status, "cancelled" | "done" | "error") {
        return Ok(row);
    }
    let config = row.get("config").cloned().unwrap_or(json!({}));
    let mut progress = row.get("progress").cloned().unwrap_or(json!({}));
    let from = config.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(1);
    let to = config.get("toChapter").and_then(|v| v.as_i64()).unwrap_or(from);
    let strict = config.get("strictMemoryReady").and_then(|v| v.as_bool()).unwrap_or(true);
    let auto_extract = config.get("autoExtract").and_then(|v| v.as_bool()).unwrap_or(false);
    let major_req = config
        .get("majorChangeRequiresApproval")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let max_calls = config.get("maxModelCalls").and_then(|v| v.as_i64()).unwrap_or(20);
    let mut model_calls = progress.get("modelCalls").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut items = progress
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let done: std::collections::HashSet<i64> = items
        .iter()
        .filter_map(|i| i.get("chapterNumber").and_then(|v| v.as_i64()))
        .collect();
    let mut chapter = progress
        .get("cursorChapter")
        .and_then(|v| v.as_i64())
        .unwrap_or(from);
    while chapter <= to && done.contains(&chapter) {
        chapter += 1;
    }
    let cost = |calls: i64| json!({ "modelCalls": calls, "maxModelCalls": max_calls });

    if chapter > to {
        progress["cursorChapter"] = Value::Null;
        progress["gate"] = Value::Null;
        progress["items"] = Value::Array(items);
        progress["modelCalls"] = json!(model_calls);
        save_batch(db, batch_id, "done", Some(to), &progress, &cost(model_calls), None)?;
        return load_row(db, book_id, batch_id);
    }

    if model_calls >= max_calls && auto_extract {
        progress["gate"] = json!("cost_cap");
        progress["cursorChapter"] = json!(chapter);
        progress["items"] = Value::Array(items);
        progress["modelCalls"] = json!(model_calls);
        save_batch(
            db,
            batch_id,
            "paused_gate",
            Some(chapter),
            &progress,
            &cost(model_calls),
            Some(&format!("已达 maxModelCalls={max_calls}")),
        )?;
        return load_row(db, book_id, batch_id);
    }

    let (chapter_id, publication_id, memory_state, body_revision_id) = chapter_meta(db, book_id, chapter)?;
    let mut item = json!({
        "chapterNumber": chapter,
        "chapterId": chapter_id,
        "publicationId": publication_id,
        "memoryState": memory_state,
        "status": "skipped",
        "proposalId": null,
        "majorOps": [],
        "note": "",
    });

    if chapter_id.is_none() || publication_id.is_none() {
        item["status"] = json!("blocked_no_publication");
        item["note"] = json!("无活跃定稿；批量记忆不会发明定稿");
        items.push(item);
        progress["items"] = Value::Array(items);
        progress["cursorChapter"] = json!(chapter + 1);
        progress["gate"] = if strict {
            json!("blocked_no_publication")
        } else {
            Value::Null
        };
        progress["modelCalls"] = json!(model_calls);
        let st = if strict { "paused_gate" } else { "running" };
        let err = if strict {
            Some("无活跃定稿；批量记忆不会发明定稿")
        } else {
            None
        };
        save_batch(db, batch_id, st, Some(chapter), &progress, &cost(model_calls), err)?;
        return load_row(db, book_id, batch_id);
    }

    if memory_state.as_deref() == Some("ready") {
        item["status"] = json!("ready");
        item["note"] = json!("记忆已就绪");
        items.push(item);
        progress["items"] = Value::Array(items);
        progress["cursorChapter"] = json!(chapter + 1);
        progress["gate"] = Value::Null;
        progress["modelCalls"] = json!(model_calls);
        let next = if chapter >= to { "done" } else { "running" };
        save_batch(
            db,
            batch_id,
            next,
            Some(if next == "done" { chapter } else { chapter + 1 }),
            &progress,
            &cost(model_calls),
            None,
        )?;
        return load_row(db, book_id, batch_id);
    }

    let pub_id = publication_id.clone().unwrap();
    let mut prop = open_proposal(db, book_id, &pub_id)?;
    if prop.is_none() && auto_extract {
        let body_id = body_revision_id.clone().unwrap_or_default();
        let summary = body_snippet(db, &body_id)?;
        let head = get_book_head(db, book_id)?;
        let epoch = head.get("storyEpoch").and_then(|v| v.as_i64()).unwrap_or(0);
        let ops = json!([{
            "operationId": format!("batch-summary-{chapter}"),
            "kind": "summary_update",
            "subjectId": format!("chapter:{chapter}"),
            "field": "chapter_summary",
            "proposedValue": { "text": summary },
            "assertionKind": "explicit",
            "evidence": { "quote": summary.chars().take(80).collect::<String>() },
            "requiresAuthorApproval": true
        }]);
        let created = create_memory_proposal(
            db,
            book_id,
            chapter,
            &body_id,
            &summary,
            Some(&pub_id),
            epoch,
            Some(ops.clone()),
        )?;
        model_calls += 1;
        let pid = created.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        prop = Some((pid.clone(), "proposed".into(), ops.to_string()));
        item["status"] = json!("extract_queued");
        item["proposalId"] = json!(pid);
        item["note"] = json!("已生成记忆提案（待作者批准）；未写正式事实");
    } else if prop.is_none() {
        item["status"] = json!("needs_extract");
        item["note"] = json!("记忆未就绪且未开启 autoExtract");
    }

    if let Some((pid, pstatus, ops_json)) = prop {
        item["proposalId"] = json!(pid);
        let ops: Value = serde_json::from_str(&ops_json).unwrap_or(json!([]));
        let majors: Vec<String> = ops
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| is_major_op(o))
            .map(|o| {
                o.get("operationId")
                    .and_then(|v| v.as_str())
                    .or_else(|| o.get("kind").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        item["majorOps"] = json!(majors);
        if pstatus == "proposed" && !majors.is_empty() && major_req {
            item["status"] = json!("needs_approval");
            item["note"] = json!(format!("重大变化待审批：{}", majors.join(",")));
            items.push(item.clone());
            progress["items"] = Value::Array(items);
            progress["cursorChapter"] = json!(chapter);
            progress["gate"] = json!("needs_approval");
            progress["modelCalls"] = json!(model_calls);
            let note = item.get("note").and_then(|v| v.as_str()).unwrap_or("");
            save_batch(
                db,
                batch_id,
                "paused_gate",
                Some(chapter),
                &progress,
                &cost(model_calls),
                Some(note),
            )?;
            return load_row(db, book_id, batch_id);
        }
    }

    if strict && item.get("status").and_then(|v| v.as_str()) != Some("ready") {
        items.push(item.clone());
        progress["items"] = Value::Array(items);
        progress["cursorChapter"] = json!(chapter);
        progress["gate"] = item.get("status").cloned().unwrap_or(json!("paused"));
        progress["modelCalls"] = json!(model_calls);
        let note = item
            .get("note")
            .and_then(|v| v.as_str())
            .unwrap_or("严格模式：记忆未就绪");
        save_batch(
            db,
            batch_id,
            "paused_gate",
            Some(chapter),
            &progress,
            &cost(model_calls),
            Some(note),
        )?;
        return load_row(db, book_id, batch_id);
    }

    items.push(item);
    progress["items"] = Value::Array(items);
    progress["cursorChapter"] = json!(chapter + 1);
    progress["gate"] = Value::Null;
    progress["modelCalls"] = json!(model_calls);
    let next = if chapter >= to { "done" } else { "running" };
    save_batch(
        db,
        batch_id,
        next,
        Some(if next == "done" { chapter } else { chapter + 1 }),
        &progress,
        &cost(model_calls),
        None,
    )?;
    load_row(db, book_id, batch_id)
}

pub fn get_memory_ready_batch(db: &Db, book_id: &str, batch_id: &str) -> AppResult<Value> {
    load_row(db, book_id, batch_id)
}

pub fn cancel_memory_ready_batch(db: &Db, book_id: &str, batch_id: &str) -> AppResult<Value> {
    let row = load_row(db, book_id, batch_id)?;
    if row.get("status").and_then(|v| v.as_str()) == Some("done") {
        return Ok(row);
    }
    let mut progress = row.get("progress").cloned().unwrap_or(json!({}));
    progress["gate"] = json!("cancelled");
    let cost = row.get("cost").cloned().unwrap_or(json!({}));
    save_batch(db, batch_id, "cancelled", None, &progress, &cost, Some("作者取消"))?;
    load_row(db, book_id, batch_id)
}

pub fn resume_memory_ready_batch(db: &Db, book_id: &str, batch_id: &str) -> AppResult<Value> {
    let row = load_row(db, book_id, batch_id)?;
    let status = row.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if matches!(status, "cancelled" | "done") {
        return Ok(row);
    }
    let mut progress = row.get("progress").cloned().unwrap_or(json!({}));
    let chapter = progress
        .get("cursorChapter")
        .and_then(|v| v.as_i64())
        .or_else(|| row.get("currentChapter").and_then(|v| v.as_i64()))
        .or_else(|| row.get("fromChapter").and_then(|v| v.as_i64()))
        .unwrap_or(1);
    let (_cid, _pid, memory_state, _) = chapter_meta(db, book_id, chapter)?;
    if memory_state.as_deref() == Some("ready") {
        if let Some(arr) = progress.get_mut("items").and_then(|v| v.as_array_mut()) {
            for item in arr.iter_mut().rev() {
                if item.get("chapterNumber").and_then(|v| v.as_i64()) == Some(chapter)
                    && item.get("status").and_then(|v| v.as_str()) == Some("needs_approval")
                {
                    item["status"] = json!("ready");
                    item["note"] = json!("作者已批准，记忆就绪");
                    item["memoryState"] = json!("ready");
                    break;
                }
            }
        }
        progress["cursorChapter"] = json!(chapter + 1);
        progress["gate"] = Value::Null;
        let cost = row.get("cost").cloned().unwrap_or(json!({}));
        save_batch(db, batch_id, "running", Some(chapter + 1), &progress, &cost, None)?;
    } else {
        progress["gate"] = Value::Null;
        let cost = row.get("cost").cloned().unwrap_or(json!({}));
        save_batch(db, batch_id, "running", None, &progress, &cost, None)?;
    }
    tick_memory_ready_batch(db, book_id, batch_id)
}

pub fn readonly_story_review(db: &Db, book_id: &str, chapter_number: Option<i64>) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        Ok(())
    })?;
    let mut findings = vec![
        json!({
            "id": "readonly",
            "level": "info",
            "message": "只读审查器：不改正文、不定稿、不批准提案；写回须走 StoryLedger。"
        }),
        json!({
            "id": "no_agent_orchestration",
            "level": "info",
            "message": "禁止无约束多 Agent 工具编排；本接口不注册 tools。"
        }),
    ];
    if let Some(n) = chapter_number.filter(|n| *n > 0) {
        let pc = publish_check(db, book_id, n)?;
        if let Some(checks) = pc.get("checks").and_then(|v| v.as_array()) {
            for c in checks {
                let level = c.get("level").and_then(|v| v.as_str()).unwrap_or("info");
                let pass = c.get("pass").and_then(|v| v.as_bool()).unwrap_or(false);
                let out = if level == "blocker" && !pass {
                    "blocker"
                } else if pass {
                    "info"
                } else {
                    "warn"
                };
                findings.push(json!({
                    "id": format!("publish:{}", c.get("id").and_then(|v| v.as_str()).unwrap_or("")),
                    "level": out,
                    "message": c.get("message").cloned().unwrap_or(json!("")),
                }));
            }
        }
        let chapter_id: Option<String> = db.with_conn(|conn| {
            conn.query_row(
                "SELECT id FROM chapters WHERE book_id = ?1 AND number = ?2",
                params![book_id, n],
                |r| r.get(0),
            )
            .optional()
            .map_err(AppError::from)
        })?;
        if let Some(cid) = chapter_id {
            let imp = story_impact(db, book_id, &cid)?;
            let facts = imp
                .pointer("/wouldInvalidate/facts")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let stale = imp
                .get("subsequentChaptersPossiblyStale")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let diverge = imp.get("draftDiverges").and_then(|v| v.as_bool()).unwrap_or(false);
            findings.push(json!({
                "id": "impact",
                "level": if diverge { "warn" } else { "info" },
                "message": format!("影响报告：将失效事实 {facts}，后章可能需复核 {stale}（不自动改正文）"),
            }));
        }
        let hooks_wrap = list_foreshadowing(db, book_id, Some(n))?;
        let hooks = hooks_wrap
            .get("hooks")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let open = hooks
            .iter()
            .filter(|h| {
                matches!(
                    h.get("status").and_then(|v| v.as_str()),
                    Some("planted") | Some("developed")
                )
            })
            .count();
        findings.push(json!({
            "id": "open_hooks",
            "level": if open > 0 { "warn" } else { "info" },
            "message": format!("未回收伏笔 {open}（计划回收≠已回收）"),
        }));
    } else {
        findings.push(json!({
            "id": "chapter",
            "level": "warn",
            "message": "未指定 chapterNumber，仅返回原则性说明"
        }));
    }
    Ok(json!({
        "writable": false,
        "agentOrchestration": false,
        "toolsRegistered": false,
        "chapterNumber": chapter_number,
        "findings": findings,
        "note": "专门审查器使用只读 Interface；任何写回仍走定稿 / 提案批准 / 幂等。",
    }))
}

pub fn refuse_agent_orchestration(body: &Value) -> AppResult<Value> {
    let asked = ["tools", "enableTools", "autonomous", "orchestration", "agents", "multiAgent"]
        .iter()
        .any(|k| !body.get(k).unwrap_or(&Value::Null).is_null());
    Err(AppError::Unprocessable(if asked {
        "拒绝无约束多 Agent / 工具编排。批量记忆与审查不得绕过定稿、版本、知识过滤、幂等与作者审批。写回请用 StoryLedger（finalize / proposals apply）。".into()
    } else {
        "墨兰写作不提供自主 Agent 编排接口。请使用场景写作、定稿与记忆提案审批。详见 docs/PI_RUNTIME.md 与 G5 说明。".into()
    }))
}
