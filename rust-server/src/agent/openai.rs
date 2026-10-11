//! OpenAI-compatible adapter — parity with Node `agent/openai.ts`.

use crate::agent::{RunInput, RunOutput, Usage, throw_if_cancelled};
use crate::error::{AppError, AppResult};
use crate::outbound::{MODEL_FETCH_RETRIES, MODEL_FETCH_RETRY_BACKOFF_MS, SecureFetchOptions, secure_fetch};
use crate::security::redact_secrets;
use crate::thinking::{
    max_tokens_hint, model_likely_supports_reasoning, reasoning_effort_for_model, temperature_of,
    thinking_system_hint,
};
use futures::StreamExt;
use reqwest::Method;
use serde_json::{Value, json};

const CONTRACT: &[(&str, &str)] = &[
    ("topic", "交付题材方案：读者、冲突、不写什么、书名和两句简介。"),
    ("book_setup", "先逐行写出书名、题材、简介、文风、目标章数、每章字数和章目，再写档案散文。"),
    ("outline", "按章交付全书大纲。每章一行「数字. 章名」，下一段写这一章不能退回的因果。"),
    ("chapter_outline", "交付本章细纲：章名、三到四个场景（目标、冲突、细节）和章末钩子。"),
    ("chapter_body", "只交付本章正文。不要标题，不要创作说明。用叙事散文写完这一章。对白必须用弯引号“”（U+201C/U+201D），禁止用「」、（）或()包说话。"),
    ("review", "只交付问题清单。每条包含类型、稿中原句和改法。不要重写全文。"),
    ("humanize", "只交付润色后的正文。不改人名、时间和物件事实，不加说明。对白改用弯引号“”，去掉「」、（）或()包的说话。"),
    ("memory_extract", "用短行写下本章事实、章末留下的物件、下一章必须接住的信息。"),
    ("chat", "用简体中文简短回答用户关于本书写作的问题。不要擅自生成整章正文或大纲，除非对方明确要求。"),
];

fn contract_for(scene: &str) -> &str {
    CONTRACT
        .iter()
        .find(|(s, _)| *s == scene)
        .map(|(_, c)| *c)
        .unwrap_or("用简体中文交付结果。")
}

fn strip_fence(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        if let Some(nl) = rest.find('\n') {
            let body = &rest[nl + 1..];
            if let Some(end) = body.rfind("\n```") {
                return body[..end].trim().to_string();
            }
        }
    }
    t.to_string()
}

fn normalize_dialogue_quotes(text: &str) -> String {
    text.replace('「', "“").replace('」', "”")
}

fn finalize_model_text(scene: &str, text: &str) -> String {
    let cleaned = strip_fence(text);
    if scene == "chapter_body" || scene == "humanize" {
        normalize_dialogue_quotes(&cleaned)
    } else {
        cleaned
    }
}

fn build_messages(input: &RunInput) -> Vec<Value> {
    let mut system_parts = vec![
        "你是墨兰写作的写作引擎。用简体中文交付当前场景的稿件，不要解释写作过程。正文对白只用弯引号“…”（U+201C/U+201D），禁止用「」、（）或()包说话。".to_string(),
        contract_for(&input.scene).to_string(),
        thinking_system_hint(input.thinking_intensity).to_string(),
    ];
    for skill in &input.skill_texts {
        system_parts.push(format!("# {}\n{}", skill.name, skill.text));
    }
    let system = system_parts.join("\n\n");
    let user = {
        let mut parts = vec![input.context.clone()];
        if !input.instruction.is_empty() {
            parts.push(format!("【本次指令】\n{}", input.instruction));
        }
        parts.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n")
    };
    vec![
        json!({"role": "system", "content": system}),
        json!({"role": "user", "content": user}),
    ]
}

