import { db, type BookRow, type ChapterRow, type RouteRow } from "./db";
import { HttpError } from "./httpError";
export { HttpError } from "./httpError";
import { deleteBookFiles, syncBook, wipeChapterDirs } from "./manuscripts";
import { sceneKind, type SceneId } from "./agent/adapter";
import { getAdapter } from "./agent/runtime";
import { normalizeDialogueQuotes, rewriteSelectionLocal } from "./agent/localDraft";
import {
  formatBibleForContext,
  formatMemoriesForContext,
  bookProgress as computeBookProgress,
} from "./features";
import { formatOpenHooksForContext, formatOpenHooksForReview } from "./hooks";
import { estimateTokensFromText, recordUsage } from "./usage";
import { skillPromptMeta, skillsForScene, toSkillTexts } from "./skills";
import { normalizeThinking } from "./thinking";


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
  };
}

type ArtifactJoin = {
  id: string;
  kind: string;
  chapter_id: string | null;
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
      `SELECT a.id, a.kind, a.chapter_id, c.number AS chapter_number,
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
  const title = input.title.trim();
  if (!title) throw new HttpError(400, "要有书名");
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
  const title = input.title !== undefined ? input.title.trim() : book.title;
  if (!title) throw new HttpError(400, "要有书名");
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
    db.prepare("DELETE FROM api_usage WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM idempotency_keys WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM books WHERE id = ?").run(id);
  });
  tx();
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

export function saveRevision(input: {
  bookId: string;
  kind: string;
  chapterNumber: number | null;
  body: string;
  source: string;
  model: string | null;
  skillIds: string[];
  scene: string | null;
  skipMemory?: boolean;
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

  mustBook(input.bookId);
  const chapter = input.chapterNumber
    ? (db.prepare("SELECT * FROM chapters WHERE book_id = ? AND number = ?").get(input.bookId, input.chapterNumber) as
        | ChapterRow
        | undefined)
    : undefined;
  if (input.chapterNumber && !chapter) throw new HttpError(400, `没有第 ${input.chapterNumber} 章`);
  const chapterId = chapter?.id ?? null;
  const revision = db.transaction(() => {
    let artifact = db
      .prepare("SELECT id FROM artifacts WHERE book_id = ? AND kind = ? AND ifnull(chapter_id, '') = ifnull(?, '')")
      .get(input.bookId, input.kind, chapterId) as { id: string } | undefined;
    if (!artifact) {
      const id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO artifacts (id, book_id, chapter_id, kind, current_revision_id) VALUES (?, ?, ?, ?, NULL)",
      ).run(id, input.bookId, chapterId, input.kind);
      artifact = { id };
    }
    const prev = db
      .prepare("SELECT COALESCE(MAX(revision), 0) AS n FROM artifact_revisions WHERE artifact_id = ?")
      .get(artifact.id) as { n: number };
    const next = prev.n + 1;
    const revId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO artifact_revisions
        (id, artifact_id, revision, body, source, model, skill_ids, scene, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    db.prepare("UPDATE artifacts SET current_revision_id = ? WHERE id = ?").run(revId, artifact.id);
    if (chapterId && input.kind === "chapter_outline") {
      db.prepare("UPDATE chapters SET status = CASE WHEN status = 'empty' THEN 'outlined' ELSE status END WHERE id = ?").run(
        chapterId,
      );
    } else if (chapterId && input.kind === "chapter_body") {
      db.prepare(
        "UPDATE chapters SET status = CASE WHEN status = 'reviewed' THEN status ELSE 'drafted' END WHERE id = ?",
      ).run(chapterId);
    } else if (chapterId && input.kind === "review_report") {
      db.prepare("UPDATE chapters SET status = 'reviewed' WHERE id = ?").run(chapterId);
    }
    return next;
  })();
  applyDerived(input.bookId, input.kind, input.scene, input.body);
  try {
    syncBook(input.bookId);
  } catch (error) {
    console.error("manuscript sync failed", error);
  }
  if (
    input.kind === "chapter_body" &&
    input.chapterNumber &&
    input.body.trim() &&
    input.model !== "import" &&
    !(input as { skipMemory?: boolean }).skipMemory
  ) {
    scheduleMemoryExtract(input.bookId, input.chapterNumber);
  }
  return { kind: input.kind, revision, chapterNumber: input.chapterNumber };
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
export function scheduleMemoryExtract(bookId: string, chapterNumber: number) {
  const key = `${bookId}:${chapterNumber}`;
  if (memoryPromises.has(key)) return memoryPromises.get(key)!;
  memoryPending.add(key);
  const promise = new Promise<void>((resolve) => {
    setTimeout(() => {
      void (async () => {
        try {
          await executeScene({
            bookId,
            scene: "memory_extract",
            chapterNumber,
            instruction: "",
          });
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

export function buildContext(bookId: string, chapterNumber: number | null, instruction: string): string {
  const book = mustBook(bookId);
  const chapters = db
    .prepare("SELECT * FROM chapters WHERE book_id = ? ORDER BY number")
    .all(bookId) as ChapterRow[];
  const current = chapterNumber ? chapters.find((chapter) => chapter.number === chapterNumber) : undefined;
  const prev = chapterNumber && chapterNumber > 1 ? artifactBody(bookId, "chapter_body", chapterNumber - 1) : "";
  const tail = Array.from(prev).slice(-800).join("");
  const memories = formatMemoriesForContext(bookId, chapterNumber);
  const bible = formatBibleForContext(bookId);
  const openHooks = formatOpenHooksForContext(bookId, chapterNumber);
  const reviewHooks =
    /* review scene gets extra injection via instruction in executeScene */ "";
  void reviewHooks;
  return [
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
  const skills = skillsForScene(input.scene, input.skillIds);
  const skillTexts = toSkillTexts(skills);
  let instruction = input.instruction?.trim() ?? "";
  if (input.scene === "review" && chapterNumber) {
    const hookBlock = formatOpenHooksForReview(input.bookId, chapterNumber);
    if (hookBlock) instruction = [instruction, hookBlock].filter(Boolean).join("\n\n");
  }
  const context = buildContext(input.bookId, chapterNumber, instruction);
  const route = routeFor(input.scene);
  const result = await getAdapter(route).runScene({
    scene: input.scene,
    model: route.model_id,
    thinkingIntensity: normalizeThinking(route.thinking_intensity),
    skillTexts,
    context,
    instruction,
  });
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
  const saved = kind
    ? saveRevision({
        bookId: input.bookId,
        kind,
        chapterNumber: kind === "book_profile" || kind === "book_outline" ? null : chapterNumber,
        body: result.text,
        source: "agent",
        model: result.modelUsed,
        skillIds: skills.map((skill) => skill.id),
        scene: input.scene,
      })
    : null;
  return {
    text: result.text,
    modelUsed: result.modelUsed,
    skills: skills.map((skill) => ({ id: skill.id, name: skill.name, role: skill.role })),
    skillPromptMeta: skillPromptMeta(skillTexts),
    saved,
  };
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
  if (modelUsed.startsWith("local-draft")) return "本地草稿引擎（远端模型失败，已回退）";
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

/** Exported for smoke tests — keep intents narrow (no bare 写/生成 → 正文). */
export function routeMessage(message: string): SceneId | null {
  // A question ("这一章写得怎样？") must not be treated as a write command,
  // unless it actually names a document to produce.
  const asks = /[？?]\s*$/.test(message);
  const ordersDraft =
    /(写|生成|重写|续写|起草|扩写).{0,16}(大纲|细纲|正文|档案|设定|审核)|(大纲|细纲|正文|档案|设定).{0,10}(写|生成|重写|续写|起草|扩写)/.test(
      message,
    );
  // Avoid「这一章写得怎样？」— require imperative write, not 写得/写的.
  const chapterWrite =
    /(写|生成|重写|续写|起草|扩写)\s*(一?下)?\s*(这一章|本章|这章)/.test(message) ||
    /(这一章|本章|这章).{0,8}(写出来|写完|重写|生成|续写|起草|扩写)/.test(message);
  if (asks && !ordersDraft && !chapterWrite && !/去\s*AI|润色|审核/.test(message)) return null;

  if (/去\s*AI|润色/.test(message)) return "humanize";
  if (message.includes("审核")) return "review";
  if (/建书|新建一本|建一本/.test(message) || (/(档案|设定)/.test(message) && (ordersDraft || !asks))) {
    return "book_setup";
  }
  if (message.includes("细纲") && (ordersDraft || !asks)) return "chapter_outline";
  // 「写全书大纲」— check 大纲 before 正文.
  if (message.includes("大纲") && (ordersDraft || !asks)) return "outline";
  if (message.includes("正文") && (ordersDraft || chapterWrite || !asks)) return "chapter_body";
  // 「写这一章 / 写本章」走正文；不再把裸「写/生成」当成写正文。
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
  const skillRows = skillsForScene("humanize");
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
      context: `【待改片段】\n${selection}\n`,
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
    return { text, modelUsed: result.modelUsed, local, ...skillInfo };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const reason = error instanceof Error ? error.message : "未知错误";
    throw new HttpError(502, `选区改写失败：${reason}`);
  }
}

export async function chat(bookId: string, message: string, preferredChapter?: number | null) {
  const book = mustBook(bookId);
  const text = message.trim();
  if (!text) throw new HttpError(400, "要说一句");
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
      const context = buildContext(bookId, null, text);
      const result = await getAdapter(route).runScene({
        scene: chatScene,
        model: route.model_id,
        thinkingIntensity: normalizeThinking(route.thinking_intensity),
        skillTexts,
        context,
        instruction: text,
      });
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
    const result = await executeScene({ bookId, scene, chapterNumber, instruction: text });
    const label = result.saved ? KIND_LABEL[result.saved.kind] ?? "稿件" : "稿件";
    const where = result.saved?.chapterNumber ? `第 ${result.saved.chapterNumber} 章` : "";
    const content = `已写入${where}${label}，修订 ${result.saved?.revision ?? 1}。用的是${modelLabel(result.modelUsed)}。\n${replyBody(result.text)}`;
    const meta = {
      scene,
      modelUsed: result.modelUsed,
      saved: result.saved,
      skills: result.skills,
      skillPromptMeta: result.skillPromptMeta,
    };
    const assistant = insertMessage(bookId, "assistant", content, meta);
    return { message: assistant, saved: result.saved, skills: result.skills, skillPromptMeta: result.skillPromptMeta };
  } catch (error) {
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

export function setJobStatus(id: string, status: string) {
  if (!["paused", "running", "done"].includes(status)) throw new HttpError(400, "状态只能是 paused、running 或 done");
  getJob(id);
  db.prepare("UPDATE writing_jobs SET status = ?, error = CASE WHEN ? = 'running' THEN NULL ELSE error END WHERE id = ?").run(
    status,
    status,
    id,
  );
  appendJobLog(id, getJob(id).currentStage, getJob(id).currentChapter, status === "paused" ? "已暂停" : status === "running" ? "继续运行" : "标记完成");
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

export async function tickJob(id: string) {
  const job = getJob(id);
  if (job.status === "paused" || job.status === "done") return { job, advanced: false };
  try {
    if (job.currentStage === "outline") {
      const existing = artifactBody(job.bookId, "book_outline", null);
      if (!existing.trim()) {
        await executeScene({ bookId: job.bookId, scene: "outline", chapterNumber: null, instruction: "按档案写全书大纲" });
        appendJobLog(id, "outline", job.currentChapter, "已生成全书大纲");
      } else {
        appendJobLog(id, "outline", job.currentChapter, "已有全书大纲，跳过");
      }
      db.prepare("UPDATE writing_jobs SET current_stage = 'chapter_outline', current_chapter = ?, status = 'running', error = NULL WHERE id = ?").run(
        job.fromChapter,
        id,
      );
    } else if (job.currentStage === "chapter_outline") {
      await executeScene({
        bookId: job.bookId,
        scene: "chapter_outline",
        chapterNumber: job.currentChapter,
        instruction: `写第 ${job.currentChapter} 章细纲`,
      });
      appendJobLog(id, "chapter_outline", job.currentChapter, `第 ${job.currentChapter} 章细纲完成`);
      db.prepare("UPDATE writing_jobs SET current_stage = 'chapter_body', error = NULL WHERE id = ?").run(id);
    } else if (job.currentStage === "chapter_body") {
      await executeScene({
        bookId: job.bookId,
        scene: "chapter_body",
        chapterNumber: job.currentChapter,
        instruction: `写第 ${job.currentChapter} 章正文`,
      });
      appendJobLog(id, "chapter_body", job.currentChapter, `第 ${job.currentChapter} 章正文完成`);
      db.prepare("UPDATE writing_jobs SET current_stage = 'memory', error = NULL WHERE id = ?").run(id);
    } else if (job.currentStage === "memory") {
      const ok = await waitMemoryExtract(job.bookId, job.currentChapter, 40_000);
      appendJobLog(
        id,
        "memory",
        job.currentChapter,
        ok ? `第 ${job.currentChapter} 章记忆已抽取` : `第 ${job.currentChapter} 章记忆等待超时，继续`,
      );
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
      });
      appendJobLog(id, "review", job.currentChapter, `第 ${job.currentChapter} 章审核完成`);
      advanceAfterChapter(id, getJob(id));
    } else {
      db.prepare("UPDATE writing_jobs SET status = 'done', current_stage = 'done' WHERE id = ?").run(id);
      appendJobLog(id, "done", job.currentChapter, "完成");
    }
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

