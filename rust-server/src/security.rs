//! Outbound Base URL allowlist (parity with Node security.ts, phase-1 subset).

use crate::error::{AppError, AppResult};
use std::collections::HashSet;

pub const DEFAULT_ALLOWED_BASE_HOSTS: &[&str] = &[
    "api.openai.com",
    "api.deepseek.com",
    "api.siliconflow.cn",
    "api.moonshot.cn",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "open.bigmodel.cn",
    "dashscope.aliyuncs.com",
    "ark.cn-beijing.volces.com",
    "api.groq.com",
    "api.together.xyz",
    "api.fireworks.ai",
    "api.mistral.ai",
    "api.x.ai",
];

fn allowed_hosts() -> HashSet<String> {
    let mut set: HashSet<String> = DEFAULT_ALLOWED_BASE_HOSTS
        .iter()
        .map(|h| h.to_lowercase())
        .collect();
    if let Ok(extra) = std::env::var("MOLAN_ALLOWED_BASE_HOSTS") {
        for h in extra.split(',') {
            let h = h.trim().to_lowercase();
            if !h.is_empty() {
                set.insert(h);
            }
        }
    }
    set
}

fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|p| p.parse::<u8>().is_ok())
}

fn ipv4_to_u32(host: &str) -> Option<u32> {
    let parts: Vec<u32> = host.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 4 {
        return None;
    }
    Some((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3])
}

pub fn is_private_or_reserved_host(hostname: &str) -> bool {
    let host = hostname
        .to_lowercase()
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    if host == "localhost"
        || host == "0.0.0.0"
        || host == "::"
        || host == "::1"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "metadata.google.internal"
    {
        return true;
    }
    if is_ipv4(&host) {
        let Some(n) = ipv4_to_u32(&host) else {
            return true;
        };
        let in_range = |a: &str, b: &str| {
            let a = ipv4_to_u32(a).unwrap_or(0);
            let b = ipv4_to_u32(b).unwrap_or(u32::MAX);
            n >= a && n <= b
        };
        return in_range("0.0.0.0", "0.255.255.255")
            || in_range("10.0.0.0", "10.255.255.255")
            || in_range("127.0.0.0", "127.255.255.255")
            || in_range("169.254.0.0", "169.254.255.255")
            || in_range("172.16.0.0", "172.31.255.255")
            || in_range("192.168.0.0", "192.168.255.255")
            || in_range("100.64.0.0", "100.127.255.255")
            || in_range("192.0.0.0", "192.0.0.255")
            || in_range("192.0.2.0", "192.0.2.255")
            || in_range("198.51.100.0", "198.51.100.255")
            || in_range("203.0.113.0", "203.0.113.255")
            || in_range("224.0.0.0", "255.255.255.255");
    }
    if host.contains(':') {
        if host == "::1" || host.starts_with("fc") || host.starts_with("fd") || host.starts_with("fe80")
        {
            return true;
        }
        if let Some(mapped) = host.strip_prefix("::ffff:") {
            if is_ipv4(mapped) {
                return is_private_or_reserved_host(mapped);
            }
        }
    }
    false
}

struct ParsedUrl {
    scheme: String,
    host: String,
    normalized: String,
}

fn parse_http_url(raw: &str) -> AppResult<ParsedUrl> {
    let trimmed = raw.trim();
    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        ("http", r)
    } else {
        return Err(AppError::BadRequest("Base URL 仅支持 http/https".into()));
    };
    if rest.is_empty() {
        return Err(AppError::BadRequest("Base URL 缺少主机名".into()));
    }
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let path = &rest[authority_end..];
    // strip userinfo
    let hostport = authority.rsplit('@').next().unwrap_or(authority);
    let host = if hostport.starts_with('[') {
        let end = hostport
            .find(']')
            .ok_or_else(|| AppError::BadRequest("Base URL 无效".into()))?;
        hostport[1..end].to_string()
    } else {
        hostport
            .split(':')
            .next()
            .unwrap_or(hostport)
            .to_string()
    };
    if host.is_empty() {
        return Err(AppError::BadRequest("Base URL 缺少主机名".into()));
    }
    let mut normalized = format!("{scheme}://{hostport}{path}");
    while normalized.ends_with('/') {
        normalized.pop();
    }
    Ok(ParsedUrl {
        scheme: scheme.into(),
        host: host.to_lowercase(),
        normalized,
    })
}

pub fn assert_safe_base_url(raw: &str, with_api_key: bool) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parsed = parse_http_url(trimmed)?;
    if is_private_or_reserved_host(&parsed.host) {
        return Ok(parsed.normalized);
    }
    let allowed = allowed_hosts();
    if allowed.contains(&parsed.host) {
        return Ok(parsed.normalized);
    }
    if with_api_key {
        let allow_public_http = std::env::var("MOLAN_ALLOW_PUBLIC_HTTP_BASE")
            .map(|v| v.trim() == "1")
            .unwrap_or(false);
        if allow_public_http && is_ipv4(&parsed.host) {
            return Ok(parsed.normalized);
        }
        let _ = parsed.scheme;
        return Err(AppError::BadRequest(format!(
            "Base URL 主机「{}」不在白名单；请设置 MOLAN_ALLOWED_BASE_HOSTS 或使用官方兼容端点",
            parsed.host
        )));
    }
    Ok(parsed.normalized)
}

pub fn listen_hostname() -> String {
    let raw = std::env::var("MOLAN_HOST")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "127.0.0.1".into());
    let t = raw.trim();
    if t.is_empty() {
        "127.0.0.1".into()
    } else {
        t.into()
    }
}
