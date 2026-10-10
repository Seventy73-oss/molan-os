//! progress / search / bible / review / hooks / usage / agent runtime.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::features::{
    create_bible_card, delete_bible_card, get_book_progress, list_bible_cards, review_issues,
    search_book, update_bible_card,
};
use crate::services::context::preview_context;
use crate::services::hooks::{list_hooks, mark_hook};
use crate::services::usage::{list_usage, usage_summary};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

#[derive(Deserialize)]
pub struct ChapterQuery {
    #[serde(rename = "chapterNumber")]
    chapter_number: Option<String>,
}

#[derive(Deserialize)]
pub struct UsageQuery {
    #[serde(rename = "bookId")]
    book_id: Option<String>,
    limit: Option<i64>,
}

pub async fn progress(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(get_book_progress(&db, &id)?))
}

pub async fn search(
    State(db): State<Db>,
    Path(id): Path<String>,
    Query(q): Query<SearchQuery>,
) -> AppResult<impl IntoResponse> {
    let query = q.q.unwrap_or_default();
    Ok(Json(json!({ "query": query, "hits": search_book(&db, &id, &query)? })))
}

pub async fn bible_list(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(json!({ "cards": list_bible_cards(&db, &id)? })))
}

pub async fn bible_create(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let card = create_bible_card(
        &db,
        &id,
        body.get("kind").and_then(|v| v.as_str()).unwrap_or("character"),
        body.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        body.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
        body.get("details").and_then(|v| v.as_str()).unwrap_or(""),
    )?;
    Ok((StatusCode::CREATED, Json(card)))
}

pub async fn bible_patch(
    State(db): State<Db>,
    Path((id, card_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let card = update_bible_card(
        &db,
        &id,
        &card_id,
        body.get("kind").and_then(|v| v.as_str()),
        body.get("name").and_then(|v| v.as_str()),
        body.get("summary").and_then(|v| v.as_str()),
        body.get("details").and_then(|v| v.as_str()),
        body.get("sortOrder").and_then(|v| v.as_i64()),
    )?;
    Ok(Json(card))
}

pub async fn bible_delete(
    State(db): State<Db>,
    Path((id, card_id)): Path<(String, String)>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(delete_bible_card(&db, &id, &card_id)?))
}


pub async fn context_preview(
    State(db): State<Db>,
    Path(id): Path<String>,
    Query(q): Query<ChapterQuery>,
) -> AppResult<impl IntoResponse> {
    let chapter = q
        .chapter_number
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0);
    Ok(Json(preview_context(&db, &id, chapter)?))
}

pub async fn hooks_list(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(json!({ "hooks": list_hooks(&db, &id)? })))
}

pub async fn hooks_patch(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let key = body.get("key").and_then(|v| v.as_str()).unwrap_or("");
    if key.is_empty() {
        return Err(AppError::BadRequest("缺少钩子 key".into()));
    }
    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("marked");
    let hook = mark_hook(
        &db,
        &id,
        key,
        status,
        body.get("recycledChapter").and_then(|v| v.as_i64()),
        body.get("note").and_then(|v| v.as_str()).unwrap_or(""),
    )?;
    Ok(Json(json!({ "hook": hook, "hooks": list_hooks(&db, &id)? })))
}

pub async fn review(
    State(db): State<Db>,
    Path(id): Path<String>,
    Query(q): Query<ChapterQuery>,
) -> AppResult<impl IntoResponse> {
    let raw = q.chapter_number.unwrap_or_default();
    let chapter_number: i64 = raw
        .parse()
        .map_err(|_| AppError::BadRequest("章节号无效".into()))?;
    Ok(Json(review_issues(&db, &id, chapter_number)?))
}

pub async fn usage_global(
    State(db): State<Db>,
    Query(q): Query<UsageQuery>,
) -> AppResult<impl IntoResponse> {
    let limit = q.limit.unwrap_or(50);
    Ok(Json(json!({
        "entries": list_usage(&db, q.book_id.as_deref(), limit)?,
        "summary": usage_summary(&db, q.book_id.as_deref())?,
    })))
}

pub async fn usage_summary_route(
    State(db): State<Db>,
    Query(q): Query<UsageQuery>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(usage_summary(&db, q.book_id.as_deref())?))
}

pub async fn usage_book(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(json!({
        "entries": list_usage(&db, Some(&id), 80)?,
        "summary": usage_summary(&db, Some(&id))?,
    })))
}

pub async fn agent_runtime(State(db): State<Db>) -> impl IntoResponse {
    let env_runtime = std::env::var("MOLAN_AGENT_RUNTIME")
        .or_else(|_| std::env::var("CHANGJUAN_AGENT_RUNTIME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Json(json!({
        "capabilities": [
            {
                "id": "local-draft",
                "label": "本地草稿",
                "available": true,
                "reason": "内置结构化中文草稿，无需密钥",
            },
            {
                "id": "openai-compatible",
                "label": "OpenAI 兼容",
                "available": true,
                "reason": "在「模型」页配置 Base URL / API Key 后按场景路由调用",
            },
            crate::agent::pi::probe_pi_capability(),
        ],
        "envRuntime": env_runtime,
        "db": {
            "driver": "sqlite",
            "detail": db.path.display().to_string(),
            "ready": true,
        },
        "pi": crate::agent::pi::pi_orchestration_boundary(),
        "note": "Rust API：默认 sqlite；pi 为原生模型代调（非自主编排，拒 tools）。详见 docs/PI_RUNTIME.md / docs/RUST_REWRITE.md。",
        "runtime": "rust",
    }))
}
