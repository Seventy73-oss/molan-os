//! Secure outbound HTTP — parity with Node `server/src/outbound.ts`.
//! All credentialed provider calls go through `secure_fetch`.
//!
//! Optional limited retries: network / HTTP 5xx only. Never 4xx/auth or cancel.
//! No silent local downgrade.

use crate::error::{AppError, AppResult};
use crate::security::{assert_safe_base_url, assert_safe_base_url_resolved, redact_secrets};
use reqwest::{Client, Method, Response, redirect::Policy};
use std::time::Duration;
use tokio::time::sleep;

/// Default retries for outbound model / provider credentialed calls.
pub const MODEL_FETCH_RETRIES: u32 = 2;
pub const MODEL_FETCH_RETRY_BACKOFF_MS: u64 = 300;

fn has_auth_header(headers: &[(String, String)]) -> bool {
    headers.iter().any(|(k, v)| {
        let k = k.to_lowercase();
        (k == "authorization" || k == "x-api-key") && !v.trim().is_empty()
    })
}

fn client() -> AppResult<Client> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Other(anyhow::anyhow!("http client: {e}")))
}

pub struct SecureFetchOptions {
    pub method: Method,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub with_api_key: Option<bool>,
    pub timeout_ms: u64,
    /// Extra attempts after the first failure (default 0).
    pub retries: u32,
    /// Base backoff ms before retry #1 (default 300).
    pub retry_backoff_ms: u64,
}

impl Default for SecureFetchOptions {
    fn default() -> Self {
        Self {
            method: Method::GET,
            headers: vec![],
            body: None,
            with_api_key: None,
            timeout_ms: 60_000,
            retries: 0,
            retry_backoff_ms: MODEL_FETCH_RETRY_BACKOFF_MS,
        }
    }
}

/// HTTP 5xx only — never 4xx / auth / 429.
pub fn is_retryable_http_status(status: u16) -> bool {
    (500..=599).contains(&status)
}

/// Network / transport failures are retryable. Policy / SSRF / cancel are not.
pub fn is_retryable_network_error(err: &AppError) -> bool {
    if err.is_abort() {
        return false;
    }
    let msg = err.to_string();
    if msg.contains("已取消") || msg.contains("cancelled") || msg.contains("Canceled") {
        return false;
    }
    if msg.contains("出站目标")
        || msg.contains("SSRF")
        || msg.contains("内网")
        || msg.contains("已拒绝")
        || msg.contains("重定向")
        || msg.contains("白名单")
        || msg.contains("allowlist")
    {
        return false;
    }
    if msg.contains("HTTP 4") {
        return false;
    }
    // reqwest / hyper transport wording
    msg.contains("error sending request")
        || msg.contains("connection")
        || msg.contains("timed out")
        || msg.contains("timeout")
        || msg.contains("dns")
        || msg.contains("broken pipe")
        || msg.contains("出站请求失败")
}

fn backoff_delay_ms(base_ms: u64, attempt_index: u32) -> u64 {
    if base_ms == 0 {
        return 0;
    }
    base_ms.saturating_mul(1u64 << (attempt_index.saturating_sub(1).min(8)))
}

pub async fn secure_fetch(raw_url: &str, options: SecureFetchOptions) -> AppResult<Response> {
    let with_api_key = options
        .with_api_key
        .unwrap_or_else(|| has_auth_header(&options.headers));
    let cleaned = assert_safe_base_url(raw_url, with_api_key)?;
    let cleaned = assert_safe_base_url_resolved(&cleaned, with_api_key)?;
    let client = client()?;
    let max_retries = options.retries.min(5);
    let backoff_ms = options.retry_backoff_ms;

    let mut last_err: Option<AppError> = None;

    for attempt in 0..=max_retries {
        if attempt > 0 {
            let delay = backoff_delay_ms(backoff_ms, attempt);
            if delay > 0 {
                sleep(Duration::from_millis(delay)).await;
            }
        }

        let mut req = client
            .request(options.method.clone(), &cleaned)
            .timeout(Duration::from_millis(options.timeout_ms));
        for (k, v) in &options.headers {
            req = req.header(k, v);
        }
        if let Some(body) = &options.body {
            if options.method != Method::GET && options.method != Method::HEAD {
                req = req.body(body.clone());
            }
        }

        match req.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                if (300..400).contains(&status) {
                    let loc = response
                        .headers()
                        .get("location")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("(missing)")
                        .to_string();
                    return Err(AppError::BadGateway(format!(
                        "出站请求被重定向到 {loc}，已拒绝（防 SSRF）"
                    )));
                }
                if is_retryable_http_status(status) && attempt < max_retries {
                    // Drain body before retry.
                    let _ = response.bytes().await;
                    last_err = Some(AppError::BadGateway(format!("HTTP {status}")));
                    continue;
                }
                return Ok(response);
            }
            Err(e) => {
                let mapped = AppError::BadGateway(redact_secrets(&format!("出站请求失败：{e}")));
                if attempt >= max_retries || !is_retryable_network_error(&mapped) {
                    return Err(mapped);
                }
                last_err = Some(mapped);
                continue;
            }
        }
    }

    Err(last_err.unwrap_or_else(|| AppError::BadGateway("出站请求失败".into())))
}

pub fn safe_error_message(err: &dyn std::fmt::Display) -> String {
    redact_secrets(&err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_status_matrix() {
        assert!(is_retryable_http_status(503));
        assert!(is_retryable_http_status(500));
        assert!(!is_retryable_http_status(401));
        assert!(!is_retryable_http_status(403));
        assert!(!is_retryable_http_status(429));
        assert!(!is_retryable_http_status(400));
        assert!(!is_retryable_http_status(200));
    }

    #[test]
    fn network_error_classifier() {
        assert!(is_retryable_network_error(&AppError::BadGateway(
            "出站请求失败：error sending request for url".into()
        )));
        assert!(!is_retryable_network_error(&AppError::BadGateway(
            "出站目标 x 解析到内网地址，已拒绝".into()
        )));
        assert!(!is_retryable_network_error(&AppError::BadGateway(
            "已取消".into()
        )));
    }
}
