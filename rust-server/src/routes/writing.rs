//! chat / scene-runs / selection-rewrite (+ SSE stream).

use axum::{
    Json,
    extract::{Path, State},
    response::{
        IntoResponse, Sse,
        sse::{Event, KeepAlive},
    },
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::schema::SCENES;
use crate::services::engine::{
    ExecuteSceneInput, chat, execute_scene, list_messages, rewrite_selection, stream_scene_run,
};
use crate::services::generations::{GenerationStatus, complete_generation};
use crate::services::revisions::OnConflict;
use crate::agent::openai::emit_chunked;
use futures::stream::Stream;
use serde_json::{Value, json};
use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::mpsc;

fn parse_scene(v: Option<&Value>) -> AppResult<String> {
    let s = v.and_then(|x| x.as_str()).unwrap_or("");
    if SCENES.contains(&s) {
        Ok(s.into())
    } else {
        Err(AppError::BadRequest("未知场景".into()))
    }
}

fn parse_expected(body: &Value) -> Option<Option<String>> {
    match body.get("expectedRevisionId") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => v.as_str().map(|s| Some(s.to_string())),
    }
}

fn parse_skill_ids(body: &Value) -> Option<Vec<String>> {
    body.get("skillIds").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect()
    })
}

pub async fn post_scene_run(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let scene = parse_scene(body.get("scene"))?;
    let result = execute_scene(
        &db,
        ExecuteSceneInput {
            book_id: id,
            scene,
            chapter_number: body.get("chapterNumber").and_then(|v| v.as_i64()),
            instruction: body
                .get("instruction")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            skill_ids: parse_skill_ids(&body),
            expected_revision_id: parse_expected(&body),
            on_conflict: if body.get("onConflict").and_then(|v| v.as_str()) == Some("throw") {
                OnConflict::Throw
            } else {
                OnConflict::Candidate
            },
            generation_id: body
                .get("generationId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            cancelled: None,
        },
    )
    .await?;
    Ok(Json(result))
}

pub async fn post_selection_rewrite(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let scene_raw = body.get("scene").and_then(|v| v.as_str());
    let scene = scene_raw.filter(|s| SCENES.contains(s));
    let result = rewrite_selection(
        &db,
        &id,
        body.get("selection").and_then(|v| v.as_str()).unwrap_or(""),
        body.get("instruction").and_then(|v| v.as_str()).unwrap_or(""),
        scene,
    )
    .await?;
    Ok(Json(result))
}

pub async fn post_chat(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    let message = body.get("message").and_then(|v| v.as_str()).unwrap_or("");
    let chapter = body.get("chapterNumber").and_then(|v| v.as_i64());
    let generation_id = body.get("generationId").and_then(|v| v.as_str());
    let result = chat(&db, &id, message, chapter, generation_id, None).await?;
    Ok(Json(result))
}

pub async fn get_messages(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(list_messages(&db, &id)?))
}

