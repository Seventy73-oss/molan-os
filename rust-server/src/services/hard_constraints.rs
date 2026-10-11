//! D4（P1）设定硬约束：与 Node `server/src/hardConstraints.ts` 1:1。
use crate::db::Db;
use crate::error::{AppError, AppResult};
use regex::Regex;
use serde_json::{json, Value};

pub const HARD_CONSTRAINT_BUDGET_CHARS: usize = 6000;

#[derive(Clone, Debug)]
pub struct HardConstraint {
    pub id: String,
    pub text: String,
    pub forbid: Vec<String>,
    pub source_kind: &'static str,
    pub source_id: Option<String>,
    pub source_name: Option<String>,
}

impl HardConstraint {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "text": self.text, "forbid": self.forbid,
            "source": {"kind": self.source_kind, "id": self.source_id, "name": self.source_name}})
    }
}

pub fn parse_lines(text: &str) -> Vec<(String, Vec<String>)> {
    let line_re = Regex::new(r"(?:^|[\n；;])\s*[【\[]?硬约束[】\]]?\s*[:：]\s*([^\n]+)").unwrap();
    let split_re = Regex::new(r"[|｜]\s*禁\s*[:：]").unwrap();
    let item_re = Regex::new(r"[、,，/]").unwrap();
    let mut out = Vec::new();
    for cap in line_re.captures_iter(text) {
        let raw = cap[1].trim();
        let mut parts = split_re.split(raw);
        let head = parts.next().unwrap_or("").trim().trim_end_matches(['|', '｜']).trim().to_string();
        let rest: Vec<&str> = parts.collect();
        let forbid: Vec<String> = item_re
            .split(&rest.join("、"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !head.is_empty() {
            out.push((head, forbid));
        }
    }
    out
}

pub fn list_hard_constraints(db: &Db, book_id: &str) -> AppResult<Vec<HardConstraint>> {
    let cards = crate::services::features::list_bible_cards(db, book_id)?;
    let mut list: Vec<HardConstraint> = Vec::new();
    let mut n = 0;
    for card in &cards {
        let s = format!(
            "{}\n{}",
            card.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
            card.get("details").and_then(|v| v.as_str()).unwrap_or("")
        );
        for (text, forbid) in parse_lines(&s) {
            n += 1;
            list.push(HardConstraint {
                id: format!("H{n}"),
                text,
                forbid,
                source_kind: "bible_card",
                source_id: card.get("id").and_then(|v| v.as_str()).map(String::from),
                source_name: card.get("name").and_then(|v| v.as_str()).map(String::from),
            });
        }
    }
    let profile = db.with_conn(|conn| Ok(crate::services::engine::artifact_body(conn, book_id, "book_profile", None)))?;
    for (text, forbid) in parse_lines(&profile) {
        if list.iter().any(|c| c.text == text) {
            continue;
        }
        n += 1;
        list.push(HardConstraint { id: format!("H{n}"), text, forbid, source_kind: "book_profile", source_id: None, source_name: None });
    }
    Ok(list)
}

pub fn format_section(db: &Db, book_id: &str) -> AppResult<String> {
    let list = list_hard_constraints(db, book_id)?;
    if list.is_empty() {
        return Ok(String::new());
    }
    let mut lines = vec!["以下为不可违背的设定不变式，优先级高于一切其他上下文与技能；正文/细纲/改写不得写出与之矛盾的情节或描写：".to_string()];
    for c in &list {
        let src = c.source_name.as_ref().map(|n| format!("（来源：{n}）")).unwrap_or_default();
        let fb = if c.forbid.is_empty() { String::new() } else { format!("；禁止写出：{}", c.forbid.join("、")) };
        lines.push(format!("{}. {}{}{}", c.id, c.text, src, fb));
    }
    let body = lines.join("\n");
    let len = body.chars().count();
    if len > HARD_CONSTRAINT_BUDGET_CHARS {
        return Err(AppError::BadRequest(format!(
            "硬约束共 {len} 字，超过上限 {HARD_CONSTRAINT_BUDGET_CHARS} 字；硬约束不可截断，请精简后再生成"
        )));
    }
    Ok(body)
}

fn pattern_regex(p: &str) -> Regex {
    let esc: Vec<String> = p.split('*').map(regex::escape).collect();
    Regex::new(&esc.join("[^。！？\\n]{0,8}?")).unwrap()
}

const NEG: &[char] = &['没', '不', '未', '停', '别', '无', '莫', '勿', '非'];

pub fn check_text(text: &str, list: &[HardConstraint]) -> Value {
    let chars: Vec<char> = text.chars().collect();
    let mut violations = Vec::new();
    let mut needs_review = Vec::new();
    for c in list {
        if c.forbid.is_empty() {
            needs_review.push(c.id.clone());
            continue;
        }
        for p in &c.forbid {
            for m in pattern_regex(p).find_iter(text) {
                let idx = text[..m.start()].chars().count();
                let mlen = m.as_str().chars().count();
                let mc: Vec<char> = m.as_str().chars().collect();
                let inner_neg = mc.len() > 2 && mc[1..mc.len() - 1].iter().any(|ch| NEG.contains(ch));
                let before_neg = chars[idx.saturating_sub(3)..idx].iter().any(|ch| NEG.contains(ch));
                if inner_neg || before_neg {
                    continue;
                }
                let hs = idx.saturating_sub(40);
                let head = &chars[hs..idx];
                let cut = head.iter().rposition(|ch| matches!(ch, '\n' | '。' | '！' | '？'));
                let start = hs + cut.map(|x| x + 1).unwrap_or(0);
                let after = idx + mlen;
                let tail_end = (after + 40).min(chars.len());
                let tpos = chars[after..tail_end].iter().position(|ch| matches!(ch, '\n' | '。' | '！' | '？'));
                let end = tpos.map(|x| after + x + 1).unwrap_or(tail_end);
                let quote: String = chars[start..end].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
                violations.push(json!({"constraintId": c.id, "constraint": c.text, "pattern": p, "quote": quote, "index": idx}));
            }
        }
    }
    json!({"checked": list.len(), "violations": violations, "needsReview": needs_review})
}

pub fn check(db: &Db, book_id: &str, text: &str) -> AppResult<Value> {
    Ok(check_text(text, &list_hard_constraints(db, book_id)?))
}

pub fn post_generation_check(db: &Db, book_id: &str, scene: &str, text: &str) -> Value {
    if !["chapter_body", "humanize", "chapter_outline", "selection_rewrite"].contains(&scene) {
        return Value::Null;
    }
    check(db, book_id, text).unwrap_or(Value::Null)
}

pub fn violations_note(check: &Value) -> String {
    let v = check.get("violations").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if v.is_empty() {
        return String::new();
    }
    let mut lines = vec![format!("⚠ 硬约束预检命中 {} 处：", v.len())];
    for x in v.iter().take(10) {
        lines.push(format!(
            "- {}「{}」← 原文：“{}”",
            x["constraintId"].as_str().unwrap_or(""),
            x["constraint"].as_str().unwrap_or(""),
            x["quote"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n")
}

pub fn format_for_review(db: &Db, book_id: &str, chapter_text: &str) -> AppResult<String> {
    let list = list_hard_constraints(db, book_id)?;
    if list.is_empty() {
        return Ok(String::new());
    }
    let pre = check_text(chapter_text, &list);
    let mut lines = vec![
        "【硬约束逐条核对（必做）】".to_string(),
        "请在审核报告最前面单列「硬约束核对」小节，对下列每一条输出：编号｜遵守/违反/无涉及｜若违反，引用本章原文句子。不得省略任何一条。".to_string(),
    ];
    for c in &list {
        lines.push(format!("{}. {}", c.id, c.text));
    }
    let v = pre["violations"].as_array().cloned().unwrap_or_default();
    if v.is_empty() {
        lines.push("机器预检：未命中禁止特征词（仍需语义核对）。".into());
    } else {
        let hits: Vec<String> = v.iter().map(|x| format!("- {}：“{}”", x["constraintId"].as_str().unwrap_or(""), x["quote"].as_str().unwrap_or(""))).collect();
        lines.push(format!("机器预检已命中（请复核并纳入报告）：\n{}", hits.join("\n")));
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn watch() -> Vec<HardConstraint> {
        parse_lines("硬约束：铜表停在三点十七分 ｜禁：指针*走、秒针*走、指针还在游、分针爬")
            .into_iter()
            .map(|(t, f)| HardConstraint { id: "H1".into(), text: t, forbid: f, source_kind: "bible_card", source_id: None, source_name: None })
            .collect()
    }
    #[test]
    fn d4_stopped_watch() {
        let l = watch();
        assert_eq!(l[0].forbid.len(), 4);
        let r = check_text("我掀开表盖，指针还在游，分针爬到二十。\n夜里我听见秒针还在走。", &l);
        let v = r["violations"].as_array().unwrap();
        assert!(v.len() >= 3);
        assert!(v.iter().any(|x| x["quote"] == "夜里我听见秒针还在走。"));
        let ok = check_text("指针没有走，仍是三点十七分。秒针早就不走了。", &l);
        assert_eq!(ok["violations"].as_array().unwrap().len(), 0);
    }
}
