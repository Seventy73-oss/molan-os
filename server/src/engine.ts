import { db, getDbInfo, type BookRow, type ChapterRow, type RouteRow } from "./db";
import { HttpError } from "./httpError";
import { checkHardConstraints, formatHardConstraintsForReview, formatHardConstraintsSection, formatViolationsNote, type HardConstraintCheck } from "./hardConstraints";
import {
  DEFAULT_LEASE_TTL_MS,
  SQLITE_ACQUIRE_SQL,
  SQLITE_RELEASE_SQL,
  leaseUntilIso,
} from "./jobs/lease";
export { HttpError } from "./httpError";
import { deleteBookFiles, syncBook, wipeChapterDirs } from "./manuscripts";
import { deleteCover } from "./imageProvider";
import { sceneKind, type SceneId } from "./agent/adapter";
import { getAdapter } from "./agent/runtime";
import { normalizeDialogueQuotes, rewriteSelectionLocal } from "./agent/localDraft";
import { bookProgress as computeBookProgress } from "./features";
import { formatOpenHooksForReview } from "./hooks";
import { buildContextManifest, saveContextSnapshot } from "./contextSnapshot";
import { estimateTokensFromText, recordUsage } from "./usage";
import { selectionSkillScene, skillPromptMeta, skillsForScene, toSkillTexts } from "./skills";
import { normalizeThinking } from "./thinking";
import { isAbortError, optionalStreamPreDelay, throwIfAborted } from "./abortUtil";


const CN: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export const BOOK_TITLE_MAX = 200;
export const CHAT_MESSAGE_MAX = 20000;
const BOOK_SCOPED_TABLES = [
  "generations", "story_book_heads", "chapter_publications", "memory_proposals", "story_fact_sets",
  "story_facts", "story_operation_results", "story_outbox", "hook_events", "story_knowledge_events",
  "bible_card_revisions", "story_batches",
] as const;

export function cnNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  if (token === "十") return 10;
  if (token.startsWith("十")) return 10 + (CN[token.slice(1)] ?? 0);
  const idx = token.indexOf("十");
  if (idx > 0) {
    const hi = CN[token.slice(0, idx)] ?? 1;
    const rest = token.slice(idx + 1);
    return hi * 10 + (rest ? (CN[rest] ?? 0) : 0);
  }
  return CN[token] ?? null;
}

export function parseChapterMention(text: string): number | null {
  const match = text.match(/第\s*(\d+|[一二三四五六七八九十两]+)\s*章/);
  if (!match) return null;
  return cnNumber(match[1] ?? "");
}

function now(): string {
  return new Date().toISOString();
}

function mustBook(id: string): BookRow {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(id) as BookRow | undefined;
  if (!book) throw new HttpError(404, "没有这本书");
  return book;
}

export function bookJson(
  row: BookRow,
  chapterCount = 0,
  draftedCount = 0,
  words = 0,
  targetWords = 0,
) {
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    logline: row.logline,
    style: row.style,
    targetChapters: row.target_chapters,
    wordsPerChapter: row.words_per_chapter,
    createdAt: row.created_at,
    chapterCount,
    draftedCount,
    words,
    targetWords,
    // Cover art lives next to the database; the version query busts the browser cache.
    coverUrl: row.cover_file ? `/api/books/${row.id}/cover?v=${encodeURIComponent(row.cover_at || "")}` : null,
    coverAt: row.cover_at ?? null,
  };
}

type ArtifactJoin = {
  id: string;
  kind: string;
  chapter_id: string | null;
  current_revision_id: string | null;
  chapter_number: number | null;
  revision: number | null;
  body: string | null;
  source: string | null;
  model: string | null;
  skill_ids: string | null;
  scene: string | null;
  created_at: string | null;
};

export function getBookPayload(id: string) {
  const book = mustBook(id);
  const chapters = db
    .prepare("SELECT * FROM chapters WHERE book_id = ? ORDER BY number")
    .all(id) as ChapterRow[];
  const artifacts = db
    .prepare(
      `SELECT a.id, a.kind, a.chapter_id, a.current_revision_id, c.number AS chapter_number,
              r.revision, r.body, r.source, r.model, r.skill_ids, r.scene, r.created_at
       FROM artifacts a
       LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
       LEFT JOIN chapters c ON c.id = a.chapter_id
       WHERE a.book_id = ?`,
    )
    .all(id) as ArtifactJoin[];
  const draftedCount = chapters.filter((chapter) => chapter.status === "drafted" || chapter.status === "reviewed").length;
  const progress = computeBookProgress(id);
  return {
    book: bookJson(book, chapters.length, draftedCount, progress.words, progress.targetWords),
    progress,
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      number: chapter.number,
      title: chapter.title,
      status: chapter.status,
      words: progress.chapters.find((c) => c.number === chapter.number)?.words ?? 0,
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      chapterId: artifact.chapter_id,
      chapterNumber: artifact.chapter_number,
      revision: artifact.revision ?? 0,
      revisionId: artifact.current_revision_id,
      body: artifact.body ?? "",
      source: artifact.source,
      model: artifact.model,
      skillIds: artifact.skill_ids ? (JSON.parse(artifact.skill_ids) as string[]) : [],
      scene: artifact.scene,
      createdAt: artifact.created_at,
    })),
  };
}

export function listBooks() {
  const rows = db
    .prepare(
      `SELECT b.*,
        (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count,
        (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id AND c.status IN ('drafted','reviewed')) AS drafted_count
       FROM books b
       ORDER BY b.created_at DESC`,
    )
    .all() as (BookRow & { chapter_count: number; drafted_count: number })[];
  return rows.map((row) => {
    const progress = computeBookProgress(row.id);
    return bookJson(row, row.chapter_count, row.drafted_count, progress.words, progress.targetWords);
  });
}

function fieldOf(text: string, label: string): string {
  return text.match(new RegExp(`^${label}：(.+)$`, "m"))?.[1]?.trim() ?? "";
}

function titlesFrom(text: string): string[] {
  const start = text.indexOf("章目：");
  if (start < 0) return [];
  const titles: string[] = [];
  for (const line of text.slice(start + 3).split("\n")) {
    const match = line.match(/^(\d+)\.\s+(.+)$/);
    if (match) titles.push(match[2]!.trim());
    else if (line.trim()) break;
  }
  return titles;
}

function insertChapters(bookId: string, titles: string[]) {
  const insert = db.prepare(
    "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?, ?, ?, ?, 'empty')",
  );
  titles.forEach((title, index) => {
    insert.run(crypto.randomUUID(), bookId, index + 1, title || `第${index + 1}章`);
  });
}

export function createBook(input: {
  title: string;
  genre?: string;
  logline?: string;
  style?: string;
  targetChapters?: number;
  wordsPerChapter?: number;
  idempotencyKey?: string | null;
}) {
  const key = input.idempotencyKey?.trim();
  if (key) {
    const hit = db.prepare("SELECT book_id FROM idempotency_keys WHERE key = ?").get(key) as
      | { book_id: string }
      | undefined;
    if (hit) return { payload: getBookPayload(hit.book_id), reused: true };
  }
  const title = input.title.replace(/[\u200b-\u200d\u2060\ufeff]/g, "").trim();
  if (!title) throw new HttpError(400, "要有书名");
  if ([...title].length > BOOK_TITLE_MAX) throw new HttpError(400, `书名最多 ${BOOK_TITLE_MAX} 字`);
  const count = Math.min(48, Math.max(1, input.targetChapters ?? 12));
  const id = crypto.randomUUID();
  const created = now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO books (id, title, genre, logline, style, target_chapters, words_per_chapter, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      title,
      input.genre?.trim() ?? "",
      input.logline?.trim() ?? "",
      input.style?.trim() ?? "",
      count,
      input.wordsPerChapter ?? 2000,
      created,
    );
    insertChapters(
      id,
      Array.from({ length: count }, (_, index) => `第${index + 1}章`),
    );
    if (key) db.prepare("INSERT INTO idempotency_keys (key, book_id, created_at) VALUES (?, ?, ?)").run(key, id, created);
  });
  tx();
  return { payload: getBookPayload(id), reused: false };
}


