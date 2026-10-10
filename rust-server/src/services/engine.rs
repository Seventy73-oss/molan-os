//! executeScene / chat / rewriteSelection / buildContext — Node engine subset.

use crate::agent::local_draft::{normalize_dialogue_quotes, rewrite_selection_local};
use crate::agent::runtime::get_adapter;
use crate::agent::{RunInput, SkillText, scene_kind, throw_if_cancelled};
use crate::db::{Db, now_iso};
use crate::error::{AppError, AppResult};
use crate::services::books::must_book;
use crate::services::generations::{
    GenerationStatus, begin_generation, complete_generation, demote_cancelled_result_revision,
    get_generation, link_generation_result_revision,
};
use crate::services::revisions::{OnConflict, SaveRevisionInput, current_revision_id_for, field_of, save_revision, titles_from};
use crate::services::scene_routes::route_for;
use crate::services::skills::{
    is_user_pack, skill_prompt_meta, skill_prompt_text, skills_for_scene, user_pack_default_max,
};
use crate::thinking::normalize_thinking;
use regex::Regex;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

fn cn_number(token: &str) -> Option<i64> {
    if token.chars().all(|c| c.is_ascii_digit()) {
        return token.parse().ok();
    }
    let map: &[(&str, i64)] = &[
        ("零", 0), ("一", 1), ("二", 2), ("两", 2), ("三", 3), ("四", 4),
        ("五", 5), ("六", 6), ("七", 7), ("八", 8), ("九", 9),
    ];
    let digit = |s: &str| map.iter().find(|(k, _)| *k == s).map(|(_, v)| *v);
    if token == "十" {
        return Some(10);
    }
    if let Some(rest) = token.strip_prefix("十") {
        return Some(10 + digit(rest).unwrap_or(0));
    }
    if let Some(idx) = token.find('十') {
        let hi = digit(&token[..idx]).unwrap_or(1);
        let lo = &token[idx + '十'.len_utf8()..];
        return Some(hi * 10 + if lo.is_empty() { 0 } else { digit(lo).unwrap_or(0) });
    }
    digit(token)
}

pub fn parse_chapter_mention(text: &str) -> Option<i64> {
    let re = Regex::new(r"第\s*(\d+|[一二三四五六七八九十两]+)\s*章").ok()?;
    let c = re.captures(text)?;
    cn_number(c.get(1)?.as_str())
}

pub fn route_message(message: &str) -> Option<&'static str> {
    let text = message.trim();
    if text.is_empty() {
        return None;
    }
    let neg = Regex::new(r"(不要|别|禁止|无需|不用|别再|先别|不要再).{0,12}(写|生成|重写|续写|起草|扩写|审核|润色|去\s*AI)").unwrap();
    if neg.is_match(text) {
        return None;
    }
    let howto = Regex::new(r"(怎么|如何|怎样).{0,8}(写|生成)|(写|生成).{0,8}(怎么|如何|怎样)").unwrap();
    if howto.is_match(text) {
        return None;
    }
    let asks = Regex::new(r"[？?]\s*$").unwrap().is_match(text);
    let orders = Regex::new(
        r"(写|生成|重写|续写|起草|扩写).{0,16}(大纲|细纲|正文|档案|设定|审核)|(大纲|细纲|正文|档案|设定).{0,10}(写|生成|重写|续写|起草|扩写)",
    )
    .unwrap()
    .is_match(text);
    let chapter_write = Regex::new(
        r"(写|生成|重写|续写|起草|扩写)\s*(一?下)?\s*(这一章|本章|这章)|(这一章|本章|这章).{0,8}(写出来|写完|重写|生成|续写|起草|扩写)",
    )
    .unwrap()
    .is_match(text);
    if Regex::new(r"(太短|太长|怎样|怎么样|如何|感觉|觉得|评价|分析一下)")
        .unwrap()
        .is_match(text)
        && !orders
        && !chapter_write
    {
        return None;
    }
    if asks && !orders && !chapter_write && !Regex::new(r"^(去\s*AI|润色|审核)").unwrap().is_match(text)
    {
        return None;
    }
    if Regex::new(r"去\s*AI|润色").unwrap().is_match(text) {
        return Some("humanize");
    }
    if text.contains("审核")
        && (orders
            || Regex::new(r"审核(一下|本章|这一章|第\s*\d+)|^(请)?审核")
                .unwrap()
                .is_match(text))
    {
        return Some("review");
    }
    if Regex::new(r"建书|新建一本|建一本").unwrap().is_match(text)
        || (Regex::new(r"(档案|设定)").unwrap().is_match(text) && orders)
    {
        return Some("book_setup");
    }
    if text.contains("细纲") && orders {
        return Some("chapter_outline");
    }
    if text.contains("大纲") && orders {
        return Some("outline");
    }
    if text.contains("正文") && (orders || chapter_write) {
        return Some("chapter_body");
    }
    if chapter_write {
        return Some("chapter_body");
    }
    None
}

