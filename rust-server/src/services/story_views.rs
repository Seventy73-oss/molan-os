//! G5: derived views from the same authority tables (not a second store).
use rusqlite::params;
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::AppResult;
use crate::services::books::must_book;
use crate::services::story_state::{list_foreshadowing, list_story_characters, project_character_state};

fn relation_endpoint(value: &Value) -> Option<(String, String)> {
    match value {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some((t.to_string(), "related".into()))
            }
        }
        Value::Object(o) => {
            let target = o
                .get("targetId")
                .or_else(|| o.get("target"))
                .or_else(|| o.get("to"))
                .or_else(|| o.get("with"))
                .or_else(|| o.get("other"))
                .or_else(|| o.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if target.is_empty() {
                return None;
            }
            let label = o
                .get("type")
                .or_else(|| o.get("relation"))
                .or_else(|| o.get("kind"))
                .or_else(|| o.get("label"))
                .and_then(|v| v.as_str())
                .unwrap_or("related")
                .to_string();
            Some((target, label))
        }
        _ => None,
    }
}

pub fn story_relation_view(db: &Db, book_id: &str, as_of: Option<i64>) -> AppResult<Value> {
    let chars_wrap = list_story_characters(db, book_id, as_of)?;
    let characters = chars_wrap
        .get("characters")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut nodes: Vec<Value> = Vec::new();
    let mut node_ids = std::collections::HashSet::new();
    for c in &characters {
        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() || !node_ids.insert(id.clone()) {
            continue;
        }
        nodes.push(json!({
            "id": id,
            "label": c.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "kind": "character",
            "fromBible": true,
        }));
    }

    let mut edges: Vec<Value> = Vec::new();
    for c in &characters {
        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let projected = project_character_state(db, book_id, id, as_of, "author")?;
        let history = projected
            .get("history")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for h in history {
            if h.get("field").and_then(|v| v.as_str()) != Some("relation") {
                continue;
            }
            let Some(val) = h.get("value") else { continue };
            let Some((target, label)) = relation_endpoint(val) else { continue };
            if node_ids.insert(target.clone()) {
                nodes.push(json!({
                    "id": target,
                    "label": target,
                    "kind": "character_or_entity",
                    "fromBible": false,
                }));
            }
            edges.push(json!({
                "id": h.get("factId").cloned().unwrap_or(Value::String(String::new())),
                "source": id,
                "target": target,
                "label": label,
                "factId": h.get("factId").cloned().unwrap_or(Value::Null),
                "effectiveFromChapter": h.get("effectiveFromChapter").cloned().unwrap_or(Value::Null),
                "evidenceQuote": h.get("evidenceQuote").cloned().unwrap_or(Value::String(String::new())),
                "sourceRevisionId": h.get("sourceRevisionId").cloned().unwrap_or(Value::String(String::new())),
            }));
        }
    }

    Ok(json!({
        "authority": ["bible_cards", "story_facts"],
        "derived": true,
        "asOfChapter": as_of,
        "nodes": nodes,
        "edges": edges,
        "note": "关系图为派生视图；权威在 bible_cards / story_facts，不另建图库。",
    }))
}