export function updateBook(
  bookId: string,
  input: {
    title?: string;
    genre?: string;
    logline?: string;
    style?: string;
    targetChapters?: number;
    wordsPerChapter?: number;
    /** When shrinking target chapters, allow deleting trailing empty chapters. */
    confirmTrim?: boolean;
  },
) {
  const book = mustBook(bookId);
  const title = input.title !== undefined ? input.title.replace(/[\u200b-\u200d\u2060\ufeff]/g, "").trim() : book.title;
  if (!title) throw new HttpError(400, "要有书名");
  if ([...title].length > BOOK_TITLE_MAX) throw new HttpError(400, `书名最多 ${BOOK_TITLE_MAX} 字`);
  const genre = input.genre !== undefined ? input.genre.trim() : book.genre;
  const logline = input.logline !== undefined ? input.logline.trim() : book.logline;
  const style = input.style !== undefined ? input.style.trim() : book.style;
  const wordsPerChapter =
    input.wordsPerChapter !== undefined
      ? Math.min(20000, Math.max(200, Math.floor(input.wordsPerChapter)))
      : book.words_per_chapter;
  let targetChapters = book.target_chapters;
  if (input.targetChapters !== undefined) {
    targetChapters = Math.min(48, Math.max(1, Math.floor(input.targetChapters)));
  }

  const chapters = db
    .prepare("SELECT * FROM chapters WHERE book_id = ? ORDER BY number")
    .all(bookId) as ChapterRow[];
  const currentCount = chapters.length;

  if (targetChapters > currentCount) {
    const insert = db.prepare(
      "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?, ?, ?, ?, 'empty')",
    );
    for (let n = currentCount + 1; n <= targetChapters; n++) {
      insert.run(crypto.randomUUID(), bookId, n, `第${n}章`);
    }
  } else if (targetChapters < currentCount) {
    const trailing = chapters.filter((c) => c.number > targetChapters);
    const blocking = trailing.filter((c) => {
      if (c.status !== "empty") return true;
      const arts = db
        .prepare(
          `SELECT r.body AS body FROM artifacts a
           LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
           WHERE a.book_id = ? AND a.chapter_id = ?`,
        )
        .all(bookId, c.id) as { body: string | null }[];
      return arts.some((a) => (a.body || "").trim().length > 0);
    });
    if (blocking.length && !input.confirmTrim) {
      throw new HttpError(
        409,
        `缩减到 ${targetChapters} 章会丢掉第 ${blocking.map((c) => c.number).join("、")} 章已有内容，请确认后重试`,
      );
    }
    if (!input.confirmTrim && trailing.length) {
      // Only empty trailing — still require confirm for UX consistency when any trailing exists? 
      // Allow silent trim of fully empty trailing.
    }
    const tx = db.transaction(() => {
      for (const chapter of trailing) {
        const artifacts = db
          .prepare("SELECT id FROM artifacts WHERE book_id = ? AND chapter_id = ?")
          .all(bookId, chapter.id) as { id: string }[];
        for (const art of artifacts) {
          db.prepare("DELETE FROM artifact_revisions WHERE artifact_id = ?").run(art.id);
          db.prepare("DELETE FROM artifacts WHERE id = ?").run(art.id);
        }
        db.prepare("DELETE FROM chapters WHERE id = ?").run(chapter.id);
      }
    });
    tx();
    try {
      wipeChapterDirs(bookId);
    } catch {
      /* ignore */
    }
  }

  db.prepare(
    `UPDATE books SET title = ?, genre = ?, logline = ?, style = ?, target_chapters = ?, words_per_chapter = ? WHERE id = ?`,
  ).run(title, genre, logline, style, targetChapters, wordsPerChapter, bookId);

  try {
    syncBook(bookId);
  } catch (error) {
    console.error("manuscript sync failed", error);
  }
  return getBookPayload(bookId);
}

export function deleteBook(id: string) {
  mustBook(id);
  const tx = db.transaction(() => {
    const artifacts = db.prepare("SELECT id FROM artifacts WHERE book_id = ?").all(id) as { id: string }[];
    const dropRev = db.prepare("DELETE FROM artifact_revisions WHERE artifact_id = ?");
    for (const artifact of artifacts) dropRev.run(artifact.id);
    db.prepare("DELETE FROM artifacts WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM chapters WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM bible_cards WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM writing_jobs WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM hook_marks WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM context_snapshots WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM api_usage WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM idempotency_keys WHERE book_id = ?").run(id);
    // 兜底：generations / story_* 等也按 book_id 清理，不留孤儿（B6）
    for (const name of BOOK_SCOPED_TABLES) {
      db.prepare(`DELETE FROM ${name} WHERE book_id = ?`).run(id);
    }
    db.prepare("DELETE FROM books WHERE id = ?").run(id);
  });
  tx();
  // Cover art is a file on disk, not a row: drop it together with the book.
  deleteCover(id);
  deleteBookFiles(id);
}


export function addChapter(bookId: string, title?: string) {
  mustBook(bookId);
  const row = db.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM chapters WHERE book_id = ?").get(bookId) as {
    n: number;
  };
  const number = row.n + 1;
  db.prepare("INSERT INTO chapters (id, book_id, number, title, status) VALUES (?, ?, ?, ?, 'empty')").run(
    crypto.randomUUID(),
    bookId,
    number,
    title?.trim() || `第${number}章`,
  );
  db.prepare("UPDATE books SET target_chapters = ? WHERE id = ?").run(number, bookId);
  const payload = getBookPayload(bookId);
  try {
    syncBook(bookId);
  } catch (error) {
    console.error("manuscript sync failed", error);
  }
  return payload;
}

export function renameChapter(bookId: string, number: number, title: string) {
  mustBook(bookId);
  const chapter = db.prepare("SELECT * FROM chapters WHERE book_id = ? AND number = ?").get(bookId, number) as
    | ChapterRow
    | undefined;
  if (!chapter) throw new HttpError(404, `没有第 ${number} 章`);
  const next = title.trim() || `第${number}章`;
  db.prepare("UPDATE chapters SET title = ? WHERE id = ?").run(next, chapter.id);
  try {
    syncBook(bookId);
  } catch (error) {
    console.error("manuscript sync failed", error);
  }
  return getBookPayload(bookId);
}

export function deleteChapter(bookId: string, number: number) {
  mustBook(bookId);
  const chapter = db.prepare("SELECT * FROM chapters WHERE book_id = ? AND number = ?").get(bookId, number) as
    | ChapterRow
    | undefined;
  if (!chapter) throw new HttpError(404, `没有第 ${number} 章`);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?").get(bookId) as { n: number }).n;
  if (count <= 1) throw new HttpError(400, "至少保留一章");

  const tx = db.transaction(() => {
    const arts = db.prepare("SELECT id FROM artifacts WHERE book_id = ? AND chapter_id = ?").all(bookId, chapter.id) as {
      id: string;
    }[];
    const dropRev = db.prepare("DELETE FROM artifact_revisions WHERE artifact_id = ?");
    const dropArt = db.prepare("DELETE FROM artifacts WHERE id = ?");
    for (const art of arts) {
      dropRev.run(art.id);
      dropArt.run(art.id);
    }
    db.prepare("DELETE FROM chapters WHERE id = ?").run(chapter.id);

    const higher = db
      .prepare("SELECT id, number FROM chapters WHERE book_id = ? AND number > ? ORDER BY number ASC")
      .all(bookId, number) as { id: string; number: number }[];
    // Two-phase renumber to avoid UNIQUE(book_id, number) clashes.
    for (const row of higher) {
      db.prepare("UPDATE chapters SET number = ? WHERE id = ?").run(-(row.number), row.id);
    }
    for (const row of higher) {
      db.prepare("UPDATE chapters SET number = ? WHERE id = ?").run(row.number - 1, row.id);
    }
    const left = (db.prepare("SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?").get(bookId) as { n: number }).n;
    db.prepare("UPDATE books SET target_chapters = ? WHERE id = ?").run(left, bookId);
  });
  tx();
  try {
    wipeChapterDirs(bookId);
    syncBook(bookId);
  } catch (error) {
    console.error("manuscript sync failed", error);
  }
  return getBookPayload(bookId);
}

/** Current revision id for a book artifact kind (+ optional chapter), or null if none. */
export function currentRevisionIdFor(
  bookId: string,
  kind: string,
  chapterNumber: number | null,
): string | null {
  if (chapterNumber != null) {
    const row = db
      .prepare(
        `SELECT a.current_revision_id AS id FROM artifacts a
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = ? AND c.number = ?`,
      )
      .get(bookId, kind, chapterNumber) as { id: string | null } | undefined;
    return row?.id ?? null;
  }
  const row = db
    .prepare(
      `SELECT current_revision_id AS id FROM artifacts
       WHERE book_id = ? AND kind = ? AND chapter_id IS NULL`,
    )
    .get(bookId, kind) as { id: string | null } | undefined;
  return row?.id ?? null;
}