fn sse_stream_from_channel(
    mut rx: mpsc::UnboundedReceiver<Value>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        let mut seq = 0u64;
        while let Some(event) = rx.recv().await {
            seq += 1;
            let data = event.to_string();
            yield Ok(Event::default().data(data).id(seq.to_string()));
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub async fn post_scene_run_stream(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let scene = match parse_scene(body.get("scene")) {
        Ok(s) => s,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let cancelled = Arc::new(AtomicBool::new(false));
    let generation_id = body
        .get("generationId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let input = ExecuteSceneInput {
        book_id: id,
        scene,
        chapter_number: body.get("chapterNumber").and_then(|v| v.as_i64()),
        instruction: body
            .get("instruction")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        skill_ids: parse_skill_ids(&body),
        expected_revision_id: parse_expected(&body),
        on_conflict: if body.get("onConflict").and_then(|v| v.as_str()) == Some("throw") {
            OnConflict::Throw
        } else {
            OnConflict::Candidate
        },
        generation_id: generation_id.clone(),
        cancelled: Some(cancelled.clone()),
    };

    tokio::spawn(async move {
        let tx2 = tx.clone();
        match stream_scene_run(&db, tx, input).await {
            Ok(()) => {}
            Err(e) if e.is_abort() => {
                let _ = tx2.send(json!({ "type": "error", "message": "已取消" }));
            }
            Err(e) => {
                let _ = tx2.send(json!({ "type": "error", "message": e.to_string() }));
            }
        }
    });

    sse_stream_from_channel(rx).into_response()
}

pub async fn post_selection_rewrite_stream(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let selection = body
        .get("selection")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let instruction = body
        .get("instruction")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let scene_raw = body.get("scene").and_then(|v| v.as_str()).map(|s| s.to_string());
    let scene = scene_raw
        .as_deref()
        .filter(|s| SCENES.contains(s))
        .map(|s| s.to_string());

    tokio::spawn(async move {
        let tx2 = tx.clone();
        let emit = |event: Value| -> AppResult<()> {
            tx2.send(event)
                .map_err(|_| AppError::Cancelled("已取消".into()))
        };
        let _ = emit(json!({ "type": "status", "message": "正在改写选区…" }));
        match rewrite_selection(
            &db,
            &id,
            &selection,
            &instruction,
            scene.as_deref(),
        )
        .await
        {
            Ok(result) => {
                let text = result.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let mut emit2 = emit;
                if let Err(e) = emit_chunked(
                    text,
                    |delta| emit2(json!({ "type": "token", "text": delta })),
                    24,
                    &None,
                )
                .await
                {
                    let _ = emit2(json!({ "type": "error", "message": e.to_string() }));
                    return;
                }
                let _ = emit2(json!({ "type": "done", "payload": result }));
            }
            Err(e) => {
                let _ = emit(json!({ "type": "error", "message": e.to_string() }));
            }
        }
    });

    sse_stream_from_channel(rx).into_response()
}

pub async fn post_chat_stream(
    State(db): State<Db>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let message = body
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let chapter = body.get("chapterNumber").and_then(|v| v.as_i64());
    let generation_id = body
        .get("generationId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let cancelled = Arc::new(AtomicBool::new(false));

    tokio::spawn(async move {
        let tx2 = tx.clone();
        let emit = |event: Value| -> AppResult<()> {
            tx2.send(event)
                .map_err(|_| AppError::Cancelled("已取消".into()))
        };
        let _ = emit(json!({ "type": "status", "message": "助手正在写…" }));
        match chat(
            &db,
            &id,
            &message,
            chapter,
            generation_id.as_deref(),
            Some(cancelled.clone()),
        )
        .await
        {
            Ok(result) => {
                let body = result
                    .pointer("/message/content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let (head, tail) = match body.find('\n') {
                    Some(i) => (&body[..=i], &body[i + 1..]),
                    None => (body, ""),
                };
                let mut emit2 = emit;
                if !head.is_empty() {
                    let _ = emit2(json!({ "type": "token", "text": head }));
                }
                if !tail.is_empty() {
                    let _ = emit_chunked(
                        tail,
                        |delta| emit2(json!({ "type": "token", "text": delta })),
                        36,
                        &None,
                    )
                    .await;
                }
                if let Some(ref gid) = generation_id {
                    let _ = complete_generation(
                        &db,
                        gid,
                        GenerationStatus::Completed,
                        None,
                        Some(&result),
                        None,
                    );
                }
                let _ = emit2(json!({ "type": "done", "payload": result }));
            }
            Err(e) if e.is_abort() => {
                if let Some(ref gid) = generation_id {
                    let _ = crate::services::generations::cancel_generation(&db, gid);
                }
                let _ = emit(json!({ "type": "error", "message": "已取消" }));
            }
            Err(e) => {
                if let Some(ref gid) = generation_id {
                    let _ = complete_generation(
                        &db,
                        gid,
                        GenerationStatus::Failed,
                        None,
                        None,
                        Some(&e.to_string()),
                    );
                }
                let _ = emit(json!({ "type": "error", "message": e.to_string() }));
            }
        }
    });

    sse_stream_from_channel(rx).into_response()
}
