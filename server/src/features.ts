import { db, type BookRow, type ChapterRow } from "./db";
import { HttpError } from "./httpError";

function now() {
  return new Date().toISOString();
}

function mustBook(id: string): BookRow {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(id) as BookRow | undefined;
  if (!book) throw new HttpError(404, "没有这本书");
  return book;
}

export function countChars(text: string): number {
  return (text || "").replace(/\s/g, "").length;
}

/** -------- Progress / word counts -------- */

export type ChapterProgress = {
  number: number;
  title: string;
  status: string;
  words: number;
  target: number;
};

export type BookProgress = {
  chapterCount: number;
  draftedCount: number;
  words: number;
  targetWords: number;
  targetChapters: number;
  wordsPerChapter: number;
  chapters: ChapterProgress[];
};

export function bookProgress(bookId: string): BookProgress {
  const book = mustBook(bookId);
  const chapters = db
    .prepare("SELECT * FROM chapters WHERE book_id = ? ORDER BY number")
    .all(bookId) as ChapterRow[];
  const bodies = db
    .prepare(
      `SELECT c.number AS number, r.body AS body
       FROM chapters c
       LEFT JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = 'chapter_body'
       LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
       WHERE c.book_id = ?
       ORDER BY c.number`,
    )
    .all(bookId) as { number: number; body: string | null }[];
  const byNum = new Map(bodies.map((row) => [row.number, countChars(row.body ?? "")]));
  const chapterRows: ChapterProgress[] = chapters.map((chapter) => ({
    number: chapter.number,
    title: chapter.title,
    status: chapter.status,
    words: byNum.get(chapter.number) ?? 0,
    target: book.words_per_chapter,
  }));
  const words = chapterRows.reduce((sum, row) => sum + row.words, 0);
  const draftedCount = chapters.filter((c) => c.status === "drafted" || c.status === "reviewed").length;
  return {
    chapterCount: chapters.length,
    draftedCount,
    words,
    targetWords: book.target_chapters * book.words_per_chapter,
    targetChapters: book.target_chapters,
    wordsPerChapter: book.words_per_chapter,
    chapters: chapterRows,
  };
}

export function listBooksProgress(): Record<string, { words: number; targetWords: number; draftedCount: number; chapterCount: number }> {
  const books = db.prepare("SELECT id FROM books").all() as { id: string }[];
  const out: Record<string, { words: number; targetWords: number; draftedCount: number; chapterCount: number }> = {};
  for (const book of books) {
    const p = bookProgress(book.id);
    out[book.id] = {
      words: p.words,
      targetWords: p.targetWords,
      draftedCount: p.draftedCount,
      chapterCount: p.chapterCount,
    };
  }
  return out;
}

/** -------- Version history -------- */

export type RevisionMeta = {
  id: string;
  revision: number;
  source: string;
  model: string | null;
  scene: string | null;
  createdAt: string;
  chars: number;
  isCurrent: boolean;
};

function resolveArtifact(bookId: string, kind: string, chapterNumber: number | null) {
  mustBook(bookId);
  const chapter = chapterNumber
    ? (db.prepare("SELECT id FROM chapters WHERE book_id = ? AND number = ?").get(bookId, chapterNumber) as
        | { id: string }
        | undefined)
    : undefined;
  if (chapterNumber && !chapter) throw new HttpError(400, `没有第 ${chapterNumber} 章`);
  const chapterId = chapter?.id ?? null;
  const artifact = db
    .prepare(
      "SELECT id, current_revision_id FROM artifacts WHERE book_id = ? AND kind = ? AND ifnull(chapter_id, '') = ifnull(?, '')",
    )
    .get(bookId, kind, chapterId) as { id: string; current_revision_id: string | null } | undefined;
  return { artifact, chapterId };
}

export function listRevisions(bookId: string, kind: string, chapterNumber: number | null): RevisionMeta[] {
  const { artifact } = resolveArtifact(bookId, kind, chapterNumber);
  if (!artifact) return [];
  const rows = db
    .prepare(
      `SELECT id, revision, source, model, scene, created_at, body
       FROM artifact_revisions
       WHERE artifact_id = ?
       ORDER BY revision DESC`,
    )
    .all(artifact.id) as {
    id: string;
    revision: number;
    source: string;
    model: string | null;
    scene: string | null;
    created_at: string;
    body: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    source: row.source,
    model: row.model,
    scene: row.scene,
    createdAt: row.created_at,
    chars: countChars(row.body),
    isCurrent: row.id === artifact.current_revision_id,
  }));
}