export function saveRevision(input: {
  bookId: string;
  kind: string;
  chapterNumber: number | null;
  /** Stable chapter id preferred over number when provided. */
  chapterId?: string | null;
  body: string;
  source: string;
  model: string | null;
  skillIds: string[];
  scene: string | null;
  skipMemory?: boolean;
  /** G2: run model but do not save artifact (proposal extract). */
  skipPersist?: boolean;
  /** Optimistic concurrency: must match current revision id (or null if none). */
  expectedRevisionId?: string | null;
  /** When true (or returns true at commit time), insert revision but do not set as current (candidate / late AI). */
  asCandidate?: boolean | (() => boolean);
  /**
   * CAS mismatch policy: "throw" (default) → 409;
   * "candidate" → keep user current, insert AI result as non-current candidate.
   */
  onConflict?: "throw" | "candidate";
  /** Bind derived artifacts (review/memory) to a body revision. */
  sourceRevisionId?: string | null;
}) {
  let body = input.body;
  if (
    input.kind === "chapter_body" ||
    input.scene === "chapter_body" ||
    input.scene === "humanize"
  ) {
    body = normalizeDialogueQuotes(body);
  }
  input = { ...input, body };

  let asCandidate =
    typeof input.asCandidate === "function" ? Boolean(input.asCandidate()) : Boolean(input.asCandidate);
  let casConflict = false;
  const onConflict = input.onConflict ?? "throw";

  mustBook(input.bookId);
  let chapter: ChapterRow | undefined;
  if (input.chapterId) {
    chapter = db.prepare("SELECT * FROM chapters WHERE id = ? AND book_id = ?").get(input.chapterId, input.bookId) as
      | ChapterRow
      | undefined;
    if (!chapter) throw new HttpError(400, "章节不存在或不属于本书");
  } else if (input.chapterNumber) {
    chapter = db.prepare("SELECT * FROM chapters WHERE book_id = ? AND number = ?").get(input.bookId, input.chapterNumber) as
      | ChapterRow
      | undefined;
    if (!chapter) throw new HttpError(400, `没有第 ${input.chapterNumber} 章`);
  }
  const chapterId = chapter?.id ?? null;
  const chapterNumber = chapter?.number ?? input.chapterNumber ?? null;
  const saved = db.transaction(() => {
    let artifact = db
      .prepare("SELECT id, current_revision_id FROM artifacts WHERE book_id = ? AND kind = ? AND ifnull(chapter_id, '') = ifnull(?, '')")
      .get(input.bookId, input.kind, chapterId) as { id: string; current_revision_id: string | null } | undefined;
    if (!artifact) {
      if (input.expectedRevisionId !== undefined && input.expectedRevisionId !== null) {
        // Client thought there was a revision but server has none
        if (onConflict === "candidate") {
          casConflict = true;
          asCandidate = true;
        } else {
          throw new HttpError(409, "稿件版本冲突：本地基线已失效（尚无服务端稿）");
        }
      }
      const id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO artifacts (id, book_id, chapter_id, kind, current_revision_id) VALUES (?, ?, ?, ?, NULL)",
      ).run(id, input.bookId, chapterId, input.kind);
      artifact = { id, current_revision_id: null };
    } else if (input.expectedRevisionId !== undefined) {
      const current = artifact.current_revision_id;
      if (current !== input.expectedRevisionId) {
        if (onConflict === "candidate") {
          casConflict = true;
          asCandidate = true;
        } else {
          throw new HttpError(409, "稿件版本冲突：已有更新的修订，请刷新后重试");
        }
      }
    }
    // E4：人工保存内容与当前修订完全相同时不产生垃圾版本
    if (input.source === "human" && !asCandidate && artifact.current_revision_id) {
      const cur = db
        .prepare("SELECT id, revision, body FROM artifact_revisions WHERE id = ?")
        .get(artifact.current_revision_id) as { id: string; revision: number; body: string } | undefined;
      if (cur && cur.body === input.body) {
        return { revision: cur.revision, revisionId: cur.id, artifactId: artifact.id, chapterId, chapterNumber, unchanged: true };
      }
    }
    const prev = db
      .prepare("SELECT COALESCE(MAX(revision), 0) AS n FROM artifact_revisions WHERE artifact_id = ?")
      .get(artifact.id) as { n: number };
    const next = prev.n + 1;
    const revId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO artifact_revisions
        (id, artifact_id, revision, body, source, model, skill_ids, scene, created_at, source_revision_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revId,
      artifact.id,
      next,
      input.body,
      input.source,
      input.model,
      JSON.stringify(input.skillIds),
      input.scene,
      now(),
      input.sourceRevisionId ?? null,
    );
    if (!asCandidate) {
      db.prepare("UPDATE artifacts SET current_revision_id = ? WHERE id = ?").run(revId, artifact.id);
      if (chapterId && input.kind === "chapter_outline") {
        db.prepare("UPDATE chapters SET status = CASE WHEN status = 'empty' THEN 'outlined' ELSE status END WHERE id = ?").run(
          chapterId,
        );
      } else if (chapterId && input.kind === "chapter_body") {
        // Body change invalidates reviewed status
        db.prepare("UPDATE chapters SET status = 'drafted' WHERE id = ?").run(chapterId);
        // Mark review/memory derived from older body as stale via status field on chapter already
      } else if (chapterId && input.kind === "review_report") {
        db.prepare("UPDATE chapters SET status = 'reviewed' WHERE id = ?").run(chapterId);
      }
    }
    return { revision: next, revisionId: revId, artifactId: artifact.id, chapterId, chapterNumber };
  })() as { revision: number; revisionId: string; artifactId: string; chapterId: string | null; chapterNumber: number | null; unchanged?: boolean };
  if (saved.unchanged) {
    return {
      kind: input.kind,
      revision: saved.revision,
      revisionId: saved.revisionId,
      artifactId: saved.artifactId,
      chapterId: saved.chapterId,
      chapterNumber: saved.chapterNumber,
      current: true,
      conflicted: false,
      unchanged: true,
    };
  }
  if (!asCandidate) {
    applyDerived(input.bookId, input.kind, input.scene, input.body);
    try {
      syncBook(input.bookId);
    } catch (error) {
      console.error("manuscript sync failed", error);
    }
    if (
      input.kind === "chapter_body" &&
      chapterNumber &&
      input.body.trim() &&
      input.model !== "import" &&
      !input.skipMemory
    ) {
      // G2: formal memory owned by finalize→proposal→accept once published.
      const hasPub = db
        .prepare(
          `SELECT 1 AS ok FROM chapter_publications p
           JOIN chapters c ON c.id = p.chapter_id
           WHERE p.book_id = ? AND c.number = ? AND p.status = 'active'`,
        )
        .get(input.bookId, chapterNumber) as { ok: number } | undefined;
      if (!hasPub) {
        scheduleMemoryExtract(input.bookId, chapterNumber, saved.revisionId);
      }
    }
  }
  return {
    kind: input.kind,
    revision: saved.revision,
    revisionId: saved.revisionId,
    artifactId: saved.artifactId,
    chapterId: saved.chapterId,
    chapterNumber: saved.chapterNumber,
    current: !asCandidate,
    conflicted: casConflict,
  };
}

function applyDerived(bookId: string, kind: string, scene: string | null, body: string) {
  if (scene === "book_setup" || (kind === "book_profile" && scene !== "topic")) {
    const title = fieldOf(body, "书名");
    const genre = fieldOf(body, "题材");
    const logline = fieldOf(body, "简介");
    const style = fieldOf(body, "文风");
    const current = mustBook(bookId);
    db.prepare("UPDATE books SET title = ?, genre = ?, logline = ?, style = ? WHERE id = ?").run(
      title || current.title,
      genre || current.genre,
      logline || current.logline,
      style || current.style,
      bookId,
    );
    for (const [index, chapterTitle] of titlesFrom(body).entries()) {
      db.prepare("UPDATE chapters SET title = ? WHERE book_id = ? AND number = ?").run(chapterTitle, bookId, index + 1);
    }
  }
  if (kind === "book_outline") {
    for (const line of body.split("\n")) {
      const match = line.match(/^(\d+)\.\s+(\S.*?)\s*$/);
      if (!match) continue;
      db.prepare("UPDATE chapters SET title = ? WHERE book_id = ? AND number = ?").run(match[2]!.trim(), bookId, Number(match[1]));
    }
  }
  if (kind === "chapter_outline") {
    const match = body.match(/^第\s*(\d+)\s*章\s+(\S.*?)\s*$/m);
    if (match) {
      db.prepare("UPDATE chapters SET title = ? WHERE book_id = ? AND number = ?").run(match[2]!.trim(), bookId, Number(match[1]));
    }
  }
}

export function getArtifactBodyForReview(bookId: string, chapterNumber: number): string {
  return artifactBody(bookId, "chapter_body", chapterNumber);
}

function artifactBody(bookId: string, kind: string, chapterNumber: number | null): string {
  const row = db
    .prepare(
      `SELECT r.body AS body
       FROM artifacts a
       JOIN artifact_revisions r ON r.id = a.current_revision_id
       LEFT JOIN chapters c ON c.id = a.chapter_id
       WHERE a.book_id = ? AND a.kind = ? AND ifnull(c.number, 0) = ifnull(?, 0)`,
    )
    .get(bookId, kind, chapterNumber) as { body: string } | undefined;
  return row?.body ?? "";
}


const memoryPending = new Set<string>();
const memoryPromises = new Map<string, Promise<void>>();

/** After chapter body is saved/generated, quietly refresh chapter memory ledger. */
/** Latest body revision we want memory for — late extracts must not overwrite newer. */
const memoryDesiredRevision = new Map<string, string>();

export function scheduleMemoryExtract(bookId: string, chapterNumber: number, sourceRevisionId?: string | null): Promise<void> {
  const key = `${bookId}:${chapterNumber}`;
  if (sourceRevisionId) memoryDesiredRevision.set(key, sourceRevisionId);
  const desired = memoryDesiredRevision.get(key) || sourceRevisionId || "";
  if (memoryPromises.has(key)) {
    // Already running — after it finishes, re-check desired revision.
    const existing = memoryPromises.get(key)!;
    return existing.then(async () => {
      const still = memoryDesiredRevision.get(key);
      if (still && still !== desired) {
        await scheduleMemoryExtract(bookId, chapterNumber, still);
      }
    });
  }
  memoryPending.add(key);
  const targetRev = desired;
  const promise = new Promise<void>((resolve) => {
    setTimeout(() => {
      void (async () => {
        try {
          const result = await executeScene({
            bookId,
            scene: "memory_extract",
            chapterNumber,
            instruction: "",
            sourceRevisionId: targetRev || null,
          });
          void result;
          // If a newer body landed while we ran, schedule again.
          const latest = memoryDesiredRevision.get(key);
          if (latest && targetRev && latest !== targetRev) {
            memoryPromises.delete(key);
            memoryPending.delete(key);
            scheduleMemoryExtract(bookId, chapterNumber, latest);
            resolve();
            return;
          }
        } catch (error) {
          console.error("[memory] extract failed", error);
        } finally {
          memoryPending.delete(key);
          memoryPromises.delete(key);
          resolve();
        }
      })();
    }, 80);
  });
  memoryPromises.set(key, promise);
  return promise;
}

export async function waitMemoryExtract(bookId: string, chapterNumber: number, timeoutMs = 45_000) {
  const key = `${bookId}:${chapterNumber}`;
  const existing = artifactBody(bookId, "chapter_memory", chapterNumber);
  const pending = memoryPromises.get(key);
  if (!pending) {
    if (existing.trim()) return true;
    // kick off if body exists but memory missing
    if (artifactBody(bookId, "chapter_body", chapterNumber).trim()) {
      scheduleMemoryExtract(bookId, chapterNumber);
    } else {
      return true;
    }
  }
  const p = memoryPromises.get(key);
  if (!p) return Boolean(artifactBody(bookId, "chapter_memory", chapterNumber).trim());
  let timedOut = false;
  await Promise.race([
    p,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ]);
  return !timedOut || Boolean(artifactBody(bookId, "chapter_memory", chapterNumber).trim());
}

