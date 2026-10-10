//! G2 story ledger HTTP routes.

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

/// Distinguishes JSON field omitted vs null vs string (serde Option alone cannot).
#[derive(Debug, Default)]
pub enum ExplicitOptString {
    #[default]
    Missing,
    Null,
    Present(String),
}

impl<'de> Deserialize<'de> for ExplicitOptString {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Option::<String>::deserialize(deserializer)? {
            None => Ok(Self::Null),
            Some(s) => Ok(Self::Present(s)),
        }
    }
}


use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::story::{
    ApplyProposalInput, FinalizeInput, apply_proposal, chapter_story_status,
    chapter_story_status_by_number, finalize_chapter, get_book_head, get_proposal, reject_proposal,
};
use crate::services::story_state::{list_foreshadowing, list_story_characters, project_character_state, story_impact};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeBody {
    pub body_revision_id: String,
    /// Omitted → Missing; JSON null → Null; string → Present.
    #[serde(default)]
    pub expected_publication_id: ExplicitOptString,
    pub expected_current_revision_id: Option<String>,
    pub expected_story_epoch: Option<i64>,
    pub idempotency_key: String,
    pub accepted_by: Option<String>,
}

pub async fn finalize(
    State(db): State<Db>,
    Path((book_id, chapter_id)): Path<(String, String)>,
    Json(body): Json<FinalizeBody>,
) -> AppResult<Json<Value>> {
    let expected_publication_id = match body.expected_publication_id {
        ExplicitOptString::Missing => None,
        ExplicitOptString::Null => Some(None),
        ExplicitOptString::Present(s) => Some(Some(s)),
    };
    let result = finalize_chapter(
        &db,
        FinalizeInput {
            book_id,
            chapter_id,
            body_revision_id: body.body_revision_id,
            expected_publication_id,
            expected_current_revision_id: body.expected_current_revision_id,
            expected_story_epoch: body.expected_story_epoch,
            idempotency_key: body.idempotency_key,
            accepted_by: body.accepted_by.unwrap_or_else(|| "author".into()),
        },
    )?;
    Ok(Json(result))
}

