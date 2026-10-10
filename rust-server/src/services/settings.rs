use crate::crypto::{decrypt_secret, encrypt_secret, env_api_key, key_hint};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::security::assert_safe_base_url;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

const KEY_BASE: &str = "openai_base_url";
const KEY_API: &str = "openai_api_key";
const KEY_DEFAULT: &str = "default_model";
const KEY_CHAT: &str = "chat_model";
const KEY_MODELS: &str = "models_cache";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub base_url: String,
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
    pub default_model: String,
    pub chat_model: String,
    pub configured: bool,
    pub key_source: String,
}

fn read_setting(conn: &rusqlite::Connection, key: &str) -> AppResult<String> {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.unwrap_or_default().trim().to_string())
}

fn write_setting(conn: &rusqlite::Connection, key: &str, value: &str) -> AppResult<()> {
    if value.is_empty() {
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn read_stored_api_key(db: &Db, conn: &rusqlite::Connection) -> AppResult<String> {
    let raw = read_setting(conn, KEY_API)?;
    if raw.is_empty() {
        return Ok(String::new());
    }
    Ok(decrypt_secret(&db.root, &raw).unwrap_or_default())
}

fn maybe_reencrypt(db: &Db, conn: &rusqlite::Connection) -> AppResult<()> {
    let raw = read_setting(conn, KEY_API)?;
    if raw.is_empty() || raw.starts_with("enc:v1:") {
        return Ok(());
    }
    if let Ok(enc) = encrypt_secret(&db.root, &raw) {
        let _ = write_setting(conn, KEY_API, &enc);
    }
    Ok(())
}

pub fn provider_view(db: &Db) -> AppResult<ProviderView> {
    db.with_conn(|conn| {
        maybe_reencrypt(db, conn)?;
        let stored_key = read_stored_api_key(db, conn)?;
        let env_key = env_api_key();
        let shown = if !env_key.is_empty() {
            env_key.clone()
        } else {
            stored_key.clone()
        };
        let key_source = if !env_key.is_empty() {
            "env"
        } else if !stored_key.is_empty() {
            "stored"
        } else {
            "none"
        };
        Ok(ProviderView {
            base_url: read_setting(conn, KEY_BASE)?,
            has_api_key: !shown.is_empty(),
            api_key_hint: key_hint(&shown),
            default_model: read_setting(conn, KEY_DEFAULT)?,
            chat_model: read_setting(conn, KEY_CHAT)?,
            configured: !shown.is_empty(),
            key_source: key_source.into(),
        })
    })
    
}

pub fn save_provider(db: &Db, body: &Value) -> AppResult<ProviderView> {
    db.with_conn(|conn| {
        maybe_reencrypt(db, conn)?;
        if let Some(base) = body.get("baseUrl").and_then(|v| v.as_str()) {
            let next = if base.trim().is_empty() {
                String::new()
            } else {
                assert_safe_base_url(base, false)?
            };
            let clear = body.get("clearApiKey").and_then(|v| v.as_bool()) == Some(true);
            let incoming_key = body
                .get("apiKey")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let will_have_stored = !clear
                && (incoming_key.is_some() || !read_stored_api_key(db, conn)?.is_empty());
            if !next.is_empty() && (will_have_stored || !env_api_key().is_empty()) {
                assert_safe_base_url(&next, true)?;
            }
            write_setting(conn, KEY_BASE, &next)?;
        }
        if body.get("clearApiKey").and_then(|v| v.as_bool()) == Some(true) {
            write_setting(conn, KEY_API, "")?;
        } else if let Some(api) = body.get("apiKey").and_then(|v| v.as_str()) {
            let plain = api.trim();
            if !plain.is_empty() {
                if plain.starts_with("enc:v1:") {
                    return Err(AppError::BadRequest("无效的 API Key".into()));
                }
                let enc = encrypt_secret(&db.root, plain)
                    .map_err(|e| AppError::BadRequest(e.to_string()))?;
                write_setting(conn, KEY_API, &enc)?;
            }
        }
        if let Some(m) = body.get("defaultModel").and_then(|v| v.as_str()) {
            write_setting(conn, KEY_DEFAULT, m.trim())?;
        }
        if let Some(m) = body.get("chatModel").and_then(|v| v.as_str()) {
            write_setting(conn, KEY_CHAT, m.trim())?;
        }
        Ok(())
    })?;
    provider_view(db)
}

pub fn get_models_list(db: &Db) -> AppResult<Value> {
    let view = provider_view(db)?;
    let cache: Option<Value> = db.with_conn(|conn| {
        let raw = read_setting(conn, KEY_MODELS)?;
        if raw.is_empty() {
            return Ok(None);
        }
        Ok(serde_json::from_str(&raw).ok())
    })?;
    if !view.configured && env_api_key().is_empty() {
        return Ok(json!({
            "models": cache.as_ref().and_then(|c| c.get("models")).cloned().unwrap_or_else(|| json!([])),
            "fetchedAt": cache.as_ref().and_then(|c| c.get("fetchedAt")).cloned().unwrap_or(Value::Null),
            "error": "还没有配置 API Key，无法拉取模型列表",
        }));
    }
    Ok(json!({
        "models": cache.as_ref().and_then(|c| c.get("models")).cloned().unwrap_or_else(|| json!([])),
        "fetchedAt": cache.as_ref().and_then(|c| c.get("fetchedAt")).cloned().unwrap_or(Value::Null),
        "error": cache.as_ref().and_then(|c| c.get("error")).cloned(),
    }))
}


#[derive(Debug, Clone)]
pub struct ResolvedProvider {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub has_stored_key: bool,
    pub using_stored_key: bool,
    pub key_source: String,
}

/// Resolve credentials for outbound calls. Env key wins over DB.
pub fn resolve_provider(db: &Db, route: Option<&Value>) -> AppResult<Value> {
    let resolved = resolve_provider_inner(db, route)?;
    Ok(json!({
        "apiKey": resolved.api_key,
        "baseUrl": resolved.base_url,
        "model": resolved.model,
        "hasStoredKey": resolved.has_stored_key,
        "usingStoredKey": resolved.using_stored_key,
        "keySource": resolved.key_source,
    }))
}

pub fn resolve_provider_inner(db: &Db, route: Option<&Value>) -> AppResult<ResolvedProvider> {
    db.with_conn(|conn| {
        maybe_reencrypt(db, conn)?;
        let stored_key = read_stored_api_key(db, conn)?;
        let env_key = env_api_key();
        let stored_base = read_setting(conn, KEY_BASE)?;
        let stored_default = read_setting(conn, KEY_DEFAULT)?;
        let stored_chat = read_setting(conn, KEY_CHAT)?;
        let api_key = if !env_key.is_empty() {
            env_key.clone()
        } else {
            stored_key.clone()
        };
        let route_base = route
            .and_then(|r| r.get("base_url").or_else(|| r.get("baseUrl")))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let env_base = std::env::var("OPENAI_BASE_URL")
            .or_else(|_| std::env::var("MOLAN_BASE_URL"))
            .unwrap_or_default();
        let mut base_url = if !route_base.is_empty() {
            route_base
        } else if !stored_base.is_empty() {
            stored_base
        } else if !env_base.trim().is_empty() {
            env_base.trim().to_string()
        } else {
            "https://api.openai.com/v1".into()
        };
        if !base_url.is_empty() {
            base_url = assert_safe_base_url(&base_url, !api_key.is_empty())?;
        }
        let route_model = route
            .and_then(|r| r.get("model_id").or_else(|| r.get("modelId")))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let env_model = std::env::var("OPENAI_MODEL")
            .or_else(|_| std::env::var("MOLAN_MODEL"))
            .unwrap_or_default();
        let model = if !route_model.is_empty() && route_model != "local-draft" {
            route_model
        } else if !stored_chat.is_empty() {
            stored_chat
        } else if !stored_default.is_empty() {
            stored_default
        } else {
            env_model.trim().to_string()
        };
        let key_source = if !env_key.is_empty() {
            "env"
        } else if !stored_key.is_empty() {
            "stored"
        } else {
            "none"
        };
        Ok(ResolvedProvider {
            api_key,
            base_url,
            model,
            has_stored_key: !stored_key.is_empty(),
            using_stored_key: !stored_key.is_empty() && env_key.is_empty(),
            key_source: key_source.into(),
        })
    })
}

fn write_cache(conn: &rusqlite::Connection, payload: &Value) -> AppResult<()> {
    write_setting(conn, KEY_MODELS, &payload.to_string())
}

fn read_cache(conn: &rusqlite::Connection) -> AppResult<Option<Value>> {
    let raw = read_setting(conn, KEY_MODELS)?;
    if raw.is_empty() {
        return Ok(None);
    }
    Ok(serde_json::from_str(&raw).ok())
}

pub async fn refresh_models(db: &Db, _force: bool) -> AppResult<Value> {
    use crate::outbound::{MODEL_FETCH_RETRIES, MODEL_FETCH_RETRY_BACKOFF_MS, SecureFetchOptions, secure_fetch};
    use crate::security::redact_secrets;
    use reqwest::Method;

    let resolved = match resolve_provider_inner(db, None) {
        Ok(r) => r,
        Err(e) => {
            let cache = db.with_conn(|c| read_cache(c))?;
            return Ok(json!({
                "models": cache.as_ref().and_then(|c| c.get("models")).cloned().unwrap_or(json!([])),
                "fetchedAt": cache.as_ref().and_then(|c| c.get("fetchedAt")).cloned().unwrap_or(Value::Null),
                "error": redact_secrets(&e.to_string()),
            }));
        }
    };
    let existing = db.with_conn(|c| read_cache(c))?;
    if resolved.api_key.is_empty() {
        return Ok(json!({
            "models": existing.as_ref().and_then(|c| c.get("models")).cloned().unwrap_or(json!([])),
            "fetchedAt": existing.as_ref().and_then(|c| c.get("fetchedAt")).cloned().unwrap_or(Value::Null),
            "error": "还没有 API Key",
        }));
    }
    if resolved.base_url.is_empty() {
        return Ok(json!({
            "models": existing.as_ref().and_then(|c| c.get("models")).cloned().unwrap_or(json!([])),
            "fetchedAt": existing.as_ref().and_then(|c| c.get("fetchedAt")).cloned().unwrap_or(Value::Null),
            "error": "还没有 Base URL",
        }));
    }
    let url = format!("{}/models", resolved.base_url.trim_end_matches('/'));
    match secure_fetch(
        &url,
        SecureFetchOptions {
            method: Method::GET,
            headers: vec![("Authorization".into(), format!("Bearer {}", resolved.api_key))],
            body: None,
            with_api_key: Some(true),
            timeout_ms: 15_000,
            retries: MODEL_FETCH_RETRIES,
            retry_backoff_ms: MODEL_FETCH_RETRY_BACKOFF_MS,
        },
    )
    .await
    {
        Ok(resp) if resp.status().is_success() => {
            let data: Value = resp.json().await.unwrap_or(json!({}));
            let mut models: Vec<Value> = data
                .get("data")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.to_string();
                    if id.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "id": id,
                        "ownedBy": item.get("owned_by").and_then(|v| v.as_str()),
                    }))
                })
                .collect();
            models.sort_by(|a, b| {
                a.get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .cmp(b.get("id").and_then(|v| v.as_str()).unwrap_or(""))
            });
            let payload = json!({
                "models": models,
                "fetchedAt": crate::db::now_iso(),
            });
            db.with_conn(|c| write_cache(c, &payload))?;
            Ok(json!({
                "models": payload["models"].clone(),
                "fetchedAt": payload["fetchedAt"].clone(),
                "error": Value::Null,
            }))
        }
        Ok(resp) => {
            let status = resp.status().as_u16();
            let detail = redact_secrets(&resp.text().await.unwrap_or_default());
            let error = format!("HTTP {status}{detail}");
            let payload = json!({
                "models": existing.as_ref().and_then(|c| c.get("models")).cloned().unwrap_or(json!([])),
                "fetchedAt": crate::db::now_iso(),
                "error": error,
            });
            db.with_conn(|c| write_cache(c, &payload))?;
            Ok(json!({
                "models": payload["models"].clone(),
                "fetchedAt": payload["fetchedAt"].clone(),
                "error": payload["error"].clone(),
            }))
        }
        Err(e) => {
            let reason = redact_secrets(&e.to_string());
            let payload = json!({
                "models": existing.as_ref().and_then(|c| c.get("models")).cloned().unwrap_or(json!([])),
                "fetchedAt": crate::db::now_iso(),
                "error": reason,
            });
            db.with_conn(|c| write_cache(c, &payload))?;
            Ok(json!({
                "models": payload["models"].clone(),
                "fetchedAt": payload["fetchedAt"].clone(),
                "error": payload["error"].clone(),
            }))
        }
    }
}

