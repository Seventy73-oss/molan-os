//! Skills + user pack attachScenes — mirrors Node `server/src/skills.ts`.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct SkillRow {
    pub id: String,
    pub name: String,
    pub scene: String,
    pub role: String,
    pub path: String,
    pub enabled: i64,
}

struct PackSpec {
    id: &'static str,
    title: &'static str,
    inject: &'static [&'static str],
    attach_scenes: &'static [&'static str],
    default_max_chars: usize,
}

fn user_packs() -> &'static [PackSpec] {
    static PACKS: OnceLock<Vec<PackSpec>> = OnceLock::new();
    PACKS.get_or_init(|| {
        vec![
            PackSpec {
                id: "humanize",
                title: "网文去AI味流水线（用户包 skills_V0.4）",
                inject: &[
                    "references/00_门速查卡.md",
                    "references/04_病灶库.md",
                    "data/中文腔禁词清单_v2.json",
                    "references/01_规则书_V0.40.md",
                    "references/11_恶人编辑_子代理审核包.md",
                ],
                attach_scenes: &["humanize", "chapter_body", "review"],
                default_max_chars: 48000,
            },
            PackSpec {
                id: "opening-cards",
                title: "开局拆解卡（用户包 01-开局拆解卡_1983本）",
                inject: &["inject/00_方法论.md", "inject/01_题材分布与样例.md"],
                attach_scenes: &["book_setup", "topic", "chapter_outline", "chat"],
                default_max_chars: 36000,
            },
            PackSpec {
                id: "volume-arcs",
                title: "卷级蒸馏（用户包 02-卷级蒸馏_1175本）",
                inject: &["inject/00_方法论.md", "inject/01_题材分布与样例.md"],
                attach_scenes: &["outline"],
                default_max_chars: 36000,
            },
            PackSpec {
                id: "structure-skeleton",
                title: "结构骨架（用户包 03-结构骨架_1983本）",
                inject: &["inject/00_方法论.md", "inject/01_题材统计与样例.md"],
                attach_scenes: &["outline", "book_setup"],
                default_max_chars: 36000,
            },
            PackSpec {
                id: "style-corpus",
                title: "文风语料（用户包 04-文风语料）",
                inject: &["inject/00_方法论.md", "inject/01_作者与题材文风.md"],
                attach_scenes: &["chapter_body", "humanize"],
                default_max_chars: 40000,
            },
            PackSpec {
                id: "novel-craft",
                title: "选题创作（用户包 novel-craft）",
                inject: &["inject/01_关键卡.md"],
                attach_scenes: &["topic", "book_setup", "outline", "chapter_outline", "chat"],
                default_max_chars: 48000,
            },
        ]
    })
}

fn pack_by_id() -> &'static HashMap<&'static str, &'static PackSpec> {
    static MAP: OnceLock<HashMap<&'static str, &'static PackSpec>> = OnceLock::new();
    MAP.get_or_init(|| user_packs().iter().map(|p| (p.id, p)).collect())
}

pub fn is_user_pack(id: &str) -> bool {
    pack_by_id().contains_key(id)
}

pub fn attach_scenes_of_pack(pack_id: &str) -> Vec<String> {
    pack_by_id()
        .get(pack_id)
        .map(|p| p.attach_scenes.iter().map(|s| (*s).to_string()).collect())
        .unwrap_or_default()
}

pub fn user_pack_ids_for_scene(scene: &str) -> Vec<String> {
    user_packs()
        .iter()
        .filter(|p| p.attach_scenes.contains(&scene))
        .map(|p| p.id.to_string())
        .collect()
}

pub fn user_pack_default_max(id: &str) -> usize {
    pack_by_id()
        .get(id)
        .map(|p| p.default_max_chars)
        .unwrap_or(12000)
}

pub fn parse_frontmatter(raw: &str) -> (HashMap<String, String>, String) {
    let text = raw.trim_start_matches('\u{feff}');
    if !text.starts_with("---") {
        return (HashMap::new(), text.to_string());
    }
    let Some(end) = text[3..].find("\n---") else {
        return (HashMap::new(), text.to_string());
    };
    let meta_block = &text[3..3 + end];
    let body = text[3 + end + 4..].trim_start().to_string();
    let mut meta = HashMap::new();
    for line in meta_block.trim().lines() {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            if k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                meta.insert(k.to_string(), v.trim().to_string());
            }
        }
    }
    (meta, body)
}

