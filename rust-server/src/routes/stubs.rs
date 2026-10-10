//! Catch-all stubs so the API surface is discoverable; returns 501 until ported.

use axum::{
    Json, Router,
    http::StatusCode,
    response::IntoResponse,
    routing::any,
};
use serde_json::json;
use crate::db::Db;

pub async fn not_ported_handler() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "该接口尚未移植到 Rust（见 docs/RUST_REWRITE.md）",
            "runtime": "rust-scaffold",
        })),
    )
}

pub fn stub_router() -> Router<Db> {
    Router::new().route("/api/{*rest}", any(not_ported_handler))
}