export function buildContext(
  bookId: string,
  chapterNumber: number | null,
  instruction: string,
  opts?: { scene?: string | null; generationId?: string | null; persist?: boolean },
): string {
  const book = mustBook(bookId);
  const chapters = db
    .prepare("SELECT * FROM chapters WHERE book_id = ? ORDER BY number")
    .all(bookId) as ChapterRow[];
  const current = chapterNumber ? chapters.find((chapter) => chapter.number === chapterNumber) : undefined;
  const prev = chapterNumber && chapterNumber > 1 ? artifactBody(bookId, "chapter_body", chapterNumber - 1) : "";
  const tail = Array.from(prev).slice(-800).join("");
  const { bible, memories, openHooks, manifest } = buildContextManifest(
    bookId,
    chapterNumber,
    opts?.scene ?? null,
  );
  const hard = formatHardConstraintsSection(bookId);
  const text = [
    ...(hard ? ["【硬约束】", hard] : []),
    "【书】",
    `书名：${book.title}`,
    `题材：${book.genre}`,
    `简介：${book.logline}`,
    `文风：${book.style}`,
    `目标章数：${book.target_chapters}`,
    `每章字数：${book.words_per_chapter}`,
    "【档案】",
    artifactBody(bookId, "book_profile", null),
    "【设定卡】",
    bible,
    "【章目】",
    chapters.map((chapter) => `${chapter.number}. ${chapter.title}`).join("\n"),
    "【全书大纲】",
    artifactBody(bookId, "book_outline", null),
    "【前文记忆】",
    memories,
    "【未回收钩子】",
    openHooks,
    "【本章】",
    current ? `章号：${current.number}\n章名：${current.title}` : "",
    "【本章细纲】",
    current ? artifactBody(bookId, "chapter_outline", current.number) : "",
    "【本章正文】",
    current ? artifactBody(bookId, "chapter_body", current.number) : "",
    "【上章结尾】",
    tail,
    "【作者指令】",
    instruction,
  ].join("\n");
  if (opts?.persist) {
    try {
      saveContextSnapshot({
        bookId,
        scene: opts.scene ?? null,
        chapterNumber,
        renderedText: text,
        manifest,
        generationId: opts.generationId ?? null,
      });
    } catch (error) {
      console.error("[context] snapshot save failed", error);
    }
  }
  return text;
}


function routeFor(scene: string): RouteRow {
  const route = db.prepare("SELECT * FROM scene_routes WHERE scene = ?").get(scene) as RouteRow | undefined;
  return route ?? { scene, provider: "local", model_id: "local-draft", base_url: null, thinking_intensity: "medium" };
}

export async function executeScene(input: {
  bookId: string;
  scene: SceneId;
  chapterNumber: number | null;
  instruction?: string;
  skillIds?: string[];
  /** When saving review/memory, bind to this body revision. */
  sourceRevisionId?: string | null;
  expectedRevisionId?: string | null;
  asCandidate?: boolean | (() => boolean);
  /** CAS mismatch: AI writes default to candidate; sync callers may force throw (409). */
  onConflict?: "throw" | "candidate";
  generationId?: string | null;
  signal?: AbortSignal;
  skipMemory?: boolean;
  /** G2: run model but do not save artifact (proposal extract). */
  skipPersist?: boolean;
}) {
  mustBook(input.bookId);
  const needsChapter = input.scene === "chapter_outline" || input.scene === "chapter_body" || input.scene === "review" || input.scene === "humanize" || input.scene === "memory_extract";
  const chapterNumber = needsChapter ? input.chapterNumber ?? 1 : null;
  if (chapterNumber) {
    const chapter = db
      .prepare("SELECT id FROM chapters WHERE book_id = ? AND number = ?")
      .get(input.bookId, chapterNumber) as { id: string } | undefined;
    if (!chapter) throw new HttpError(400, `没有第 ${chapterNumber} 章`);
  }
  // Capture write baseline BEFORE the model call so a concurrent human save becomes candidate, not overwrite.
  const kindForBaseline = sceneKind(input.scene);
  const writeChapterNumber =
    kindForBaseline === "book_profile" || kindForBaseline === "book_outline" || !kindForBaseline
      ? null
      : chapterNumber;
  const baselineRevisionId =
    input.expectedRevisionId !== undefined
      ? input.expectedRevisionId
      : kindForBaseline
        ? currentRevisionIdFor(input.bookId, kindForBaseline, writeChapterNumber)
        : undefined;
  const writeOnConflict = input.onConflict ?? "candidate";
  const skills = skillsForScene(input.scene, input.skillIds);
  const skillTexts = toSkillTexts(skills);
  let instruction = input.instruction?.trim() ?? "";
  if (input.scene === "review" && chapterNumber) {
    const hookBlock = formatOpenHooksForReview(input.bookId, chapterNumber);
    if (hookBlock) instruction = [instruction, hookBlock].filter(Boolean).join("\n\n");
    const hcBlock = formatHardConstraintsForReview(input.bookId, artifactBody(input.bookId, "chapter_body", chapterNumber));
    if (hcBlock) instruction = [instruction, hcBlock].filter(Boolean).join("\n\n");
  }
  const context = buildContext(input.bookId, chapterNumber, instruction, {
    scene: input.scene,
    generationId: input.generationId,
    persist: true,
  });
  const route = routeFor(input.scene);
  throwIfGenerationCancelled(input.generationId, input.signal);
  const result = await getAdapter(route).runScene({
    scene: input.scene,
    model: route.model_id,
    thinkingIntensity: normalizeThinking(route.thinking_intensity),
    skillTexts,
    context,
    instruction,
    signal: input.signal,
  });
  throwIfGenerationCancelled(input.generationId, input.signal);
  try {
    const local = /local/i.test(result.modelUsed);
    const promptTokens = result.usage?.promptTokens ?? estimateTokensFromText(context + instruction);
    const completionTokens = result.usage?.completionTokens ?? estimateTokensFromText(result.text);
    recordUsage({
      bookId: input.bookId,
      scene: input.scene,
      model: result.modelUsed,
      provider: route.provider,
      promptTokens,
      completionTokens,
      totalTokens: result.usage?.totalTokens ?? promptTokens + completionTokens,
      local,
    });
  } catch (error) {
    console.error("[usage] record failed", error);
  }
  const kind = sceneKind(input.scene);
  // Bind review/memory to the body revision they were based on.
  let sourceRevisionId = input.sourceRevisionId ?? null;
  if (!sourceRevisionId && (input.scene === "review" || input.scene === "memory_extract") && chapterNumber) {
    const bodyArt = db
      .prepare(
        `SELECT a.current_revision_id AS id FROM artifacts a
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = ?`,
      )
      .get(input.bookId, chapterNumber) as { id: string | null } | undefined;
    sourceRevisionId = bodyArt?.id ?? null;
  }
  throwIfGenerationCancelled(input.generationId, input.signal);
  const cancelCandidate = () => {
    if (generationWriteShouldBeCandidate(input.generationId, input.signal)) return true;
    if (typeof input.asCandidate === "function") return Boolean(input.asCandidate());
    return Boolean(input.asCandidate);
  };
  const asCandidateNow = cancelCandidate();
  const saved = input.skipPersist
    ? null
    : kind
    ? saveRevision({
        bookId: input.bookId,
        kind,
        chapterNumber: kind === "book_profile" || kind === "book_outline" ? null : chapterNumber,
        body: result.text,
        source: asCandidateNow && generationWriteShouldBeCandidate(input.generationId, input.signal)
          ? "agent_cancelled"
          : "agent",
        model: result.modelUsed,
        skillIds: skills.map((skill) => skill.id),
        scene: input.scene,
        expectedRevisionId: baselineRevisionId,
        asCandidate: asCandidateNow,
        onConflict: writeOnConflict,
        sourceRevisionId,
      })
    : null;
  if (input.generationId && saved && "revisionId" in saved) {
    linkGenerationResultRevision(input.generationId, (saved as { revisionId: string }).revisionId);
  }
  // Race: became current then cancel won — demote before completing.
  if (
    saved &&
    "revisionId" in saved &&
    (saved as { current?: boolean }).current &&
    generationWriteShouldBeCandidate(input.generationId, input.signal)
  ) {
    demoteCancelledResultRevision((saved as { revisionId: string }).revisionId);
    if (input.generationId) {
      completeGeneration(input.generationId, {
        status: "cancelled",
        resultRevisionId: (saved as { revisionId: string }).revisionId,
        error: "已取消（已退回上一版修订）",
        result: {
          cancelRevert: true,
          note: "取消前已写入的修订已退回上一版；该次结果保留在版本历史（来源 agent_cancelled）。",
          saved,
        },
      });
    }
    const err = new Error("已取消");
    err.name = "AbortError";
    throw err;
  }
  if (input.generationId) {
    if (generationWriteShouldBeCandidate(input.generationId, input.signal)) {
      completeGeneration(input.generationId, {
        status: "cancelled",
        resultRevisionId: saved && "revisionId" in saved ? (saved as { revisionId: string }).revisionId : null,
        error: "已取消",
        result: { text: result.text, modelUsed: result.modelUsed, saved, current: false },
      });
      const err = new Error("已取消");
      err.name = "AbortError";
      throw err;
    }
    completeGeneration(input.generationId, {
      status: "completed",
      resultRevisionId: saved && "revisionId" in saved ? (saved as { revisionId: string }).revisionId : null,
      result: { text: result.text, modelUsed: result.modelUsed, saved },
    });
  }
  return {
    text: result.text,
    modelUsed: result.modelUsed,
    skills: skills.map((skill) => ({ id: skill.id, name: skill.name, role: skill.role })),
    skillPromptMeta: skillPromptMeta(skillTexts),
    saved,
    hardConstraintCheck: postGenerationHardCheck(input.bookId, input.scene, result.text),
  };
}

