import { createHash, randomUUID } from "node:crypto";
import { db } from "../db";
import { ReferenceError, optionalText, requiredText } from "./errors";

export const LIMITS = { importChars: 2_000_000, chapters: 2000, downloadChapters: 200, distillChars: 48000, chunkChars: 8000, maxChunks: 6, sources: 100, dailyJobs: 20 };
export const CARD_KINDS = ["opening", "structure", "pacing", "style"] as const;
export type CardKind = typeof CARD_KINDS[number];
export const CARD_STAGES: Record<CardKind, string[]> = {
  opening: ["topic", "book_setup", "chapter_outline", "chat"],
  structure: ["book_setup", "outline", "chapter_outline", "chat"],
  pacing: ["outline", "chapter_outline", "chapter_body", "review", "chat"],
  style: ["chapter_body", "humanize", "review", "chat"],
};
export type SourceRow = { id: string; owner_id: string; title: string; author: string; origin_kind: string; source_url: string; note: string; char_count: number; created_at: string };
export type ChapterRow = { id: string; owner_id: string; source_id: string; ordinal: number; title: string; body: string; source_url: string; char_count: number; content_hash: string };
export type JobRow = { id: string; owner_id: string; source_id: string; kind: "download" | "distill"; status: string; selection_json: string; focus_json: string; progress: number; total: number; error: string; model_label: string; tokens: number; created_at: string; updated_at: string };
export type Evidence = { chapterId: string; chapterTitle: string; ordinal: number; hash: string; from: number; to: number; quote: string };
export type CardRow = { id: string; owner_id: string; source_id: string; job_id: string; kind: CardKind; title: string; principle: string; application: string; caution: string; evidence_json: string; stages_json: string; approved: number; created_at: string };
export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");
export const now = () => new Date().toISOString();
const missing = () => new ReferenceError(404, "not_found", "参考资料不存在或无权访问");

