//! API usage ledger — parity with Node usage.ts.

use crate::db::{Db, now_iso};
use crate::error::AppResult;
use rusqlite::params;
use serde_json::{Value, json};
use uuid::Uuid;

fn estimate_cost(model: &str, prompt: i64, completion: i64) -> f64 {
    let (inp, out) = if regex::Regex::new(r"(?i)gpt-4o-mini").unwrap().is_match(model) {
        (0.15, 0.6)
    } else if regex::Regex::new(r"(?i)gpt-4o").unwrap().is_match(model) {
        (2.5, 10.0)
    } else if regex::Regex::new(r"(?i)deepseek").unwrap().is_match(model) {
        (0.27, 1.1)
    } else if regex::Regex::new(r"(?i)moonshot|kimi").unwrap().is_match(model) {
        (1.0, 1.0)
    } else if regex::Regex::new(r"(?i)claude-3-5|claude-sonnet").unwrap().is_match(model) {
        (3.0, 15.0)
    } else if regex::Regex::new(r"(?i)local").unwrap().is_match(model) {
        (0.0, 0.0)
    } else {
        (0.5, 1.5)
    };
    (prompt as f64 / 1_000_000.0) * inp + (completion as f64 / 1_000_000.0) * out
}

fn map_row(
    id: String,
    book_id: Option<String>,
    scene: String,
    model: String,
    provider: String,
    prompt: i64,
    completion: i64,
    total: i64,
    cost: f64,
    local: i64,
    meta_json: Option<String>,
    created_at: String,
) -> Value {
    let meta = meta_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    json!({
        "id": id,
        "bookId": book_id,
        "scene": scene,
        "model": model,
        "provider": provider,
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": total,
        "estimatedCost": cost,
        "local": local == 1,
        "meta": meta,
        "createdAt": created_at,
    })
}

pub fn list_usage(db: &Db, book_id: Option<&str>, limit: i64) -> AppResult<Vec<Value>> {
    let limit = limit.clamp(1, 200);
    db.with_conn(|conn| {
        let mut out = Vec::new();
        if let Some(bid) = book_id {
            let mut stmt = conn.prepare(
                "SELECT id, book_id, scene, model, provider, prompt_tokens, completion_tokens, total_tokens,
                        estimated_cost, local, meta_json, created_at
                 FROM api_usage WHERE book_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![bid, limit], |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                    r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                    r.get(10)?, r.get(11)?,
                ))
            })?;
            for row in rows {
                let r = row?;
                out.push(map_row(r.0, r.1, r.2, r.3, r.4, r.5, r.6, r.7, r.8, r.9, r.10, r.11));
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, book_id, scene, model, provider, prompt_tokens, completion_tokens, total_tokens,
                        estimated_cost, local, meta_json, created_at
                 FROM api_usage ORDER BY created_at DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit], |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                    r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                    r.get(10)?, r.get(11)?,
                ))
            })?;
            for row in rows {
                let r = row?;
                out.push(map_row(r.0, r.1, r.2, r.3, r.4, r.5, r.6, r.7, r.8, r.9, r.10, r.11));
            }
        }
        Ok(out)
    })
}

pub fn usage_summary(db: &Db, book_id: Option<&str>) -> AppResult<Value> {
    db.with_conn(|conn| {
        let (calls, prompt, completion, total, cost, local_calls): (i64, i64, i64, i64, f64, i64) =
            if let Some(bid) = book_id {
                conn.query_row(
                    "SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0),
                            COALESCE(SUM(total_tokens),0), COALESCE(SUM(estimated_cost),0),
                            COALESCE(SUM(CASE WHEN local = 1 THEN 1 ELSE 0 END),0)
                     FROM api_usage WHERE book_id = ?1",
                    params![bid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )?
            } else {
                conn.query_row(
                    "SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0),
                            COALESCE(SUM(total_tokens),0), COALESCE(SUM(estimated_cost),0),
                            COALESCE(SUM(CASE WHEN local = 1 THEN 1 ELSE 0 END),0)
                     FROM api_usage",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )?
            };
        Ok(json!({
            "calls": calls,
            "promptTokens": prompt,
            "completionTokens": completion,
            "totalTokens": total,
            "estimatedCost": cost,
            "localCalls": local_calls,
        }))
    })
}

#[allow(dead_code)]
pub fn record_usage(
    db: &Db,
    book_id: Option<&str>,
    scene: &str,
    model: &str,
    provider: &str,
    prompt: i64,
    completion: i64,
    local: bool,
) -> AppResult<Value> {
    let prompt = prompt.max(0);
    let completion = completion.max(0);
    let total = prompt + completion;
    let local = local || regex::Regex::new(r"(?i)local").unwrap().is_match(model);
    let cost = if local { 0.0 } else { estimate_cost(model, prompt, completion) };
    let id = Uuid::new_v4().to_string();
    let created = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO api_usage
              (id, book_id, scene, model, provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost, local, meta_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)"#,
            params![
                id,
                book_id,
                scene,
                model,
                if provider.is_empty() { if local { "local" } else { "openai" } } else { provider },
                prompt,
                completion,
                total,
                cost,
                if local { 1 } else { 0 },
                created
            ],
        )?;
        Ok(())
    })?;
    Ok(json!({
        "id": id,
        "bookId": book_id,
        "scene": scene,
        "model": model,
        "provider": provider,
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": total,
        "estimatedCost": cost,
        "local": local,
        "createdAt": created,
    }))
}
