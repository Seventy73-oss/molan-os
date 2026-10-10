//! Jobs API + worker status.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use crate::db::Db;
use crate::error::AppResult;
use crate::services::jobs::{create_job, get_job, list_jobs, retry_job, set_job_status, tick_job};
use crate::services::worker::{LockOutcome, global_worker, worker_status};
use serde_json::{Value, json};

pub async fn worker_get() -> impl IntoResponse {
    Json(worker_status())
}

pub async fn list_book_jobs(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(json!({ "jobs": list_jobs(&db, &id)? })))
}

pub async fn create_book_job(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let job = create_job(
        &db,
        &id,
        body.get("fromChapter").and_then(|v| v.as_i64()),
        body.get("toChapter").and_then(|v| v.as_i64()),
        body.get("autoReview").and_then(|v| v.as_bool()).unwrap_or(false),
        body.get("maxRetries").and_then(|v| v.as_i64()),
    )?;
    Ok((StatusCode::CREATED, Json(job)))
}

pub async fn get_one(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(get_job(&db, &id)?))
}

pub async fn tick(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let owner = format!("http-{}-{}", std::process::id(), crate::db::now_iso());
    let worker = global_worker();
    match worker
        .with_job_lock(&db, &id, &owner, tick_job(&db, &id))
        .await
    {
        Ok(result) => Ok(Json(result)),
        Err(LockOutcome::Locked) => Ok(Json(json!({
            "job": get_job(&db, &id)?,
            "advanced": false,
            "locked": true,
        }))),
        Err(LockOutcome::Err(e)) => Err(e),
    }
}

pub async fn patch_status(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("");
    Ok(Json(set_job_status(&db, &id, status)?))
}

pub async fn retry(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(retry_job(&db, &id)?))
}
