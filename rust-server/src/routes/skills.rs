use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::{Value, json};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::skills::{
    for_scene_payload, list_skills, prompt_preview, reload_skills, set_skill_enabled, skill_json,
};

#[derive(Debug, Deserialize)]
pub struct ForSceneQuery {
    pub scene: Option<String>,
}

pub async fn list(State(db): State<Db>) -> AppResult<impl IntoResponse> {
    let rows = list_skills(&db)?;
    let mut skills = Vec::with_capacity(rows.len());
    for row in rows {
        skills.push(skill_json(&db, &row)?);
    }
    Ok(Json(json!({ "skills": skills })))
}

pub async fn reload(State(db): State<Db>) -> AppResult<impl IntoResponse> {
    let rows = reload_skills(&db)?;
    let mut skills = Vec::with_capacity(rows.len());
    for row in rows {
        skills.push(skill_json(&db, &row)?);
    }
    Ok(Json(json!({ "skills": skills })))
}

pub async fn patch(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    if let Some(enabled) = body.get("enabled").and_then(|v| v.as_bool()) {
        let row = set_skill_enabled(&db, &id, enabled)?;
        return Ok(Json(skill_json(&db, &row)?));
    }
    let rows = list_skills(&db)?;
    let row = rows
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::NotFound("没有这个技能".into()))?;
    Ok(Json(skill_json(&db, &row)?))
}

pub async fn for_scene(
    State(db): State<Db>,
    Query(q): Query<ForSceneQuery>,
) -> AppResult<impl IntoResponse> {
    let scene = q.scene.unwrap_or_default();
    let scene = scene.trim();
    if scene.is_empty() {
        return Err(AppError::BadRequest("缺少 scene".into()));
    }
    Ok(Json(for_scene_payload(&db, scene)?))
}

pub async fn preview(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(prompt_preview(&db, &id)?))
}