fn skills_dir(root: &Path) -> PathBuf {
    root.join("skills")
}

pub fn read_skill_file(root: &Path, rel: &str) -> AppResult<String> {
    let abs = root.join(rel);
    let raw = fs::read_to_string(&abs).map_err(|e| {
        AppError::Other(anyhow::anyhow!("read skill {}: {e}", abs.display()))
    })?;
    Ok(raw.trim_start_matches('\u{feff}').to_string())
}

pub fn skill_description(raw: &str) -> String {
    parse_frontmatter(raw).0.get("description").cloned().unwrap_or_default()
}

fn read_user_pack_file(root: &Path, pack_id: &str, rel: &str) -> Option<String> {
    let abs = root.join("skills").join(pack_id).join("pack").join(rel);
    fs::read_to_string(abs)
        .ok()
        .map(|s| s.trim_start_matches('\u{feff}').to_string())
}

fn clip(text: &str, max: usize, pack_id: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let clipped: String = t.chars().take(max).collect();
    format!("{clipped}\n\n…（已截断；完整见 skills/{pack_id}/pack/ 对应文件）")
}

fn join_capped(parts: &[String], max_chars: usize, pack_id: &str) -> String {
    let joined = parts.join("\n\n---\n\n");
    if joined.chars().count() <= max_chars {
        return joined;
    }
    let clipped: String = joined.chars().take(max_chars).collect();
    format!("{clipped}\n\n…（技能注入过长已截断；完整包在 skills/{pack_id}/pack/）")
}

pub fn load_user_pack_prompt(root: &Path, pack_id: &str, max_chars: Option<usize>) -> AppResult<String> {
    let Some(spec) = pack_by_id().get(pack_id) else {
        let raw = read_skill_file(root, &format!("skills/{pack_id}/SKILL.md"))?;
        return Ok(parse_frontmatter(&raw).1.trim().to_string());
    };
    let cap = max_chars.unwrap_or(spec.default_max_chars);
    let mut parts = Vec::new();
    let skill_raw = read_skill_file(root, &format!("skills/{pack_id}/SKILL.md"))?;
    let body = parse_frontmatter(&skill_raw).1.trim().to_string();
    parts.push(format!("# {}\n\n{body}", spec.title));
    let per_file = 16000.min(cap / 2.max(spec.inject.len()));
    for rel in spec.inject {
        if let Some(raw) = read_user_pack_file(root, pack_id, rel) {
            parts.push(format!("# 原文 · {rel}\n\n{}", clip(&raw, per_file, pack_id)));
        }
    }
    Ok(join_capped(&parts, cap, pack_id))
}

pub fn user_pack_sources(pack_id: &str) -> Vec<String> {
    match pack_by_id().get(pack_id) {
        Some(spec) => {
            let mut v = vec![format!("skills/{pack_id}/SKILL.md")];
            for rel in spec.inject {
                v.push(format!("skills/{pack_id}/pack/{rel}"));
            }
            v
        }
        None => vec![format!("skills/{pack_id}/SKILL.md")],
    }
}

pub fn skill_prompt_text(root: &Path, rel: &str, max_chars: usize) -> AppResult<String> {
    if let Some(id) = rel
        .strip_prefix("skills/")
        .and_then(|s| s.strip_suffix("/SKILL.md"))
    {
        if let Some(spec) = pack_by_id().get(id) {
            return load_user_pack_prompt(
                root,
                id,
                Some(max_chars.max(spec.default_max_chars / 2)),
            );
        }
    }
    let raw = read_skill_file(root, rel)?;
    let body = parse_frontmatter(&raw).1.trim().to_string();
    if body.chars().count() <= max_chars {
        return Ok(body);
    }
    let clipped: String = body.chars().take(max_chars).collect();
    Ok(format!(
        "{clipped}\n\n…（技能正文过长，已截断；完整内容见磁盘 {rel}）"
    ))
}

fn load_skill_row(conn: &Connection, id: &str) -> AppResult<Option<SkillRow>> {
    Ok(conn
        .query_row(
            "SELECT id, name, scene, role, path, enabled FROM skills WHERE id = ?1",
            params![id],
            |r| {
                Ok(SkillRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    scene: r.get(2)?,
                    role: r.get(3)?,
                    path: r.get(4)?,
                    enabled: r.get(5)?,
                })
            },
        )
        .optional()?)
}

