//! Thinking intensity — parity with Node `server/src/thinking.ts`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingIntensity {
    Off,
    Low,
    Medium,
    High,
}

impl ThinkingIntensity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

pub fn normalize_thinking(raw: Option<&str>) -> ThinkingIntensity {
    let Some(raw) = raw else {
        return ThinkingIntensity::Medium;
    };
    let v = raw.trim().to_lowercase();
    match v.as_str() {
        "off" | "none" | "关闭" => ThinkingIntensity::Off,
        "low" | "低" => ThinkingIntensity::Low,
        "high" | "高" => ThinkingIntensity::High,
        "medium" | "中" | "med" => ThinkingIntensity::Medium,
        _ => ThinkingIntensity::Medium,
    }
}

pub fn reasoning_effort_for_model(model: &str, level: ThinkingIntensity) -> Option<&'static str> {
    let effort = match level {
        ThinkingIntensity::Off => return None,
        ThinkingIntensity::Low => "low",
        ThinkingIntensity::Medium => "medium",
        ThinkingIntensity::High => "high",
    };
    if model.to_lowercase().contains("deepseek") && effort == "medium" {
        return Some("low");
    }
    Some(effort)
}

pub fn temperature_of(level: ThinkingIntensity) -> f64 {
    match level {
        ThinkingIntensity::Off => 0.9,
        ThinkingIntensity::Low => 0.75,
        ThinkingIntensity::Medium => 0.65,
        ThinkingIntensity::High => 0.45,
    }
}

pub fn max_tokens_hint(level: ThinkingIntensity) -> Option<u32> {
    match level {
        ThinkingIntensity::Off => None,
        ThinkingIntensity::Low => Some(4096),
        ThinkingIntensity::Medium => Some(8192),
        ThinkingIntensity::High => Some(16384),
    }
}

pub fn thinking_system_hint(level: ThinkingIntensity) -> &'static str {
    match level {
        ThinkingIntensity::Off => "【思考强度：关闭】直接交付结果，不要长篇推敲或列出思考过程。",
        ThinkingIntensity::Low => "【思考强度：低】稍作核对关键事实与节奏后交付，保持简洁。",
        ThinkingIntensity::Medium => "【思考强度：中】仔细推敲结构、因果与细节后再交付；不要写出思考过程。",
        ThinkingIntensity::High => "【思考强度：高】深度推敲人物动机、前后矛盾、钩子与节奏，再交付定稿；不要写出思考过程。",
    }
}

pub fn model_likely_supports_reasoning(model: &str) -> bool {
    let m = model.to_lowercase();
    (m.starts_with('o') && m.len() > 1 && m.as_bytes()[1].is_ascii_digit())
        || m.contains("o1-")
        || m.contains("o3")
        || m.contains("o4")
        || m.contains("gpt-5")
        || m.contains("reasoner")
        || m.contains("thinking")
        || m.contains("r1")
}
