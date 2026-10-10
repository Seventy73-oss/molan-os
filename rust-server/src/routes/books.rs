use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use serde_json::{Value, json};
use crate::db::Db;
use crate::error::AppResult;
use crate::services::books::{CreateBookInput, UpdateBookInput, create_book, delete_book, get_book_payload, list_books, update_book};
use crate::services::manuscripts::sync_book;

pub async fn list(State(db): State<Db>) -> AppResult<impl IntoResponse> {
    let books = list_books(&db)?;
    Ok(Json(json!({ "books": books })))
}

pub async fn get(State(db): State<Db>, Path(id): Path<String>) -> AppResult<impl IntoResponse> {
    let _ = sync_book(&db, &id);
    Ok(Json(get_book_payload(&db, &id)?))
}

pub async fn create(
    State(db): State<Db>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let idem = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let input = CreateBookInput {
        title: body
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        genre: body
            .get("genre")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        logline: body
            .get("logline")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        style: body
            .get("style")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        target_chapters: body.get("targetChapters").and_then(|v| v.as_i64()),
        words_per_chapter: body.get("wordsPerChapter").and_then(|v| v.as_i64()),
        idempotency_key: idem,
    };
    let (payload, reused) = create_book(&db, input)?;
    let status = if reused {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(payload)))
}

pub async fn update(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let input = UpdateBookInput {
        title: body.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
        genre: body.get("genre").and_then(|v| v.as_str()).map(|s| s.to_string()),
        logline: body.get("logline").and_then(|v| v.as_str()).map(|s| s.to_string()),
        style: body.get("style").and_then(|v| v.as_str()).map(|s| s.to_string()),
        target_chapters: body.get("targetChapters").and_then(|v| v.as_i64()),
        words_per_chapter: body.get("wordsPerChapter").and_then(|v| v.as_i64()),
        confirm_trim: body.get("confirmTrim").and_then(|v| v.as_bool()).unwrap_or(false),
    };
    Ok(Json(update_book(&db, &id, input)?))
}

pub async fn delete(State(db): State<Db>, Path(id): Path<String>) -> AppResult<impl IntoResponse> {
    delete_book(&db, &id)?;
    Ok(Json(json!({ "ok": true })))
}
