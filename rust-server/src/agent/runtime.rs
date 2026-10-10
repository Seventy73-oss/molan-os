//! Adapter selection — parity with Node `agent/runtime.ts`.
//! OpenAI route must fail loudly — never silently swap in local-draft.

use crate::agent::local_draft::LocalDraftAdapter;
use crate::agent::openai::OpenAiCompatibleAdapter;
use crate::agent::pi::PiRelayAdapter;
use crate::agent::{RunInput, RunOutput};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::settings::resolve_provider;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct RouteRow {
    pub scene: String,
    pub provider: String,
    pub model_id: String,
    pub base_url: Option<String>,
    pub thinking_intensity: String,
}

pub enum AdapterKind {
    Local(LocalDraftAdapter),
    OpenAi(OpenAiCompatibleAdapter),
    Pi(PiRelayAdapter),
}

impl AdapterKind {
    pub async fn run_scene(&self, input: &RunInput) -> AppResult<RunOutput> {
        match self {
            Self::Local(a) => a.run_scene(input),
            Self::OpenAi(a) => a.run_scene(input).await,
            Self::Pi(a) => a.run_scene(input).await,
        }
    }

    pub fn is_openai(&self) -> bool {
        matches!(self, Self::OpenAi(_))
    }

    pub async fn run_scene_stream<F>(&self, input: &RunInput, on_token: F) -> AppResult<RunOutput>
    where
        F: FnMut(String) -> AppResult<()>,
    {
        match self {
            Self::OpenAi(a) => a.run_scene_stream(input, on_token).await,
            Self::Pi(a) => a.run_scene_stream(input, on_token).await,
            Self::Local(a) => {
                let result = a.run_scene(input)?;
                crate::agent::openai::emit_chunked(
                    &result.text,
                    on_token,
                    24,
                    &input.cancelled,
                )
                .await?;
                Ok(result)
            }
        }
    }
}

pub fn get_adapter(db: &Db, route: &RouteRow) -> AppResult<AdapterKind> {
    let env_runtime = std::env::var("MOLAN_AGENT_RUNTIME")
        .or_else(|_| std::env::var("CHANGJUAN_AGENT_RUNTIME"))
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let provider = if matches!(env_runtime.as_str(), "pi" | "openai" | "local") {
        env_runtime
    } else {
        route.provider.clone()
    };

    if provider == "pi" {
        return Ok(AdapterKind::Pi(PiRelayAdapter::from_db(db)?));
    }

    if provider != "openai" {
        return Ok(AdapterKind::Local(LocalDraftAdapter));
    }

    let route_json = json_route(route);
    let resolved = resolve_provider(db, Some(&route_json))?;
    let api_key = resolved
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let base_url = resolved
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let model = resolved
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if api_key.is_empty() || base_url.is_empty() || model.is_empty() {
        return Err(AppError::BadRequest(
            "该场景已选 OpenAI 兼容，但还没有可用的 API Key、接口地址或模型 ID。请到「模型」页配置，或把该场景改回本地草稿。"
                .into(),
        ));
    }
    Ok(AdapterKind::OpenAi(OpenAiCompatibleAdapter {
        base_url: base_url.into(),
        api_key: api_key.into(),
        model: model.into(),
    }))
}

fn json_route(route: &RouteRow) -> Value {
    serde_json::json!({
        "base_url": route.base_url,
        "model_id": route.model_id,
    })
}
