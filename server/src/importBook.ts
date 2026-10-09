import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db";
import { HttpError } from "./httpError";
import { createBook, getBookPayload, saveRevision } from "./engine";
import { booksRoot, sanitizeTitle, syncBook } from "./manuscripts";

export type ImportConflict = "new_book" | "overwrite" | "skip";

export type ImportResult = {
  bookId: string;
  title: string;
  conflict: ImportConflict;
  reused: boolean;
  skipped: boolean;
  imported: { kind: string; chapterNumber: number | null; path: string }[];
  chapters: number;
};

const IMPORT_LIMITS = {
  maxEntries: Number(process.env.MOLAN_IMPORT_MAX_ENTRIES || 4000),
  maxTotalBytes: Number(process.env.MOLAN_IMPORT_MAX_TOTAL_BYTES || 80 * 1024 * 1024),
  maxFileBytes: Number(process.env.MOLAN_IMPORT_MAX_FILE_BYTES || 8 * 1024 * 1024),
  maxRatio: Number(process.env.MOLAN_IMPORT_MAX_RATIO || 200),
  timeoutMs: Number(process.env.MOLAN_IMPORT_TIMEOUT_MS || 60_000),
};

function unzipTo(zipPath: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync(
    "python3",
    [
      "-c",
      `
import pathlib, sys, zipfile, stat
zf = zipfile.ZipFile(sys.argv[1])
dest = pathlib.Path(sys.argv[2]).resolve()
dest.mkdir(parents=True, exist_ok=True)
max_entries = int(sys.argv[3])
max_total = int(sys.argv[4])
max_file = int(sys.argv[5])
max_ratio = float(sys.argv[6])
entries = 0
total = 0
compressed_total = 0
for info in zf.infolist():
    name = info.filename.replace("\\\\", "/")
    if not name or name.startswith("__MACOSX/") or name.endswith("/"):
        continue
    if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        raise SystemExit("zip absolute path refused")
    if ".." in pathlib.PurePosixPath(name).parts:
        raise SystemExit("zip slip")
    is_symlink = ((info.external_attr >> 16) & stat.S_IFLNK) == stat.S_IFLNK
    if is_symlink:
        raise SystemExit("zip symlink refused")
    target = (dest / name).resolve()
    try:
        target.relative_to(dest)
    except ValueError:
        raise SystemExit("zip slip")
    entries += 1
    if entries > max_entries:
        raise SystemExit("zip too many entries")
    data = zf.read(info)
    if len(data) > max_file:
        raise SystemExit("zip file too large")
    total += len(data)
    compressed_total += max(info.compress_size, 1)
    if total > max_total:
        raise SystemExit("zip uncompressed too large")
    if compressed_total > 0 and (total / compressed_total) > max_ratio:
        raise SystemExit("zip bomb ratio")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
`,
      zipPath,
      dest,
      String(IMPORT_LIMITS.maxEntries),
      String(IMPORT_LIMITS.maxTotalBytes),
      String(IMPORT_LIMITS.maxFileBytes),
      String(IMPORT_LIMITS.maxRatio),
    ],
    { timeout: IMPORT_LIMITS.timeoutMs },
  );
}

function findBookRoot(extracted: string): string {
  const entries = fs.readdirSync(extracted, { withFileTypes: true });
  // If single top folder, descend
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  const files = entries.filter((e) => e.isFile());
  if (dirs.length === 1 && files.length === 0) {
    return path.join(extracted, dirs[0]!.name);
  }
  return extracted;
}

function readIf(file: string): string | null {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return fs.readFileSync(file, "utf8");
}

function parseChapterDirs(root: string): { number: number; title: string; dir: string }[] {
  const out: { number: number; title: string; dir: string }[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = entry.name.match(/^(\d{1,3})-(.+)$/);
    if (!m) continue;
    out.push({ number: Number(m[1]), title: m[2]!.trim() || `第${Number(m[1])}章`, dir: path.join(root, entry.name) });
  }
  return out.sort((a, b) => a.number - b.number);
}

function fieldOf(text: string, label: string): string {
  return text.match(new RegExp(`^${label}：(.+)$`, "m"))?.[1]?.trim() ?? "";
}

