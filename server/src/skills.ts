import fs from "node:fs";
import path from "node:path";
import { db, root, skillsDir } from "./db";

export type SkillRow = {
  id: string;
  name: string;
  scene: string;
  role: string;
  path: string;
  enabled: number;
};

export type SkillText = {
  id: string;
  name: string;
  role: string;
  text: string;
};

type PackSpec = {
  id: string;
  title: string;
  /** Relative paths under skills/<id>/pack/ to inject (in order). */
  inject: string[];
  /** Scenes that should auto-attach this pack when enabled. */
  attachScenes: Set<string>;
  defaultMaxChars: number;
  markers?: Record<string, (text: string) => boolean>;
};

const USER_PACKS: PackSpec[] = [
  {
    id: "humanize",
    title: "网文去AI味流水线（用户包 skills_V0.4）",
    inject: [
      "references/00_门速查卡.md",
      "references/04_病灶库.md",
      "data/中文腔禁词清单_v2.json",
      "references/01_规则书_V0.40.md",
      "references/11_恶人编辑_子代理审核包.md",
    ],
    attachScenes: new Set(["humanize", "chapter_body", "review", "chapter_outline"]),
    defaultMaxChars: 48000,
    markers: {
      menSpeedCheck: (t) => t.includes("门速查"),
      rulebook: (t) => t.includes("规则书"),
      lesionLib: (t) => t.includes("病灶"),
      banList: (t) => t.includes("中文腔禁词") || t.includes("铁禁"),
      evilEditor: (t) => t.includes("恶人编辑"),
      sevenSteps: (t) => t.includes("每章 7 步") || t.includes("7 步"),
    },
  },
  {
    id: "opening-cards",
    title: "开局拆解卡（用户包 01-开局拆解卡_1983本）",
    inject: ["inject/00_方法论.md", "inject/01_题材分布与样例.md"],
    attachScenes: new Set(["book_setup", "topic", "chapter_outline"]),
    defaultMaxChars: 36000,
    markers: {
      openingMethod: (t) => t.includes("开局拆解卡"),
      hookChain: (t) => t.includes("钩子链"),
      openType: (t) => t.includes("开局型"),
    },
  },
  {
    id: "volume-arcs",
    title: "卷级蒸馏（用户包 02-卷级蒸馏_1175本）",
    inject: ["inject/00_方法论.md", "inject/01_题材分布与样例.md"],
    attachScenes: new Set(["outline"]),
    defaultMaxChars: 36000,
    markers: {
      volumeMethod: (t) => t.includes("卷级蒸馏"),
      growthLadder: (t) => t.includes("成长") || t.includes("成长阶梯") || t.includes("成长兑付"),
      arcSample: (t) => t.includes("弧段") || t.includes("主线推进"),
    },
  },
  {
    id: "structure-skeleton",
    title: "结构骨架（用户包 03-结构骨架_1983本）",
    inject: ["inject/00_方法论.md", "inject/01_题材统计与样例.md"],
    attachScenes: new Set(["outline", "chapter_outline", "book_setup"]),
    defaultMaxChars: 36000,
    markers: {
      skeletonMethod: (t) => t.includes("结构骨架"),
      chapterMedian: (t) => t.includes("章数中位") || t.includes("卷数中位"),
      chapterNames: (t) => t.includes("章名"),
    },
  },
  {
    id: "style-corpus",
    title: "文风语料（用户包 04-文风语料）",
    inject: ["inject/00_方法论.md", "inject/01_作者与题材文风.md"],
    attachScenes: new Set(["chapter_body", "humanize"]),
    defaultMaxChars: 40000,
    markers: {
      styleMethod: (t) => t.includes("文风语料"),
      authorCard: (t) => t.includes("古龙") || t.includes("猫腻") || t.includes("作者文风"),
      genreStyle: (t) => t.includes("文风增量") || t.includes("题材文风"),
    },
  },
  {
    id: "novel-craft",
    title: "选题创作（用户包 novel-craft）",
    inject: ["inject/01_关键卡.md"],
    attachScenes: new Set(["topic", "book_setup", "outline", "chapter_outline", "chapter_body"]),
    defaultMaxChars: 48000,
    markers: {
      craftOverview: (t) => t.includes("跨题材总览") || t.includes("novel-craft") || t.includes("选题与创作"),
      openingTable: (t) => t.includes("开局类型"),
      failModes: (t) => t.includes("低分书") || t.includes("失败模式"),
      templates: (t) => t.includes("建书档案") || t.includes("卷纲") || t.includes("章纲"),
    },
  },
];

