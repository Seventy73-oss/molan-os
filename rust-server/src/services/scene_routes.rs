//! Scene routes GET/PUT — parity with Node `/api/scene-routes`.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::schema::SCENES;
use crate::security::{assert_safe_base_url, redact_secrets};
use crate::thinking::normalize_thinking;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub fn list_scene_routes(db: &Db) -> AppResult<Value> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT scene, provider, model_id, base_url, thinking_intensity FROM scene_routes",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let routes: Vec<Value> = rows
            .into_iter()
            .map(|(scene, provider, model_id, base_url, thinking)| {
                json!({
                    "scene": scene,
                    "provider": provider,
                    "modelId": model_id,
                    "baseUrl": base_url,
                    "thinkingIntensity": normalize_thinking(thinking.as_deref()).as_str(),
                })
            })
            .collect();
        Ok(json!({ "routes": routes }))
    })
}

pub fn put_scene_routes(db: &Db, body: &Value) -> AppResult<Value> {
    let routes = body
        .get("routes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for route in &routes {
            if !route.is_object() {
                continue;
            }
            let scene = route
                .get("scene")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !SCENES.contains(&scene) {
                return Err(AppError::BadRequest(format!("未知场景：{scene}")));
            }
            let provider = match route.get("provider").and_then(|v| v.as_str()).unwrap_or("local") {
                "openai" => "openai",
                "pi" => "pi",
                _ => "local",
            };
            let model_id = route
                .get("modelId")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("local-draft");
            let mut base_url = route
                .get("baseUrl")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            if let Some(ref b) = base_url {
                match assert_safe_base_url(b, true) {
                    Ok(cleaned) => base_url = Some(cleaned),
                    Err(e) => {
                        return Err(AppError::BadRequest(redact_secrets(&e.to_string())));
                    }
                }
            }
            let thinking = normalize_thinking(
                route
                    .get("thinkingIntensity")
                    .or_else(|| route.get("thinking_intensity"))
                    .and_then(|v| v.as_str()),
            );
            tx.execute(
                r#"INSERT INTO scene_routes (scene, provider, model_id, base_url, thinking_intensity)
                   VALUES (?1, ?2, ?3, ?4, ?5)
                   ON CONFLICT(scene) DO UPDATE SET
                     provider = excluded.provider,
                     model_id = excluded.model_id,
                     base_url = excluded.base_url,
                     thinking_intensity = excluded.thinking_intensity"#,
                params![scene, provider, model_id, base_url, thinking.as_str()],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    list_scene_routes(db)
}

pub fn route_for(db: &Db, scene: &str) -> AppResult<crate::agent::runtime::RouteRow> {
    db.with_conn(|conn| {
        let row = conn
            .query_row(
                "SELECT scene, provider, model_id, base_url, thinking_intensity FROM scene_routes WHERE scene = ?1",
                params![scene],
                |r| {
                    Ok(crate::agent::runtime::RouteRow {
                        scene: r.get(0)?,
                        provider: r.get(1)?,
                        model_id: r.get(2)?,
                        base_url: r.get(3)?,
                        thinking_intensity: r
                            .get::<_, Option<String>>(4)?
                            .unwrap_or_else(|| "medium".into()),
                    })
                },
            )
            .optional()?;
        Ok(row.unwrap_or(crate::agent::runtime::RouteRow {
            scene: scene.into(),
            provider: "local".into(),
            model_id: "local-draft".into(),
            base_url: None,
            thinking_intensity: "medium".into(),
        }))
    })
}

