use axum::{
    Json,
    extract::{Path, State},
    response::IntoResponse,
};
use serde_json::Value;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::generations::{begin_stub, cancel_generation, get_generation};

pub async fn get(State(db): State<Db>, Path(id): Path<String>) -> AppResult<impl IntoResponse> {
    let row = get_generation(&db, &id)?
        .ok_or_else(|| AppError::NotFound("生成记录不存在".into()))?;
    Ok(Json(serde_json::json!({
        "id": row.id,
        "bookId": row.book_id,
        "scene": row.scene,
        "status": row.status.as_str(),
        "result": row.result,
        "error": row.error,
        "resultRevisionId": row.result_revision_id,
        "baseRevisionId": row.base_revision_id,
    })))
}

pub async fn cancel(State(db): State<Db>, Path(id): Path<String>) -> AppResult<impl IntoResponse> {
    Ok(Json(cancel_generation(&db, &id)?))
}

/// Dev/parity stub so clients can begin a generation before stream is ported.
pub async fn begin(State(db): State<Db>, Json(body): Json<Value>) -> AppResult<impl IntoResponse> {
    Ok(Json(begin_stub(&db, &body)?))
}