const PACK_BY_ID = new Map(USER_PACKS.map((p) => [p.id, p]));

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "").replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).trim().split("\n")) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (match) meta[match[1]!] = match[2]!.trim();
  }
  return { meta, body: text.slice(end + 4).replace(/^\s+/, "") };
}

export function reloadSkills(): SkillRow[] {
  fs.mkdirSync(skillsDir, { recursive: true });
  const upsert = db.prepare(
    `INSERT INTO skills (id, name, scene, role, path, enabled)
     VALUES (@id, @name, @scene, @role, @path, 1)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       scene = excluded.scene,
       role = excluded.role,
       path = excluded.path`,
  );
  const tx = db.transaction(() => {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = path.posix.join("skills", entry.name, "SKILL.md");
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) continue;
      const { meta } = parseFrontmatter(fs.readFileSync(abs, "utf8"));
      upsert.run({
        id: entry.name,
        name: meta.name || entry.name,
        scene: meta.scene || "chapter_body",
        role: meta.role === "aux" ? "aux" : "primary",
        path: rel,
      });
    }
    const rows = db.prepare("SELECT id, path FROM skills").all() as { id: string; path: string }[];
    for (const row of rows) {
      if (!fs.existsSync(path.join(root, row.path))) {
        db.prepare("DELETE FROM skills WHERE id = ?").run(row.id);
      }
    }
  });
  tx();
  return db.prepare("SELECT * FROM skills ORDER BY scene, role DESC, id").all() as SkillRow[];
}

export function readSkillFile(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8").replace(/^\uFEFF/, "");
}

export function skillDescription(raw: string): string {
  return parseFrontmatter(raw).meta.description ?? "";
}

function readUserPackFile(packId: string, relFromPack: string): string | null {
  const abs = path.join(root, "skills", packId, "pack", relFromPack);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, "");
}

function clip(text: string, max: number, packId: string): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n\n…（已截断；完整见 skills/${packId}/pack/ 对应文件）`;
}

function joinCapped(parts: string[], maxChars: number, packId: string): string {
  const joined = parts.join("\n\n---\n\n");
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}\n\n…（技能注入过长已截断；完整包在 skills/${packId}/pack/）`;
}

/** Load the user's uploaded humanize pack by path — not a longjuan-authored summary. */
export function loadHumanizePackPrompt(maxChars = 48000): string {
  return loadUserPackPrompt("humanize", maxChars);
}

export function loadUserPackPrompt(packId: string, maxChars?: number): string {
  const spec = PACK_BY_ID.get(packId);
  if (!spec) {
    const body = parseFrontmatter(readSkillFile(`skills/${packId}/SKILL.md`)).body.trim();
    return body;
  }
  const cap = maxChars ?? spec.defaultMaxChars;
  const parts: string[] = [];
  const skillRaw = readSkillFile(`skills/${packId}/SKILL.md`);
  parts.push(`# ${spec.title}\n\n${parseFrontmatter(skillRaw).body.trim()}`);

  for (const rel of spec.inject) {
    const raw = readUserPackFile(packId, rel);
    if (!raw) continue;
    // Soft per-file caps so multi-file packs stay balanced.
    const perFile = Math.min(16000, Math.floor(cap / Math.max(2, spec.inject.length)));
    parts.push(`# 原文 · ${rel}\n\n${clip(raw, perFile, packId)}`);
  }

  return joinCapped(parts, cap, packId);
}

