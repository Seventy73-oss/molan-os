//! G3: character dynamic state, hook events, knowledge filter, republish impact.

use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::books::must_book;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn overwrite_field(f: &str) -> bool {
    matches!(f, "location" | "injury" | "goal")
}
fn accumulate_field(f: &str) -> bool {
    matches!(f, "inventory" | "relation" | "knows_fact")
}
fn character_field(f: &str) -> bool {
    overwrite_field(f) || accumulate_field(f)
}


#[derive(Clone, Debug)]
struct FactRow {
    id: String,
    subject: String,
    predicate: String,
    value_json: String,
    evidence_quote: String,
    source_revision_id: String,
    publication_id: Option<String>,
    effective_from_chapter: Option<i64>,
    kind: String,
    audience: String,
    character_id: Option<String>,
}

fn list_active_facts(conn: &Connection, book_id: &str, as_of: Option<i64>) -> AppResult<Vec<FactRow>> {
    let mut stmt = conn.prepare(
        r#"SELECT id, subject, predicate, value_json, evidence_quote, source_revision_id,
                  publication_id, effective_from_chapter,
                  COALESCE(kind, 'generic'), COALESCE(audience, 'author'), character_id
           FROM story_facts WHERE book_id = ?1 AND status = 'active'
           ORDER BY COALESCE(effective_from_chapter, 0) ASC, created_at ASC"#,
    )?;
    let rows = stmt
        .query_map(params![book_id], |r| {
            Ok(FactRow {
                id: r.get(0)?,
                subject: r.get(1)?,
                predicate: r.get(2)?,
                value_json: r.get(3)?,
                evidence_quote: r.get(4)?,
                source_revision_id: r.get(5)?,
                publication_id: r.get(6)?,
                effective_from_chapter: r.get(7)?,
                kind: r.get(8)?,
                audience: r.get(9)?,
                character_id: r.get(10)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(match as_of {
        Some(n) => rows
            .into_iter()
            .filter(|f| f.effective_from_chapter.unwrap_or(0) < n)
            .collect(),
        None => rows,
    })
}

fn filter_by_knowledge(
    conn: &Connection,
    book_id: &str,
    facts: Vec<FactRow>,
    mode: &str,
    as_of: Option<i64>,
    viewpoint: Option<&str>,
) -> AppResult<(Vec<FactRow>, Vec<Value>)> {
    if mode == "author" {
        return Ok((facts, vec![]));
    }
    let mut stmt = conn.prepare(
        r#"SELECT fact_id, audience, character_id, revealed_at_chapter
           FROM story_knowledge_events WHERE book_id = ?1 AND status = 'active'"#,
    )?;
    let events: Vec<(String, String, Option<String>, i64)> = stmt
        .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut allowed = Vec::new();
    let mut excluded = Vec::new();
    for fact in facts {
        let audience = if fact.audience.is_empty() {
            "author"
        } else {
            fact.audience.as_str()
        };
        let ok = if mode == "reader" {
            if audience == "reader" {
                true
            } else {
                events.iter().any(|(fid, aud, _, rev)| {
                    fid == &fact.id
                        && aud == "reader"
                        && as_of.map(|n| *rev < n).unwrap_or(true)
                })
            }
        } else {
            // character
            let Some(cid) = viewpoint else {
                excluded.push(json!({"sourceId": fact.id, "reason": "knowledge_gate"}));
                continue;
            };
            if fact.character_id.as_deref() == Some(cid) && audience != "author" {
                true
            } else {
                events.iter().any(|(fid, aud, ch, rev)| {
                    fid == &fact.id
                        && aud == "character"
                        && ch.as_deref() == Some(cid)
                        && as_of.map(|n| *rev < n).unwrap_or(true)
                })
            }
        };
        if ok {
            allowed.push(fact);
        } else {
            excluded.push(json!({"sourceId": fact.id, "reason": "knowledge_gate"}));
        }
    }
    Ok((allowed, excluded))
}

pub fn project_character_state(
    db: &Db,
    book_id: &str,
    character_id: &str,
    as_of: Option<i64>,
    knowledge_mode: &str,
) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let facts: Vec<FactRow> = list_active_facts(conn, book_id, as_of)?
            .into_iter()
            .filter(|f| {
                f.subject == character_id
                    && (f.kind == "character_state" || character_field(&f.predicate))
            })
            .collect();
        let (allowed, excluded) = filter_by_knowledge(
            conn,
            book_id,
            facts,
            knowledge_mode,
            as_of,
            Some(character_id),
        )?;
        let mut dynamic = Map::new();
        let mut inventory = Vec::new();
        let mut relations = Vec::new();
        let mut knows = Vec::new();
        let mut history = Vec::new();
        for f in &allowed {
            let value: Value = serde_json::from_str(&f.value_json).unwrap_or(json!({"raw": f.value_json}));
            history.push(json!({
                "factId": f.id,
                "field": f.predicate,
                "value": value,
                "effectiveFromChapter": f.effective_from_chapter,
                "evidenceQuote": f.evidence_quote,
                "sourceRevisionId": f.source_revision_id,
                "audience": f.audience,
            }));
            if overwrite_field(&f.predicate) {
                dynamic.insert(f.predicate.clone(), value);
            } else if f.predicate == "inventory" {
                inventory.push(value);
                dynamic.insert("inventory".into(), Value::Array(inventory.clone()));
            } else if f.predicate == "relation" {
                relations.push(value);
                dynamic.insert("relations".into(), Value::Array(relations.clone()));
            } else if f.predicate == "knows_fact" {
                knows.push(value);
                dynamic.insert("knows".into(), Value::Array(knows.clone()));
            } else {
                dynamic.insert(f.predicate.clone(), value);
            }
        }
        let card: Option<(String, String, String, String)> = conn
            .query_row(
                "SELECT id, name, summary, details FROM bible_cards WHERE id = ?1 AND book_id = ?2 AND kind = 'character'",
                params![character_id, book_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        Ok(json!({
            "characterId": character_id,
            "asOfChapter": as_of,
            "knowledgeMode": knowledge_mode,
            "static": card.map(|(id, name, summary, details)| json!({
                "id": id, "name": name, "summary": summary, "details": details
            })),
            "dynamic": Value::Object(dynamic),
            "history": history,
            "excluded": excluded,
        }))
    })
}

pub fn list_story_characters(db: &Db, book_id: &str, as_of: Option<i64>) -> AppResult<Value> {
    let chars: Vec<(String, String, String)> = db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, summary FROM bible_cards WHERE book_id = ?1 AND kind = 'character' ORDER BY sort_order, name",
        )?;
        let mut chars: Vec<(String, String, String)> = stmt
            .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt2 = conn.prepare(
            r#"SELECT DISTINCT subject FROM story_facts
               WHERE book_id = ?1 AND status = 'active'
                 AND (kind = 'character_state' OR predicate IN ('location','injury','goal','inventory','relation','knows_fact'))"#,
        )?;
        for s in stmt2.query_map(params![book_id], |r| r.get::<_, String>(0))? {
            let s = s?;
            if s.is_empty() || chars.iter().any(|(id, _, _)| id == &s) {
                continue;
            }
            chars.push((s.clone(), s, String::new()));
        }
        Ok(chars)
    })?;
    let mut out = Vec::new();
    for (id, name, summary) in chars {
        let projected = project_character_state(db, book_id, &id, as_of, "author")?;
        out.push(json!({
            "id": id,
            "name": name,
            "summary": summary,
            "asOfChapter": as_of,
            "dynamic": projected.get("dynamic").cloned().unwrap_or(json!({})),
        }));
    }
    Ok(json!({ "characters": out }))
}

