use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::{Value, json};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::revisions::{
    OnConflict, SaveRevisionInput, diff_revisions, get_revision_body, list_revisions,
    restore_revision, save_revision,
};

#[derive(Debug, Deserialize)]
pub struct RevisionsQuery {
    pub kind: Option<String>,
    #[serde(rename = "chapterNumber")]
    pub chapter_number: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    pub against: Option<String>,
}

fn parse_expected(body: &Value) -> Option<Option<String>> {
    match body.get("expectedRevisionId") {
        None => None,
        Some(v) if v.is_null() => Some(None),
        Some(v) => v.as_str().map(|s| Some(s.to_string())),
    }
}

pub async fn put_artifact(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let kind = body
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if kind.is_empty() {
        return Err(AppError::BadRequest("缺少稿件类型".into()));
    }
    if !valid_artifact_kind(&kind) {
        return Err(AppError::BadRequest("稿件类型无效".into()));
    }
    let chapter_number = body.get("chapterNumber").and_then(|v| v.as_i64());
    let chapter_id = body
        .get("chapterId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let skill_ids = body
        .get("skillIds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let saved = save_revision(
        &db,
        SaveRevisionInput {
            book_id: id,
            kind,
            chapter_number,
            chapter_id,
            body: body
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            source: if body.get("source").and_then(|v| v.as_str()) == Some("agent") {
                "agent".into()
            } else {
                "human".into()
            },
            model: body
                .get("model")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            skill_ids,
            scene: body
                .get("scene")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            expected_revision_id: parse_expected(&body),
            as_candidate: body.get("asCandidate").and_then(|v| v.as_bool()).unwrap_or(false),
            on_conflict: OnConflict::Throw,
            source_revision_id: body
                .get("sourceRevisionId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            skip_memory: true,
        },
    )?;
    Ok(Json(saved))
}

pub async fn list_revs(
    State(db): State<Db>,
    Path(id): Path<String>,
    Query(q): Query<RevisionsQuery>,
) -> AppResult<impl IntoResponse> {
    let kind = q.kind.unwrap_or_default();
    if kind.is_empty() {
        return Err(AppError::BadRequest("缺少稿件类型".into()));
    }
    let chapter_number = match q.chapter_number.as_deref() {
        None | Some("") | Some("null") => None,
        Some(raw) => {
            let n: i64 = raw
                .parse()
                .map_err(|_| AppError::BadRequest("章节号无效".into()))?;
            Some(n)
        }
    };
    Ok(Json(json!({
        "revisions": list_revisions(&db, &id, &kind, chapter_number)?
    })))
}

pub async fn get_rev(
    State(db): State<Db>,
    Path((id, rev_id)): Path<(String, String)>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(get_revision_body(&db, &id, &rev_id)?))
}

pub async fn diff_rev(
    State(db): State<Db>,
    Path((id, rev_id)): Path<(String, String)>,
    Query(q): Query<DiffQuery>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(diff_revisions(
        &db,
        &id,
        &rev_id,
        q.against.as_deref(),
    )?))
}

pub async fn restore_rev(
    State(db): State<Db>,
    Path((id, rev_id)): Path<(String, String)>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(restore_revision(&db, &id, &rev_id)?))
}

/// ACC60：稿件类型只允许 [a-z_]{1,40}
pub fn valid_artifact_kind(kind: &str) -> bool {
    !kind.is_empty() && kind.len() <= 40 && kind.chars().all(|c| c.is_ascii_lowercase() || c == '_')
}

#[cfg(test)]
mod acc60_tests {
    #[test]
    fn artifact_kind_validation() {
        assert!(super::valid_artifact_kind("chapter_body"));
        assert!(!super::valid_artifact_kind("../../etc"));
        assert!(!super::valid_artifact_kind(""));
    }
}
