use axum::{Json, extract::State, response::IntoResponse};
use serde_json::Value;
use crate::db::Db;
use crate::error::AppResult;
use crate::services::settings::{
    get_models_list, provider_view, refresh_models as refresh_models_svc, save_provider,
    test_provider as test_provider_svc,
};

pub async fn get_provider(State(db): State<Db>) -> AppResult<impl IntoResponse> {
    Ok(Json(provider_view(&db)?))
}

pub async fn put_provider(
    State(db): State<Db>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(save_provider(&db, &body)?))
}

pub async fn list_models(State(db): State<Db>) -> AppResult<impl IntoResponse> {
    Ok(Json(get_models_list(&db)?))
}

pub async fn test_provider(
    State(db): State<Db>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(test_provider_svc(&db, &body).await?))
}

pub async fn refresh_models(State(db): State<Db>) -> AppResult<impl IntoResponse> {
    Ok(Json(refresh_models_svc(&db, true).await?))
}