pub fn list_foreshadowing(db: &Db, book_id: &str, as_of: Option<i64>) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let mut stmt = conn.prepare(
            r#"SELECT id, hook_stable_id, event_kind, description, planned_payoff_chapter,
                      source_revision_id, publication_id, evidence_quote, effective_chapter
               FROM hook_events WHERE book_id = ?1 AND status = 'active'
               ORDER BY effective_chapter ASC, created_at ASC"#,
        )?;
        let rows: Vec<(String, String, String, String, Option<i64>, Option<String>, Option<String>, String, i64)> = stmt
            .query_map(params![book_id], |r| {
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
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let filtered: Vec<_> = match as_of {
            Some(n) => rows.into_iter().filter(|r| r.8 < n).collect(),
            None => rows,
        };
        let mut map: Map<String, Value> = Map::new();
        for (id, hook, kind, desc, planned, src, pub_id, quote, eff) in filtered {
            let entry = map.entry(hook.clone()).or_insert_with(|| {
                json!({
                    "hookStableId": hook,
                    "description": desc,
                    "status": "planned",
                    "plannedPayoffChapter": planned,
                    "plantedChapter": Value::Null,
                    "paidOffChapter": Value::Null,
                    "events": [],
                })
            });
            if let Some(obj) = entry.as_object_mut() {
                if !desc.is_empty() {
                    obj.insert("description".into(), json!(desc));
                }
                if let Some(p) = planned {
                    obj.insert("plannedPayoffChapter".into(), json!(p));
                }
                if let Some(arr) = obj.get_mut("events").and_then(|v| v.as_array_mut()) {
                    arr.push(json!({
                        "id": id,
                        "eventKind": kind,
                        "effectiveChapter": eff,
                        "evidenceQuote": quote,
                        "sourceRevisionId": src,
                        "publicationId": pub_id,
                    }));
                }
                match kind.as_str() {
                    "planned" => {
                        obj.insert("status".into(), json!("planned"));
                    }
                    "planted" => {
                        obj.insert("status".into(), json!("planted"));
                        obj.insert("plantedChapter".into(), json!(eff));
                    }
                    "developed" => {
                        obj.insert("status".into(), json!("developed"));
                    }
                    "paid_off" => {
                        obj.insert("status".into(), json!("paid_off"));
                        obj.insert("paidOffChapter".into(), json!(eff));
                    }
                    "abandoned" => {
                        obj.insert("status".into(), json!("abandoned"));
                    }
                    _ => {}
                }
            }
        }
        let hooks: Vec<Value> = map.into_values().collect();
        Ok(json!({ "hooks": hooks }))
    })
}