export function getRevisionBody(bookId: string, revisionId: string): { id: string; revision: number; body: string; kind: string; chapterNumber: number | null } {
  mustBook(bookId);
  const row = db
    .prepare(
      `SELECT r.id, r.revision, r.body, a.kind, c.number AS chapter_number
       FROM artifact_revisions r
       JOIN artifacts a ON a.id = r.artifact_id
       LEFT JOIN chapters c ON c.id = a.chapter_id
       WHERE r.id = ? AND a.book_id = ?`,
    )
    .get(revisionId, bookId) as
    | { id: string; revision: number; body: string; kind: string; chapter_number: number | null }
    | undefined;
  if (!row) throw new HttpError(404, "没有这条修订");
  return {
    id: row.id,
    revision: row.revision,
    body: row.body,
    kind: row.kind,
    chapterNumber: row.chapter_number,
  };
}

export function diffRevisions(bookId: string, revisionId: string, againstId?: string | null) {
  const current = getRevisionBody(bookId, revisionId);
  let otherBody = "";
  let otherRevision: number | null = null;
  if (againstId) {
    const other = getRevisionBody(bookId, againstId);
    otherBody = other.body;
    otherRevision = other.revision;
  } else {
    const meta = listRevisions(bookId, current.kind, current.chapterNumber);
    const idx = meta.findIndex((item) => item.id === revisionId);
    const older = meta[idx + 1];
    if (older) {
      const body = getRevisionBody(bookId, older.id);
      otherBody = body.body;
      otherRevision = body.revision;
    }
  }
  const aLines = otherBody.replace(/\r\n?/g, "\n").split("\n");
  const bLines = current.body.replace(/\r\n?/g, "\n").split("\n");
  const max = Math.max(aLines.length, bLines.length);
  const hunks: { type: "same" | "add" | "del"; text: string }[] = [];
  for (let i = 0; i < max; i++) {
    const a = aLines[i];
    const b = bLines[i];
    if (a === b) {
      if (a != null) hunks.push({ type: "same", text: a });
    } else {
      if (a != null) hunks.push({ type: "del", text: a });
      if (b != null) hunks.push({ type: "add", text: b });
    }
  }
  return {
    kind: current.kind,
    chapterNumber: current.chapterNumber,
    leftRevision: otherRevision,
    rightRevision: current.revision,
    leftChars: countChars(otherBody),
    rightChars: countChars(current.body),
    hunks,
    leftBody: otherBody,
    rightBody: current.body,
  };
}

/** -------- Search -------- */

export type SearchHit = {
  kind: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  title: string;
  snippet: string;
  index: number;
};

const KIND_TITLE: Record<string, string> = {
  book_profile: "档案",
  book_outline: "全书大纲",
  chapter_outline: "细纲",
  chapter_body: "正文",
  review_report: "审核",
  chapter_memory: "记忆",
};

export function searchBook(bookId: string, query: string): SearchHit[] {
  mustBook(bookId);
  const q = query.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const chapters = db
    .prepare("SELECT number, title FROM chapters WHERE book_id = ? ORDER BY number")
    .all(bookId) as { number: number; title: string }[];
  for (const chapter of chapters) {
    if (chapter.title.includes(q) || `第${chapter.number}章`.includes(q)) {
      hits.push({
        kind: "chapter_title",
        chapterNumber: chapter.number,
        chapterTitle: chapter.title,
        title: `第 ${chapter.number} 章 · ${chapter.title}`,
        snippet: chapter.title,
        index: chapter.title.indexOf(q),
      });
    }
  }
  const rows = db
    .prepare(
      `SELECT a.kind, c.number AS chapter_number, c.title AS chapter_title, r.body AS body
       FROM artifacts a
       JOIN artifact_revisions r ON r.id = a.current_revision_id
       LEFT JOIN chapters c ON c.id = a.chapter_id
       WHERE a.book_id = ?`,
    )
    .all(bookId) as {
    kind: string;
    chapter_number: number | null;
    chapter_title: string | null;
    body: string;
  }[];
  for (const row of rows) {
    const body = row.body || "";
    let from = 0;
    let guard = 0;
    while (guard < 8) {
      const index = body.indexOf(q, from);
      if (index < 0) break;
      const start = Math.max(0, index - 24);
      const end = Math.min(body.length, index + q.length + 36);
      let snippet = body.slice(start, end).replace(/\s+/g, " ");
      if (start > 0) snippet = "…" + snippet;
      if (end < body.length) snippet = snippet + "…";
      const label = KIND_TITLE[row.kind] ?? row.kind;
      const title =
        row.chapter_number != null
          ? `第 ${row.chapter_number} 章 · ${label}`
          : label;
      hits.push({
        kind: row.kind,
        chapterNumber: row.chapter_number,
        chapterTitle: row.chapter_title,
        title,
        snippet,
        index,
      });
      from = index + Math.max(q.length, 1);
      guard += 1;
    }
  }
  return hits.slice(0, 60);
}

/** -------- Bible cards -------- */