pub fn build_completion_body(input: &RunInput, model: &str, stream: bool) -> Value {
    let level = input.thinking_intensity;
    let mut body = json!({
        "model": model,
        "messages": build_messages(input),
        "temperature": temperature_of(level),
    });
    if stream {
        body["stream"] = json!(true);
    }
    if let Some(effort) = reasoning_effort_for_model(model, level) {
        body["reasoning_effort"] = json!(effort);
        if model_likely_supports_reasoning(model) {
            let budget = match level {
                crate::thinking::ThinkingIntensity::High => 8000,
                crate::thinking::ThinkingIntensity::Medium => 4000,
                _ => 1024,
            };
            body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
        }
    }
    // ACC60：长文场景至少 LONG_FORM_MAX_TOKENS，防止推理模型把预算吃在思考上导致正文半截
    let floor = if LONG_FORM_SCENES.contains(&input.scene.as_str()) { LONG_FORM_MAX_TOKENS } else { 0 };
    let max = max_tokens_hint(level).unwrap_or(0).max(floor);
    if max > 0 {
        body["max_tokens"] = json!(max);
    }
    if stream {
        body["stream_options"] = json!({"include_usage": true});
    }
    body
}

pub const LONG_FORM_MAX_TOKENS: u32 = 16384;
pub const MODEL_TIMEOUT_MS: u64 = 120_000;
pub const LONG_FORM_TIMEOUT_MS: u64 = 300_000;
/// 长文场景（推理模型首字常 >60s）给 300s，其余 120s。
pub fn model_timeout_ms(input: &RunInput) -> u64 {
    if LONG_FORM_SCENES.contains(&input.scene.as_str()) { LONG_FORM_TIMEOUT_MS } else { MODEL_TIMEOUT_MS }
}
/// 超时不是用户取消：报可重试的超时错误
fn map_fetch_err(prefix: &str, input: &RunInput, e: &AppError) -> AppError {
    let msg = e.to_string();
    if msg.contains("timed out") || msg.contains("timeout") || msg.contains("超时") {
        return AppError::BadGateway(format!("{prefix}：响应超时（>{}s），可重试", model_timeout_ms(input) / 1000));
    }
    AppError::BadGateway(format!("{prefix}：{}", redact_secrets(&msg)))
}
const LONG_FORM_SCENES: &[&str] = &[
    "chapter_body", "humanize", "outline", "chapter_outline", "book_setup", "topic", "memory_extract", "review", "chat",
];

pub fn assert_not_truncated(finish_reason: Option<&str>) -> AppResult<()> {
    if finish_reason == Some("length") {
        return Err(AppError::BadGateway(
            "输出被截断（finish_reason=length，超出 max_tokens）；未保存半截稿，请重试或调低思考强度".into(),
        ));
    }
    Ok(())
}

pub struct OpenAiCompatibleAdapter {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl OpenAiCompatibleAdapter {
    fn resolve_model(&self, input: &RunInput) -> String {
        input
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty() && *m != "local-draft")
            .unwrap_or(self.model.as_str())
            .to_string()
    }

