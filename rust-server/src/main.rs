mod crypto;
mod thinking;
mod outbound;
mod agent;
mod db;
mod error;
mod routes;
mod schema;
mod security;
mod services;

use axum::http::{HeaderValue, Method};
use db::Db;
use security::listen_hostname;
use std::net::SocketAddr;
use std::path::PathBuf;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

fn project_root() -> PathBuf {
    if let Ok(p) = std::env::var("MOLAN_ROOT") {
        let p = p.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    // rust-server/ is one level under repo root
    let exe_related = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    exe_related
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(exe_related)
}

fn cors_layer() -> CorsLayer {
    let mut origins = vec![
        "http://127.0.0.1:5173".to_string(),
        "http://localhost:5173".to_string(),
        "http://127.0.0.1:5174".to_string(),
        "http://localhost:5174".to_string(),
    ];
    if let Ok(extra) = std::env::var("MOLAN_CORS_ORIGINS") {
        for o in extra.split(',') {
            let o = o.trim();
            if !o.is_empty() {
                origins.push(o.to_string());
            }
        }
    }
    let list: Vec<HeaderValue> = origins
        .into_iter()
        .filter_map(|o| o.parse().ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(list))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(tower_http::cors::Any)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("molan_api=info".parse()?))
        .init();

    let root = project_root();
    let db = Db::open(root.clone())?;
    let app = routes::api_router(db.clone()).layer(TraceLayer::new_for_http()).layer(cors_layer());

    let host = listen_hostname();
    // Default 8788 so Node :8787 can keep running during dual-stack rewrite.
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8788);
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    tracing::info!(
        "墨兰写作 Rust API http://{}  db=sqlite:{}  root={}",
        addr,
        db.path.display(),
        root.display()
    );
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
