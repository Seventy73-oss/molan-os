use axum::{Json, extract::State, response::IntoResponse};
use serde_json::Value;
use crate::db::Db;
use crate::error::AppResult;
use crate::services::scene_routes::{list_scene_routes, put_scene_routes};

pub async fn get_routes(State(db): State<Db>) -> AppResult<impl IntoResponse> {
    Ok(Json(list_scene_routes(&db)?))
}

pub async fn put_routes(
    State(db): State<Db>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(put_scene_routes(&db, &body)?))
}
