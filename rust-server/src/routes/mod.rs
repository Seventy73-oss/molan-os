pub mod artifacts;
pub mod books;
pub mod chapters;
pub mod generations;
pub mod health;
pub mod settings;
pub mod skills;
pub mod stubs;

use axum::{
    Router,
    routing::{get, patch, post, put},
};
use crate::db::Db;

pub fn api_router(db: Db) -> Router {
    Router::new()
        .route("/api/health", get(health::health))
        .route("/api/books", get(books::list).post(books::create))
        .route(
            "/api/books/{id}",
            get(books::get).patch(books::update).delete(books::delete),
        )
        .route(
            "/api/books/{id}/chapters",
            post(chapters::create),
        )
        .route(
            "/api/books/{id}/chapters/{number}",
            patch(chapters::update).delete(chapters::delete),
        )
        .route(
            "/api/books/{id}/artifacts",
            put(artifacts::put_artifact),
        )
        .route(
            "/api/books/{id}/artifacts/revisions",
            get(artifacts::list_revs),
        )
        .route(
            "/api/books/{id}/artifacts/revisions/{revId}",
            get(artifacts::get_rev),
        )
        .route(
            "/api/books/{id}/artifacts/revisions/{revId}/diff",
            get(artifacts::diff_rev),
        )
        .route(
            "/api/books/{id}/artifacts/revisions/{revId}/restore",
            post(artifacts::restore_rev),
        )
        .route("/api/settings/provider", get(settings::get_provider).put(settings::put_provider))
        .route("/api/settings/provider/models", get(settings::list_models))
        .route("/api/skills", get(skills::list))
        .route("/api/skills/reload", post(skills::reload))
        .route("/api/skills/for-scene", get(skills::for_scene))
        .route("/api/skills/{id}", patch(skills::patch))
        .route("/api/skills/{id}/prompt-preview", get(skills::preview))
        .route("/api/generations/{id}", get(generations::get))
        .route("/api/generations/{id}/cancel", post(generations::cancel))
        .route("/api/generations/begin", post(generations::begin))
        .merge(stubs::stub_router())
        .with_state(db)
}