pub(crate) fn artifact_body(conn: &rusqlite::Connection, book_id: &str, kind: &str, chapter_number: Option<i64>) -> String {
    let n = chapter_number.unwrap_or(0);
    conn.query_row(
        r#"SELECT r.body AS body
           FROM artifacts a
           JOIN artifact_revisions r ON r.id = a.current_revision_id
           LEFT JOIN chapters c ON c.id = a.chapter_id
           WHERE a.book_id = ?1 AND a.kind = ?2 AND ifnull(c.number, 0) = ifnull(?3, 0)"#,
        params![book_id, kind, n],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_default()
}

pub fn build_context(db: &Db, book_id: &str, chapter_number: Option<i64>, instruction: &str) -> AppResult<String> {
    Ok(crate::services::context::build_context_bundle(
        db, book_id, chapter_number, instruction, None, None, false,
    )?.text)
}

pub fn build_context_for_scene(
    db: &Db,
    book_id: &str,
    chapter_number: Option<i64>,
    instruction: &str,
    scene: &str,
    generation_id: Option<&str>,
) -> AppResult<crate::services::context::BuiltContext> {
    crate::services::context::build_context_bundle(
        db,
        book_id,
        chapter_number,
        instruction,
        Some(scene),
        generation_id,
        true,
    )
}


fn to_skill_texts(db: &Db, skills: &[crate::services::skills::SkillRow], max_chars: Option<usize>) -> AppResult<Vec<SkillText>> {
    let mut out = Vec::new();
    for skill in skills {
        let max = max_chars.unwrap_or_else(|| user_pack_default_max(&skill.id));
        let text = skill_prompt_text(&db.root, &skill.path, max)?;
        let role = if is_user_pack(&skill.id) {
            "primary".into()
        } else {
            skill.role.clone()
        };
        out.push(SkillText {
            id: skill.id.clone(),
            name: skill.name.clone(),
            role,
            text,
        });
    }
    Ok(out)
}

fn skill_info_json(skills: &[crate::services::skills::SkillRow], texts: &[SkillText]) -> (Value, Value) {
    let skills_json: Vec<Value> = skills
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "name": s.name,
                "role": if is_user_pack(&s.id) { "primary" } else { s.role.as_str() },
            })
        })
        .collect();
    let meta: Vec<Value> = texts
        .iter()
        .map(|t| skill_prompt_meta(&t.id, &t.name, &t.role, &t.text))
        .collect();
    (json!(skills_json), json!(meta))
}

pub fn generation_write_should_be_candidate(
    db: &Db,
    generation_id: Option<&str>,
    cancelled: &Option<Arc<AtomicBool>>,
) -> bool {
    if let Some(f) = cancelled {
        if f.load(Ordering::SeqCst) {
            return true;
        }
    }
    let Some(id) = generation_id else {
        return false;
    };
    get_generation(db, id)
        .ok()
        .flatten()
        .map(|r| r.status == GenerationStatus::Cancelled)
        .unwrap_or(false)
}


async fn optional_stream_pre_delay(
    db: &Db,
    generation_id: Option<&str>,
    cancelled: &Option<Arc<AtomicBool>>,
) -> AppResult<()> {
    let ms: u64 = std::env::var("MOLAN_STREAM_PRE_DELAY_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if ms == 0 {
        return Ok(());
    }
    let mut left = ms;
    while left > 0 {
        throw_if_generation_cancelled(db, generation_id, cancelled)?;
        let step = left.min(50);
        tokio::time::sleep(std::time::Duration::from_millis(step)).await;
        left -= step;
    }
    Ok(())
}

fn throw_if_generation_cancelled(
    db: &Db,
    generation_id: Option<&str>,
    cancelled: &Option<Arc<AtomicBool>>,
) -> AppResult<()> {
    throw_if_cancelled(cancelled)?;
    if let Some(id) = generation_id {
        if let Some(row) = get_generation(db, id)? {
            if row.status == GenerationStatus::Cancelled {
                return Err(AppError::Cancelled("已取消".into()));
            }
        }
    }
    Ok(())
}

fn reply_body(text: &str) -> String {
    let t = text.replace("\r\n", "\n");
    let re = Regex::new(r"\n{3,}").unwrap();
    re.replace_all(t.trim(), "\n\n").into_owned()
}

fn model_label(model_used: &str) -> String {
    if model_used == "local-draft" || model_used.starts_with("local-draft/") {
        return "本地草稿引擎".into();
    }
    model_used.into()
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "book_profile" => "档案",
        "book_outline" => "全书大纲",
        "chapter_outline" => "章节细纲",
        "chapter_body" => "正文",
        "review_report" => "审核",
        "chapter_memory" => "记忆",
        _ => "稿件",
    }
}

fn insert_message(db: &Db, book_id: &str, role: &str, content: &str, meta: Option<&Value>) -> AppResult<Value> {
    let id = Uuid::new_v4().to_string();
    let created = now_iso();
    let meta_json = meta.map(|m| m.to_string());
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO messages (id, book_id, role, content, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, book_id, role, content, meta_json, created],
        )?;
        Ok(())
    })?;
    Ok(json!({
        "id": id,
        "role": role,
        "content": content,
        "meta": meta.cloned(),
        "createdAt": created,
    }))
}

pub fn list_messages(db: &Db, book_id: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        let _ = must_book(conn, book_id)?;
        let mut stmt = conn.prepare(
            "SELECT id, role, content, meta_json, created_at FROM messages WHERE book_id = ?1 ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows: Vec<Value> = stmt
            .query_map(params![book_id], |r| {
                let meta_raw: Option<String> = r.get(3)?;
                let meta: Value = meta_raw
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or(Value::Null);
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "role": r.get::<_, String>(1)?,
                    "content": r.get::<_, String>(2)?,
                    "meta": meta,
                    "createdAt": r.get::<_, String>(4)?,
                }))
            })?
            .collect::<Result<_, _>>()?;
        Ok(json!({ "messages": rows }))
    })
}