/** D4：正文类产出生成后做硬约束预检，结果回传 UI（不阻断写入、不自动改稿）。 */
export function postGenerationHardCheck(bookId: string, scene: string, text: string): HardConstraintCheck | null {
  if (!["chapter_body", "humanize", "chapter_outline", "selection_rewrite"].includes(scene)) return null;
  try {
    return checkHardConstraints(bookId, text);
  } catch (error) {
    console.error("[hard-constraints] check failed", error);
    return null;
  }
}

export async function autoSetup(brief: string, forcedId?: string) {
  const text = brief.trim();
  if (!text) throw new HttpError(400, "要有一句题材");
  if (forcedId && db.prepare("SELECT id FROM books WHERE id = ?").get(forcedId)) {
    throw new HttpError(409, "这本书已经存在");
  }
  const scene: SceneId = "book_setup";
  const skills = skillsForScene(scene);
  const route = routeFor(scene);
  const result = await getAdapter(route).runScene({
    scene,
    model: route.model_id,
    thinkingIntensity: normalizeThinking(route.thinking_intensity),
    skillTexts: toSkillTexts(skills),
    context: `【题材简述】\n${text}\n`,
    instruction: text,
  });
  const title = fieldOf(result.text, "书名") || "未命名";
  const genre = fieldOf(result.text, "题材") || "";
  const logline = fieldOf(result.text, "简介") || text;
  const style = fieldOf(result.text, "文风") || "";
  const titles = titlesFrom(result.text);
  const count = Math.min(48, Math.max(1, Number(fieldOf(result.text, "目标章数")) || titles.length || 12));
  const chapterTitles = titles.length
    ? titles.slice(0, count)
    : Array.from({ length: count }, (_, index) => `第${index + 1}章`);
  while (chapterTitles.length < count) chapterTitles.push(`第${chapterTitles.length + 1}章`);
  const id = forcedId || crypto.randomUUID();
  const created = now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO books (id, title, genre, logline, style, target_chapters, words_per_chapter, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, genre, logline, style, count, 800, created);
    insertChapters(id, chapterTitles);
  })();
  saveRevision({
    bookId: id,
    kind: "book_profile",
    chapterNumber: null,
    body: result.text,
    source: "agent",
    model: result.modelUsed,
    skillIds: skills.map((skill) => skill.id),
    scene: "book_setup",
  });
  return { ...getBookPayload(id), modelUsed: result.modelUsed };
}

const KIND_LABEL: Record<string, string> = {
  book_profile: "档案",
  book_outline: "全书大纲",
  chapter_outline: "章节细纲",
  chapter_body: "正文",
  review_report: "审核",
  chapter_memory: "记忆",
};

