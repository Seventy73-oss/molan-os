//! Secure outbound HTTP — parity with Node `server/src/outbound.ts`.
//! All credentialed provider calls go through `secure_fetch`.

use crate::error::{AppError, AppResult};
use crate::security::{assert_safe_base_url, assert_safe_base_url_resolved, redact_secrets};
use reqwest::{Client, Method, Response, redirect::Policy};
use std::time::Duration;

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
}

impl Default for SecureFetchOptions {
    fn default() -> Self {
        Self {
            method: Method::GET,
            headers: vec![],
            body: None,
            with_api_key: None,
            timeout_ms: 60_000,
        }
    }
}

pub async fn secure_fetch(raw_url: &str, options: SecureFetchOptions) -> AppResult<Response> {
    let with_api_key = options
        .with_api_key
        .unwrap_or_else(|| has_auth_header(&options.headers));
    let cleaned = assert_safe_base_url(raw_url, with_api_key)?;
    let cleaned = assert_safe_base_url_resolved(&cleaned, with_api_key)?;
    let client = client()?;
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
    let response = req.send().await.map_err(|e| {
        AppError::BadGateway(redact_secrets(&format!("出站请求失败：{e}")))
    })?;
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
    Ok(response)
}

pub fn safe_error_message(err: &dyn std::fmt::Display) -> String {
    redact_secrets(&err.to_string())
}
