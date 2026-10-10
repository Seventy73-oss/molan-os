//! Import / export ZIP + artifact file.

use axum::{
    Json,
    
    extract::{FromRequest, Multipart, Path, Query, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::IntoResponse,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::books::get_book_payload;
use crate::services::import_book::{
    ImportConflict, export_book_zip, export_chapter_markdown, export_chapter_zip,
    import_book_from_zip_buffer, read_artifact_file,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct FileQuery {
    kind: Option<String>,
    #[serde(rename = "chapterNumber")]
    chapter_number: Option<String>,
}

pub async fn import_book(State(db): State<Db>, req: Request) -> AppResult<impl IntoResponse> {
    let ct = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let (conflict, title, buffer) = if ct.contains("multipart/form-data") {
        let mut multipart = Multipart::from_request(req, &db)
            .await
            .map_err(|e| AppError::BadRequest(format!("multipart 无效：{e}")))?;
        let mut conflict = ImportConflict::parse("new_book");
        let mut title: Option<String> = None;
        let mut buffer: Vec<u8> = Vec::new();
        while let Some(field) = multipart
            .next_field()
            .await
            .map_err(|e| AppError::BadRequest(format!("multipart 字段读取失败：{e}")))?
        {
            let name = field.name().unwrap_or("").to_string();
            match name.as_str() {
                "conflict" => {
                    let text = field
                        .text()
                        .await
                        .map_err(|e| AppError::BadRequest(format!("conflict 字段无效：{e}")))?;
                    conflict = ImportConflict::parse(&text);
                }
                "title" => {
                    let text = field
                        .text()
                        .await
                        .map_err(|e| AppError::BadRequest(format!("title 字段无效：{e}")))?;
                    if !text.trim().is_empty() {
                        title = Some(text);
                    }
                }
                "file" => {
                    let bytes = field
                        .bytes()
                        .await
                        .map_err(|e| AppError::BadRequest(format!("file 字段无效：{e}")))?;
                    buffer = bytes.to_vec();
                }
                _ => {
                    let _ = field.bytes().await;
                }
            }
        }
        (conflict, title, buffer)
    } else {
        let bytes = axum::body::to_bytes(req.into_body(), 100 * 1024 * 1024)
            .await
            .map_err(|e| AppError::BadRequest(format!("读取上传失败：{e}")))?;
        if !(ct.contains("application/json") || ct.contains("+json") || bytes.starts_with(b"{")) {
            return Err(AppError::BadRequest(
                "请上传 zip（multipart file）或 JSON { zipBase64, conflict?, title? }".into(),
            ));
        }
        let v: Value = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::BadRequest(format!("JSON 无效：{e}")))?;
        let conflict =
            ImportConflict::parse(v.get("conflict").and_then(|x| x.as_str()).unwrap_or("new_book"));
        let title = v
            .get("title")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let b64 = v.get("zipBase64").and_then(|x| x.as_str()).unwrap_or("");
        if b64.is_empty() {
            return Err(AppError::BadRequest("请上传 zip 书稿".into()));
        }
        let buf = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| AppError::BadRequest(format!("zipBase64 无效：{e}")))?;
        (conflict, title, buf)
    };

    if buffer.is_empty() {
        return Err(AppError::BadRequest("请上传 zip 书稿".into()));
    }
    let result = import_book_from_zip_buffer(&db, &buffer, conflict, title.as_deref())?;
    let book_id = result.get("bookId").and_then(|v| v.as_str()).unwrap_or("");
    let book = get_book_payload(&db, book_id)?;
    let skipped = result
        .get("skipped")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut out = result;
    if let Some(m) = out.as_object_mut() {
        m.insert("book".into(), book);
    }
    let status = if skipped {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(out)))
}

pub async fn export_zip(
    State(db): State<Db>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let (filename, buffer) =
        export_book_zip(&db, &id).map_err(|e| AppError::BadRequest(e.to_string()))?;
    Ok(zip_response(filename, buffer))
}

pub async fn export_chapter_zip_route(
    State(db): State<Db>,
    Path((id, number)): Path<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let (filename, buffer) = export_chapter_zip(&db, &id, number)
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    Ok(zip_response(filename, buffer))
}

pub async fn export_chapter_md(
    State(db): State<Db>,
    Path((id, number)): Path<(String, i64)>,
) -> AppResult<impl IntoResponse> {
    let (filename, buffer) = export_chapter_markdown(&db, &id, number, "chapter_body")
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    let res = (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/markdown; charset=utf-8"),
            ),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&format!(
                    "attachment; filename*=UTF-8''{}",
                    urlencoding_filename(&filename)
                ))
                .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
            ),
        ],
        buffer,
    );
    Ok(res)
}

pub async fn artifact_file(
    State(db): State<Db>,
    Path(id): Path<String>,
    Query(q): Query<FileQuery>,
) -> AppResult<impl IntoResponse> {
    let kind = q.kind.unwrap_or_default();
    if kind.is_empty() {
        return Err(AppError::BadRequest("缺少稿件类型".into()));
    }
    let chapter_number = match q.chapter_number.as_deref() {
        None | Some("") | Some("null") => None,
        Some(s) => {
            let n: i64 = s
                .parse()
                .map_err(|_| AppError::BadRequest("章节号无效".into()))?;
            Some(n)
        }
    };
    Ok(Json(read_artifact_file(
        &db,
        &id,
        &kind,
        chapter_number,
    )?))
}

fn zip_response(filename: String, buffer: Vec<u8>) -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/zip"),
            ),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&format!(
                    "attachment; filename*=UTF-8''{}",
                    urlencoding_filename(&filename)
                ))
                .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
            ),
        ],
        buffer,
    )
}

fn urlencoding_filename(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
