//! Outbound Base URL allowlist — parity with Node `server/src/security.ts`.

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

fn parse_host_list(env_name: &str) -> Vec<String> {
    std::env::var(env_name)
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn allowed_hosts() -> HashSet<String> {
    let mut set: HashSet<String> = DEFAULT_ALLOWED_BASE_HOSTS
        .iter()
        .map(|h| h.to_lowercase())
        .collect();
    for h in parse_host_list("MOLAN_ALLOWED_BASE_HOSTS") {
        set.insert(h);
    }
    set
}

fn local_llm_allowed() -> bool {
    matches!(
        std::env::var("MOLAN_ALLOW_LOCAL_LLM")
            .unwrap_or_default()
            .trim()
            .to_lowercase()
            .as_str(),
        "1" | "true" | "yes"
    )
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
    hostport: String,
    path: String,
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
    if rest.contains('@') && !rest.split('/').next().unwrap_or("").starts_with('[') {
        // userinfo present (user:pass@host) — reject
        let authority = rest.split('/').next().unwrap_or(rest);
        if authority.contains('@') {
            return Err(AppError::BadRequest("不要把密钥写进地址".into()));
        }
    }
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let path = &rest[authority_end..];
    if authority.contains('@') {
        return Err(AppError::BadRequest("不要把密钥写进地址".into()));
    }
    let hostport = authority.to_string();
    let host = if hostport.starts_with('[') {
        let end = hostport
            .find(']')
            .ok_or_else(|| AppError::BadRequest("Base URL 无效".into()))?;
        hostport[1..end].to_string()
    } else {
        hostport
            .split(':')
            .next()
            .unwrap_or(&hostport)
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
        hostport,
        path: path.into(),
        normalized,
    })
}

/// Validate provider Base URL before attaching credentials.
pub fn assert_safe_base_url(raw: &str, with_api_key: bool) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parsed = parse_http_url(trimmed)?;
    let allow_local = local_llm_allowed();
    let private_host = is_private_or_reserved_host(&parsed.host);
    let allowed = allowed_hosts();
    let is_local_host = parsed.host == "127.0.0.1" || parsed.host == "localhost";

    if private_host {
        if !allow_local {
            return Err(AppError::BadRequest(
                "禁止把接口指到内网/本机地址（SSRF 防护）。本地模型请设 MOLAN_ALLOW_LOCAL_LLM=1，并把主机加入 MOLAN_ALLOWED_BASE_HOSTS"
                    .into(),
            ));
        }
        if !allowed.contains(&parsed.host) && !is_local_host {
            return Err(AppError::BadRequest(format!(
                "内网主机 {} 未在 MOLAN_ALLOWED_BASE_HOSTS 白名单中",
                parsed.host
            )));
        }
    }

    if with_api_key {
        if allow_local && is_local_host {
            // ok
        } else if !allowed.contains(&parsed.host) {
            // public IP relay opt-in (Sub2API etc.)
            let allow_public_http = std::env::var("MOLAN_ALLOW_PUBLIC_HTTP_BASE")
                .map(|v| v.trim() == "1")
                .unwrap_or(false);
            if !(allow_public_http && is_ipv4(&parsed.host)) {
                return Err(AppError::BadRequest(format!(
                    "携带 API Key 时，Base URL 主机必须在白名单内（当前 {} 不在）。可设 MOLAN_ALLOWED_BASE_HOSTS",
                    parsed.host
                )));
            }
        } else if parsed.scheme == "http" && !is_local_host {
            let explicit: HashSet<String> = parse_host_list("MOLAN_ALLOWED_BASE_HOSTS")
                .into_iter()
                .collect();
            let allow_public_http = std::env::var("MOLAN_ALLOW_PUBLIC_HTTP_BASE")
                .map(|v| v.trim() == "1")
                .unwrap_or(false);
            if !explicit.contains(&parsed.host)
                && !(allow_public_http && is_ipv4(&parsed.host))
            {
                return Err(AppError::BadRequest(
                    "携带 API Key 时公网 Base URL 必须使用 https（本地模型除外；自建中转请把主机写入 MOLAN_ALLOWED_BASE_HOSTS）"
                        .into(),
                ));
            }
        }
    }

    let _ = (parsed.hostport, parsed.path);
    Ok(parsed.normalized)
}

/// DNS rebinding check — rejects private A/AAAA answers unless local LLM mode.
pub fn assert_safe_base_url_resolved(raw: &str, with_api_key: bool) -> AppResult<String> {
    let cleaned = assert_safe_base_url(raw, with_api_key)?;
    if cleaned.is_empty() {
        return Ok(cleaned);
    }
    let parsed = parse_http_url(&cleaned)?;
    let host = &parsed.host;
    if is_ipv4(host) || host.contains(':') || host == "localhost" {
        return Ok(cleaned);
    }
    match std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:0")) {
        Ok(addrs) => {
            for addr in addrs {
                let ip = addr.ip().to_string();
                if is_private_or_reserved_host(&ip) && !local_llm_allowed() {
                    return Err(AppError::BadRequest(format!(
                        "主机 {host} 解析到内网地址 {ip}，已拒绝（SSRF 防护）"
                    )));
                }
            }
        }
        Err(_) => {
            // offline / DNS fail: still allow allowlisted hosts
        }
    }
    Ok(cleaned)
}

pub fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    let patterns: &[(&str, &str)] = &[
        (r"sk-[A-Za-z0-9_-]{8,}", "sk-…"),
        (r"sk-proj-[A-Za-z0-9_-]{8,}", "sk-proj-…"),
        (r"(?i)Bearer\s+\S+", "Bearer …"),
        (r"(?i)api[_-]?key\s*[:=]\s*\S+", "api_key=…"),
        (r"enc:v1:[A-Za-z0-9+/=:_-]{16,}", "enc:v1:…"),
    ];
    for (pat, repl) in patterns {
        if let Ok(re) = regex::Regex::new(pat) {
            out = re.replace_all(&out, *repl).into_owned();
        }
    }
    out.chars().take(220).collect()
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