export function sourceOwned(owner: string, id: string): SourceRow {
  const row = db.prepare("SELECT * FROM novel_sources WHERE id = ? AND owner_id = ?").get(id, owner) as SourceRow | undefined;
  if (!row) throw missing(); return row;
}
export function cardOwned(owner: string, id: string): CardRow {
  const row = db.prepare("SELECT * FROM novel_cards WHERE id = ? AND owner_id = ?").get(id, owner) as CardRow | undefined;
  if (!row) throw missing(); return row;
}
export function jobOwned(owner: string, id: string): JobRow {
  const row = db.prepare("SELECT * FROM novel_jobs WHERE id = ? AND owner_id = ?").get(id, owner) as JobRow | undefined;
  if (!row) throw missing(); return row;
}
export function cardView(row: CardRow) {
  return { id: row.id, sourceId: row.source_id, jobId: row.job_id, kind: row.kind, title: row.title, principle: row.principle, application: row.application, caution: row.caution, evidence: JSON.parse(row.evidence_json) as Evidence[], stages: JSON.parse(row.stages_json) as string[], approved: row.approved === 1, createdAt: row.created_at,
    bookIds: (db.prepare("SELECT book_id FROM novel_book_links WHERE card_id = ? AND owner_id = ?").all(row.id, row.owner_id) as { book_id: string }[]).map(x => x.book_id),
  };
}
export function jobView(row: JobRow) {
  return { id: row.id, sourceId: row.source_id, kind: row.kind, status: row.status, progress: row.progress, total: row.total, error: row.error, modelLabel: row.model_label, tokens: row.tokens, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function sourceView(row: SourceRow) {
  const counts = db.prepare("SELECT COUNT(*) AS n FROM novel_chapters WHERE source_id = ? AND owner_id = ?").get(row.id, row.owner_id) as { n: number };
  const cards = db.prepare("SELECT COUNT(*) AS n FROM novel_cards WHERE source_id = ? AND owner_id = ?").get(row.id, row.owner_id) as { n: number };
  return { id: row.id, title: row.title, author: row.author, originKind: row.origin_kind, sourceUrl: row.source_url, note: row.note, charCount: row.char_count, chapterCount: Number(counts.n), cardCount: Number(cards.n), createdAt: row.created_at };
}
export function listReferences(owner: string) {
  return {
    sources: (db.prepare("SELECT * FROM novel_sources WHERE owner_id = ? ORDER BY created_at DESC").all(owner) as SourceRow[]).map(sourceView),
    jobs: (db.prepare("SELECT j.* FROM novel_jobs j JOIN novel_sources s ON s.id = j.source_id AND s.owner_id = j.owner_id WHERE j.owner_id = ? ORDER BY j.created_at DESC LIMIT 30").all(owner) as JobRow[]).map(jobView),
  };
}
export function sourceDetail(owner: string, id: string) {
  const source = sourceOwned(owner, id);
  const chapters = db.prepare("SELECT id, ordinal, title, char_count, source_url FROM novel_chapters WHERE owner_id = ? AND source_id = ? ORDER BY ordinal").all(owner, id) as Pick<ChapterRow, "id" | "ordinal" | "title" | "char_count" | "source_url">[];
  const cards = db.prepare("SELECT * FROM novel_cards WHERE owner_id = ? AND source_id = ? ORDER BY created_at DESC, id").all(owner, id) as CardRow[];
  return { source: sourceView(source), chapters: chapters.map(c => ({ id: c.id, ordinal: c.ordinal, title: c.title, charCount: c.char_count, sourceUrl: c.source_url })), cards: cards.map(cardView) };
}

export function splitNovelText(raw: string): { title: string; body: string }[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (text.length < 100 || text.length > LIMITS.importChars) throw new ReferenceError(400, "invalid_text_size", "请导入 100 至 200 万字的纯文本");
  const lines = text.split("\n"); const chapters: { title: string; body: string }[] = [];
  let title = "正文"; let body: string[] = [];
  const push = () => {
    const content = body.join("\n").trim(); if (content) chapters.push({ title, body: content }); body = [];
    if (chapters.length > LIMITS.chapters) throw new ReferenceError(400, "too_many_chapters", "章节数量超过 2000，请分卷导入");
  };
  for (const line of lines) {
    const heading = /^(?:#{1,3}\s+\S.{0,90}|第[零〇一二三四五六七八九十百千万两\d]+[章回节卷部][^\n]{0,70}|chapter\s+\d+[^\n]{0,70})$/i.test(line.trim());
    if (heading) { push(); title = line.trim().replace(/^#{1,3}\s+/, ""); }
    else body.push(line);
  }
  push();
  if (chapters.length === 1 && chapters[0]!.body.length > 16000) {
    const only = chapters[0]!; const parts = [];
    for (let i = 0; i < only.body.length; i += 8000) parts.push({ title: `${only.title} · ${parts.length + 1}`, body: only.body.slice(i, i + 8000) });
    return parts;
  }
  return chapters;
}
export function createSource(owner: string, input: { title: string; author?: string; originKind: "text" | "web"; sourceUrl?: string; note?: string }) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM novel_sources WHERE owner_id = ?").get(owner) as { n: number };
  if (Number(count.n) >= LIMITS.sources) throw new ReferenceError(400, "source_limit", "参考库已达 100 个来源，请先删除不用的资料");
  const id = randomUUID();
  db.prepare("INSERT INTO novel_sources (id, owner_id, title, author, origin_kind, source_url, note, char_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)")
    .run(id, owner, requiredText(input.title, 200, "资料标题"), optionalText(input.author, 120), input.originKind, optionalText(input.sourceUrl, 500), optionalText(input.note, 500), now());
  return sourceOwned(owner, id);
}
export function addSourceChapter(owner: string, sourceId: string, chapter: { ordinal: number; title: string; body: string; url?: string }) {
  const source = sourceOwned(owner, sourceId);
  if (source.char_count + chapter.body.length > LIMITS.importChars) throw new ReferenceError(400, "source_size_limit", "单个来源超过 200 万字，请分批导入");
  const id = randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO novel_chapters (id, owner_id, source_id, ordinal, title, body, source_url, char_count, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, owner, sourceId, chapter.ordinal, chapter.title, chapter.body, chapter.url || "", chapter.body.length, hashText(chapter.body));
    db.prepare("UPDATE novel_sources SET char_count = char_count + ? WHERE id = ? AND owner_id = ?").run(chapter.body.length, sourceId, owner);
  })();
  return id;
}
export function importText(owner: string, input: Record<string, unknown>) {
  if (input.rightsConfirmed !== true) throw new ReferenceError(400, "rights_required", "请确认有权使用并分析这些内容");
  const text = requiredText(input.text, LIMITS.importChars, "小说文本");
  if (/^(MZ|PK\u0003\u0004)/.test(text)) throw new ReferenceError(400, "text_only", "仅支持 TXT 或 Markdown，不执行 EXE、脚本或压缩包");
  const chapters = splitNovelText(text);
  const title = requiredText(input.title, 200, "资料标题"); const author = optionalText(input.author, 120); const note = optionalText(input.note, 500);
  const id = db.transaction(() => {
    const source = createSource(owner, { title, author, note, originKind: "text" });
    chapters.forEach((c, i) => addSourceChapter(owner, source.id, { ...c, ordinal: i + 1 })); return source.id;
  })();
  return sourceDetail(owner, id);
}
export function chapterText(owner: string, sourceId: string, chapterId: string) {
  sourceOwned(owner, sourceId);
  const chapter = db.prepare("SELECT * FROM novel_chapters WHERE id = ? AND source_id = ? AND owner_id = ?").get(chapterId, sourceId, owner) as ChapterRow | undefined;
  if (!chapter) throw missing();
  return { id: chapter.id, title: chapter.title, body: chapter.body, sourceUrl: chapter.source_url };
}

export function approveCard(owner: string, id: string, approved: boolean) {
  cardOwned(owner, id);
  db.transaction(() => {
    db.prepare("UPDATE novel_cards SET approved = ? WHERE id = ? AND owner_id = ?").run(approved ? 1 : 0, id, owner);
    // Revoking review removes all grants immediately; no stale copied references.
    if (!approved) db.prepare("DELETE FROM novel_book_links WHERE card_id = ? AND owner_id = ?").run(id, owner);
  })();
  return cardView(cardOwned(owner, id));
}
export function bindCard(owner: string, id: string, bookId: string, enabled: boolean, shareConfirmed: boolean) {
  const card = cardOwned(owner, id);
  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId);
  if (!book) throw new ReferenceError(404, "book_not_found", "目标书稿不存在");
  if (enabled) {
    if (card.approved !== 1) throw new ReferenceError(409, "review_required", "请先审阅并通过参考卡");
    if (!shareConfirmed) throw new ReferenceError(400, "share_confirmation_required", "请确认将方法卡提供给当前单实例写作工作区");
    const n = db.prepare("SELECT COUNT(*) AS n FROM novel_book_links WHERE book_id = ?").get(bookId) as { n: number };
    const existing = db.prepare("SELECT id FROM novel_book_links WHERE card_id = ? AND book_id = ? AND owner_id = ?").get(id, bookId, owner);
    if (!existing && Number(n.n) >= 24) throw new ReferenceError(400, "binding_limit", "每本书最多绑定 24 张参考卡，请先取消不用的卡片");
    db.prepare("INSERT INTO novel_book_links (id, owner_id, card_id, book_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(book_id, card_id) DO NOTHING").run(randomUUID(), owner, id, bookId, now());
  } else db.prepare("DELETE FROM novel_book_links WHERE card_id = ? AND book_id = ? AND owner_id = ?").run(id, bookId, owner);
  return cardView(cardOwned(owner, id));
}
export function deleteSource(owner: string, id: string) {
  sourceOwned(owner, id);
  if (db.prepare("SELECT id FROM novel_jobs WHERE source_id = ? AND owner_id = ? AND status IN ('queued', 'running')").get(id, owner)) throw new ReferenceError(409, "job_running", "请先取消进行中的任务");
  db.transaction(() => {
    const cards = db.prepare("SELECT id FROM novel_cards WHERE source_id = ? AND owner_id = ?").all(id, owner) as { id: string }[];
    for (const c of cards) db.prepare("DELETE FROM novel_book_links WHERE card_id = ? AND owner_id = ?").run(c.id, owner);
    for (const table of ["novel_cards", "novel_chapters"] as const) db.prepare(`DELETE FROM ${table} WHERE source_id = ? AND owner_id = ?`).run(id, owner);
    // Keep only minimal usage metadata for the rolling 24h abuse limit: deleting
    // a source must not reset paid-call quotas. No selected chapters/text remain.
    const day = new Date(Date.now() - 86400000).toISOString();
    db.prepare("DELETE FROM novel_jobs WHERE source_id = ? AND owner_id = ? AND created_at <= ?").run(id, owner, day);
    db.prepare("UPDATE novel_jobs SET selection_json = '[]', focus_json = '[]', error = '来源已删除' WHERE source_id = ? AND owner_id = ?").run(id, owner);
    db.prepare("DELETE FROM novel_sources WHERE id = ? AND owner_id = ?").run(id, owner);
  })();
}
export function exportSource(owner: string, id: string) {
  const source = sourceOwned(owner, id);
  const chapters = db.prepare("SELECT * FROM novel_chapters WHERE source_id = ? AND owner_id = ? ORDER BY ordinal").all(id, owner) as ChapterRow[];
  return { title: source.title, text: `# ${source.title}\n\n${source.author}\n${source.source_url}\n\n` + chapters.map(c => `## ${c.title}\n\n${c.body}`).join("\n\n") };
}