export function userPackSources(packId: string): string[] {
  const spec = PACK_BY_ID.get(packId);
  if (!spec) return [`skills/${packId}/SKILL.md`];
  return [`skills/${packId}/SKILL.md`, ...spec.inject.map((rel) => `skills/${packId}/pack/${rel}`)];
}

export function isUserPack(id: string): boolean {
  return PACK_BY_ID.has(id);
}

export function userPackDefaultMax(id: string): number {
  return PACK_BY_ID.get(id)?.defaultMaxChars ?? 12000;
}

/** Body only (no frontmatter), for prompt injection. Soft-cap keeps multi-skill prompts usable. */
export function skillPromptText(rel: string, maxChars = 12000): string {
  const match = rel.match(/skills\/([^/]+)\/SKILL\.md$/);
  const id = match?.[1];
  if (id && PACK_BY_ID.has(id)) {
    return loadUserPackPrompt(id, Math.max(maxChars, PACK_BY_ID.get(id)!.defaultMaxChars / 2));
  }
  const body = parseFrontmatter(readSkillFile(rel)).body.trim();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n…（技能正文过长，已截断；完整内容见磁盘 ${rel}）`;
}

function attachPack(picked: SkillRow[], scene: string, packId: string): SkillRow[] {
  const pack = db.prepare("SELECT * FROM skills WHERE id = ?").get(packId) as SkillRow | undefined;
  if (!pack || pack.enabled !== 1) return picked;
  if (picked.some((row) => row.id === packId)) return picked;
  const asPrimary = pack.scene === scene && pack.role === "primary";
  return [...picked, asPrimary ? pack : { ...pack, role: "aux" }];
}

export function skillsForScene(scene: string, ids?: string[]): SkillRow[] {
  const rows = db.prepare("SELECT * FROM skills WHERE scene = ?").all(scene) as SkillRow[];
  let picked = ids?.length ? rows.filter((row) => ids.includes(row.id)) : rows.filter((row) => row.enabled === 1);

  // When the caller pinpoints skillIds, still honor explicit ids only — except we still
  // allow auto-attach when ids omitted (normal generation path).
  if (!ids?.length) {
    for (const pack of USER_PACKS) {
      if (pack.attachScenes.has(scene)) {
        picked = attachPack(picked, scene, pack.id);
      }
    }
  } else {
    // If caller asked for a user pack id that lives on another scene row, still include it.
    for (const id of ids) {
      if (!PACK_BY_ID.has(id)) continue;
      if (picked.some((row) => row.id === id)) continue;
      const pack = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
      if (pack && pack.enabled === 1) picked = [...picked, pack];
    }
  }

  return picked.sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === "primary" ? -1 : 1));
}

export function toSkillTexts(skills: SkillRow[], maxChars?: number): SkillText[] {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    role: skill.role,
    text: skillPromptText(skill.path, maxChars ?? userPackDefaultMax(skill.id)),
  }));
}

export function skillPromptMeta(texts: SkillText[]) {
  return texts.map((skill) => {
    const spec = PACK_BY_ID.get(skill.id);
    const markers: Record<string, boolean> = {};
    if (spec?.markers) {
      for (const [key, fn] of Object.entries(spec.markers)) {
        markers[key] = fn(skill.text);
      }
    }
    return {
      id: skill.id,
      name: skill.name,
      role: skill.role,
      chars: skill.text.length,
      excerpt: skill.text.slice(0, 360),
      fromUserPack: Boolean(spec),
      markers: {
        // keep humanize keys for older UI/tests
        menSpeedCheck: skill.text.includes("门速查"),
        rulebook: skill.text.includes("规则书"),
        lesionLib: skill.text.includes("病灶"),
        banList: skill.text.includes("中文腔禁词") || skill.text.includes("铁禁"),
        evilEditor: skill.text.includes("恶人编辑"),
        sevenSteps: skill.text.includes("每章 7 步") || skill.text.includes("7 步"),
        ...markers,
      },
    };
  });
}
