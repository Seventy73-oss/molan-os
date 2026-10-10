//! Catch-all stubs so the API surface is discoverable; returns 501 until ported.

use axum::{
    Json, Router,
    http::StatusCode,
    response::IntoResponse,
    routing::{any, get, post},
};
use serde_json::json;
use crate::db::Db;

async fn not_ported() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "该接口尚未移植到 Rust（见 docs/RUST_REWRITE.md）",
            "runtime": "rust-scaffold",
        })),
    )
}

pub fn stub_router() -> Router<Db> {
    Router::new()
        .route("/api/books/{id}/chat", post(not_ported))
        .route("/api/books/{id}/chat/stream", post(not_ported))
        .route("/api/books/{id}/scene-runs", post(not_ported))
        .route("/api/books/{id}/scene-runs/stream", post(not_ported))
        .route("/api/books/{id}/selection-rewrite", post(not_ported))
        .route("/api/books/{id}/selection-rewrite/stream", post(not_ported))
        .route("/api/skills", get(not_ported))
        .route("/api/skills/for-scene", get(not_ported))
        .route("/api/scene-routes", get(not_ported).put(not_ported))
        .route("/api/generations/{id}", get(not_ported))
        .route("/api/generations/{id}/cancel", post(not_ported))
        .route("/api/jobs/worker", get(not_ported))
        .route("/api/agent/runtime", get(not_ported))
        .route("/api/{*rest}", any(not_ported))
}