pub fn story_impact(db: &Db, book_id: &str, chapter_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let chapter: (String, i64) = conn
            .query_row(
                "SELECT id, number FROM chapters WHERE id = ?1 AND book_id = ?2",
                params![chapter_id, book_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AppError::NotFound("章节不存在".into()))?;
        let pub_row: Option<(String, String, i64, String)> = conn
            .query_row(
                r#"SELECT id, body_revision_id, publication_version, memory_state
                   FROM chapter_publications WHERE book_id = ?1 AND chapter_id = ?2 AND status = 'active'"#,
                params![book_id, chapter_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let mut facts = Vec::new();
        let mut hooks = Vec::new();
        let mut knowledge_n = 0i64;
        if let Some((pid, _, _, _)) = &pub_row {
            let mut stmt = conn.prepare(
                "SELECT id, subject, predicate, effective_from_chapter, COALESCE(kind,'generic') FROM story_facts WHERE publication_id = ?1 AND status = 'active'",
            )?;
            facts = stmt
                .query_map(params![pid], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "subject": r.get::<_, String>(1)?,
                        "predicate": r.get::<_, String>(2)?,
                        "effectiveFromChapter": r.get::<_, Option<i64>>(3)?,
                        "kind": r.get::<_, String>(4)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut stmt2 = conn.prepare(
                "SELECT id, hook_stable_id, event_kind, effective_chapter FROM hook_events WHERE publication_id = ?1 AND status = 'active'",
            )?;
            hooks = stmt2
                .query_map(params![pid], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "hookStableId": r.get::<_, String>(1)?,
                        "eventKind": r.get::<_, String>(2)?,
                        "effectiveChapter": r.get::<_, i64>(3)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            knowledge_n = conn.query_row(
                "SELECT COUNT(*) FROM story_knowledge_events WHERE publication_id = ?1 AND status = 'active'",
                params![pid],
                |r| r.get(0),
            )?;
        }
        let mut stmt = conn.prepare(
            r#"SELECT p.id, c.number, p.memory_state FROM chapter_publications p
               JOIN chapters c ON c.id = p.chapter_id
               WHERE p.book_id = ?1 AND p.status = 'active' AND c.number > ?2 ORDER BY c.number"#,
        )?;
        let subsequent: Vec<Value> = stmt
            .query_map(params![book_id, chapter.1], |r| {
                Ok(json!({
                    "publicationId": r.get::<_, String>(0)?,
                    "chapterNumber": r.get::<_, i64>(1)?,
                    "memoryState": r.get::<_, String>(2)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let current: Option<String> = conn
            .query_row(
                "SELECT current_revision_id FROM artifacts WHERE book_id = ?1 AND chapter_id = ?2 AND kind = 'chapter_body'",
                params![book_id, chapter_id],
                |r| r.get(0),
            )
            .optional()?;
        let draft_diverges = matches!(
            (&pub_row, &current),
            (Some((_, body, _, _)), Some(cur)) if body != cur
        );
        Ok(json!({
            "bookId": book_id,
            "chapterId": chapter_id,
            "chapterNumber": chapter.1,
            "activePublication": pub_row.as_ref().map(|(id, body, ver, mem)| json!({
                "id": id,
                "bodyRevisionId": body,
                "publicationVersion": ver,
                "memoryState": mem,
            })),
            "currentBodyRevisionId": current,
            "draftDiverges": draft_diverges,
            "wouldInvalidate": {
                "facts": facts,
                "hookEvents": hooks,
                "knowledgeEvents": knowledge_n,
            },
            "subsequentChaptersPossiblyStale": subsequent,
            "pendingProposals": [],
            "note": "替换定稿会立即失效本章旧来源事实/钩子事件；不会自动改写后章正文。后章仅标记可能需复核。",
            "autoRewriteSubsequentBodies": false,
        }))
    })
}

pub fn invalidate_knowledge_and_hooks(tx: &Connection, publication_id: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE story_knowledge_events SET status = 'invalidated' WHERE publication_id = ?1 AND status = 'active'",
        params![publication_id],
    )?;
    tx.execute(
        "UPDATE hook_events SET status = 'invalidated' WHERE publication_id = ?1 AND status = 'active'",
        params![publication_id],
    )?;
    Ok(())
}

pub fn enrich_accepted_operations(
    tx: &Connection,
    book_id: &str,
    chapter_number: i64,
    source_revision_id: &str,
    publication_id: Option<&str>,
    accepted_ops: &[Value],
    fact_ids_by_op: &[(String, String)],
) -> AppResult<()> {
    let now = now_iso();
    let lookup = |op_id: &str| -> Option<String> {
        fact_ids_by_op
            .iter()
            .find(|(k, _)| k == op_id)
            .map(|(_, v)| v.clone())
    };
    for op in accepted_ops {
        let op_id = op.get("operationId").and_then(|v| v.as_str()).unwrap_or("");
        let Some(fact_id) = lookup(op_id) else {
            continue;
        };
        let kind = op.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let field = op.get("field").and_then(|v| v.as_str()).unwrap_or("");
        let subject = op.get("subjectId").and_then(|v| v.as_str()).unwrap_or("");
        let audience = op
            .get("audience")
            .and_then(|v| v.as_str())
            .unwrap_or("author");
        let character_id = op
            .get("characterId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                if kind == "character_state_change" {
                    Some(subject.to_string())
                } else {
                    None
                }
            });
        let fact_kind = if kind == "character_state_change" || character_field(field) {
            "character_state"
        } else if kind.starts_with("foreshadow_") {
            "foreshadow"
        } else if kind == "summary_update" {
            "summary"
        } else {
            "generic"
        };
        let pred = if field.is_empty() { kind } else { field };
        tx.execute(
            "UPDATE story_facts SET kind = ?1, audience = ?2, character_id = ?3, predicate = COALESCE(NULLIF(predicate,''), ?4) WHERE id = ?5",
            params![fact_kind, audience, character_id, pred, fact_id],
        )?;
        tx.execute(
            r#"INSERT INTO story_knowledge_events
                (id, book_id, fact_id, audience, character_id, revealed_at_chapter,
                 source_revision_id, publication_id, status, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9)"#,
            params![
                Uuid::new_v4().to_string(),
                book_id,
                fact_id,
                audience,
                character_id,
                chapter_number,
                source_revision_id,
                publication_id,
                now
            ],
        )?;
        if kind.starts_with("foreshadow_") {
            let event_kind = kind.strip_prefix("foreshadow_").unwrap_or("planted");
            let normalized = match event_kind {
                "planned" | "planted" | "developed" | "paid_off" | "abandoned" => event_kind,
                _ => "planted",
            };
            let proposed = op.get("proposedValue").cloned().unwrap_or(json!({}));
            let description = proposed
                .get("description")
                .and_then(|v| v.as_str())
                .or_else(|| op.pointer("/evidence/quote").and_then(|v| v.as_str()))
                .unwrap_or(subject)
                .to_string();
            let planned = proposed
                .get("plannedPayoffChapter")
                .and_then(|v| v.as_i64())
                .or_else(|| op.get("plannedPayoffChapter").and_then(|v| v.as_i64()));
            let hook_stable = if subject.is_empty() {
                format!("hook:{chapter_number}:{}", description.chars().take(40).collect::<String>())
            } else {
                subject.to_string()
            };
            let quote = op
                .pointer("/evidence/quote")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            tx.execute(
                r#"INSERT INTO hook_events
                    (id, book_id, hook_stable_id, event_kind, description, planned_payoff_chapter,
                     source_revision_id, publication_id, evidence_quote, effective_chapter, status, created_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11)"#,
                params![
                    Uuid::new_v4().to_string(),
                    book_id,
                    hook_stable,
                    normalized,
                    description,
                    planned,
                    source_revision_id,
                    publication_id,
                    quote,
                    chapter_number,
                    now
                ],
            )?;
            if normalized == "paid_off" {
                let hook_key = if hook_stable.contains(':') {
                    hook_stable.clone()
                } else {
                    format!(
                        "{chapter_number}:{}",
                        description.chars().take(120).collect::<String>()
                    )
                };
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT id FROM hook_marks WHERE book_id = ?1 AND hook_key = ?2",
                        params![book_id, hook_key],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(eid) = existing {
                    tx.execute(
                        "UPDATE hook_marks SET status = 'recycled', recycled_chapter = ?1, note = ?2, updated_at = ?3 WHERE id = ?4",
                        params![chapter_number, "from hook_events paid_off", now, eid],
                    )?;
                } else {
                    tx.execute(
                        r#"INSERT INTO hook_marks (id, book_id, hook_key, status, recycled_chapter, note, updated_at)
                           VALUES (?1, ?2, ?3, 'recycled', ?4, ?5, ?6)"#,
                        params![
                            Uuid::new_v4().to_string(),
                            book_id,
                            hook_key,
                            chapter_number,
                            "from hook_events paid_off",
                            now
                        ],
                    )?;
                }
            }
        }
    }
    Ok(())
}

pub fn snapshot_bible_card(
    conn: &Connection,
    card_id: &str,
    book_id: &str,
    kind: &str,
    name: &str,
    summary: &str,
    details: &str,
) -> AppResult<String> {
    let content = format!("{kind}\n{name}\n{summary}\n{details}");
    let hash = hex::encode(Sha256::digest(content.as_bytes()));
    conn.execute(
        r#"INSERT INTO bible_card_revisions
            (id, card_id, book_id, content_hash, kind, name, summary, details, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
        params![
            Uuid::new_v4().to_string(),
            card_id,
            book_id,
            hash,
            kind,
            name,
            summary,
            details,
            now_iso()
        ],
    )?;
    Ok(hash)
}