pub async fn test_provider(db: &Db, input: &Value) -> AppResult<Value> {
    use crate::outbound::{MODEL_FETCH_RETRIES, MODEL_FETCH_RETRY_BACKOFF_MS, SecureFetchOptions, secure_fetch};
    use crate::security::{assert_safe_base_url, assert_safe_base_url_resolved, redact_secrets};
    use reqwest::Method;

    let saved = resolve_provider_inner(db, None).unwrap_or_else(|_| {
        let stored = db
            .with_conn(|c| read_stored_api_key(db, c))
            .unwrap_or_default();
        let env_key = env_api_key();
        ResolvedProvider {
            api_key: if !env_key.is_empty() { env_key } else { stored.clone() },
            base_url: db.with_conn(|c| read_setting(c, KEY_BASE)).unwrap_or_default(),
            model: String::new(),
            has_stored_key: !stored.is_empty(),
            using_stored_key: false,
            key_source: "none".into(),
        }
    });

    let typed_key = input
        .get("apiKey")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let api_key = if !typed_key.is_empty() {
        typed_key
    } else {
        saved.api_key.clone()
    };
    let with_api_key = !api_key.is_empty();

    let mut base_url = saved.base_url.clone();
    if let Some(b) = input.get("baseUrl").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        base_url = assert_safe_base_url(b, with_api_key)?;
    } else if !base_url.is_empty() {
        base_url = assert_safe_base_url(&base_url, with_api_key)?;
    }

    let model = input
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "local-draft")
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| if saved.model.is_empty() { None } else { Some(saved.model.clone()) })
        .unwrap_or_else(|| "gpt-4o-mini".into());

    if api_key.is_empty() {
        return Ok(json!({ "ok": false, "model": model, "error": "还没有 API Key" }));
    }
    if base_url.is_empty() {
        return Ok(json!({ "ok": false, "model": model, "error": "还没有 Base URL" }));
    }

    let safe = assert_safe_base_url_resolved(&base_url, with_api_key)?;
    let url = format!("{}/chat/completions", safe.trim_end_matches('/'));
    let body = json!({
        "model": model,
        "max_tokens": 1,
        "temperature": 0,
        "messages": [{"role": "user", "content": "ping"}],
    });
    match secure_fetch(
        &url,
        SecureFetchOptions {
            method: Method::POST,
            headers: vec![
                ("Content-Type".into(), "application/json".into()),
                ("Authorization".into(), format!("Bearer {api_key}")),
            ],
            body: Some(body.to_string()),
            with_api_key: Some(true),
            timeout_ms: 12_000,
            retries: MODEL_FETCH_RETRIES,
            retry_backoff_ms: MODEL_FETCH_RETRY_BACKOFF_MS,
        },
    )
    .await
    {
        Ok(resp) if resp.status().is_success() => Ok(json!({ "ok": true, "model": model })),
        Ok(resp) => {
            let status = resp.status().as_u16();
            let detail = redact_secrets(&resp.text().await.unwrap_or_default());
            Ok(json!({ "ok": false, "model": model, "error": format!("HTTP {status} {detail}") }))
        }
        Err(e) => Ok(json!({
            "ok": false,
            "model": model,
            "error": redact_secrets(&e.to_string()),
        })),
    }
}
