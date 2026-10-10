//! Simplified local-draft adapter + selection rewrite (Node localDraft subset).

use crate::agent::{RunInput, RunOutput};
use crate::error::AppResult;
use crate::thinking::ThinkingIntensity;
use regex::Regex;
use std::sync::OnceLock;

pub fn normalize_dialogue_quotes(text: &str) -> String {
    static RE_SPEECH: OnceLock<Regex> = OnceLock::new();
    static RE_LINE: OnceLock<Regex> = OnceLock::new();
    let re_speech = RE_SPEECH.get_or_init(|| {
        Regex::new(
            r"(说|道|问|喊|答|叫|骂|笑|回|应|斥|劝|吼|嘀咕|低语)([道了着过]?)\s*[（(]([^（）()]{1,160})[）)]",
        )
        .unwrap()
    });
    let re_line = RE_LINE
        .get_or_init(|| Regex::new(r"(^|\n)\s*[（(]([^（）()\n]{1,160})[）)]\s*").unwrap());
    let mut out = re_speech.replace_all(text, "$1$2“$3”").into_owned();
    out = re_line.replace_all(&out, "$1“$2”").into_owned();
    out = out.replace('「', "“").replace('」', "”");
    out
}


fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    for ch in text.chars() {
        buf.push(ch);
        if "。！？!?".contains(ch) {
            let t = buf.trim().to_string();
            if !t.is_empty() {
                out.push(t);
            }
            buf.clear();
        }
    }
    let t = buf.trim().to_string();
    if !t.is_empty() {
        out.push(t);
    }
    out
}

fn section(text: &str, name: &str) -> String {
    let re = Regex::new(&format!(r"【{}】\n([\s\S]*?)(?=\n【|$)", regex::escape(name))).ok();
    re.and_then(|r| r.captures(text).map(|c| c.get(1).unwrap().as_str().trim().to_string()))
        .unwrap_or_default()
}

fn field(text: &str, label: &str) -> String {
    let re = Regex::new(&format!(r"(?m)^{}：(.+)$", regex::escape(label))).ok();
    re.and_then(|r| r.captures(text).map(|c| c.get(1).unwrap().as_str().trim().to_string()))
        .unwrap_or_default()
}

fn chapter_titles(context: &str) -> Vec<String> {
    let block = section(context, "章目");
    let mut titles = Vec::new();
    let re = Regex::new(r"^(\d+)\.\s+(.+)$").unwrap();
    for line in block.lines() {
        if let Some(c) = re.captures(line) {
            titles.push(c.get(2).unwrap().as_str().trim().to_string());
        }
    }
    if titles.is_empty() {
        titles = (1..=12).map(|i| format!("第{i}章")).collect();
    }
    titles
}

fn humanize_local(text: &str) -> String {
    let mut out = text.to_string();
    let rules: &[(&str, &str)] = &[
        ("不禁", ""),
        ("宛如", "像"),
        ("仿佛", ""),
        ("一抹", ""),
        ("与此同时，", ""),
        ("与此同时", ""),
        ("然而，", "可"),
        ("深深地", ""),
        ("缓缓地", ""),
        ("缓缓", ""),
        ("竟然", ""),
        ("不由得", ""),
        ("嘴角微微上扬", "笑了一下"),
        ("心中涌起一股", ""),
        ("心中涌起", ""),
        ("目光深邃", "他看着"),
        ("时间仿佛静止", ""),
        ("的的", "的"),
    ];
    for (a, b) in rules {
        out = out.replace(a, b);
    }
    normalize_dialogue_quotes(out.trim())
}

/// Lightweight local rewrite for a selected span.
pub fn rewrite_selection_local(selection: &str, instruction: &str) -> String {
    let text = selection.replace("\r\n", "\n").replace('\r', "\n").trim().to_string();
    if text.is_empty() {
        return String::new();
    }
    let ask = instruction.trim();

    if ask.contains("续写") {
        let last = text
            .split('\n')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or(&text);
        let hint: String = last.chars().rev().take(24).collect::<Vec<_>>().into_iter().rev().collect();
        return normalize_dialogue_quotes(&format!(
            "{hint}——话还没落完，对面已经把茶杯放下。窗外的声响近了一寸，像有人故意踩着旧板。"
        ));
    }

    if Regex::new(r"缩短|精简|压缩").unwrap().is_match(ask) {
        let parts = split_sentences(&text);
        if parts.len() <= 2 {
            return normalize_dialogue_quotes(&text);
        }
        let keep = (parts.len() as f64 * 0.55).ceil() as usize;
        let keep = keep.max(2);
        return normalize_dialogue_quotes(&parts[..keep.min(parts.len())].join(""));
    }

    if Regex::new(r"对白|对话").unwrap().is_match(ask) {
        let base = normalize_dialogue_quotes(&text);
        return normalize_dialogue_quotes(&format!(
            "{base}\n\n“你就说一句实话。”\n“我说过了。”他停了一停，“你只是不想听。”\n她看着他，没有再追。"
        ));
    }

    if Regex::new(r"冷一点|更冷|语气.*冷|别解释动机").unwrap().is_match(ask) {
        let mut out = text
            .replace("不禁", "")
            .replace("宛如", "像")
            .replace("温暖", "")
            .replace("柔和", "")
            .replace("轻轻", "")
            .replace("嘴角微微上扬", "没笑");
        out = Regex::new(r"。{2,}").unwrap().replace_all(&out, "。").into_owned();
        return normalize_dialogue_quotes(out.trim());
    }

    let mut out = humanize_local(&text);
    if ask.contains("改写") {
        let sentences = split_sentences(&out);
        let complete: Vec<&String> = sentences
            .iter()
            .filter(|p| p.ends_with('。') || p.ends_with('！') || p.ends_with('？') || p.ends_with('!') || p.ends_with('?'))
            .collect();
        if complete.len() >= 2 && complete.len() == sentences.len() {
            let mut reordered = vec![sentences[1].clone(), sentences[0].clone()];
            reordered.extend_from_slice(&sentences[2..]);
            out = reordered.join("");
        } else {
            out = out
                .replace("把", "将")
                .replace("没有", "没")
                .replace("一边", "一面")
                .replace("看着", "望着");
            if out == text {
                let bare = Regex::new(r"[。！？!?]+$").unwrap().replace(&out, "");
                out = if bare.is_empty() {
                    text.clone()
                } else {
                    format!("{bare}——他停了一停。")
                };
            }
        }
    }
    let out = normalize_dialogue_quotes(&out);
    if out.is_empty() { text } else { out }
}