    pub async fn run_scene(&self, input: &RunInput) -> AppResult<RunOutput> {
        throw_if_cancelled(&input.cancelled)?;
        let model = self.resolve_model(input);
        let url = format!(
            "{}/chat/completions",
            self.base_url.trim_end_matches('/')
        );
        let body = build_completion_body(input, &model, false);
        let response = secure_fetch(
            &url,
            SecureFetchOptions {
                method: Method::POST,
                headers: vec![
                    ("Content-Type".into(), "application/json".into()),
                    ("Authorization".into(), format!("Bearer {}", self.api_key)),
                ],
                body: Some(body.to_string()),
                with_api_key: Some(true),
                timeout_ms: model_timeout_ms(input),
                retries: MODEL_FETCH_RETRIES,
                retry_backoff_ms: MODEL_FETCH_RETRY_BACKOFF_MS,
            },
        )
        .await
        .map_err(|e| map_fetch_err("模型调用失败", input, &e))?;
        throw_if_cancelled(&input.cancelled)?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let detail = redact_secrets(&response.text().await.unwrap_or_default());
            return Err(AppError::BadGateway(format!(
                "模型调用失败：HTTP {status} {detail}"
            )));
        }
        let data: Value = response
            .json()
            .await
            .map_err(|e| AppError::BadGateway(format!("模型调用失败：{}", redact_secrets(&e.to_string()))))?;
        assert_not_truncated(data.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()))?;
        let content = data
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let text = finalize_model_text(&input.scene, content);
        if text.is_empty() {
            return Err(AppError::BadGateway("模型调用失败：空响应".into()));
        }
        let usage = data.get("usage").map(|u| Usage {
            prompt_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).map(|n| n as u32),
            completion_tokens: u
                .get("completion_tokens")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32),
            total_tokens: u.get("total_tokens").and_then(|v| v.as_u64()).map(|n| n as u32),
        });
        Ok(RunOutput {
            text,
            model_used: model,
            usage,
        })
    }

    pub async fn run_scene_stream<F>(&self, input: &RunInput, mut on_token: F) -> AppResult<RunOutput>
    where
        F: FnMut(String) -> AppResult<()>,
    {
        throw_if_cancelled(&input.cancelled)?;
        let model = self.resolve_model(input);
        let url = format!(
            "{}/chat/completions",
            self.base_url.trim_end_matches('/')
        );
        let body = build_completion_body(input, &model, true);
        let response = secure_fetch(
            &url,
            SecureFetchOptions {
                method: Method::POST,
                headers: vec![
                    ("Content-Type".into(), "application/json".into()),
                    ("Authorization".into(), format!("Bearer {}", self.api_key)),
                ],
                body: Some(body.to_string()),
                with_api_key: Some(true),
                timeout_ms: model_timeout_ms(input),
                retries: MODEL_FETCH_RETRIES,
                retry_backoff_ms: MODEL_FETCH_RETRY_BACKOFF_MS,
            },
        )
        .await
        .map_err(|e| map_fetch_err("模型流式调用失败", input, &e))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let detail = redact_secrets(&response.text().await.unwrap_or_default());
            return Err(AppError::BadGateway(format!(
                "模型流式调用失败：HTTP {status} {detail}"
            )));
        }
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut assembled = String::new();
        let mut finish_reason: Option<String> = None;
        let mut stream_usage: Option<Usage> = None;
        while let Some(chunk) = stream.next().await {
            throw_if_cancelled(&input.cancelled)?;
            let chunk = chunk.map_err(|e| {
                AppError::BadGateway(format!("模型流式调用失败：{}", redact_secrets(&e.to_string())))
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();
                if !line.starts_with("data:") {
                    continue;
                }
                let payload = line[5..].trim();
                if payload.is_empty() || payload == "[DONE]" {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<Value>(payload) {
                    if let Some(u) = json.get("usage").filter(|u| u.is_object()) {
                        let g = |k: &str| u.get(k).and_then(|v| v.as_u64()).map(|n| n as u32);
                        stream_usage = Some(Usage {
                            prompt_tokens: g("prompt_tokens"),
                            completion_tokens: g("completion_tokens"),
                            total_tokens: g("total_tokens"),
                        });
                    }
                    if let Some(fr) = json.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()) {
                        finish_reason = Some(fr.to_string());
                    }
                    if let Some(delta) = json
                        .pointer("/choices/0/delta/content")
                        .and_then(|v| v.as_str())
                    {
                        if !delta.is_empty() {
                            assembled.push_str(delta);
                            on_token(delta.to_string())?;
                        }
                    }
                }
            }
        }
        assert_not_truncated(finish_reason.as_deref())?;
        let text = finalize_model_text(&input.scene, &assembled);
        if text.is_empty() {
            return Err(AppError::BadGateway("模型流式调用失败：空流式响应".into()));
        }
        Ok(RunOutput {
            text,
            model_used: model,
            usage: stream_usage,
        })
    }
}

pub async fn emit_chunked<F>(
    text: &str,
    mut on_token: F,
    chunk_size: usize,
    cancelled: &Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> AppResult<()>
where
    F: FnMut(String) -> AppResult<()>,
{
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        throw_if_cancelled(cancelled)?;
        let end = (i + chunk_size).min(chars.len());
        let delta: String = chars[i..end].iter().collect();
        on_token(delta)?;
        i = end;
    }
    Ok(())
}

#[cfg(test)]
mod acc60_tests {
    use super::*;
    #[test]
    fn truncation_is_error() {
        assert!(assert_not_truncated(Some("length")).is_err());
        assert!(assert_not_truncated(Some("stop")).is_ok());
    }
}