function findBookByTitle(title: string): string | null {
  const row = db.prepare("SELECT id FROM books WHERE title = ? ORDER BY created_at DESC LIMIT 1").get(title) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

function wipeBookContent(bookId: string) {
  const artifacts = db.prepare("SELECT id FROM artifacts WHERE book_id = ?").all(bookId) as { id: string }[];
  const dropRev = db.prepare("DELETE FROM artifact_revisions WHERE artifact_id = ?");
  for (const a of artifacts) dropRev.run(a.id);
  db.prepare("DELETE FROM artifacts WHERE book_id = ?").run(bookId);
  db.prepare("DELETE FROM chapters WHERE book_id = ?").run(bookId);
  db.prepare("DELETE FROM messages WHERE book_id = ?").run(bookId);
  db.prepare("DELETE FROM bible_cards WHERE book_id = ?").run(bookId);
  db.prepare("DELETE FROM hook_marks WHERE book_id = ?").run(bookId);
}

/**
 * Import a zip (or already-extracted folder) of molan/墨兰写作 markdown layout into a book.
 * Layout: optional book folder containing 00-档案.md / 00-全书大纲.md / NN-章名/{细纲,正文,审核,记忆}.md
 */
export function importBookFromZipBuffer(
  buffer: Buffer,
  opts: { conflict?: ImportConflict; title?: string; filename?: string } = {},
): ImportResult {
  const conflict: ImportConflict = opts.conflict ?? "new_book";
  const tmpZip = path.join(os.tmpdir(), `molan-import-${Date.now()}.zip`);
  const tmpDir = path.join(os.tmpdir(), `molan-import-dir-${Date.now()}`);
  fs.writeFileSync(tmpZip, buffer);
  try {
    unzipTo(tmpZip, tmpDir);
    return importBookFromFolder(findBookRoot(tmpDir), { ...opts, conflict });
  } finally {
    try {
      fs.unlinkSync(tmpZip);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function importBookFromFolder(
  folder: string,
  opts: { conflict?: ImportConflict; title?: string } = {},
): ImportResult {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new HttpError(400, "导入目录无效");
  }
  const conflict: ImportConflict = opts.conflict ?? "new_book";
  const profile = readIf(path.join(folder, "00-档案.md")) ?? "";
  const outline = readIf(path.join(folder, "00-全书大纲.md")) ?? "";
  const chapterDirs = parseChapterDirs(folder);
  const folderName = sanitizeTitle(path.basename(folder));
  const title =
    opts.title?.trim() ||
    fieldOf(profile, "书名") ||
    folderName ||
    "导入书稿";
  const genre = fieldOf(profile, "题材");
  const logline = fieldOf(profile, "简介");
  const style = fieldOf(profile, "文风");
  const targetFromProfile = Number(fieldOf(profile, "目标章数"));
  const wordsFromProfile = Number(fieldOf(profile, "每章字数"));
  const chapterCount = Math.max(chapterDirs.length, Number.isFinite(targetFromProfile) ? targetFromProfile : 0, 1);
  if (chapterDirs.length > 500) throw new HttpError(400, "章节过多，拒绝导入");
  const seenNums = new Set<number>();
  for (const ch of chapterDirs) {
    if (!Number.isFinite(ch.number) || ch.number < 1) throw new HttpError(400, `非法章号：${ch.number}`);
    if (seenNums.has(ch.number)) throw new HttpError(400, `重复章号：${ch.number}`);
    seenNums.add(ch.number);
  }

  // Validate & preload all chapter files BEFORE any DB wipe (fail closed).
  const preloaded: { number: number; title: string; files: { kind: string; body: string; path: string }[] }[] = [];
  for (const ch of chapterDirs) {
    const files: { kind: string; body: string; path: string }[] = [];
    for (const { file, kind } of [
      { file: "细纲.md", kind: "chapter_outline" },
      { file: "正文.md", kind: "chapter_body" },
      { file: "审核.md", kind: "review_report" },
      { file: "记忆.md", kind: "chapter_memory" },
    ] as const) {
      const body = readIf(path.join(ch.dir, file));
      if (body == null) continue;
      if (!body.trim() && kind !== "chapter_body") continue;
      files.push({ kind, body, path: path.join(path.basename(ch.dir), file) });
    }
    preloaded.push({ number: ch.number, title: ch.title, files });
  }

  const existingId = findBookByTitle(title);
  if (existingId && conflict === "skip") {
    return {
      bookId: existingId,
      title,
      conflict,
      reused: true,
      skipped: true,
      imported: [],
      chapters: (db.prepare("SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?").get(existingId) as { n: number }).n,
    };
  }

  let bookId: string;
  let reused = false;
  if (existingId && conflict === "overwrite") {
    bookId = existingId;
    reused = true;
    db.prepare(
      `UPDATE writing_jobs SET status = 'cancelled', error = COALESCE(error, '导入覆盖前取消') WHERE book_id = ? AND status IN ('running', 'paused', 'error')`,
    ).run(bookId);
    wipeBookContent(bookId);
    db.prepare(
      `UPDATE books SET title = ?, genre = ?, logline = ?, style = ?, target_chapters = ?, words_per_chapter = ? WHERE id = ?`,
    ).run(
      title,
      genre || (db.prepare("SELECT genre FROM books WHERE id = ?").get(bookId) as { genre: string }).genre,
      logline || (db.prepare("SELECT logline FROM books WHERE id = ?").get(bookId) as { logline: string }).logline,
      style || (db.prepare("SELECT style FROM books WHERE id = ?").get(bookId) as { style: string }).style,
      chapterCount,
      Number.isFinite(wordsFromProfile) && wordsFromProfile > 0 ? wordsFromProfile : 2000,
      bookId,
    );
    const insert = db.prepare(
      "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?, ?, ?, ?, 'empty')",
    );
    for (let i = 1; i <= chapterCount; i++) {
      const hit = chapterDirs.find((c) => c.number === i);
      insert.run(crypto.randomUUID(), bookId, i, hit?.title || `第${i}章`);
    }
  } else {
    // new_book — if title collision, append suffix
    let finalTitle = title;
    if (existingId && conflict === "new_book") {
      finalTitle = `${title}（导入 ${new Date().toLocaleString("zh-CN", { hour12: false })}）`;
    }
    const titles = Array.from({ length: chapterCount }, (_, i) => {
      const hit = chapterDirs.find((c) => c.number === i + 1);
      return hit?.title || `第${i + 1}章`;
    });
    const created = createBook({
      title: finalTitle,
      genre,
      logline,
      style,
      targetChapters: chapterCount,
      wordsPerChapter: Number.isFinite(wordsFromProfile) && wordsFromProfile > 0 ? wordsFromProfile : 2000,
    });
    bookId = created.payload.book.id;
    // retitle chapters precisely
    for (const [index, t] of titles.entries()) {
      db.prepare("UPDATE chapters SET title = ? WHERE book_id = ? AND number = ?").run(t, bookId, index + 1);
    }
  }

  const imported: ImportResult["imported"] = [];

  if (profile.trim()) {
    saveRevision({
      bookId,
      kind: "book_profile",
      chapterNumber: null,
      body: profile,
      source: "human",
      model: "import",
      skillIds: [],
      scene: "topic",
    });
    imported.push({ kind: "book_profile", chapterNumber: null, path: "00-档案.md" });
  }
  if (outline.trim()) {
    saveRevision({
      bookId,
      kind: "book_outline",
      chapterNumber: null,
      body: outline,
      source: "human",
      model: "import",
      skillIds: [],
      scene: "outline",
    });
    imported.push({ kind: "book_outline", chapterNumber: null, path: "00-全书大纲.md" });
  }

  for (const ch of preloaded) {
    db.prepare("UPDATE chapters SET title = ? WHERE book_id = ? AND number = ?").run(ch.title, bookId, ch.number);
    for (const file of ch.files) {
      saveRevision({
        bookId,
        kind: file.kind,
        chapterNumber: ch.number,
        body: file.body,
        source: "human",
        model: "import",
        skillIds: [],
        scene:
          file.kind === "chapter_body"
            ? "chapter_body"
            : file.kind === "chapter_outline"
              ? "chapter_outline"
              : file.kind === "review_report"
                ? "review"
                : "memory_extract",
        skipMemory: true,
      });
      imported.push({ kind: file.kind, chapterNumber: ch.number, path: file.path });
    }
  }

  // Keep resolved title (incl. new_book disambiguation suffix); don't let raw profile 书名 wipe it.
  const resolvedTitle =
    (db.prepare("SELECT title FROM books WHERE id = ?").get(bookId) as { title: string } | undefined)?.title || title;
  db.prepare(
    `UPDATE books SET title = ?, genre = COALESCE(NULLIF(?, ''), genre), logline = COALESCE(NULLIF(?, ''), logline), style = COALESCE(NULLIF(?, ''), style) WHERE id = ?`,
  ).run(resolvedTitle, genre, logline, style, bookId);

  try {
    syncBook(bookId);
  } catch (error) {
    console.error("import sync failed", error);
  }

  const payload = getBookPayload(bookId);
  return {
    bookId,
    title: payload.book.title,
    conflict,
    reused,
    skipped: false,
    imported,
    chapters: payload.chapters.length,
  };
}

/** Keep booksRoot referenced for typecheck / future disk import. */
export function booksRootPath() {
  return booksRoot;
}
