//! Context assembly: bible cards, chapter memories (source-revision matched), open hooks,
//! ContextSnapshot persistence — G1 / F01.

use crate::db::{Db, now_iso};
use crate::error::AppResult;
use crate::services::books::must_book;
use crate::services::hooks::{format_open_hooks_for_context, list_hooks};

fn artifact_body(conn: &rusqlite::Connection, book_id: &str, kind: &str, chapter_number: Option<i64>) -> String {
    let n = chapter_number.unwrap_or(0);
    conn.query_row(
        r#"SELECT r.body AS body
           FROM artifacts a
           JOIN artifact_revisions r ON r.id = a.current_revision_id
           LEFT JOIN chapters c ON c.id = a.chapter_id
           WHERE a.book_id = ?1 AND a.kind = ?2 AND ifnull(c.number, 0) = ifnull(?3, 0)"#,
        rusqlite::params![book_id, kind, n],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_default()
}
use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MODE_LEGACY_CURRENT: &str = "legacy_current";
const MODE_PUBLISHED: &str = "published_only";

#[derive(Debug, Clone)]
pub struct BuiltContext {
    pub text: String,
    pub snapshot_id: String,
    pub mode: String,
    pub missing: Vec<String>,
    pub manifest: Value,
}

fn hash_text(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub fn format_bible_for_context(conn: &rusqlite::Connection, book_id: &str) -> AppResult<(String, Vec<Value>)> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, name, summary, details FROM bible_cards
         WHERE book_id = ?1 ORDER BY kind, sort_order ASC, created_at ASC",
    )?;
    let rows: Vec<(String, String, String, String, String)> = stmt
        .query_map(params![book_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<Result<_, _>>()?;
    let label = |kind: &str| -> String {
        match kind {
            "character" => "人物".into(),
            "prop" => "物件".into(),
            "place" => "地点".into(),
            other => other.to_string(),
        }
    };
    let mut lines = Vec::new();
    let mut included = Vec::new();
    for (id, kind, name, summary, details) in rows {
        let head = format!("{} · {}", label(&kind), name);
        let bits = [summary.as_str(), details.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("；");
        lines.push(if bits.is_empty() {
            head.clone()
        } else {
            format!("{head}：{bits}")
        });
        included.push(json!({
            "kind": "bible_card",
            "sourceId": id,
            "cardKind": kind,
            "name": name,
            "reason": "book_bible",
        }));
    }
    Ok((lines.join("\n"), included))
}

/// Memories for chapters before `before_chapter`, only when source_revision matches
/// current chapter_body revision, or legacy (no source_revision) marked as legacy_current.
pub fn format_memories_for_context(
    conn: &rusqlite::Connection,
    book_id: &str,
    before_chapter: Option<i64>,
) -> AppResult<(String, Vec<Value>, Vec<Value>)> {
    let Some(before) = before_chapter.filter(|n| *n > 1) else {
        return Ok((String::new(), vec![], vec![]));
    };
    let mut stmt = conn.prepare(
        r#"SELECT c.number AS number, c.title AS title, r.body AS body,
                  r.id AS memory_revision_id, r.source_revision_id AS source_revision_id,
                  body_a.current_revision_id AS body_current_id,
                  pub.body_revision_id AS published_body_id
           FROM chapters c
           JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = 'chapter_memory'
           JOIN artifact_revisions r ON r.id = a.current_revision_id
           LEFT JOIN artifacts body_a ON body_a.book_id = c.book_id AND body_a.chapter_id = c.id AND body_a.kind = 'chapter_body'
           LEFT JOIN chapter_publications pub ON pub.book_id = c.book_id AND pub.chapter_id = c.id AND pub.status = 'active'
           WHERE c.book_id = ?1 AND c.number < ?2
           ORDER BY c.number"#,
    )?;
    let rows: Vec<(i64, String, String, String, Option<String>, Option<String>, Option<String>)> = stmt
        .query_map(params![book_id, before], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<Result<_, _>>()?;

    let mut lines = Vec::new();
    let mut included = Vec::new();
    let mut excluded = Vec::new();
    for (number, title, body, mem_rev, source_rev, body_current, published_body) in rows {
        if body.trim().is_empty() {
            continue;
        }
        let source = source_rev.unwrap_or_default();
        if source.is_empty() {
            if published_body.is_some() {
                excluded.push(json!({
                    "kind": "chapter_summary",
                    "sourceId": mem_rev,
                    "chapterNumber": number,
                    "reason": "legacy_excluded_under_publication",
                }));
                continue;
            }
            lines.push(format!("第{number}章《{title}》〔legacy_current〕\n{body}"));
            included.push(json!({
                "kind": "chapter_summary",
                "sourceId": mem_rev,
                "chapterNumber": number,
                "mode": MODE_LEGACY_CURRENT,
                "reason": "legacy_current",
            }));
            continue;
        }
        let target = published_body.as_ref().or(body_current.as_ref());
        let body_ok = target.map(|s| s.as_str()) == Some(source.as_str());
        if body_ok {
            let reason = if published_body.is_some() {
                "previous_publication"
            } else {
                "source_matched"
            };
            lines.push(format!("第{number}章《{title}》\n{body}"));
            included.push(json!({
                "kind": "chapter_summary",
                "sourceId": mem_rev,
                "sourceRevisionId": source,
                "chapterNumber": number,
                "reason": reason,
                "mode": if published_body.is_some() { MODE_PUBLISHED } else { MODE_LEGACY_CURRENT },
            }));
        } else {
            excluded.push(json!({
                "kind": "chapter_summary",
                "sourceId": mem_rev,
                "sourceRevisionId": source,
                "bodyCurrentId": body_current,
                "publishedBodyId": published_body,
                "chapterNumber": number,
                "reason": "superseded_source",
            }));
        }
    }
Ok((lines.join("\n\n"), included, excluded))
}

pub fn format_open_hooks_bundle(
    db: &Db,
    book_id: &str,
    before_chapter: Option<i64>,
) -> AppResult<(String, Vec<Value>)> {
    let text = format_open_hooks_for_context(db, book_id, before_chapter)?;
    let hooks = list_hooks(db, book_id)?;
    let mut included = Vec::new();
    for h in hooks {
        let warning = h.get("warning").and_then(|v| v.as_bool()).unwrap_or(false);
        let status = h.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if !(warning || status == "open") {
            continue;
        }
        let from = h.get("fromChapter").and_then(|v| v.as_i64()).unwrap_or(0);
        if let Some(before) = before_chapter {
            if from >= before {
                continue;
            }
        }
        included.push(json!({
            "kind": "open_hook",
            "sourceId": h.get("key"),
            "fromChapter": from,
            "reason": "active_hook",
            "qualification": "legacy_unverified",
        }));
    }
    Ok((text, included))
}

fn missing_hints(
    bible_count: usize,
    memory_count: usize,
    open_hook_count: usize,
    chapter_number: Option<i64>,
) -> Vec<String> {
    let mut missing = Vec::new();
    if bible_count == 0 {
        missing.push("设定卡为空：生成时缺少人物/物件/地点约束".into());
    }
    if chapter_number.map(|n| n > 1).unwrap_or(false) && memory_count == 0 {
        missing.push("前文记忆缺失或源版本不匹配：续写可能丢连续性".into());
    }
    if open_hook_count > 0 {
        missing.push(format!("有 {open_hook_count} 条未回收钩子待接住"));
    }
    missing
}

/// Build the full context string + optional snapshot persistence.
pub fn build_context_bundle(
    db: &Db,
    book_id: &str,
    chapter_number: Option<i64>,
    instruction: &str,
    scene: Option<&str>,
    generation_id: Option<&str>,
    persist: bool,
) -> AppResult<BuiltContext> {
    let mode = db.with_conn(|conn| {
        must_book(conn, book_id)?;
        Ok(
            if crate::services::story::book_has_any_publication(conn, book_id) {
                MODE_PUBLISHED.to_string()
            } else {
                MODE_LEGACY_CURRENT.to_string()
            },
        )
    })?;
    let (bible, bible_inc) = db.with_conn(|conn| {
        must_book(conn, book_id)?;
        format_bible_for_context(conn, book_id)
    })?;
    let (memories, mem_inc, mem_exc) = db.with_conn(|conn| {
        format_memories_for_context(conn, book_id, chapter_number)
    })?;
    let (hooks_text, hook_inc) = format_open_hooks_bundle(db, book_id, chapter_number)?;

    let book_bits = db.with_conn(|conn| {
        let book = must_book(conn, book_id)?;
        let mut stmt = conn.prepare(
            "SELECT number, title FROM chapters WHERE book_id = ?1 ORDER BY number",
        )?;
        let chapters: Vec<(i64, String)> = stmt
            .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let current = chapter_number.and_then(|n| chapters.iter().find(|(num, _)| *num == n));
        let prev = if let Some(n) = chapter_number {
            if n > 1 {
                artifact_body(conn, book_id, "chapter_body", Some(n - 1))
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let tail: String = prev.chars().rev().take(800).collect::<Vec<_>>().into_iter().rev().collect();
        let chapter_list = chapters
            .iter()
            .map(|(n, t)| format!("{n}. {t}"))
            .collect::<Vec<_>>()
            .join("\n");
        Ok((
            book,
            chapter_list,
            current.map(|(n, t)| (*n, t.clone())),
            tail,
            artifact_body(conn, book_id, "book_profile", None),
            artifact_body(conn, book_id, "book_outline", None),
            current
                .map(|(n, _)| artifact_body(conn, book_id, "chapter_outline", Some(*n)))
                .unwrap_or_default(),
            current
                .map(|(n, _)| artifact_body(conn, book_id, "chapter_body", Some(*n)))
                .unwrap_or_default(),
        ))
    })?;

    let (book, chapter_list, current, tail, profile, outline, ch_outline, ch_body) = book_bits;
    let hard = crate::services::hard_constraints::format_section(db, book_id)?;
    let hard_head: Vec<String> = if hard.is_empty() { vec![] } else { vec!["【硬约束】".into(), hard] };
    let text = hard_head.into_iter().chain([
        "【书】".to_string(),
        format!("书名：{}", book.title),
        format!("题材：{}", book.genre),
        format!("简介：{}", book.logline),
        format!("文风：{}", book.style),
        format!("目标章数：{}", book.target_chapters),
        format!("每章字数：{}", book.words_per_chapter),
        "【档案】".into(),
        profile,
        "【设定卡】".into(),
        bible.clone(),
        "【章目】".into(),
        chapter_list,
        "【全书大纲】".into(),
        outline,
        "【前文记忆】".into(),
        memories.clone(),
        "【未回收钩子】".into(),
        hooks_text.clone(),
        "【本章】".into(),
        current
            .as_ref()
            .map(|(n, t)| format!("章号：{n}\n章名：{t}"))
            .unwrap_or_default(),
        "【本章细纲】".into(),
        ch_outline,
        "【本章正文】".into(),
        ch_body,
        "【上章结尾】".into(),
        tail,
        "【作者指令】".into(),
        instruction.to_string(),
    ])
    .collect::<Vec<String>>()
    .join("\n");

    let missing = missing_hints(bible_inc.len(), mem_inc.len(), hook_inc.len(), chapter_number);
    let mut included = bible_inc;
    included.extend(mem_inc);
    included.extend(hook_inc);
    let manifest = json!({
        "mode": mode,
        "chapterNumber": chapter_number,
        "scene": scene,
        "included": included,
        "excluded": mem_exc,
        "missing": missing.clone(),
        "counts": {
            "bibleCards": bible.lines().filter(|l| !l.is_empty()).count(),
            "memories": if memories.trim().is_empty() { 0 } else { memories.split("\n\n").filter(|s| !s.trim().is_empty()).count() },
            "openHooks": hooks_text.lines().filter(|l| !l.is_empty()).count(),
        },
        "note": "G2：有活跃定稿时按 publication 匹配记忆；否则 legacy_current",
    });

    let snapshot_id = Uuid::new_v4().to_string();
    let rendered_hash = hash_text(&text);
    if persist {
        let ts = now_iso();
        let scene_s = scene.unwrap_or("").to_string();
        let gen = generation_id.map(|s| s.to_string());
        let manifest_s = manifest.to_string();
        db.with_conn(|conn| {
            conn.execute(
                r#"INSERT INTO context_snapshots
                   (id, book_id, scene, chapter_number, mode, rendered_text, rendered_hash, manifest_json, generation_id, created_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
                params![
                    snapshot_id,
                    book_id,
                    scene_s,
                    chapter_number,
                    mode,
                    text,
                    rendered_hash,
                    manifest_s,
                    gen,
                    ts,
                ],
            )?;
            Ok(())
        })?;
    }

    Ok(BuiltContext {
        text,
        snapshot_id,
        mode: mode.clone(),
        missing,
        manifest,
    })
}

pub fn preview_context(db: &Db, book_id: &str, chapter_number: Option<i64>) -> AppResult<Value> {
    let built = build_context_bundle(db, book_id, chapter_number, "", Some("preview"), None, false)?;
    // Extract section bodies for UI without full dump of secrets in logs — return summaries.
    let bible = section_after(&built.text, "【设定卡】", "【章目】");
    let memories = section_after(&built.text, "【前文记忆】", "【未回收钩子】");
    let hooks = section_after(&built.text, "【未回收钩子】", "【本章】");
    let sections = json!({
            "bible": bible,
            "memories": memories,
            "openHooks": hooks,
        });
    let preview = json!({
        "mode": built.mode,
        "chapterNumber": chapter_number,
        "missing": built.missing,
        "manifest": built.manifest,
        "sections": sections,
        "renderedHash": hash_text(&built.text),
        "charCount": built.text.chars().count(),
    });
    let budget = crate::services::story_pack::estimate_context_budget(&preview);
    let mut out = preview;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("budgetEstimate".into(), budget);
    }
    Ok(out)
}

fn section_after(text: &str, start: &str, end: &str) -> String {
    let Some(i) = text.find(start) else {
        return String::new();
    };
    let after = &text[i + start.len()..];
    let body = if let Some(j) = after.find(end) {
        &after[..j]
    } else {
        after
    };
    body.trim().to_string()
}