pub fn story_timeline_view(db: &Db, book_id: &str, as_of: Option<i64>) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        let mut events: Vec<Value> = Vec::new();

        let mut stmt = conn.prepare(
            r#"SELECT p.id, p.body_revision_id, p.publication_version, p.memory_state, c.number
               FROM chapter_publications p
               JOIN chapters c ON c.id = p.chapter_id
               WHERE p.book_id = ?1 AND p.status = 'active'
               ORDER BY c.number ASC"#,
        )?;
        for row in stmt.query_map(params![book_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })? {
            let (id, body, ver, mem, ch) = row?;
            if let Some(n) = as_of {
                if ch > n {
                    continue;
                }
            }
            events.push(json!({
                "id": format!("pub:{id}"),
                "chapter": ch,
                "kind": "publication",
                "title": format!("第{ch}章定稿 v{ver}"),
                "detail": format!("memory={mem}"),
                "authorityTable": "chapter_publications",
                "refs": { "publicationId": id, "bodyRevisionId": body, "memoryState": mem },
            }));
        }

        let mut stmt = conn.prepare(
            r#"SELECT id, hook_stable_id, event_kind, description, planned_payoff_chapter,
                      effective_chapter, evidence_quote, source_revision_id, publication_id
               FROM hook_events WHERE book_id = ?1 AND status = 'active'
               ORDER BY effective_chapter ASC, created_at ASC"#,
        )?;
        for row in stmt.query_map(params![book_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })? {
            let (id, hook, kind, desc, planned, eff, quote, src, pub_id) = row?;
            if let Some(n) = as_of {
                if eff > n {
                    continue;
                }
            }
            let detail = if kind == "paid_off" {
                "已回收".into()
            } else if let Some(p) = planned {
                format!("计划约第{p}章回收（≠已回收）")
            } else {
                kind.clone()
            };
            events.push(json!({
                "id": format!("hook:{id}"),
                "chapter": eff,
                "kind": format!("foreshadow_{kind}"),
                "title": if desc.is_empty() { hook.clone() } else { desc },
                "detail": detail,
                "authorityTable": "hook_events",
                "refs": {
                    "hookStableId": hook,
                    "eventKind": kind,
                    "publicationId": pub_id,
                    "sourceRevisionId": src,
                    "evidenceQuote": quote,
                },
            }));
        }

        let mut stmt = conn.prepare(
            r#"SELECT id, subject, predicate, value_json, evidence_quote, effective_from_chapter,
                      kind, source_revision_id, publication_id
               FROM story_facts WHERE book_id = ?1 AND status = 'active'
               ORDER BY COALESCE(effective_from_chapter, 0) ASC, created_at ASC"#,
        )?;
        for row in stmt.query_map(params![book_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })? {
            let (id, subject, pred, val, quote, eff, kind, src, pub_id) = row?;
            let ch = eff.unwrap_or(0);
            if let Some(n) = as_of {
                if ch > n {
                    continue;
                }
            }
            if kind != "character_state" && pred != "relation" && pred != "location" {
                continue;
            }
            let detail = val.chars().take(200).collect::<String>();
            events.push(json!({
                "id": format!("fact:{id}"),
                "chapter": ch,
                "kind": format!("fact_{}", if pred.is_empty() { kind.clone() } else { pred.clone() }),
                "title": format!("{subject} · {pred}"),
                "detail": detail,
                "authorityTable": "story_facts",
                "refs": {
                    "factId": id,
                    "publicationId": pub_id,
                    "sourceRevisionId": src,
                    "evidenceQuote": quote,
                },
            }));
        }

        events.sort_by(|a, b| {
            let ca = a.get("chapter").and_then(|v| v.as_i64()).unwrap_or(0);
            let cb = b.get("chapter").and_then(|v| v.as_i64()).unwrap_or(0);
            ca.cmp(&cb).then_with(|| {
                let ia = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let ib = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                ia.cmp(ib)
            })
        });

        Ok(json!({
            "authority": ["chapter_publications", "hook_events", "story_facts", "story_knowledge_events"],
            "derived": true,
            "asOfChapter": as_of,
            "events": events,
            "note": "时间线按章节叙述顺序派生；复杂故事时间未建模。",
        }))
    })
}

pub fn story_hook_view(db: &Db, book_id: &str, as_of: Option<i64>) -> AppResult<Value> {
    let foreshadow = list_foreshadowing(db, book_id, as_of)?;
    let hooks = if foreshadow.is_array() {
        foreshadow
    } else {
        foreshadow.get("hooks").cloned().unwrap_or_else(|| json!([]))
    };
    Ok(json!({
        "authority": ["hook_events"],
        "derived": true,
        "asOfChapter": as_of,
        "hooks": hooks,
        "note": "伏笔视图与 /story/foreshadowing 同源；计划回收 ≠ 已回收。",
    }))
}