export type BibleCard = {
  id: string;
  bookId: string;
  kind: "character" | "prop" | "place" | string;
  name: string;
  summary: string;
  details: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

function mapCard(row: {
  id: string;
  book_id: string;
  kind: string;
  name: string;
  summary: string;
  details: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}): BibleCard {
  return {
    id: row.id,
    bookId: row.book_id,
    kind: row.kind,
    name: row.name,
    summary: row.summary,
    details: row.details,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBibleCards(bookId: string): BibleCard[] {
  mustBook(bookId);
  const rows = db
    .prepare(
      `SELECT * FROM bible_cards WHERE book_id = ? ORDER BY kind, sort_order ASC, created_at ASC`,
    )
    .all(bookId) as Parameters<typeof mapCard>[0][];
  return rows.map(mapCard);
}

export function createBibleCard(
  bookId: string,
  input: { kind: string; name: string; summary?: string; details?: string },
): BibleCard {
  mustBook(bookId);
  const name = input.name.trim();
  if (!name) throw new HttpError(400, "要有名称");
  const kind = (input.kind || "character").trim() || "character";
  const id = crypto.randomUUID();
  const ts = now();
  const max = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM bible_cards WHERE book_id = ? AND kind = ?")
    .get(bookId, kind) as { n: number };
  db.prepare(
    `INSERT INTO bible_cards (id, book_id, kind, name, summary, details, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, bookId, kind, name, input.summary?.trim() ?? "", input.details?.trim() ?? "", max.n + 1, ts, ts);
  return mapCard(
    db.prepare("SELECT * FROM bible_cards WHERE id = ?").get(id) as Parameters<typeof mapCard>[0],
  );
}

export function updateBibleCard(
  bookId: string,
  cardId: string,
  input: { kind?: string; name?: string; summary?: string; details?: string; sortOrder?: number },
): BibleCard {
  mustBook(bookId);
  const existing = db
    .prepare("SELECT * FROM bible_cards WHERE id = ? AND book_id = ?")
    .get(cardId, bookId) as Parameters<typeof mapCard>[0] | undefined;
  if (!existing) throw new HttpError(404, "没有这张设定卡");
  const kind = input.kind?.trim() || existing.kind;
  const name = input.name?.trim() || existing.name;
  if (!name) throw new HttpError(400, "要有名称");
  db.prepare(
    `UPDATE bible_cards
     SET kind = ?, name = ?, summary = ?, details = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    kind,
    name,
    input.summary !== undefined ? input.summary : existing.summary,
    input.details !== undefined ? input.details : existing.details,
    input.sortOrder ?? existing.sort_order,
    now(),
    cardId,
  );
  return mapCard(
    db.prepare("SELECT * FROM bible_cards WHERE id = ?").get(cardId) as Parameters<typeof mapCard>[0],
  );
}

export function deleteBibleCard(bookId: string, cardId: string) {
  mustBook(bookId);
  const info = db.prepare("DELETE FROM bible_cards WHERE id = ? AND book_id = ?").run(cardId, bookId);
  if (!info.changes) throw new HttpError(404, "没有这张设定卡");
  return { ok: true };
}

export function formatBibleForContext(bookId: string): string {
  const cards = listBibleCards(bookId);
  if (!cards.length) return "";
  const label: Record<string, string> = { character: "人物", prop: "物件", place: "地点" };
  return cards
    .map((card) => {
      const head = `${label[card.kind] ?? card.kind} · ${card.name}`;
      const bits = [card.summary, card.details].filter(Boolean).join("；");
      return bits ? `${head}：${bits}` : head;
    })
    .join("\n");
}

export function formatMemoriesForContext(bookId: string, beforeChapter: number | null): string {
  if (!beforeChapter || beforeChapter <= 1) return "";
  const rows = db
    .prepare(
      `SELECT c.number AS number, c.title AS title, r.body AS body
       FROM chapters c
       JOIN artifacts a ON a.book_id = c.book_id AND a.chapter_id = c.id AND a.kind = 'chapter_memory'
       JOIN artifact_revisions r ON r.id = a.current_revision_id
       WHERE c.book_id = ? AND c.number < ?
       ORDER BY c.number`,
    )
    .all(bookId, beforeChapter) as { number: number; title: string; body: string }[];
  if (!rows.length) return "";
  return rows.map((row) => `第${row.number}章《${row.title}》\n${row.body}`).join("\n\n");
}

/** -------- Review parse -------- */

export type ReviewIssue = {
  index: number;
  type: string;
  cite: string;
  text: string;
};

export function parseReviewIssues(body: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const blocks = body.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const m = block.trim().match(/^(\d+)\.\s*\[([^\]]+)\]\s*([\s\S]+)/);
    if (!m) continue;
    const text = m[3]!.trim();
    const citeMatch = text.match(/「([^」]{1,80})」/);
    issues.push({
      index: Number(m[1]),
      type: m[2]!.trim(),
      cite: citeMatch?.[1] ?? "",
      text,
    });
  }
  return issues;
}
