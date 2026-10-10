pub mod artifacts;
pub mod books;
pub mod chapters;
pub mod features_routes;
pub mod generations;
pub mod health;
pub mod import_export;
pub mod jobs;
pub mod scene_routes;
pub mod settings;
pub mod skills;
pub mod stubs;
pub mod story;
pub mod writing;

use axum::{
    Router,
    routing::{get, patch, post, put},
};
use crate::db::Db;

pub fn api_router(db: Db) -> Router {
    Router::new()
        .route("/api/health", get(health::health))
        .route("/api/jobs/worker", get(jobs::worker_get))
        .route("/api/agent/runtime", get(features_routes::agent_runtime))
        .route("/api/books", get(books::list).post(books::create))
        .route("/api/books/import", post(import_export::import_book))
        .route("/api/books/auto-setup", post(books::auto_setup_new))
        .route(
            "/api/books/{id}",
            get(books::get).patch(books::update).delete(books::delete),
        )
        .route("/api/books/{id}/export.zip", get(import_export::export_zip))
        .route("/api/books/{id}/story-pack.zip", get(import_export::export_story_pack))
        .route("/api/books/import-story-pack", post(import_export::import_story_pack))
        .route(
            "/api/books/{id}/chapters/{number}/export.zip",
            get(import_export::export_chapter_zip_route),
        )
        .route(
            "/api/books/{id}/chapters/{number}/export.md",
            get(import_export::export_chapter_md),
        )
        .route(
            "/api/books/{id}/artifacts/file",
            get(import_export::artifact_file),
        )
        .route("/api/books/{id}/auto-setup", post(books::auto_setup_existing))
        .route("/api/books/{id}/chapters", post(chapters::create))
        .route(
            "/api/books/{id}/chapters/{number}",
            patch(chapters::update).delete(chapters::delete),
        )
        .route("/api/books/{id}/artifacts", put(artifacts::put_artifact))
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
        .route("/api/books/{id}/jobs", get(jobs::list_book_jobs).post(jobs::create_book_job))
        .route("/api/jobs/{id}", get(jobs::get_one).patch(jobs::patch_status))
        .route("/api/jobs/{id}/tick", post(jobs::tick))
        .route("/api/jobs/{id}/retry", post(jobs::retry))
        .route("/api/books/{id}/progress", get(features_routes::progress))
        .route("/api/books/{id}/search", get(features_routes::search))
        .route("/api/books/{id}/bible", get(features_routes::bible_list).post(features_routes::bible_create))
        .route(
            "/api/books/{id}/bible/{cardId}",
            patch(features_routes::bible_patch).delete(features_routes::bible_delete),
        )
        .route("/api/books/{id}/hooks", get(features_routes::hooks_list).patch(features_routes::hooks_patch))
        .route("/api/books/{id}/context-preview", get(features_routes::context_preview))
        .route("/api/books/{id}/review-issues", get(features_routes::review))
        .route("/api/usage", get(features_routes::usage_global))
        .route("/api/usage/summary", get(features_routes::usage_summary_route))
        .route("/api/books/{id}/usage", get(features_routes::usage_book))
        .route("/api/settings/provider", get(settings::get_provider).put(settings::put_provider))
        .route("/api/settings/provider/models", get(settings::list_models))
        .route("/api/settings/provider/test", post(settings::test_provider))
        .route("/api/settings/provider/models/refresh", post(settings::refresh_models))
        .route("/api/scene-routes", get(scene_routes::get_routes).put(scene_routes::put_routes))
        .route("/api/skills", get(skills::list))
        .route("/api/skills/reload", post(skills::reload))
        .route("/api/skills/for-scene", get(skills::for_scene))
        .route("/api/skills/{id}", patch(skills::patch))
        .route("/api/skills/{id}/prompt-preview", get(skills::preview))
        .route("/api/generations/{id}", get(generations::get))
        .route("/api/generations/{id}/cancel", post(generations::cancel))
        .route("/api/generations/begin", post(generations::begin))
        .route("/api/books/{id}/chat", post(writing::post_chat))
        .route("/api/books/{id}/chat/stream", post(writing::post_chat_stream))
        .route("/api/books/{id}/scene-runs", post(writing::post_scene_run))
        .route("/api/books/{id}/scene-runs/stream", post(writing::post_scene_run_stream))
        .route("/api/books/{id}/selection-rewrite", post(writing::post_selection_rewrite))
        .route("/api/books/{id}/selection-rewrite/stream", post(writing::post_selection_rewrite_stream))
        .route("/api/books/{id}/messages", get(writing::get_messages))
        .route("/api/books/{id}/story/head", get(story::book_head))
        .route("/api/books/{id}/story/status", get(story::status_by_number))
        .route(
            "/api/books/{id}/story/chapters/{chapter_id}/finalize",
            post(story::finalize),
        )
        .route(
            "/api/books/{id}/story/chapters/{chapter_id}/status",
            get(story::status),
        )
        .route(
            "/api/books/{id}/story/memory/extract",
            post(story::extract_memory),
        )
        .route(
            "/api/books/{id}/story/memory/proposals/{proposal_id}",
            get(story::get_proposal_route),
        )
        .route(
            "/api/books/{id}/story/memory/proposals/{proposal_id}/apply",
            post(story::apply_proposal_route),
        )
        .route(
            "/api/books/{id}/story/memory/proposals/{proposal_id}/reject",
            post(story::reject_proposal_route),
        )
        .route("/api/books/{id}/story/characters", get(story::characters_list))
        .route(
            "/api/books/{id}/story/characters/{character_id}/state",
            get(story::character_state),
        )
        .route("/api/books/{id}/story/foreshadowing", get(story::foreshadowing_list))
        .route("/api/books/{id}/story/impact", get(story::impact))
        .route("/api/books/{id}/story/publish-check", get(story::publish_check_route))
        .merge(stubs::stub_router())
        .with_state(db)
}
