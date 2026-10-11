/**
 * D4（P1）设定硬约束：从设定卡 / 档案里显式标注的「硬约束：」行解析不变式，
 * 以独立、不可截断的【硬约束】段注入上下文，并对正文做确定性预检（带原文引用）。
 *
 * 写法（设定卡 summary/details 或档案正文中任一行）：
 *   硬约束：铜表停在三点十七分，指针永不再走 ｜禁：指针在走、秒针*走、分针爬
 * 「禁：」后为违例特征词，`*` 表示中间可隔 0–8 个字；命中前若带否定（没/不/未/停/别/无）视为遵守。
 * 没写「禁：」的约束仍注入并交给审核逐条核对，预检标记为 needs_review。
 */
import { db } from "./db";
import { HttpError } from "./httpError";
import { listBibleCards } from "./features";

export const HARD_CONSTRAINT_BUDGET_CHARS = 6000;

export type HardConstraint = {
  id: string;
  text: string;
  forbid: string[];
  source: { kind: "bible_card" | "book_profile"; id?: string; name?: string };
};

export type HardConstraintViolation = {
  constraintId: string;
  constraint: string;
  pattern: string;
  quote: string;
  index: number;
};

export type HardConstraintCheck = {
  checked: number;
  violations: HardConstraintViolation[];
  needsReview: string[];
};

const LINE_RE = /(?:^|[\n；;])\s*[【\[]?硬约束[】\]]?\s*[:：]\s*([^\n]+)/g;

export function parseHardConstraintLines(text: string): Array<{ text: string; forbid: string[] }> {
  const out: Array<{ text: string; forbid: string[] }> = [];
  if (!text) return out;
  for (const m of text.matchAll(LINE_RE)) {
    const raw = m[1].trim();
    const [head, ...rest] = raw.split(/[|｜]\s*禁\s*[:：]/);
    const forbid = rest
      .join("、")
      .split(/[、,，/]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const t = head.replace(/[|｜]\s*$/, "").trim();
    if (t) out.push({ text: t, forbid });
  }
  return out;
}

function profileBody(bookId: string): string {
  const row = db
    .prepare(
      `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
       WHERE a.book_id = ? AND a.kind = 'book_profile' AND a.chapter_id IS NULL`,
    )
    .get(bookId) as { body: string } | undefined;
  return row?.body ?? "";
}

export function listHardConstraints(bookId: string): HardConstraint[] {
  const list: HardConstraint[] = [];
  let n = 0;
  for (const card of listBibleCards(bookId)) {
    for (const c of parseHardConstraintLines(`${card.summary}\n${card.details}`)) {
      list.push({ id: `H${++n}`, ...c, source: { kind: "bible_card", id: card.id, name: card.name } });
    }
  }
  for (const c of parseHardConstraintLines(profileBody(bookId))) {
    if (list.some((x) => x.text === c.text)) continue;
    list.push({ id: `H${++n}`, ...c, source: { kind: "book_profile" } });
  }
  return list;
}

/** 渲染【硬约束】段；超预算直接报错，绝不静默截断。 */
export function formatHardConstraintsSection(bookId: string): string {
  const list = listHardConstraints(bookId);
  if (!list.length) return "";
  const body = [
    "以下为不可违背的设定不变式，优先级高于一切其他上下文与技能；正文/细纲/改写不得写出与之矛盾的情节或描写：",
    ...list.map((c) => `${c.id}. ${c.text}${c.source.name ? `（来源：${c.source.name}）` : ""}${c.forbid.length ? `；禁止写出：${c.forbid.join("、")}` : ""}`),
  ].join("\n");
  if (Array.from(body).length > HARD_CONSTRAINT_BUDGET_CHARS) {
    throw new HttpError(
      400,
      `硬约束共 ${Array.from(body).length} 字，超过上限 ${HARD_CONSTRAINT_BUDGET_CHARS} 字；硬约束不可截断，请精简后再生成`,
    );
  }
  return body;
}

const NEG = /[没不未停别无莫勿非]/;

function patternToRegex(p: string): RegExp {
  const esc = p
    .split("*")
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^。！？\\n]{0,8}?");
  return new RegExp(esc, "g");
}

export function checkTextAgainstConstraints(text: string, list: HardConstraint[]): HardConstraintCheck {
  const violations: HardConstraintViolation[] = [];
  const needsReview: string[] = [];
  for (const c of list) {
    if (!c.forbid.length) {
      needsReview.push(c.id);
      continue;
    }
    for (const p of c.forbid) {
      for (const m of text.matchAll(patternToRegex(p))) {
        const idx = m.index ?? 0;
        const before = text.slice(Math.max(0, idx - 3), idx);
        if (NEG.test(m[0].slice(1, -1)) || NEG.test(before)) continue;
        const head = text.slice(Math.max(0, idx - 40), idx);
        const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
        const start = Math.max(0, idx - 40) + (cut >= 0 ? cut + 1 : 0);
        const tailM = /[。！？\n]/.exec(text.slice(idx + m[0].length, idx + m[0].length + 40));
        const end = idx + m[0].length + (tailM ? tailM.index + 1 : 40);
        const quote = text.slice(start, Math.min(text.length, end)).replace(/\s+/g, " ").trim();
        violations.push({ constraintId: c.id, constraint: c.text, pattern: p, quote, index: idx });
      }
    }
  }
  return { checked: list.length, violations, needsReview };
}

export function checkHardConstraints(bookId: string, text: string): HardConstraintCheck {
  return checkTextAgainstConstraints(text, listHardConstraints(bookId));
}

export function formatViolationsNote(check: HardConstraintCheck): string {
  if (!check.violations.length) return "";
  return [
    `硬约束预检命中 ${check.violations.length} 处：`,
    ...check.violations.slice(0, 10).map((v) => `- ${v.constraintId}「${v.constraint}」← 原文：“${v.quote}”`),
  ].join("\n");
}

/** 审核场景：要求逐条核对每条硬约束，并附确定性预检结果。 */
export function formatHardConstraintsForReview(bookId: string, chapterText: string): string {
  const list = listHardConstraints(bookId);
  if (!list.length) return "";
  const pre = checkTextAgainstConstraints(chapterText, list);
  return [
    "【硬约束逐条核对（必做）】",
    "请在审核报告最前面单列「硬约束核对」小节，对下列每一条输出：编号｜遵守/违反/无涉及｜若违反，引用本章原文句子。不得省略任何一条。",
    ...list.map((c) => `${c.id}. ${c.text}`),
    pre.violations.length ? `机器预检已命中（请复核并纳入报告）：\n${pre.violations.map((v) => `- ${v.constraintId}：“${v.quote}”`).join("\n")}` : "机器预检：未命中禁止特征词（仍需语义核对）。",
  ].join("\n");
}
