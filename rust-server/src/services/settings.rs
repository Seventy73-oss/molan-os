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
