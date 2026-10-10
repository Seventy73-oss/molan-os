pub mod local_draft;
pub mod openai;
pub mod pi;
pub mod runtime;

use crate::thinking::ThinkingIntensity;

#[derive(Debug, Clone)]
pub struct SkillText {
    pub id: String,
    pub name: String,
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct RunInput {
    pub scene: String,
    pub model: Option<String>,
    pub skill_texts: Vec<SkillText>,
    pub context: String,
    pub instruction: String,
    pub thinking_intensity: ThinkingIntensity,
    pub cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// When true, pi adapter refuses (tools / enableTools / autonomous / orchestration).
    pub tools_requested: bool,
}

#[derive(Debug, Clone)]
pub struct RunOutput {
    pub text: String,
    pub model_used: String,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone)]
pub struct Usage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
}

pub fn scene_kind(scene: &str) -> Option<&'static str> {
    match scene {
        "topic" | "book_setup" => Some("book_profile"),
        "outline" => Some("book_outline"),
        "chapter_outline" => Some("chapter_outline"),
        "chapter_body" | "humanize" => Some("chapter_body"),
        "review" => Some("review_report"),
        "memory_extract" => Some("chapter_memory"),
        "chat" => None,
        _ => None,
    }
}

pub fn throw_if_cancelled(flag: &Option<std::sync::Arc<std::sync::atomic::AtomicBool>>) -> Result<(), crate::error::AppError> {
    if let Some(f) = flag {
        if f.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::error::AppError::Cancelled("已取消".into()));
        }
    }
    Ok(())
}
