use axum::{Json, extract::State};
use serde_json::{Value, json};
use crate::db::Db;
use crate::error::AppResult;
use crate::services::worker::worker_status;

pub async fn health(State(db): State<Db>) -> AppResult<Json<Value>> {
    Ok(Json(json!({
        "ok": true,
        "db": {
            "driver": "sqlite",
            "detail": db.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            "ready": true,
        },
        "jobsWorker": worker_status(),
        "runtime": "rust",
    })))
}
