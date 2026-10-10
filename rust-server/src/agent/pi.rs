//! pi-agent model-relay boundary — parity with Node `agent/piAdapter.ts`.
//! Rust does not link the npm `@earendil-works/pi-agent-core` package; behavior is
//! the same boundary: model relay only (openai if configured, else local-draft),
//! refuse tools / autonomous / orchestration.

use crate::agent::local_draft::{normalize_dialogue_quotes, LocalDraftAdapter};
use crate::agent::openai::OpenAiCompatibleAdapter;
use crate::agent::{RunInput, RunOutput};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::services::settings::resolve_provider;
use serde_json::json;

pub const PACKAGE_NAME: &str = "@earendil-works/pi-agent-core";

/// Extra fields some callers might pass; we refuse tool orchestration.
pub fn assert_pi_model_relay_only(input: &RunInput) -> AppResult<()> {
    if input.tools_requested {
        return Err(AppError::BadRequest(
            "pi-agent 在墨兰写作中仅为模型代调，不支持工具编排 / 自主代理。请去掉 tools、enableTools、autonomous、orchestration 等参数。详见 docs/PI_RUNTIME.md"
                .into(),
        ));
    }
    Ok(())
}

pub fn pi_orchestration_boundary() -> serde_json::Value {
    json!({
        "mode": "model-relay",
        "autonomous": false,
        "toolsSupported": false,
        "note": "pi-agent 仅代调模型交付文稿，不是自主工具编排 agent",
    })
}

pub fn probe_pi_capability() -> serde_json::Value {
    json!({
        "id": "pi-agent",
        "label": "pi-agent-core",
        "available": true,
        "reason": "Rust 原生 pi 代调（模型代调，非自主编排）；等价 Node 接 pi-agent-core 的边界。设 MOLAN_AGENT_RUNTIME=pi 或路由 provider=pi 启用。详见 docs/PI_RUNTIME.md",
        "packageName": PACKAGE_NAME,
        "native": true,
    })
}

pub struct PiRelayAdapter {
    openai: Option<OpenAiCompatibleAdapter>,
}

impl PiRelayAdapter {
    pub fn from_db(db: &Db) -> AppResult<Self> {
        let resolved = resolve_provider(db, None)?;
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
        let openai = if !api_key.is_empty() && !base_url.is_empty() && !model.is_empty() {
            Some(OpenAiCompatibleAdapter {
                base_url: base_url.into(),
                api_key: api_key.into(),
                model: model.into(),
            })
        } else {
            None
        };
        Ok(Self { openai })
    }

    pub async fn run_scene(&self, input: &RunInput) -> AppResult<RunOutput> {
        assert_pi_model_relay_only(input)?;
        // Produce draft text first (openai if configured, else local). OpenAI
        // failures must surface — never silently swap in local-draft when openai
        // was selected via env/route but key missing is handled by falling to local
        // only when no openai adapter was built (parity with Node piAdapter).
        let mut draft = if let Some(ref openai) = self.openai {
            openai.run_scene(input).await?
        } else {
            LocalDraftAdapter.run_scene(input)?
        };
        if matches!(input.scene.as_str(), "chapter_body" | "humanize") {
            draft.text = normalize_dialogue_quotes(draft.text.trim());
        }
        if draft.text.trim().is_empty() {
            return Err(AppError::BadGateway("pi-agent 返回空文本".into()));
        }
        draft.model_used = format!("pi-agent/{}", draft.model_used);
        Ok(draft)
    }

    pub async fn run_scene_stream<F>(&self, input: &RunInput, on_token: F) -> AppResult<RunOutput>
    where
        F: FnMut(String) -> AppResult<()>,
    {
        // Stream via underlying openai when present; else chunk local like runtime.
        assert_pi_model_relay_only(input)?;
        if let Some(ref openai) = self.openai {
            let mut out = openai.run_scene_stream(input, on_token).await?;
            out.model_used = format!("pi-agent/{}", out.model_used);
            Ok(out)
        } else {
            let result = self.run_scene(input).await?;
            // strip prefix for chunk emit of text only — already have full text
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