pub struct LocalDraftAdapter;

impl LocalDraftAdapter {
    pub fn run_scene(&self, input: &RunInput) -> AppResult<RunOutput> {
        let title = field(&section(&input.context, "书"), "书名");
        let title = if title.is_empty() { "未命名".into() } else { title };
        let genre = field(&section(&input.context, "书"), "题材");
        let logline = field(&section(&input.context, "书"), "简介");
        let style = field(&section(&input.context, "书"), "文风");
        let titles = chapter_titles(&input.context);
        let level = input.thinking_intensity;

        let mut text = match input.scene.as_str() {
            "topic" => format!(
                "读者：喜欢缓冲突与日常张力的人\n冲突：旧物与人情互相牵扯\n不写什么：无脑打脸\n书名：{title}\n简介：{logline}"
            ),
            "book_setup" => {
                let mut lines = vec![
                    format!("书名：{title}"),
                    format!("题材：{}", if genre.is_empty() { "都市现实".into() } else { genre.clone() }),
                    format!("简介：{}", if logline.is_empty() { "一部关于旧事与选择的故事。".into() } else { logline.clone() }),
                    format!("文风：{}", if style.is_empty() { "克制、具体".into() } else { style.clone() }),
                    format!("目标章数：{}", titles.len()),
                    "每章字数：800".into(),
                    "章目：".into(),
                ];
                for (i, t) in titles.iter().enumerate() {
                    lines.push(format!("{}. {t}", i + 1));
                }
                lines.push(String::new());
                lines.push(format!(
                    "档案：{title}写的是普通人在具体物件与人情里的进退。文风偏{style}。"
                ));
                lines.join("\n")
            }
            "outline" => {
                let mut lines = Vec::new();
                for (i, t) in titles.iter().enumerate() {
                    lines.push(format!("{}. {t}", i + 1));
                    lines.push(format!(
                        "这一章必须落地：旧因新果在「{t}」里不可退回，人物被迫做一次具体选择。"
                    ));
                    lines.push(String::new());
                }
                lines.join("\n").trim().to_string()
            }
            "chapter_outline" => {
                let ch = section(&input.context, "本章");
                let name = field(&ch, "章名");
                let name = if name.is_empty() { "本章".into() } else { name };
                format!(
                    "章名：{name}\n场景一：目标—弄清一件旧物；冲突—对方不说；细节—桌角缺口\n场景二：目标—换得一句实话；冲突—被岔开；细节—窗外雨声\n场景三：目标—决定是否继续；冲突—退路被堵；细节—钥匙发烫\n章末钩子：门缝里多出一张纸条。"
                )
            }
            "chapter_body" | "humanize" => {
                let ch = section(&input.context, "本章");
                let name = field(&ch, "章名");
                let body = section(&input.context, "本章正文");
                if input.scene == "humanize" && !body.is_empty() {
                    humanize_local(&body)
                } else {
                    format!(
                        "雨刚停，街面还反着薄光。{name}这件事没有开场白。\n\n“你来得正好。”对方把茶杯推过来，“别装没听见。”\n\n他没有立刻回答，只把袖口的水珠抹掉。窗外有人踩着旧板走过，一步近一寸。他知道：今晚若不把话说清，明天就更难开口。"
                    )
                }
            }
            "review" => "1. 类型：节奏\n原句：……\n改法：把解释压成动作。\n2. 类型：对白\n原句：……\n改法：改用弯引号，去掉说明腔。".into(),
            "memory_extract" => "事实：雨停后见面\n物件：茶杯、纸条\n下章必接：纸条上的字".into(),
            "chat" => format!(
                "关于《{title}》：我可以按场景帮你写全书大纲、细纲、正文或审核。直接说“写第 1 章正文”“审核第 2 章”之类即可。"
            ),
            _ => format!("档案草稿：《{title}》"),
        };

        if level == ThinkingIntensity::High
            && (input.scene == "chapter_body" || input.scene == "humanize")
        {
            text = format!(
                "{}\n\n（本地草稿·高思考：动机与钩子已按可推敲密度收束。）",
                text.trim()
            );
        }
        text = normalize_dialogue_quotes(text.trim());
        Ok(RunOutput {
            text,
            model_used: format!("local-draft/{}", level.as_str()),
            usage: None,
        })
    }
}