pub struct ExecuteSceneInput {
    pub book_id: String,
    pub scene: String,
    pub chapter_number: Option<i64>,
    pub instruction: String,
    pub skill_ids: Option<Vec<String>>,
    pub expected_revision_id: Option<Option<String>>,
    pub on_conflict: OnConflict,
    pub generation_id: Option<String>,
    pub cancelled: Option<Arc<AtomicBool>>,
    /// When set, cancelled/done job forces candidate write (parity with Node asCandidate).
    pub job_id: Option<String>,
    /// Bind review/memory to the body revision they were based on.
    pub source_revision_id: Option<String>,
    /// Refuse under pi when tools/autonomous requested.
    pub tools_requested: bool,
    /// When true, run model but do not save artifact revision (G2 proposal extract).
    pub skip_persist: bool,
}

pub async fn execute_scene(db: &Db, input: ExecuteSceneInput) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, &input.book_id)?;
        Ok(())
    })?;
    let needs_chapter = matches!(
        input.scene.as_str(),
        "chapter_outline" | "chapter_body" | "review" | "humanize" | "memory_extract"
    );
    let chapter_number = if needs_chapter {
        Some(input.chapter_number.unwrap_or(1))
    } else {
        None
    };
    if let Some(n) = chapter_number {
        db.with_conn(|conn| {
            let exists: Option<String> = conn
                .query_row(
                    "SELECT id FROM chapters WHERE book_id = ?1 AND number = ?2",
                    params![input.book_id, n],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(AppError::BadRequest(format!("没有第 {n} 章")));
            }
            Ok(())
        })?;
    }

    let kind = scene_kind(&input.scene);
    let write_chapter = match kind {
        Some("book_profile") | Some("book_outline") | None => None,
        Some(_) => chapter_number,
    };
    let baseline = if let Some(ref exp) = input.expected_revision_id {
        exp.clone()
    } else if let Some(k) = kind {
        db.with_conn(|conn| current_revision_id_for(conn, &input.book_id, k, write_chapter))?
    } else {
        None
    };

    let skills = db.with_conn(|conn| {
        skills_for_scene(conn, &input.scene, input.skill_ids.as_deref())
    })?;
    let skill_texts = to_skill_texts(db, &skills, None)?;
    let (skills_json, skill_meta) = skill_info_json(&skills, &skill_texts);
    let mut instruction = input.instruction.trim().to_string();
    if input.scene == "review" {
        if let Some(n) = chapter_number {
            if let Ok(hook_block) = crate::services::hooks::format_open_hooks_for_review(db, &input.book_id, n) {
                if !hook_block.is_empty() {
                    if instruction.is_empty() {
                        instruction = hook_block;
                    } else {
                        instruction = format!("{instruction}\n\n{hook_block}");
                    }
                }
            }
        }
    }
    let built = build_context_for_scene(
        db,
        &input.book_id,
        chapter_number,
        &instruction,
        &input.scene,
        input.generation_id.as_deref(),
    )?;
    let context = built.text;
    let route = route_for(db, &input.scene)?;
    throw_if_generation_cancelled(db, input.generation_id.as_deref(), &input.cancelled)?;

    let adapter = get_adapter(db, &route)?;
    let run_input = RunInput {
        scene: input.scene.clone(),
        model: Some(route.model_id.clone()),
        skill_texts: skill_texts.clone(),
        context,
        instruction: instruction.clone(),
        thinking_intensity: normalize_thinking(Some(&route.thinking_intensity)),
        cancelled: input.cancelled.clone(),
            tools_requested: input.tools_requested,
    };
    let result = adapter.run_scene(&run_input).await?;
    throw_if_generation_cancelled(db, input.generation_id.as_deref(), &input.cancelled)?;

    let job_forces_candidate = input.job_id.as_ref().map(|jid| {
        db.with_conn(|conn| {
            let st: Option<String> = conn
                .query_row(
                    "SELECT status FROM writing_jobs WHERE id = ?1",
                    params![jid],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(matches!(st.as_deref(), Some("cancelled") | Some("done")))
        })
        .unwrap_or(false)
    }).unwrap_or(false);
    let as_candidate_now =
        generation_write_should_be_candidate(db, input.generation_id.as_deref(), &input.cancelled)
        || job_forces_candidate;

    let mut source_revision_id = input.source_revision_id.clone();
    if source_revision_id.is_none()
        && matches!(input.scene.as_str(), "review" | "memory_extract")
        && chapter_number.is_some()
    {
        source_revision_id = db.with_conn(|conn| {
            current_revision_id_for(conn, &input.book_id, "chapter_body", chapter_number)
        })?;
    }

    let saved = if input.skip_persist {
        Some(json!({
            "kind": kind.unwrap_or(""),
            "revisionId": null,
            "current": false,
            "persisted": false,
            "text": result.text,
            "model": result.model_used,
        }))
    } else if let Some(k) = kind {
        let source = if as_candidate_now
            && generation_write_should_be_candidate(db, input.generation_id.as_deref(), &input.cancelled)
        {
            "agent_cancelled"
        } else {
            "agent"
        };
        Some(save_revision(
            db,
            SaveRevisionInput {
                book_id: input.book_id.clone(),
                kind: k.into(),
                chapter_number: if k == "book_profile" || k == "book_outline" {
                    None
                } else {
                    chapter_number
                },
                chapter_id: None,
                body: result.text.clone(),
                source: source.into(),
                model: Some(result.model_used.clone()),
                skill_ids: skills.iter().map(|s| s.id.clone()).collect(),
                scene: Some(input.scene.clone()),
                expected_revision_id: Some(baseline),
                as_candidate: as_candidate_now,
                on_conflict: input.on_conflict,
            source_revision_id: source_revision_id.clone(),
                skip_memory: false,
            },
        )?)
    } else {
        None
    };

    if let (Some(gid), Some(saved_v)) = (input.generation_id.as_deref(), saved.as_ref()) {
        if let Some(rid) = saved_v.get("revisionId").and_then(|v| v.as_str()) {
            let _ = link_generation_result_revision(db, gid, rid);
        }
    }

    if let Some(saved_v) = &saved {
        let is_current = saved_v.get("current").and_then(|v| v.as_bool()).unwrap_or(false);
        let rid = saved_v.get("revisionId").and_then(|v| v.as_str());
        if is_current
            && rid.is_some()
            && generation_write_should_be_candidate(db, input.generation_id.as_deref(), &input.cancelled)
        {
            demote_cancelled_result_revision(db, rid.unwrap())?;
            if let Some(gid) = input.generation_id.as_deref() {
                complete_generation(
                    db,
                    gid,
                    GenerationStatus::Cancelled,
                    rid,
                    Some(&json!({
                        "cancelRevert": true,
                        "note": "取消前已写入的修订已退回上一版；该次结果保留在版本历史（来源 agent_cancelled）。",
                        "saved": saved_v,
                    })),
                    Some("已取消（已退回上一版修订）"),
                )?;
            }
            return Err(AppError::Cancelled("已取消".into()));
        }
    }

    if let Some(gid) = input.generation_id.as_deref() {
        if generation_write_should_be_candidate(db, Some(gid), &input.cancelled) {
            let rid = saved
                .as_ref()
                .and_then(|v| v.get("revisionId"))
                .and_then(|v| v.as_str());
            complete_generation(
                db,
                gid,
                GenerationStatus::Cancelled,
                rid,
                Some(&json!({
                    "text": result.text,
                    "modelUsed": result.model_used,
                    "saved": saved,
                    "current": false,
                })),
                Some("已取消"),
            )?;
            return Err(AppError::Cancelled("已取消".into()));
        }
        let rid = saved
            .as_ref()
            .and_then(|v| v.get("revisionId"))
            .and_then(|v| v.as_str());
        complete_generation(
            db,
            gid,
            GenerationStatus::Completed,
            rid,
            Some(&json!({
                "text": result.text,
                "modelUsed": result.model_used,
                "saved": saved,
            })),
            None,
        )?;
    }

    Ok(json!({
        "text": result.text,
        "modelUsed": result.model_used,
        "skills": skills_json,
        "skillPromptMeta": skill_meta,
        "saved": saved,
    }))
}

