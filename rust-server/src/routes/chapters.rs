use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde_json::Value;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::chapters::{add_chapter, delete_chapter, rename_chapter};

pub async fn create(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let title = body.get("title").and_then(|v| v.as_str());
    let payload = add_chapter(&db, &id, title)?;
    Ok((StatusCode::CREATED, Json(payload)))
}

pub async fn update(
    State(db): State<Db>,
    Path((id, number)): Path<(String, i64)>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let title = body.get("title").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Json(rename_chapter(&db, &id, number, title)?))
}

pub async fn delete(
    State(db): State<Db>,
    Path((id, number)): Path<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    if number <= 0 {
        return Err(AppError::BadRequest("章节号无效".into()));
    }
    Ok(Json(delete_chapter(&db, &id, number)?))
}
