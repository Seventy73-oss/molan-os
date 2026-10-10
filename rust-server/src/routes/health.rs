use axum::{Json, extract::State};
use serde_json::{Value, json};
use crate::db::Db;
use crate::error::AppResult;

pub async fn health(State(db): State<Db>) -> AppResult<Json<Value>> {
    Ok(Json(json!({
        "ok": true,
        "db": {
            "driver": "sqlite",
            "detail": db.path.display().to_string(),
            "ready": true,
        },
        "jobsWorker": {
            "running": false,
            "backend": "rust-scaffold",
            "note": "job worker not yet ported",
        },
        "runtime": "rust",
    })))
}