fn attach_pack(conn: &Connection, mut picked: Vec<SkillRow>, pack_id: &str) -> AppResult<Vec<SkillRow>> {
    let Some(pack) = load_skill_row(conn, pack_id)? else {
        return Ok(picked);
    };
    if pack.enabled != 1 {
        return Ok(picked);
    }
    let as_primary = SkillRow {
        role: "primary".into(),
        ..pack.clone()
    };
    if let Some(idx) = picked.iter().position(|r| r.id == pack_id) {
        if picked[idx].role == "primary" {
            return Ok(picked);
        }
        picked[idx] = as_primary;
        return Ok(picked);
    }
    picked.push(as_primary);
    Ok(picked)
}

pub fn skills_for_scene(
    conn: &Connection,
    scene: &str,
    ids: Option<&[String]>,
) -> AppResult<Vec<SkillRow>> {
    let mut stmt =
        conn.prepare("SELECT id, name, scene, role, path, enabled FROM skills WHERE scene = ?1")?;
    let rows: Vec<SkillRow> = stmt
        .query_map(params![scene], |r| {
            Ok(SkillRow {
                id: r.get(0)?,
                name: r.get(1)?,
                scene: r.get(2)?,
                role: r.get(3)?,
                path: r.get(4)?,
                enabled: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;

    let mut picked: Vec<SkillRow> = if let Some(ids) = ids {
        let set: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
        rows.into_iter().filter(|r| set.contains(r.id.as_str())).collect()
    } else {
        rows.into_iter().filter(|r| r.enabled == 1).collect()
    };

    for pack in user_packs() {
        if pack.attach_scenes.contains(&scene) {
            picked = attach_pack(conn, picked, pack.id)?;
        }
    }

    if let Some(ids) = ids {
        for id in ids {
            let Some(spec) = pack_by_id().get(id.as_str()) else {
                continue;
            };
            if !spec.attach_scenes.contains(&scene) {
                continue;
            }
            if picked.iter().any(|r| r.id == *id) {
                continue;
            }
            if let Some(pack) = load_skill_row(conn, id)? {
                if pack.enabled == 1 {
                    picked.push(SkillRow {
                        role: "primary".into(),
                        ..pack
                    });
                }
            }
        }
    }

    for row in &mut picked {
        if is_user_pack(&row.id) {
            row.role = "primary".into();
        }
    }
    picked.sort_by(|a, b| {
        if a.role == b.role {
            a.id.cmp(&b.id)
        } else if a.role == "primary" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    Ok(picked)
}

pub fn reload_skills(db: &Db) -> AppResult<Vec<SkillRow>> {
    let root = db.root.clone();
    let dir = skills_dir(&root);
    let _ = fs::create_dir_all(&dir);
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let rel = format!("skills/{name}/SKILL.md");
                let abs = root.join(&rel);
                if !abs.exists() {
                    continue;
                }
                let raw = fs::read_to_string(&abs).unwrap_or_default();
                let (meta, _) = parse_frontmatter(&raw);
                let skill_name = meta.get("name").cloned().unwrap_or_else(|| name.clone());
                let scene = meta
                    .get("scene")
                    .cloned()
                    .unwrap_or_else(|| "chapter_body".into());
                let role = if meta.get("role").map(|s| s.as_str()) == Some("aux") {
                    "aux"
                } else {
                    "primary"
                };
                tx.execute(
                    r#"INSERT INTO skills (id, name, scene, role, path, enabled)
                       VALUES (?1, ?2, ?3, ?4, ?5, 1)
                       ON CONFLICT(id) DO UPDATE SET
                         name = excluded.name,
                         scene = excluded.scene,
                         role = excluded.role,
                         path = excluded.path"#,
                    params![name, skill_name, scene, role, rel],
                )?;
            }
        }
        let existing: Vec<(String, String)> = {
            let mut s = tx.prepare("SELECT id, path FROM skills")?;
            let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (id, path) in existing {
            if !root.join(&path).exists() {
                tx.execute("DELETE FROM skills WHERE id = ?1", params![id])?;
            }
        }
        tx.commit()?;

        let mut stmt = conn.prepare(
            "SELECT id, name, scene, role, path, enabled FROM skills ORDER BY scene, role DESC, id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SkillRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    scene: r.get(2)?,
                    role: r.get(3)?,
                    path: r.get(4)?,
                    enabled: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn list_skills(db: &Db) -> AppResult<Vec<SkillRow>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, scene, role, path, enabled FROM skills ORDER BY scene, role DESC, id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SkillRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    scene: r.get(2)?,
                    role: r.get(3)?,
                    path: r.get(4)?,
                    enabled: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn set_skill_enabled(db: &Db, id: &str, enabled: bool) -> AppResult<SkillRow> {
    db.with_conn(|conn| {
        let row = load_skill_row(conn, id)?
            .ok_or_else(|| AppError::NotFound("没有这个技能".into()))?;
        conn.execute(
            "UPDATE skills SET enabled = ?1 WHERE id = ?2",
            params![if enabled { 1 } else { 0 }, row.id],
        )?;
        load_skill_row(conn, id)?.ok_or_else(|| AppError::NotFound("没有这个技能".into()))
    })
}

pub fn skill_json(db: &Db, row: &SkillRow) -> AppResult<Value> {
    let raw = read_skill_file(&db.root, &row.path).unwrap_or_default();
    let user_pack = is_user_pack(&row.id);
    let attach_scenes = if user_pack {
        attach_scenes_of_pack(&row.id)
    } else {
        vec![]
    };
    let role = if user_pack {
        "primary"
    } else {
        row.role.as_str()
    };
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "scene": row.scene,
        "role": role,
        "path": row.path,
        "enabled": row.enabled == 1,
        "description": skill_description(&raw),
        "body": raw,
        "userPack": user_pack,
        "attachScenes": attach_scenes,
    }))
}

pub fn skill_prompt_meta(id: &str, name: &str, role: &str, text: &str) -> Value {
    let markers = json!({
        "menSpeedCheck": text.contains("门速查"),
        "rulebook": text.contains("规则书"),
        "lesionLib": text.contains("病灶"),
        "banList": text.contains("中文腔禁词") || text.contains("铁禁"),
        "evilEditor": text.contains("恶人编辑"),
        "sevenSteps": text.contains("每章 7 步") || text.contains("7 步"),
    });
    let excerpt: String = text.chars().take(360).collect();
    json!({
        "id": id,
        "name": name,
        "role": role,
        "chars": text.chars().count(),
        "excerpt": excerpt,
        "fromUserPack": is_user_pack(id),
        "markers": markers,
    })
}

pub fn for_scene_payload(db: &Db, scene: &str) -> AppResult<Value> {
    db.with_conn(|conn| {
        let rows = skills_for_scene(conn, scene, None)?;
        let skills: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "name": row.name,
                    "scene": row.scene,
                    "role": if is_user_pack(&row.id) { "primary".into() } else { row.role },
                    "enabled": row.enabled == 1,
                    "userPack": is_user_pack(&row.id),
                    "attachScenes": if is_user_pack(&row.id) { attach_scenes_of_pack(&row.id) } else { vec![] },
                })
            })
            .collect();
        Ok(json!({
            "scene": scene,
            "autoAttachUserPacks": user_pack_ids_for_scene(scene),
            "skills": skills,
        }))
    })
}

pub fn prompt_preview(db: &Db, id: &str) -> AppResult<Value> {
    let row = db.with_conn(|conn| {
        load_skill_row(conn, id)?.ok_or_else(|| AppError::NotFound("没有这个技能".into()))
    })?;
    let max = user_pack_default_max(id);
    let text = skill_prompt_text(&db.root, &row.path, max)?;
    let role = if is_user_pack(id) {
        "primary"
    } else {
        row.role.as_str()
    };
    let meta = skill_prompt_meta(&row.id, &row.name, role, &text);
    let pack_prompt = if is_user_pack(id) {
        Some(load_user_pack_prompt(&db.root, id, None)?)
    } else {
        None
    };
    Ok(json!({
        "skill": {
            "id": row.id,
            "name": row.name,
            "scene": row.scene,
            "role": role,
            "path": row.path,
            "enabled": row.enabled == 1,
        },
        "prompt": meta,
        "packChars": pack_prompt.as_ref().map(|p| p.chars().count()),
        "packSources": if is_user_pack(id) { user_pack_sources(id) } else { vec![row.path] },
    }))
}
