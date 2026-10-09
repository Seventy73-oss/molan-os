import { db } from "./db";
import { HttpError } from "./httpError";
import { countChars } from "./features";

export type HookItem = {
  key: string;
  fromChapter: number;
  fromTitle: string;
  text: string;
  source: "memory" | "outline";
  status: "open" | "recycled" | "marked";
  recycledIn: number | null;
  warning: boolean;
};

function mustBook(id: string) {
  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(id) as { id: string } | undefined;
  if (!book) throw new HttpError(404, "没有这本书");
}

function hookKey(fromChapter: number, text: string): string {
  const norm = text.replace(/\s+/g, " ").trim().slice(0, 120);
  return `${fromChapter}:${norm}`;
}

function extractHooksFromText(text: string): string[] {
  const out: string[] = [];
  for (const line of (text || "").replace(/\r\n?/g, "\n").split("\n")) {
    const m =
      line.match(/^(?:未回收|下一章必须接住|章末钩子|章末留下)[：:]\s*(.+)$/) ||
      line.match(/^[-*]\s*(?:未回收|钩子)[：:]\s*(.+)$/);
    if (m?.[1]) {
      const t = m[1].trim();
      if (t.length >= 2) out.push(t);
    }
  }
  return out;
}

function significantTokens(text: string): string[] {
  const raw = text.replace(/[，。！？、；：""''（）【】《》…—\s]/g, " ");
  const parts = raw.split(" ").map((p) => p.trim()).filter((p) => p.length >= 2);
  // Prefer longer CJK chunks
  const tokens = new Set<string>();
  for (const p of parts) {
    if (p.length >= 2) tokens.add(p.slice(0, 12));
    if (/[\u4e00-\u9fff]{2,}/.test(p)) {
      for (let i = 0; i < p.length - 1 && tokens.size < 8; i++) {
        tokens.add(p.slice(i, i + 2));
      }
    }
  }
  return [...tokens].slice(0, 10);
}

function laterBodies(bookId: string, afterChapter: number): { number: number; body: string }[] {
  return db
    .prepare(
      `SELECT c.number AS number, COALESCE(r.body, '') AS body
       FROM chapters c
       LEFT JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = 'chapter_body'
       LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
       WHERE c.book_id = ? AND c.number > ?
       ORDER BY c.number`,
    )
    .all(bookId, afterChapter) as { number: number; body: string }[];
}

export function listHooks(bookId: string): HookItem[] {
  mustBook(bookId);
  const chapters = db
    .prepare("SELECT number, title FROM chapters WHERE book_id = ? ORDER BY number")
    .all(bookId) as { number: number; title: string }[];
  const titleOf = new Map(chapters.map((c) => [c.number, c.title]));
  const marks = db
    .prepare("SELECT hook_key, status, recycled_chapter FROM hook_marks WHERE book_id = ?")
    .all(bookId) as { hook_key: string; status: string; recycled_chapter: number | null }[];
  const markMap = new Map(marks.map((m) => [m.hook_key, m]));

  const hooks: HookItem[] = [];
  const seen = new Set<string>();

  const memRows = db
    .prepare(
      `SELECT c.number AS number, r.body AS body
       FROM chapters c
       JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = 'chapter_memory'
       JOIN artifact_revisions r ON r.id = a.current_revision_id
       WHERE c.book_id = ?
       ORDER BY c.number`,
    )
    .all(bookId) as { number: number; body: string }[];
  for (const row of memRows) {
    for (const text of extractHooksFromText(row.body)) {
      const key = hookKey(row.number, text);
      if (seen.has(key)) continue;
      seen.add(key);
      hooks.push({
        key,
        fromChapter: row.number,
        fromTitle: titleOf.get(row.number) ?? `第${row.number}章`,
        text,
        source: "memory",
        status: "open",
        recycledIn: null,
        warning: true,
      });
    }
  }

  const outlineRows = db
    .prepare(
      `SELECT c.number AS number, r.body AS body
       FROM chapters c
       JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = 'chapter_outline'
       JOIN artifact_revisions r ON r.id = a.current_revision_id
       WHERE c.book_id = ?
       ORDER BY c.number`,
    )
    .all(bookId) as { number: number; body: string }[];
  for (const row of outlineRows) {
    for (const text of extractHooksFromText(row.body)) {
      const key = hookKey(row.number, text);
      if (seen.has(key)) continue;
      seen.add(key);
      hooks.push({
        key,
        fromChapter: row.number,
        fromTitle: titleOf.get(row.number) ?? `第${row.number}章`,
        text,
        source: "outline",
        status: "open",
        recycledIn: null,
        warning: true,
      });
    }
  }

  for (const hook of hooks) {
    const mark = markMap.get(hook.key);
    if (mark?.status === "recycled" || mark?.status === "marked") {
      hook.status = mark.status as "recycled" | "marked";
      hook.recycledIn = mark.recycled_chapter;
      hook.warning = false;
      continue;
    }
    const tokens = significantTokens(hook.text);
    if (!tokens.length) continue;
    for (const later of laterBodies(bookId, hook.fromChapter)) {
      if (!later.body || countChars(later.body) < 20) continue;
      const hits = tokens.filter((t) => later.body.includes(t)).length;
      if (hits >= Math.min(2, tokens.length) || (tokens.length === 1 && hits === 1)) {
        hook.status = "recycled";
        hook.recycledIn = later.number;
        hook.warning = false;
        break;
      }
    }
  }

  return hooks.sort((a, b) => a.fromChapter - b.fromChapter || a.text.localeCompare(b.text, "zh"));
}

export function markHook(
  bookId: string,
  hookKeyValue: string,
  status: "open" | "recycled" | "marked",
  recycledChapter?: number | null,
  note?: string,
) {
  mustBook(bookId);
  const existing = db
    .prepare("SELECT id FROM hook_marks WHERE book_id = ? AND hook_key = ?")
    .get(bookId, hookKeyValue) as { id: string } | undefined;
  const ts = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE hook_marks SET status = ?, recycled_chapter = ?, note = ?, updated_at = ? WHERE id = ?`,
    ).run(status, recycledChapter ?? null, note ?? "", ts, existing.id);
  } else {
    db.prepare(
      `INSERT INTO hook_marks (id, book_id, hook_key, status, recycled_chapter, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), bookId, hookKeyValue, status, recycledChapter ?? null, note ?? "", ts);
  }
  return listHooks(bookId).find((h) => h.key === hookKeyValue) ?? null;
}

export function formatOpenHooksForContext(bookId: string, beforeChapter: number | null): string {
  const hooks = listHooks(bookId).filter((h) => h.warning || h.status === "open");
  const relevant = beforeChapter
    ? hooks.filter((h) => h.fromChapter < beforeChapter)
    : hooks;
  if (!relevant.length) return "";
  return relevant
    .map((h) => `第${h.fromChapter}章未回收钩子：${h.text}`)
    .join("\n");
}

export function formatOpenHooksForReview(bookId: string, chapterNumber: number): string {
  const open = listHooks(bookId).filter(
    (h) => h.fromChapter < chapterNumber && (h.warning || h.status === "open"),
  );
  if (!open.length) return "";
  return [
    "【跨章未回收钩子 — 请核对本章是否接住】",
    ...open.map((h) => `- 第${h.fromChapter}章：${h.text}`),
  ].join("\n");
}
