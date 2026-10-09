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

function unzipTo(zipPath: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("python3", [
    "-c",
    `
import pathlib, sys, zipfile
zf = zipfile.ZipFile(sys.argv[1])
dest = pathlib.Path(sys.argv[2])
dest.mkdir(parents=True, exist_ok=True)
for info in zf.infolist():
    name = info.filename.replace("\\\\", "/")
    if name.startswith("__MACOSX/") or name.endswith("/"):
        continue
    # strip zip-slip
    target = (dest / name).resolve()
    if not str(target).startswith(str(dest.resolve())):
        raise SystemExit("zip slip")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(zf.read(info))
`,
    zipPath,
    dest,
  ]);
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

  const fileMap: { file: string; kind: string }[] = [
    { file: "细纲.md", kind: "chapter_outline" },
    { file: "正文.md", kind: "chapter_body" },
    { file: "审核.md", kind: "review_report" },
    { file: "记忆.md", kind: "chapter_memory" },
  ];

  for (const ch of chapterDirs) {
    db.prepare("UPDATE chapters SET title = ? WHERE book_id = ? AND number = ?").run(ch.title, bookId, ch.number);
    for (const { file, kind } of fileMap) {
      const body = readIf(path.join(ch.dir, file));
      if (body == null) continue;
      if (!body.trim() && kind !== "chapter_body") continue;
      saveRevision({
        bookId,
        kind,
        chapterNumber: ch.number,
        body,
        source: "human",
        model: "import",
        skillIds: [],
        scene: kind === "chapter_body" ? "chapter_body" : kind === "chapter_outline" ? "chapter_outline" : kind === "review_report" ? "review" : "memory_extract",
      });
      imported.push({ kind, chapterNumber: ch.number, path: path.join(path.basename(ch.dir), file) });
    }
  }

  // Keep the resolved book title (custom or folder), don't let profile 书名 silently win.
  db.prepare(
    `UPDATE books SET title = ?, genre = COALESCE(NULLIF(?, ''), genre), logline = COALESCE(NULLIF(?, ''), logline), style = COALESCE(NULLIF(?, ''), style) WHERE id = ?`,
  ).run(title, genre, logline, style, bookId);

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
