pub mod books;
pub mod health;
pub mod settings;
pub mod stubs;

use axum::{
    Router,
    routing::get,
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
        .route("/api/settings/provider", get(settings::get_provider).put(settings::put_provider))
        .route("/api/settings/provider/models", get(settings::list_models))
        // Stubs for remaining Hono surface — return 501 with clear message
        .merge(stubs::stub_router())
        .with_state(db)
}