pub async fn rewrite_selection(
    db: &Db,
    book_id: &str,
    selection: &str,
    instruction: &str,
    scene: Option<&str>,
) -> AppResult<Value> {
    db.with_conn(|conn| {
        must_book(conn, book_id)?;
        Ok(())
    })?;
    let selection = selection.replace("\r\n", "\n").replace('\r', "\n").trim().to_string();
    let instruction = instruction.trim().to_string();
    if selection.is_empty() {
        return Err(AppError::BadRequest("要先选中一段文字".into()));
    }
    if instruction.is_empty() {
        return Err(AppError::BadRequest("要有改写说明".into()));
    }
    if selection.chars().count() > 8000 {
        return Err(AppError::BadRequest("选中文字太长，请缩短后再试".into()));
    }
    let allowed = ["chapter_body", "humanize", "chapter_outline", "outline", "review", "book_setup"];
    let scene = scene
        .filter(|s| allowed.contains(s))
        .unwrap_or("humanize");
    let route = route_for(db, scene)?;
    let skills = db.with_conn(|conn| skills_for_scene(conn, "humanize", None))?;
    let skill_texts = to_skill_texts(db, &skills, Some(36000))?;
    let (skills_json, skill_meta) = skill_info_json(&skills, &skill_texts);

    if route.provider != "openai" {
        return Ok(json!({
            "text": rewrite_selection_local(&selection, &instruction),
            "modelUsed": "local-draft",
            "local": true,
            "skills": skills_json,
            "skillPromptMeta": skill_meta,
        }));
    }

    let adapter = get_adapter(db, &route)?;
    let cont_hint = if instruction.contains("续写") {
        "若指令是续写：只输出接在选区后面的新文字，不要重复原文。"
    } else {
        ""
    };
    let run = RunInput {
        scene: "humanize".into(),
        model: Some(route.model_id.clone()),
        skill_texts,
        context: format!("【待改片段】\n{selection}\n"),
        instruction: [
            instruction.as_str(),
            "只改写上面的「待改片段」。",
            "只输出改写后的文字本身，不要标题、引号包裹、创作说明或前后缀。",
            "对白只用弯引号“”，不要用「」、（）或()包说话。",
            cont_hint,
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n"),
        thinking_intensity: normalize_thinking(Some(&route.thinking_intensity)),
        cancelled: None,
            tools_requested: false,
    };
    let result = adapter.run_scene(&run).await.map_err(|e| {
        if matches!(e, AppError::BadGateway(_) | AppError::BadRequest(_)) {
            e
        } else {
            AppError::BadGateway(format!("选区改写失败：{e}"))
        }
    })?;
    let text = normalize_dialogue_quotes(result.text.replace("\r\n", "\n").trim());
    let max_len = (selection.chars().count() * 4).max(1200);
    if text.chars().count() > max_len && !instruction.contains("续写") {
        return Err(AppError::BadGateway(
            "模型返回过长，已拒绝替换选区（请缩短指令或重试）".into(),
        ));
    }
    if text.is_empty() {
        return Err(AppError::BadGateway("模型返回为空".into()));
    }
    let local = result.model_used.to_lowercase().contains("local-draft");
    Ok(json!({
        "text": text,
        "modelUsed": result.model_used,
        "local": local,
        "skills": skills_json,
        "skillPromptMeta": skill_meta,
    }))
}

pub async fn chat(
    db: &Db,
    book_id: &str,
    message: &str,
    preferred_chapter: Option<i64>,
    generation_id: Option<&str>,
    cancelled: Option<Arc<AtomicBool>>,
) -> AppResult<Value> {
    let book_title = db.with_conn(|conn| Ok(must_book(conn, book_id)?.title))?;
    let text = message.trim();
    if text.is_empty() {
        return Err(AppError::BadRequest("要说一句".into()));
    }

    if let Some(gid) = generation_id {
        let began = begin_generation(db, gid, book_id, "chat", preferred_chapter, None, None)?;
        if began.get("reused").and_then(|v| v.as_bool()) == Some(true) {
            let status = began.get("status").and_then(|v| v.as_str()).unwrap_or("");
            match status {
                "completed" => {
                    if let Some(result) = began.get("result") {
                        return Ok(result.clone());
                    }
                }
                "running" => {
                    return Err(AppError::Conflict(
                        "同一 generationId 仍在执行，请查询状态而非重试".into(),
                    ));
                }
                "failed" => {
                    return Err(AppError::BadGateway(
                        began
                            .get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("上次生成失败")
                            .into(),
                    ));
                }
                "cancelled" => return Err(AppError::Conflict("该生成已取消".into())),
                _ => {}
            }
        }
    }

    throw_if_generation_cancelled(db, generation_id, &cancelled)?;
    // Test-only: MOLAN_STREAM_PRE_DELAY_MS (parity with Node optionalStreamPreDelay).
    optional_stream_pre_delay(db, generation_id, &cancelled).await?;
    throw_if_generation_cancelled(db, generation_id, &cancelled)?;
    insert_message(db, book_id, "user", text, None)?;

    if let Some(scene) = route_message(text) {
        let mentioned = parse_chapter_mention(text);
        let fallback = preferred_chapter.filter(|n| *n > 0).unwrap_or(1);
        let chapter_number = if scene == "outline" || scene == "book_setup" {
            None
        } else {
            Some(mentioned.unwrap_or(fallback))
        };
        match execute_scene(
            db,
            ExecuteSceneInput {
                book_id: book_id.into(),
                scene: scene.into(),
                chapter_number,
                instruction: text.into(),
                skill_ids: None,
                expected_revision_id: None,
                on_conflict: OnConflict::Candidate,
                generation_id: generation_id.map(|s| s.to_string()),
                cancelled: cancelled.clone(),
                job_id: None,
            source_revision_id: None,
            tools_requested: false,
            skip_persist: false,
        },
        )
        .await
        {
            Ok(result) => {
                let saved = result.get("saved").cloned().unwrap_or(Value::Null);
                let label = saved
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .map(kind_label)
                    .unwrap_or("稿件");
                let where_ch = saved
                    .get("chapterNumber")
                    .and_then(|v| v.as_i64())
                    .map(|n| format!("第 {n} 章"))
                    .unwrap_or_default();
                let rev = saved.get("revision").and_then(|v| v.as_i64()).unwrap_or(1);
                let model = result
                    .get("modelUsed")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let body = result.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let content = format!(
                    "已写入{where_ch}{label}，修订 {rev}。用的是{}。\n{}",
                    model_label(model),
                    reply_body(body)
                );
                let meta = json!({
                    "scene": scene,
                    "modelUsed": model,
                    "saved": saved,
                    "skills": result.get("skills"),
                    "skillPromptMeta": result.get("skillPromptMeta"),
                });
                let assistant = insert_message(db, book_id, "assistant", &content, Some(&meta))?;
                let out = json!({
                    "message": assistant,
                    "saved": saved,
                    "skills": result.get("skills"),
                    "skillPromptMeta": result.get("skillPromptMeta"),
                });
                Ok(out)
            }
            Err(e) if e.is_abort() => Err(e),
            Err(e) => {
                let content = e.to_string();
                let assistant = insert_message(
                    db,
                    book_id,
                    "assistant",
                    &content,
                    Some(&json!({ "scene": scene, "saved": null })),
                )?;
                Ok(json!({ "message": assistant, "saved": null }))
            }
        }
    } else {
        // free-form chat
        let chat_scene = "chat";
        let route = route_for(db, chat_scene)?;
        let skills = db.with_conn(|conn| skills_for_scene(conn, chat_scene, None))?;
        let skill_texts = to_skill_texts(db, &skills, None)?;
        let (skills_json, skill_meta) = skill_info_json(&skills, &skill_texts);
        let built = build_context_for_scene(db, book_id, None, text, chat_scene, None)?;
        let context = built.text;
        match get_adapter(db, &route) {
            Ok(adapter) => {
                let run = RunInput {
                    scene: chat_scene.into(),
                    model: Some(route.model_id.clone()),
                    skill_texts,
                    context,
                    instruction: text.into(),
                    thinking_intensity: normalize_thinking(Some(&route.thinking_intensity)),
                    cancelled: cancelled.clone(),
            tools_requested: false,
                };
                match adapter.run_scene(&run).await {
                    Ok(result) => {
                        let content = reply_body(&result.text);
                        let meta = json!({
                            "scene": chat_scene,
                            "modelUsed": result.model_used,
                            "saved": null,
                            "skills": skills_json,
                            "skillPromptMeta": skill_meta,
                        });
                        let assistant = insert_message(db, book_id, "assistant", &content, Some(&meta))?;
                        Ok(json!({
                            "message": assistant,
                            "saved": null,
                            "skills": skills_json,
                            "skillPromptMeta": skill_meta,
                        }))
                    }
                    Err(e) if e.is_abort() => Err(e),
                    Err(e) => {
                        let fallback = format!(
                            "我可以按《{book_title}》往下写。你可以直接说：写全书大纲、写第 3 章细纲、写第 1 章正文、审核这一章、把正文去 AI 味。\n（对话模型未接通：{e}）"
                        );
                        let assistant = insert_message(
                            db,
                            book_id,
                            "assistant",
                            &fallback,
                            Some(&json!({
                                "scene": chat_scene,
                                "saved": null,
                                "skills": skills_json,
                                "skillPromptMeta": skill_meta,
                            })),
                        )?;
                        Ok(json!({
                            "message": assistant,
                            "saved": null,
                            "skills": skills_json,
                            "skillPromptMeta": skill_meta,
                        }))
                    }
                }
            }
            Err(e) => {
                let fallback = format!(
                    "我可以按《{book_title}》往下写。你可以直接说：写全书大纲、写第 3 章细纲、写第 1 章正文、审核这一章、把正文去 AI 味。\n（对话模型未接通：{e}）"
                );
                let assistant = insert_message(
                    db,
                    book_id,
                    "assistant",
                    &fallback,
                    Some(&json!({
                        "scene": chat_scene,
                        "saved": null,
                        "skills": skills_json,
                        "skillPromptMeta": skill_meta,
                    })),
                )?;
                Ok(json!({
                    "message": assistant,
                    "saved": null,
                    "skills": skills_json,
                    "skillPromptMeta": skill_meta,
                }))
            }
        }
    }
}

/// Stream scene-run with SSE events (token/status/done/error), CAS + beginGeneration.
async fn sse_emit(tx: &mpsc::UnboundedSender<Value>, event: Value) -> AppResult<()> {
    tx.send(event)
        .map_err(|_| AppError::Cancelled("已取消".into()))
}

pub async fn stream_scene_run(
    db: &Db,
    tx: mpsc::UnboundedSender<Value>,
    input: ExecuteSceneInput,
) -> AppResult<()>
{
    db.with_conn(|conn| {
        must_book(conn, &input.book_id)?;
        Ok(())
    })?;
    let needs_chapter = matches!(
        input.scene.as_str(),
        "chapter_outline" | "chapter_body" | "review" | "humanize" | "memory_extract"
    );
    let chapter_number = if needs_chapter {
        Some(input.chapter_number.unwrap_or(1))
    } else {
        None
    };
    if let Some(n) = chapter_number {
        db.with_conn(|conn| {
            let exists: Option<String> = conn
                .query_row(
                    "SELECT id FROM chapters WHERE book_id = ?1 AND number = ?2",
                    params![input.book_id, n],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(AppError::BadRequest(format!("没有第 {n} 章")));
            }
            Ok(())
        })?;
    }

    let kind = scene_kind(&input.scene);
    let write_chapter = match kind {
        Some("book_profile") | Some("book_outline") | None => None,
        Some(_) => chapter_number,
    };
    let baseline = if let Some(ref exp) = input.expected_revision_id {
        exp.clone()
    } else if let Some(k) = kind {
        db.with_conn(|conn| current_revision_id_for(conn, &input.book_id, k, write_chapter))?
    } else {
        None
    };

    if let Some(ref gid) = input.generation_id {
        let began = begin_generation(
            db,
            gid,
            &input.book_id,
            &input.scene,
            chapter_number,
            None,
            baseline.as_deref(),
        )?;
        if began.get("reused").and_then(|v| v.as_bool()) == Some(true) {
            let status = began.get("status").and_then(|v| v.as_str()).unwrap_or("");
            match status {
                "completed" => {
                    if let Some(result) = began.get("result") {
                        sse_emit(&tx, json!({ "type": "done", "payload": result })).await?;
                        return Ok(());
                    }
                }
                "running" => {
                    return Err(AppError::Conflict(
                        "同一 generationId 仍在执行，请查询状态而非重试".into(),
                    ));
                }
                "failed" => {
                    return Err(AppError::BadGateway(
                        began
                            .get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("上次生成失败")
                            .into(),
                    ));
                }
                "cancelled" => return Err(AppError::Conflict("该生成已取消".into())),
                _ => {}
            }
        }
    }

    let skills = db.with_conn(|conn| {
        skills_for_scene(conn, &input.scene, input.skill_ids.as_deref())
    })?;
    let skill_texts = to_skill_texts(db, &skills, None)?;
    let (skills_json, skill_meta) = skill_info_json(&skills, &skill_texts);
    let mut instruction = input.instruction.trim().to_string();
    if input.scene == "review" {
        if let Some(n) = chapter_number {
            if let Ok(hook_block) = crate::services::hooks::format_open_hooks_for_review(db, &input.book_id, n) {
                if !hook_block.is_empty() {
                    if instruction.is_empty() {
                        instruction = hook_block;
                    } else {
                        instruction = format!("{instruction}\n\n{hook_block}");
                    }
                }
            }
        }
    }
    let built = build_context_for_scene(
        db,
        &input.book_id,
        chapter_number,
        &instruction,
        &input.scene,
        input.generation_id.as_deref(),
    )?;
    let context = built.text;
    let route = route_for(db, &input.scene)?;
    let adapter = get_adapter(db, &route)?;
    let run_input = RunInput {
        scene: input.scene.clone(),
        model: Some(route.model_id.clone()),
        skill_texts: skill_texts.clone(),
        context,
        instruction,
        thinking_intensity: normalize_thinking(Some(&route.thinking_intensity)),
        cancelled: input.cancelled.clone(),
        tools_requested: input.tools_requested,
    };

    if adapter.is_openai() {
        sse_emit(&tx, json!({ "type": "status", "message": "正在连接模型…" })).await?;
    } else {
        sse_emit(&tx, json!({ "type": "status", "message": "本地草稿生成中…" })).await?;
    }

    let tx_tokens = tx.clone();
    let result = {
        let token_emit = move |delta: String| -> AppResult<()> {
            tx_tokens
                .send(json!({ "type": "token", "text": delta }))
                .map_err(|_| AppError::Cancelled("已取消".into()))
        };
        adapter.run_scene_stream(&run_input, token_emit).await
    };

    let result = match result {
        Ok(r) => r,
        Err(e) if e.is_abort() => {
            if let Some(ref gid) = input.generation_id {
                let _ = crate::services::generations::cancel_generation(db, gid);
            }
            return Err(e);
        }
        Err(e) => {
            if let Some(ref gid) = input.generation_id {
                let _ = complete_generation(
                    db,
                    gid,
                    GenerationStatus::Failed,
                    None,
                    None,
                    Some(&e.to_string()),
                );
            }
            return Err(e);
        }
    };

    throw_if_cancelled(&input.cancelled)?;
    let job_forces_candidate = input.job_id.as_ref().map(|jid| {
        db.with_conn(|conn| {
            let st: Option<String> = conn
                .query_row(
                    "SELECT status FROM writing_jobs WHERE id = ?1",
                    params![jid],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(matches!(st.as_deref(), Some("cancelled") | Some("done")))
        })
        .unwrap_or(false)
    }).unwrap_or(false);
    let as_candidate_now =
        generation_write_should_be_candidate(db, input.generation_id.as_deref(), &input.cancelled)
        || job_forces_candidate;
    let mut source_revision_id = input.source_revision_id.clone();
    if source_revision_id.is_none()
        && matches!(input.scene.as_str(), "review" | "memory_extract")
        && chapter_number.is_some()
    {
        source_revision_id = db.with_conn(|conn| {
            current_revision_id_for(conn, &input.book_id, "chapter_body", chapter_number)
        })?;
    }

    let saved = if input.skip_persist {
        Some(json!({
            "kind": kind.unwrap_or(""),
            "revisionId": null,
            "current": false,
            "persisted": false,
            "text": result.text,
            "model": result.model_used,
        }))
    } else if let Some(k) = kind {
        Some(save_revision(
            db,
            SaveRevisionInput {
                book_id: input.book_id.clone(),
                kind: k.into(),
                chapter_number: if k == "book_profile" || k == "book_outline" {
                    None
                } else {
                    chapter_number
                },
                chapter_id: None,
                body: result.text.clone(),
                source: if as_candidate_now {
                    "agent_cancelled".into()
                } else {
                    "agent".into()
                },
                model: Some(result.model_used.clone()),
                skill_ids: skills.iter().map(|s| s.id.clone()).collect(),
                scene: Some(input.scene.clone()),
                expected_revision_id: Some(baseline),
                as_candidate: as_candidate_now,
                on_conflict: input.on_conflict,
            source_revision_id: source_revision_id.clone(),
                skip_memory: false,
            },
        )?)
    } else {
        None
    };

    if let (Some(gid), Some(saved_v)) = (input.generation_id.as_deref(), saved.as_ref()) {
        if let Some(rid) = saved_v.get("revisionId").and_then(|v| v.as_str()) {
            let _ = link_generation_result_revision(db, gid, rid);
        }
    }

    if let Some(saved_v) = &saved {
        let is_current = saved_v.get("current").and_then(|v| v.as_bool()).unwrap_or(false);
        let rid = saved_v.get("revisionId").and_then(|v| v.as_str());
        if is_current
            && rid.is_some()
            && generation_write_should_be_candidate(db, input.generation_id.as_deref(), &input.cancelled)
        {
            demote_cancelled_result_revision(db, rid.unwrap())?;
            if let Some(gid) = input.generation_id.as_deref() {
                complete_generation(
                    db,
                    gid,
                    GenerationStatus::Cancelled,
                    rid,
                    Some(&json!({
                        "cancelRevert": true,
                        "note": "取消前已写入的修订已退回上一版；该次结果保留在版本历史（来源 agent_cancelled）。",
                        "saved": { "current": false },
                    })),
                    Some("已取消（已退回上一版修订）"),
                )?;
            }
            return Err(AppError::Cancelled("已取消".into()));
        }
    }

    let payload = json!({
        "text": result.text,
        "modelUsed": result.model_used,
        "skills": skills_json,
        "skillPromptMeta": skill_meta,
        "saved": saved,
    });

    if let Some(gid) = input.generation_id.as_deref() {
        if generation_write_should_be_candidate(db, Some(gid), &input.cancelled) {
            let rid = saved
                .as_ref()
                .and_then(|v| v.get("revisionId"))
                .and_then(|v| v.as_str());
            let mut cancelled_payload = payload.clone();
            if let Some(obj) = cancelled_payload.as_object_mut() {
                obj.insert("current".into(), json!(false));
            }
            complete_generation(
                db,
                gid,
                GenerationStatus::Cancelled,
                rid,
                Some(&cancelled_payload),
                Some("已取消"),
            )?;
            return Err(AppError::Cancelled("已取消".into()));
        }
        let rid = saved
            .as_ref()
            .and_then(|v| v.get("revisionId"))
            .and_then(|v| v.as_str());
        complete_generation(db, gid, GenerationStatus::Completed, rid, Some(&payload), None)?;
    }
    sse_emit(&tx, json!({ "type": "done", "payload": payload })).await?;
    Ok(())
}


pub async fn auto_setup(db: &Db, brief: &str, forced_id: Option<&str>) -> AppResult<Value> {
    let text = brief.trim();
    if text.is_empty() {
        return Err(AppError::BadRequest("要有一句题材".into()));
    }
    if let Some(fid) = forced_id {
        let exists = db.with_conn(|conn| {
            let row: Option<String> = conn
                .query_row("SELECT id FROM books WHERE id = ?1", params![fid], |r| r.get(0))
                .optional()?;
            Ok(row.is_some())
        })?;
        if exists {
            return Err(AppError::Conflict("这本书已经存在".into()));
        }
    }

    let scene = "book_setup";
    let skills = db.with_conn(|conn| skills_for_scene(conn, scene, None))?;
    let skill_texts = to_skill_texts(db, &skills, None)?;
    let route = route_for(db, scene)?;
    let adapter = get_adapter(db, &route)?;
    let run_input = RunInput {
        scene: scene.into(),
        model: Some(route.model_id.clone()),
        skill_texts,
        context: format!("【题材简述】\n{text}\n"),
        instruction: text.into(),
        thinking_intensity: normalize_thinking(Some(&route.thinking_intensity)),
        cancelled: None,
        tools_requested: false,
    };
    let result = adapter.run_scene(&run_input).await?;

    let title = {
        let t = field_of(&result.text, "书名");
        if t.is_empty() { "未命名".into() } else { t }
    };
    let genre = field_of(&result.text, "题材");
    let logline = {
        let t = field_of(&result.text, "简介");
        if t.is_empty() { text.to_string() } else { t }
    };
    let style = field_of(&result.text, "文风");
    let titles = titles_from(&result.text);
    let count_from_field = field_of(&result.text, "目标章数")
        .parse::<i64>()
        .unwrap_or(0);
    let count = {
        let n = if count_from_field > 0 {
            count_from_field
        } else if !titles.is_empty() {
            titles.len() as i64
        } else {
            12
        };
        n.clamp(1, 48)
    };
    let mut chapter_titles = if !titles.is_empty() {
        titles.into_iter().take(count as usize).collect::<Vec<_>>()
    } else {
        (1..=count).map(|i| format!("第{i}章")).collect()
    };
    while (chapter_titles.len() as i64) < count {
        chapter_titles.push(format!("第{}章", chapter_titles.len() + 1));
    }

    let id = forced_id
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created = now_iso();

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            r#"INSERT INTO books (id, title, genre, logline, style, target_chapters, words_per_chapter, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            params![id, title, genre, logline, style, count, 800i64, created],
        )?;
        for (i, ch_title) in chapter_titles.iter().enumerate() {
            let ch_id = Uuid::new_v4().to_string();
            let number = (i + 1) as i64;
            tx.execute(
                "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?1, ?2, ?3, ?4, 'empty')",
                params![ch_id, id, number, ch_title],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;

    save_revision(
        db,
        SaveRevisionInput {
            book_id: id.clone(),
            kind: "book_profile".into(),
            chapter_number: None,
            chapter_id: None,
            body: result.text,
            source: "agent".into(),
            model: Some(result.model_used.clone()),
            skill_ids: skills.iter().map(|s| s.id.clone()).collect(),
            scene: Some("book_setup".into()),
            expected_revision_id: None,
            as_candidate: false,
            on_conflict: OnConflict::Candidate,
            source_revision_id: None,
            skip_memory: true,
        },
    )?;

    let mut payload = crate::services::books::get_book_payload(db, &id)?;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("modelUsed".into(), json!(result.model_used));
    }
    Ok(payload)
}