function modelLabel(modelUsed: string): string {
  if (modelUsed === "local-draft") return "本地草稿引擎";
  // Intentional local runs use local-draft/<thinking>; never imply a silent remote fallback.
  if (/^local-draft\//i.test(modelUsed)) return "本地草稿引擎";
  if (/local-draft/i.test(modelUsed) && /失败|回退|openai failed|模型调用失败/i.test(modelUsed)) {
    return "本地草稿引擎（配置不完整提示）";
  }
  if (modelUsed.startsWith("local-draft")) return "本地草稿引擎";
  return modelUsed;
}

/** Full reply body: keep the generated text and its line breaks, just drop stray blank runs at the ends. */
function replyBody(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Older assistant messages were stored with an 80-character, whitespace-flattened preview ending in "…".
 * When the message points at a saved revision, return the full text of that revision instead.
 */
function expandLegacyPreview(bookId: string, content: string, meta: unknown): string {
  if (!content.endsWith("…")) return content;
  const saved = (meta as { saved?: { kind?: string; revision?: number; chapterNumber?: number | null } | null } | null)?.saved;
  if (!saved?.kind || !saved.revision) return content;
  const newline = content.indexOf("\n");
  if (newline < 0) return content;
  const row = db
    .prepare(
      `SELECT r.body AS body
         FROM artifact_revisions r
         JOIN artifacts a ON a.id = r.artifact_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
        WHERE a.book_id = ? AND a.kind = ? AND r.revision = ? AND COALESCE(c.number, -1) = ?`,
    )
    .get(bookId, saved.kind, saved.revision, saved.chapterNumber ?? -1) as { body: string } | undefined;
  if (!row?.body) return content;
  return `${content.slice(0, newline)}\n${replyBody(row.body)}`;
}

function insertMessage(bookId: string, role: string, content: string, meta: unknown) {
  const id = crypto.randomUUID();
  const createdAt = now();
  db.prepare("INSERT INTO messages (id, book_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    bookId,
    role,
    content,
    meta ? JSON.stringify(meta) : null,
    createdAt,
  );
  return { id, role, content, meta: meta ?? null, createdAt };
}

export function listMessages(bookId: string) {
  mustBook(bookId);
  const rows = db
    .prepare("SELECT * FROM messages WHERE book_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(bookId) as { id: string; role: string; content: string; meta_json: string | null; created_at: string }[];
  return rows.map((row) => {
    const meta = row.meta_json ? (JSON.parse(row.meta_json) as unknown) : null;
    return {
      id: row.id,
      role: row.role,
      content: row.role === "assistant" ? expandLegacyPreview(bookId, row.content, meta) : row.content,
      meta,
      createdAt: row.created_at,
    };
  });
}


export type GenerationStatus = "running" | "completed" | "failed" | "cancelled";


/** Abort if client signal fired or generation was cancelled via API. */
export function throwIfGenerationCancelled(generationId?: string | null, signal?: AbortSignal | null) {
  throwIfAborted(signal);
  if (!generationId) return;
  const row = getGeneration(generationId);
  if (row?.status === "cancelled") {
    const err = new Error("已取消");
    err.name = "AbortError";
    throw err;
  }
}

export function beginGeneration(input: {
  id: string;
  bookId: string;
  scene: string;
  chapterNumber?: number | null;
  chapterId?: string | null;
  baseRevisionId?: string | null;
}) {
  const existing = db.prepare("SELECT * FROM generations WHERE id = ?").get(input.id) as
    | {
        id: string;
        status: string;
        result_json: string | null;
        error: string | null;
        result_revision_id: string | null;
      }
    | undefined;
  if (existing) {
    return {
      reused: true as const,
      status: existing.status as GenerationStatus,
      result: existing.result_json ? JSON.parse(existing.result_json) : null,
      error: existing.error,
      resultRevisionId: existing.result_revision_id,
    };
  }
  const ts = now();
  db.prepare(
    `INSERT INTO generations
      (id, book_id, scene, chapter_id, chapter_number, status, base_revision_id, result_revision_id, result_json, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.id,
    input.bookId,
    input.scene,
    input.chapterId ?? null,
    input.chapterNumber ?? null,
    input.baseRevisionId ?? null,
    ts,
    ts,
  );
  return { reused: false as const, status: "running" as const };
}

export function getGeneration(id: string) {
  const row = db.prepare("SELECT * FROM generations WHERE id = ?").get(id) as
    | {
        id: string;
        book_id: string;
        scene: string;
        status: string;
        result_json: string | null;
        error: string | null;
        result_revision_id: string | null;
        base_revision_id: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    bookId: row.book_id,
    scene: row.scene,
    status: row.status as GenerationStatus,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    resultRevisionId: row.result_revision_id,
    baseRevisionId: row.base_revision_id,
  };
}

export type CancelRevertInfo = {
  demoted: boolean;
  orphanRevisionId: string | null;
  restoredRevisionId: string | null;
  artifactId: string | null;
};

/** Previous revision id for an artifact revision (by revision number), or null. */
export function peekPreviousRevisionId(revisionId: string | null | undefined): string | null {
  if (!revisionId) return null;
  const row = db
    .prepare(
      `SELECT r.artifact_id AS artifact_id, r.revision AS revision_num
       FROM artifact_revisions r WHERE r.id = ?`,
    )
    .get(revisionId) as { artifact_id: string; revision_num: number } | undefined;
  if (!row) return null;
  const prev = db
    .prepare(
      `SELECT id FROM artifact_revisions
       WHERE artifact_id = ? AND revision < ?
       ORDER BY revision DESC LIMIT 1`,
    )
    .get(row.artifact_id, row.revision_num) as { id: string } | undefined;
  return prev?.id ?? null;
}

export type CancelGenerationResult = {
  id: string;
  bookId: string;
  scene: string;
  status: GenerationStatus;
  result: unknown;
  error: string | null;
  resultRevisionId: string | null;
  baseRevisionId: string | null;
  revert: CancelRevertInfo | null;
  /** True when cancel hit an already-terminal generation (completed/failed). */
  alreadyTerminal?: boolean;
  /** True when status was already completed — result is kept; no silent demote. */
  accepted?: boolean;
  /** Immediate previous revision of the linked result, for optional manual restore. */
  previousRevisionId?: string | null;
  note?: string | null;
};

/** Link a saved revision to a still-running generation so cancel can demote it. */
export function linkGenerationResultRevision(generationId: string, revisionId: string) {
  const ts = now();
  db.prepare(
    `UPDATE generations SET result_revision_id = COALESCE(result_revision_id, ?), updated_at = ?
     WHERE id = ?`,
  ).run(revisionId, ts, generationId);
}

/**
 * If `revisionId` is the artifact's current revision, restore the previous revision
 * (or clear current) and mark the orphan as `agent_cancelled` so history is explicit.
 */
export function demoteCancelledResultRevision(revisionId: string): CancelRevertInfo {
  const row = db
    .prepare(
      `SELECT r.id AS revision_id, r.revision AS revision_num, r.artifact_id AS artifact_id,
              a.current_revision_id AS current_id, a.book_id AS book_id
       FROM artifact_revisions r
       JOIN artifacts a ON a.id = r.artifact_id
       WHERE r.id = ?`,
    )
    .get(revisionId) as
    | {
        revision_id: string;
        revision_num: number;
        artifact_id: string;
        current_id: string | null;
        book_id: string;
      }
    | undefined;
  if (!row) {
    return { demoted: false, orphanRevisionId: null, restoredRevisionId: null, artifactId: null };
  }
  db.prepare(`UPDATE artifact_revisions SET source = 'agent_cancelled' WHERE id = ?`).run(revisionId);
  if (row.current_id !== revisionId) {
    return {
      demoted: false,
      orphanRevisionId: revisionId,
      restoredRevisionId: row.current_id,
      artifactId: row.artifact_id,
    };
  }
  const prev = db
    .prepare(
      `SELECT id FROM artifact_revisions
       WHERE artifact_id = ? AND revision < ?
       ORDER BY revision DESC LIMIT 1`,
    )
    .get(row.artifact_id, row.revision_num) as { id: string } | undefined;
  const restoreId = prev?.id ?? null;
  db.prepare(`UPDATE artifacts SET current_revision_id = ? WHERE id = ?`).run(restoreId, row.artifact_id);
  try {
    syncBook(row.book_id);
  } catch (error) {
    console.error("manuscript sync after cancel demote failed", error);
  }
  return {
    demoted: true,
    orphanRevisionId: revisionId,
    restoredRevisionId: restoreId,
    artifactId: row.artifact_id,
  };
}

/** True when client aborted or generation was cancelled via API. */
export function generationWriteShouldBeCandidate(generationId?: string | null, signal?: AbortSignal | null) {
  if (signal?.aborted) return true;
  if (!generationId) return false;
  const row = getGeneration(generationId);
  return row?.status === "cancelled";
}

export function completeGeneration(
  id: string,
  patch: { status: GenerationStatus; resultRevisionId?: string | null; result?: unknown; error?: string | null },
) {
  const existing = getGeneration(id);
  // Late completed/failed must not resurrect a cancelled generation (mid-stream abort won).
  if (
    existing &&
    existing.status === "cancelled" &&
    (patch.status === "completed" || patch.status === "failed")
  ) {
    return existing;
  }
  const ts = now();
  db.prepare(
    `UPDATE generations SET status = ?, result_revision_id = COALESCE(?, result_revision_id),
      result_json = COALESCE(?, result_json), error = ?, updated_at = ? WHERE id = ?`,
  ).run(
    patch.status,
    patch.resultRevisionId ?? null,
    patch.result != null ? JSON.stringify(patch.result) : null,
    patch.error ?? null,
    ts,
    id,
  );
}

/** Mark a running generation cancelled. Idempotent for already-terminal states.
 *  If a revision was already linked/saved as current *while still running*, demote it.
 *  If already `completed`, never demote — result is treated as accepted; return
 *  `previousRevisionId` so the client can offer optional restore-from-history.
 */
export function cancelGeneration(id: string): CancelGenerationResult {
  const row = getGeneration(id);
  if (!row) throw new HttpError(404, "生成记录不存在");
  if (row.status === "completed" || row.status === "failed") {
    const previousRevisionId = peekPreviousRevisionId(row.resultRevisionId);
    const accepted = row.status === "completed";
    return {
      ...row,
      revert: null,
      alreadyTerminal: true,
      accepted,
      previousRevisionId,
      note: accepted
        ? "生成已完成，结果已保留；停止不会撤回。可在版本历史还原上一版。"
        : "生成已失败结束；停止不会改动稿面。",
    };
  }
  if (row.status === "cancelled") {
    const revert = row.resultRevisionId ? demoteCancelledResultRevision(row.resultRevisionId) : null;
    return {
      ...getGeneration(id)!,
      revert,
      alreadyTerminal: true,
      accepted: false,
      previousRevisionId: peekPreviousRevisionId(row.resultRevisionId),
      note: revert?.demoted
        ? "已取消（已退回上一版修订）"
        : "生成已取消。",
    };
  }
  completeGeneration(id, { status: "cancelled", error: "已取消" });
  const after = getGeneration(id)!;
  const revert = after.resultRevisionId ? demoteCancelledResultRevision(after.resultRevisionId) : null;
  if (revert?.demoted) {
    const ts = now();
    const result = {
      cancelRevert: revert,
      note: "取消前已写入的修订已退回上一版；该次结果保留在版本历史（来源 agent_cancelled），可手动还原。",
    };
    db.prepare(`UPDATE generations SET result_json = ?, error = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(result),
      "已取消（已退回上一版修订）",
      ts,
      id,
    );
  }
  return {
    ...getGeneration(id)!,
    revert,
    alreadyTerminal: false,
    accepted: false,
    previousRevisionId: peekPreviousRevisionId(after.resultRevisionId),
    note: revert?.demoted
      ? "取消前已写入的修订已退回上一版；该次结果保留在版本历史（来源 agent_cancelled），可手动还原。"
      : "已取消。",
  };
}

/** Exported for smoke tests — keep intents narrow (no bare 写/生成 → 正文). */
export function routeMessage(message: string): SceneId | null {
  const text = message.trim();
  if (!text) return null;

  // Negation / refusal never authorizes a write.
  if (/(不要|别|禁止|无需|不用|别再|先别|不要再).{0,12}(写|生成|重写|续写|起草|扩写|审核|润色|去\s*AI)/.test(text)) {
    return null;
  }
  // How-to / meta questions are discussion, not write auth — even if they contain 写+正文.
  if (/(怎么|如何|怎样).{0,8}(写|生成)/.test(text) || /(写|生成).{0,8}(怎么|如何|怎样)/.test(text)) {
    return null;
  }

  const asks = /[？?]\s*$/.test(text);
  const ordersDraft =
    /(写|生成|重写|续写|起草|扩写).{0,16}(大纲|细纲|正文|档案|设定|审核)|(大纲|细纲|正文|档案|设定).{0,10}(写|生成|重写|续写|起草|扩写)/.test(
      text,
    );
  const chapterWrite =
    /(写|生成|重写|续写|起草|扩写)\s*(一?下)?\s*(这一章|本章|这章)/.test(text) ||
    /(这一章|本章|这章).{0,8}(写出来|写完|重写|生成|续写|起草|扩写)/.test(text);

  // Pure evaluation / discussion without imperative write.
  if (
    /(太短|太长|怎样|怎么样|如何|感觉|觉得|评价|分析一下)/.test(text) &&
    !ordersDraft &&
    !chapterWrite
  ) {
    return null;
  }

  if (asks && !ordersDraft && !chapterWrite && !/^(去\s*AI|润色|审核)/.test(text)) return null;

  if (/去\s*AI|润色/.test(text)) return "humanize";
  if (/审核/.test(text) && (ordersDraft || /审核(一下|本章|这一章|第\s*\d+)|^(请)?审核/.test(text))) {
    return "review";
  }
  if (/建书|新建一本|建一本/.test(text) || (/(档案|设定)/.test(text) && ordersDraft)) {
    return "book_setup";
  }
  if (text.includes("细纲") && ordersDraft) return "chapter_outline";
  if (text.includes("大纲") && ordersDraft) return "outline";
  if (text.includes("正文") && (ordersDraft || chapterWrite)) return "chapter_body";
  if (chapterWrite) return "chapter_body";
  return null;
}


export async function rewriteSelection(input: {
  bookId: string;
  selection: string;
  instruction: string;
  scene?: SceneId;
}) {
  mustBook(input.bookId);
  const selection = input.selection.replace(/\r\n?/g, "\n").trim();
  const instruction = input.instruction.trim();
  if (!selection) throw new HttpError(400, "要先选中一段文字");
  if (!instruction) throw new HttpError(400, "要有改写说明");
  if (selection.length > 8000) throw new HttpError(400, "选中文字太长，请缩短后再试");

  const scene: SceneId = input.scene && ["chapter_body", "humanize", "chapter_outline", "outline", "review", "book_setup"].includes(input.scene)
    ? input.scene
    : "humanize";
  const route = routeFor(scene);
  const skillRows = skillsForScene(selectionSkillScene(scene));
  const skillTexts = toSkillTexts(skillRows, 36000);
  const skillInfo = {
    skills: skillRows.map((s) => ({ id: s.id, name: s.name, role: s.role })),
    skillPromptMeta: skillPromptMeta(skillTexts),
  };

  if (route.provider !== "openai") {
    return { text: rewriteSelectionLocal(selection, instruction), modelUsed: "local-draft", local: true, ...skillInfo };
  }

  try {
    const result = await getAdapter(route).runScene({
      scene: "humanize",
      model: route.model_id,
      thinkingIntensity: normalizeThinking(route.thinking_intensity),
      skillTexts,
      context: `${formatHardConstraintsSection(input.bookId).replace(/^(.+)/s, "【硬约束】\n$1\n")}【待改片段】\n${selection}\n`,
      instruction: [
        instruction,
        "只改写上面的「待改片段」。",
        "只输出改写后的文字本身，不要标题、引号包裹、创作说明或前后缀。",
        "对白只用弯引号“”，不要用「」、（）或()包说话。",
        /续写/.test(instruction) ? "若指令是续写：只输出接在选区后面的新文字，不要重复原文。" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    let text = normalizeDialogueQuotes(result.text.replace(/\r\n?/g, "\n").trim());
    // Drop accidental whole-document dumps — surface error instead of silent local swap.
    if (text.length > Math.max(selection.length * 4, 1200) && !/续写/.test(instruction)) {
      throw new HttpError(502, "模型返回过长，已拒绝替换选区（请缩短指令或重试）");
    }
    if (!text) {
      throw new HttpError(502, "模型返回为空");
    }
    if (/local-draft/i.test(result.modelUsed) && /openai failed|模型调用失败|模型流式/i.test(result.modelUsed)) {
      throw new HttpError(502, result.modelUsed);
    }
    const local = /local-draft/i.test(result.modelUsed);
    return { text, modelUsed: result.modelUsed, local, ...skillInfo, hardConstraintCheck: postGenerationHardCheck(input.bookId, "selection_rewrite", text) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const reason = error instanceof Error ? error.message : "未知错误";
    throw new HttpError(502, `选区改写失败：${reason}`);
  }
}

export async function chat(
  bookId: string,
  message: string,
  preferredChapter?: number | null,
  generationId?: string | null,
  signal?: AbortSignal,
) {
  const book = mustBook(bookId);
  const text = message.trim();
  if (!text) throw new HttpError(400, "要说一句");
  if (text.length > CHAT_MESSAGE_MAX) throw new HttpError(400, `单条指令最多 ${CHAT_MESSAGE_MAX} 字，请缩短或分段发送`);
  if (generationId) {
    const began = beginGeneration({
      id: generationId,
      bookId,
      scene: "chat",
      chapterNumber: preferredChapter ?? null,
    });
    if (began.reused) {
      if (began.status === "completed" && began.result) {
        return began.result as { message: ReturnType<typeof insertMessage>; saved: unknown };
      }
      if (began.status === "running") {
        throw new HttpError(409, "同一 generationId 仍在执行，请查询状态而非重试");
      }
      if (began.status === "failed") {
        throw new HttpError(502, began.error || "上次生成失败");
      }
      if (began.status === "cancelled") {
        throw new HttpError(409, "该生成已取消");
      }
    }
  }
  throwIfGenerationCancelled(generationId, signal);
  await optionalStreamPreDelay(signal);
  throwIfGenerationCancelled(generationId, signal);
  insertMessage(bookId, "user", text, null);
  const scene = routeMessage(text);
  if (!scene) {
    // Free-form dialogue uses the dedicated「对话」scene route (provider + model),
    // and still injects user primary packs so the agent can reference them.
    const chatScene: SceneId = "chat";
    const route = routeFor(chatScene);
    const skillRows = skillsForScene(chatScene);
    const skillTexts = toSkillTexts(skillRows);
    const skillInfo = {
      skills: skillRows.map((s) => ({ id: s.id, name: s.name, role: s.role })),
      skillPromptMeta: skillPromptMeta(skillTexts),
    };
    try {
      const context = buildContext(bookId, null, text, { scene: "chat", persist: true });
      throwIfAborted(signal);
      const result = await getAdapter(route).runScene({
        scene: chatScene,
        model: route.model_id,
        thinkingIntensity: normalizeThinking(route.thinking_intensity),
        skillTexts,
        context,
        instruction: text,
        signal,
      });
      throwIfAborted(signal);
      try {
        const local = /local/i.test(result.modelUsed);
        const promptTokens = result.usage?.promptTokens ?? estimateTokensFromText(context + text);
        const completionTokens = result.usage?.completionTokens ?? estimateTokensFromText(result.text);
        recordUsage({
          bookId,
          scene: chatScene,
          model: result.modelUsed,
          provider: route.provider,
          promptTokens,
          completionTokens,
          totalTokens: result.usage?.totalTokens ?? promptTokens + completionTokens,
          local,
        });
      } catch (error) {
        console.error("[usage] chat record failed", error);
      }
      const content = replyBody(result.text);
      const assistant = insertMessage(bookId, "assistant", content, {
        scene: chatScene,
        modelUsed: result.modelUsed,
        saved: null,
        ...skillInfo,
      });
      return { message: assistant, saved: null, ...skillInfo };
    } catch (error) {
      if (isAbortError(error)) throw error;
      const fallback = `我可以按《${book.title}》往下写。你可以直接说：写全书大纲、写第 3 章细纲、写第 1 章正文、审核这一章、把正文去 AI 味。`;
      const content = error instanceof Error ? `${fallback}\n（对话模型未接通：${error.message}）` : fallback;
      const assistant = insertMessage(bookId, "assistant", content, { scene: chatScene, saved: null, ...skillInfo });
      return { message: assistant, saved: null, ...skillInfo };
    }
  }
  const mentioned = parseChapterMention(text);
  const fallbackChapter =
    typeof preferredChapter === "number" && preferredChapter > 0
      ? preferredChapter
      : 1;
  // 「这一章 / 本章」或未点名时，用写作台当前章；显式「第 N 章」优先。
  const chapterNumber =
    scene === "outline" || scene === "book_setup"
      ? null
      : (mentioned ?? fallbackChapter);
  try {
    throwIfGenerationCancelled(generationId, signal);
    const result = await executeScene({ bookId, scene, chapterNumber, instruction: text, signal, generationId });
    const label = result.saved ? KIND_LABEL[result.saved.kind] ?? "稿件" : "稿件";
    const where = result.saved?.chapterNumber ? `第 ${result.saved.chapterNumber} 章` : "";
    const hcNote = result.hardConstraintCheck ? formatViolationsNote(result.hardConstraintCheck) : "";
    const content = `已写入${where}${label}，修订 ${result.saved?.revision ?? 1}。用的是${modelLabel(result.modelUsed)}。${hcNote ? `\n${hcNote}` : ""}\n${replyBody(result.text)}`;
    const meta = {
      scene,
      modelUsed: result.modelUsed,
      saved: result.saved,
      skills: result.skills,
      skillPromptMeta: result.skillPromptMeta,
      hardConstraintCheck: result.hardConstraintCheck,
    };
    const assistant = insertMessage(bookId, "assistant", content, meta);
    return { message: assistant, saved: result.saved, skills: result.skills, skillPromptMeta: result.skillPromptMeta, hardConstraintCheck: result.hardConstraintCheck };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const content = error instanceof Error ? error.message : "这次没有写成";
    const assistant = insertMessage(bookId, "assistant", content, { scene, saved: null });
    return { message: assistant, saved: null };
  }
}


type JobRow = {
  id: string;
  book_id: string;
  status: string;
  from_chapter: number;
  to_chapter: number;
  current_chapter: number;
  current_stage: string;
  error: string | null;
  created_at: string;
  auto_review?: number;
  max_retries?: number;
  retry_count?: number;
  log_json?: string | null;
  lease_owner?: string | null;
  lease_until?: string | null;
};

function parseJobLog(raw: string | null | undefined): { at: string; stage: string; chapter: number; message: string }[] {
  try {
    const parsed = JSON.parse(raw || "[]") as { at: string; stage: string; chapter: number; message: string }[];
    return Array.isArray(parsed) ? parsed.slice(-40) : [];
  } catch {
    return [];
  }
}

function appendJobLog(id: string, stage: string, chapter: number, message: string) {
  const row = db.prepare("SELECT log_json FROM writing_jobs WHERE id = ?").get(id) as { log_json: string | null } | undefined;
  const log = parseJobLog(row?.log_json);
  log.push({ at: now(), stage, chapter, message });
  db.prepare("UPDATE writing_jobs SET log_json = ? WHERE id = ?").run(JSON.stringify(log.slice(-40)), id);
}

function jobJson(row: JobRow) {
  return {
    id: row.id,
    bookId: row.book_id,
    status: row.status,
    fromChapter: row.from_chapter,
    toChapter: row.to_chapter,
    currentChapter: row.current_chapter,
    currentStage: row.current_stage,
    error: row.error,
    createdAt: row.created_at,
    autoReview: (row.auto_review ?? 0) === 1,
    maxRetries: row.max_retries ?? 1,
    retryCount: row.retry_count ?? 0,
    log: parseJobLog(row.log_json),
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: row.lease_until ?? null,
  };
}

export function listJobs(bookId: string) {
  mustBook(bookId);
  const rows = db
    .prepare("SELECT * FROM writing_jobs WHERE book_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20")
    .all(bookId) as JobRow[];
  return rows.map(jobJson);
}

export function createJob(
  bookId: string,
  fromChapter?: number,
  toChapter?: number,
  opts?: { autoReview?: boolean; maxRetries?: number },
) {
  const book = mustBook(bookId);
  const id = crypto.randomUUID();
  const from = fromChapter ?? 1;
  const to = toChapter ?? book.target_chapters;
  const autoReview = opts?.autoReview ? 1 : 0;
  const maxRetries = Math.min(5, Math.max(0, opts?.maxRetries ?? 1));
  db.prepare(
    `INSERT INTO writing_jobs
      (id, book_id, status, from_chapter, to_chapter, current_chapter, current_stage, error, created_at, auto_review, max_retries, retry_count, log_json)
     VALUES (?, ?, 'running', ?, ?, ?, 'outline', NULL, ?, ?, ?, 0, ?)`,
  ).run(id, bookId, from, to, from, now(), autoReview, maxRetries, JSON.stringify([{ at: now(), stage: "outline", chapter: from, message: "任务已创建" }]));
  return getJob(id);
}

export function getJob(id: string) {
  const row = db.prepare("SELECT * FROM writing_jobs WHERE id = ?").get(id) as JobRow | undefined;
  if (!row) throw new HttpError(404, "没有这个任务");
  return jobJson(row);
}


/**
 * Job lease: SQLite predicate on default driver; on postgres-native use
 * FOR UPDATE SKIP LOCKED + same acquire predicate (sync via native bridge).
 */
export function tryAcquireJobLease(id: string, owner: string, ttlMs = DEFAULT_LEASE_TTL_MS): boolean {
  getJob(id);
  const until = leaseUntilIso(ttlMs);
  const nowIso = now();
  if (getDbInfo().driver === "postgres-native") {
    return db.transaction(() => {
      const locked = db
        .prepare(
          `SELECT id, status, lease_owner, lease_until
           FROM writing_jobs
           WHERE id = ?
           FOR UPDATE SKIP LOCKED`,
        )
        .all(id) as { id: string }[];
      if (!locked.length) return false;
      const result = db.prepare(SQLITE_ACQUIRE_SQL).run(owner, until, id, nowIso, owner);
      return result.changes > 0;
    })();
  }
  const result = db.prepare(SQLITE_ACQUIRE_SQL).run(owner, until, id, nowIso, owner);
  return result.changes > 0;
}

export function releaseJobLease(id: string, owner: string) {
  db.prepare(SQLITE_RELEASE_SQL).run(id, owner);
}

export function setJobStatus(id: string, status: string) {
  if (!["paused", "running", "done", "cancelled"].includes(status)) {
    throw new HttpError(400, "状态只能是 paused、running、done 或 cancelled");
  }
  getJob(id);
  db.prepare("UPDATE writing_jobs SET status = ?, error = CASE WHEN ? = 'running' THEN NULL ELSE error END WHERE id = ?").run(
    status,
    status,
    id,
  );
  const label =
    status === "paused"
      ? "已暂停（当前阶段结束后停）"
      : status === "running"
        ? "继续运行"
        : status === "cancelled"
          ? "已取消（迟到结果不设为当前稿）"
          : "标记完成";
  appendJobLog(id, getJob(id).currentStage, getJob(id).currentChapter, label);
  return getJob(id);
}

/** Retry a failed job from its current stage. */
export function retryJob(id: string) {
  const job = getJob(id);
  if (job.status !== "error" && job.status !== "paused") {
    throw new HttpError(400, "只能重试失败或已暂停的任务");
  }
  db.prepare(
    `UPDATE writing_jobs SET status = 'running', error = NULL, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?`,
  ).run(id);
  appendJobLog(id, job.currentStage, job.currentChapter, `重试第 ${(job.retryCount ?? 0) + 1} 次`);
  return getJob(id);
}

function advanceAfterChapter(id: string, job: ReturnType<typeof getJob>) {
  if (job.currentChapter >= job.toChapter) {
    db.prepare("UPDATE writing_jobs SET status = 'done', current_stage = 'done', error = NULL WHERE id = ?").run(id);
    appendJobLog(id, "done", job.currentChapter, "全部完成");
  } else {
    const next = job.currentChapter + 1;
    db.prepare("UPDATE writing_jobs SET current_chapter = ?, current_stage = 'chapter_outline', error = NULL WHERE id = ?").run(
      next,
      id,
    );
    appendJobLog(id, "chapter_outline", next, `进入第 ${next} 章细纲`);
  }
}

/** cancelled → stop without advancing; paused → caller may advance stage but must keep paused. */
function jobLease(id: string, stage: string): "ok" | "paused" | "stop" {
  const fresh = getJob(id);
  if (fresh.status === "cancelled") {
    appendJobLog(id, stage, fresh.currentChapter, "任务已取消，不再推进");
    return "stop";
  }
  if (fresh.status === "done") return "stop";
  if (fresh.status === "paused") {
    appendJobLog(id, stage, fresh.currentChapter, "任务已暂停，本阶段完成后停留");
    return "paused";
  }
  return "ok";
}

export async function tickJob(id: string) {
  const job = getJob(id);
  if (job.status === "paused" || job.status === "done" || job.status === "cancelled") {
    return { job, advanced: false };
  }
  try {
    if (job.currentStage === "outline") {
      const existing = artifactBody(job.bookId, "book_outline", null);
      if (!existing.trim()) {
        await executeScene({ bookId: job.bookId, scene: "outline", chapterNumber: null, instruction: "按档案写全书大纲" });
        appendJobLog(id, "outline", job.currentChapter, "已生成全书大纲");
      } else {
        appendJobLog(id, "outline", job.currentChapter, "已有全书大纲，跳过");
      }
      const leaseOutline = jobLease(id, "outline");
      if (leaseOutline === "stop") return { job: getJob(id), advanced: false };
      db.prepare(
        `UPDATE writing_jobs SET current_stage = 'chapter_outline', current_chapter = ?, error = NULL,
          status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'running' END WHERE id = ?`,
      ).run(job.fromChapter, id);
    } else if (job.currentStage === "chapter_outline") {
      await executeScene({
        bookId: job.bookId,
        scene: "chapter_outline",
        chapterNumber: job.currentChapter,
        instruction: `写第 ${job.currentChapter} 章细纲`,
        asCandidate: () => jobLease(id, "chapter_outline") === "stop",
      });
      appendJobLog(id, "chapter_outline", job.currentChapter, `第 ${job.currentChapter} 章细纲完成`);
      const lease_chapter_outline = jobLease(id, "chapter_outline");
      if (lease_chapter_outline === "stop") return { job: getJob(id), advanced: false };
      // paused: still advance stage pointer below, status stays paused
      db.prepare("UPDATE writing_jobs SET current_stage = 'chapter_body', error = NULL WHERE id = ?").run(id);
    } else if (job.currentStage === "chapter_body") {
      const bodyBefore = db
        .prepare(
          `SELECT a.current_revision_id AS id FROM artifacts a
           LEFT JOIN chapters c ON c.id = a.chapter_id
           WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = ?`,
        )
        .get(job.bookId, job.currentChapter) as { id: string | null } | undefined;
      await executeScene({
        bookId: job.bookId,
        scene: "chapter_body",
        chapterNumber: job.currentChapter,
        instruction: `写第 ${job.currentChapter} 章正文`,
        // Cancelled mid-flight → candidate only, never becomes current.
        asCandidate: () => jobLease(id, "chapter_body") === "stop",
      });
      appendJobLog(id, "chapter_body", job.currentChapter, `第 ${job.currentChapter} 章正文完成`);
      void bodyBefore;
      const lease_chapter_body = jobLease(id, "chapter_body");
      if (lease_chapter_body === "stop") return { job: getJob(id), advanced: false };
      // paused: still advance stage pointer below, status stays paused
      db.prepare("UPDATE writing_jobs SET current_stage = 'memory', error = NULL WHERE id = ?").run(id);
    } else if (job.currentStage === "memory") {
      const ok = await waitMemoryExtract(job.bookId, job.currentChapter, 40_000);
      appendJobLog(
        id,
        "memory",
        job.currentChapter,
        ok ? `第 ${job.currentChapter} 章记忆已抽取` : `第 ${job.currentChapter} 章记忆等待超时，继续`,
      );
      const lease_memory = jobLease(id, "memory");
      if (lease_memory === "stop") return { job: getJob(id), advanced: false };
      // paused: still advance stage pointer below, status stays paused
      if (job.autoReview) {
        db.prepare("UPDATE writing_jobs SET current_stage = 'review', error = NULL WHERE id = ?").run(id);
      } else {
        advanceAfterChapter(id, getJob(id));
      }
    } else if (job.currentStage === "review") {
      await executeScene({
        bookId: job.bookId,
        scene: "review",
        chapterNumber: job.currentChapter,
        instruction: `审核第 ${job.currentChapter} 章正文，列出问题清单`,
        asCandidate: () => jobLease(id, "review") === "stop",
      });
      appendJobLog(id, "review", job.currentChapter, `第 ${job.currentChapter} 章审核完成`);
      const lease_review = jobLease(id, "review");
      if (lease_review === "stop") return { job: getJob(id), advanced: false };
      // paused: still advance stage pointer below, status stays paused
      advanceAfterChapter(id, getJob(id));
    } else {
      db.prepare("UPDATE writing_jobs SET status = 'done', current_stage = 'done' WHERE id = ?").run(id);
      appendJobLog(id, "done", job.currentChapter, "完成");
    }
    // If user paused during stage, stay paused after advancing stage pointer.
    const latest = getJob(id);
    if (latest.status === "paused") return { job: latest, advanced: true };
    return { job: getJob(id), advanced: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务失败";
    const fresh = getJob(id);
    const retries = fresh.retryCount ?? 0;
    const max = fresh.maxRetries ?? 1;
    if (retries < max) {
      db.prepare(
        `UPDATE writing_jobs SET status = 'running', error = NULL, retry_count = ? WHERE id = ?`,
      ).run(retries + 1, id);
      appendJobLog(id, fresh.currentStage, fresh.currentChapter, `失败后自动重试 (${retries + 1}/${max})：${message}`);
      return { job: getJob(id), advanced: false, retried: true };
    }
    db.prepare("UPDATE writing_jobs SET status = 'error', error = ? WHERE id = ?").run(message, id);
    appendJobLog(id, fresh.currentStage, fresh.currentChapter, `失败：${message}`);
    return { job: getJob(id), advanced: false };
  }
}