pub async fn status(
    State(db): State<Db>,
    Path((book_id, chapter_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    Ok(Json(chapter_story_status(&db, &book_id, &chapter_id)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusByNumberQuery {
    pub chapter_number: Option<i64>,
}

pub async fn status_by_number(
    State(db): State<Db>,
    Path(book_id): Path<String>,
    Query(q): Query<StatusByNumberQuery>,
) -> AppResult<Json<Value>> {
    let n = q
        .chapter_number
        .ok_or_else(|| AppError::BadRequest("chapterNumber required".into()))?;
    Ok(Json(chapter_story_status_by_number(&db, &book_id, n)?))
}

pub async fn book_head(
    State(db): State<Db>,
    Path(book_id): Path<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(get_book_head(&db, &book_id)?))
}

pub async fn get_proposal_route(
    State(db): State<Db>,
    Path((book_id, proposal_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    Ok(Json(get_proposal(&db, &book_id, &proposal_id)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBody {
    pub accepted_operation_ids: Vec<String>,
    pub expected_source_revision_id: String,
    pub expected_story_epoch: Option<i64>,
    pub idempotency_key: String,
}

pub async fn apply_proposal_route(
    State(db): State<Db>,
    Path((book_id, proposal_id)): Path<(String, String)>,
    Json(body): Json<ApplyBody>,
) -> AppResult<Json<Value>> {
    let result = apply_proposal(
        &db,
        ApplyProposalInput {
            book_id,
            proposal_id,
            accepted_operation_ids: body.accepted_operation_ids,
            expected_source_revision_id: body.expected_source_revision_id,
            expected_story_epoch: body.expected_story_epoch,
            idempotency_key: body.idempotency_key,
        },
    )?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectBody {
    pub reason: Option<String>,
}

pub async fn reject_proposal_route(
    State(db): State<Db>,
    Path((book_id, proposal_id)): Path<(String, String)>,
    body: Option<Json<RejectBody>>,
) -> AppResult<Json<Value>> {
    let reason = body.and_then(|b| b.reason.clone());
    Ok(Json(reject_proposal(
        &db,
        &book_id,
        &proposal_id,
        reason.as_deref(),
    )?))
}

/// Schedule extract for an active publication (idempotent enqueue helper).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractBody {
    pub publication_id: Option<String>,
    pub chapter_number: Option<i64>,
}

pub async fn extract_memory(
    State(db): State<Db>,
    Path(book_id): Path<String>,
    Json(body): Json<ExtractBody>,
) -> AppResult<Json<Value>> {
    let status = if let Some(n) = body.chapter_number {
        chapter_story_status_by_number(&db, &book_id, n)?
    } else if let Some(pid) = body.publication_id.as_deref() {
        // Look up chapter from publication
        let chapter_id: String = db.with_conn(|conn| {
            conn.query_row(
                "SELECT chapter_id FROM chapter_publications WHERE id = ?1 AND book_id = ?2",
                rusqlite::params![pid, book_id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::NotFound("定稿不存在".into()))
        })?;
        chapter_story_status(&db, &book_id, &chapter_id)?
    } else {
        return Err(AppError::BadRequest(
            "publicationId 或 chapterNumber 必填".into(),
        ));
    };
    let pub_obj = status
        .get("publication")
        .cloned()
        .unwrap_or(json!(null));
    if pub_obj.is_null() {
        return Err(AppError::BadRequest("本章尚无活跃定稿，请先定稿".into()));
    }
    let chapter_number = status
        .get("chapterNumber")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let body_rev = pub_obj
        .get("bodyRevisionId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    crate::services::memory::schedule_publication_memory_extract(
        db.clone(),
        book_id.clone(),
        chapter_number,
        body_rev,
    );
    Ok(Json(json!({
        "ok": true,
        "memoryState": "pending",
        "publicationId": pub_obj.get("id"),
        "note": "已安排记忆抽取为提案，需作者批准后才写入正式记忆",
    })))
}


#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsOfQuery {
    pub as_of_chapter: Option<i64>,
    pub knowledge_mode: Option<String>,
    pub chapter_id: Option<String>,
    pub chapter_number: Option<i64>,
}

pub async fn characters_list(
    State(db): State<Db>,
    Path(book_id): Path<String>,
    Query(q): Query<AsOfQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(list_story_characters(&db, &book_id, q.as_of_chapter)?))
}

pub async fn character_state(
    State(db): State<Db>,
    Path((book_id, character_id)): Path<(String, String)>,
    Query(q): Query<AsOfQuery>,
) -> AppResult<Json<Value>> {
    let mode = q.knowledge_mode.as_deref().unwrap_or("author");
    Ok(Json(project_character_state(
        &db,
        &book_id,
        &character_id,
        q.as_of_chapter,
        mode,
    )?))
}

pub async fn foreshadowing_list(
    State(db): State<Db>,
    Path(book_id): Path<String>,
    Query(q): Query<AsOfQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(list_foreshadowing(&db, &book_id, q.as_of_chapter)?))
}

pub async fn impact(
    State(db): State<Db>,
    Path(book_id): Path<String>,
    Query(q): Query<AsOfQuery>,
) -> AppResult<Json<Value>> {
    let chapter_id = if let Some(id) = q.chapter_id {
        id
    } else if let Some(n) = q.chapter_number {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT id FROM chapters WHERE book_id = ?1 AND number = ?2",
                rusqlite::params![book_id, n],
                |r| r.get::<_, String>(0),
            )
            .map_err(|_| AppError::NotFound("章节不存在".into()))
        })?
    } else {
        return Err(AppError::BadRequest("chapterId 或 chapterNumber 必填".into()));
    };
    Ok(Json(story_impact(&db, &book_id, &chapter_id)?))
}
