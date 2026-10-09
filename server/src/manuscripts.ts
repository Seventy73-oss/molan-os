import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir, db, type ChapterRow } from "./db";

export const booksRoot = path.join(dataDir, "books");

const KIND_FILE: Record<string, string> = {
  book_profile: "00-档案.md",
  book_outline: "00-全书大纲.md",
  chapter_outline: "细纲.md",
  chapter_body: "正文.md",
  review_report: "审核.md",
  chapter_memory: "记忆.md",
};

function mustBookTitle(id: string) {
  const row = db.prepare("SELECT title FROM books WHERE id = ?").get(id) as { title: string } | undefined;
  if (!row) throw new Error("没有这本书");
  return row.title;
}

export function sanitizeTitle(title: string): string {
  const cleaned = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 60);
  return cleaned || "未命名";
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function bookDir(bookId: string) {
  return path.join(booksRoot, bookId);
}

function chapterFolderName(number: number, title: string) {
  return `${pad(number)}-${sanitizeTitle(title)}`;
}

/** Find existing NN-* folder for this chapter number, or the destination name. */
function resolveChapterDir(bookId: string, number: number, title: string): string {
  const root = bookDir(bookId);
  fs.mkdirSync(root, { recursive: true });
  const wanted = chapterFolderName(number, title);
  const wantedPath = path.join(root, wanted);
  const prefix = `${pad(number)}-`;
  const matches = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
  if (matches.length === 1 && matches[0]!.name !== wanted) {
    const from = path.join(root, matches[0]!.name);
    if (!fs.existsSync(wantedPath)) {
      try {
        fs.renameSync(from, wantedPath);
      } catch {
        // If rename fails, keep writing into the existing folder.
        return from;
      }
      return wantedPath;
    }
  }
  fs.mkdirSync(wantedPath, { recursive: true });
  return wantedPath;
}

export function relativePathFor(kind: string, chapterNumber: number | null, chapterTitle?: string): string {
  if (kind === "book_profile") return KIND_FILE.book_profile!;
  if (kind === "book_outline") return KIND_FILE.book_outline!;
  const file = KIND_FILE[kind];
  if (!file || chapterNumber == null) throw new Error("不支持的稿件类型");
  const folder = chapterFolderName(chapterNumber, chapterTitle || `第${chapterNumber}章`);
  return path.join(folder, file);
}

function absolutePath(bookId: string, kind: string, chapterNumber: number | null, chapterTitle?: string) {
  if (kind === "book_profile" || kind === "book_outline") {
    return path.join(bookDir(bookId), KIND_FILE[kind]!);
  }
  if (chapterNumber == null) throw new Error("缺少章节");
  const chapters = db.prepare("SELECT * FROM chapters WHERE book_id = ? AND number = ?").get(bookId, chapterNumber) as
    | ChapterRow
    | undefined;
  const title = chapterTitle || chapters?.title || `第${chapterNumber}章`;
  const dir = resolveChapterDir(bookId, chapterNumber, title);
  return path.join(dir, KIND_FILE[kind]!);
}

export function writeArtifactFile(bookId: string, kind: string, chapterNumber: number | null, body: string) {
  const file = absolutePath(bookId, kind, chapterNumber);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body ?? "", "utf8");
  return file;
}

export function readArtifactFile(bookId: string, kind: string, chapterNumber: number | null): string {
  mustBookTitle(bookId);
  const file = absolutePath(bookId, kind, chapterNumber);
  if (!fs.existsSync(file)) throw new Error("磁盘上还没有这份稿件");
  return fs.readFileSync(file, "utf8");
}

type ArtifactRow = {
  kind: string;
  body: string | null;
  chapter_number: number | null;
  chapter_title: string | null;
};

/** Rewrite the whole book folder from the current DB state (DB wins). */
export function syncBook(bookId: string) {
  mustBookTitle(bookId);
  const root = bookDir(bookId);
  fs.mkdirSync(root, { recursive: true });
  const chapters = db
    .prepare("SELECT * FROM chapters WHERE book_id = ? ORDER BY number")
    .all(bookId) as ChapterRow[];
  for (const chapter of chapters) {
    resolveChapterDir(bookId, chapter.number, chapter.title);
    for (const kind of ["chapter_outline", "chapter_body", "review_report", "chapter_memory"] as const) {
      const file = path.join(resolveChapterDir(bookId, chapter.number, chapter.title), KIND_FILE[kind]!);
      if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
    }
  }
  const artifacts = db
    .prepare(
      `SELECT a.kind, r.body, c.number AS chapter_number, c.title AS chapter_title
         FROM artifacts a
         LEFT JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
        WHERE a.book_id = ?`,
    )
    .all(bookId) as ArtifactRow[];
  for (const artifact of artifacts) {
    if (!KIND_FILE[artifact.kind]) continue;
    writeArtifactFile(bookId, artifact.kind, artifact.chapter_number, artifact.body ?? "");
  }
  // Book-level stubs
  for (const kind of ["book_profile", "book_outline"] as const) {
    const file = path.join(root, KIND_FILE[kind]!);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
  }
  return root;
}

export function syncAllBooks() {
  const rows = db.prepare("SELECT id FROM books").all() as { id: string }[];
  for (const row of rows) {
    try {
      syncBook(row.id);
    } catch (error) {
      console.error(`sync book ${row.id} failed`, error);
    }
  }
}

export function deleteBookFiles(bookId: string) {
  const root = bookDir(bookId);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

/** Remove NN-* chapter folders so a subsequent syncBook can rewrite them from DB. */
export function wipeChapterDirs(bookId: string) {
  const root = bookDir(bookId);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d{2}-/.test(entry.name)) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
}

function zipDirectory(sourceDir: string, zipPath: string, prefix = "") {
  const script = `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
prefix = sys.argv[3]
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            arc = pathlib.Path(prefix) / path.relative_to(root) if prefix else path.relative_to(root)
            zf.write(path, arc.as_posix())
`;
  execFileSync("python3", ["-c", script, sourceDir, zipPath, prefix], { stdio: ["ignore", "pipe", "pipe"] });
}

export function exportBookZip(bookId: string): { filename: string; buffer: Buffer } {
  const title = sanitizeTitle(mustBookTitle(bookId));
  syncBook(bookId);
  const tmp = path.join(os.tmpdir(), `changjuan-${bookId}-${Date.now()}.zip`);
  zipDirectory(bookDir(bookId), tmp, title);
  const buffer = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return { filename: `${title}.zip`, buffer };
}

export function exportChapterZip(bookId: string, chapterNumber: number): { filename: string; buffer: Buffer } {
  mustBookTitle(bookId);
  syncBook(bookId);
  const chapter = db.prepare("SELECT * FROM chapters WHERE book_id = ? AND number = ?").get(bookId, chapterNumber) as
    | ChapterRow
    | undefined;
  if (!chapter) throw new Error(`没有第 ${chapterNumber} 章`);
  const dir = resolveChapterDir(bookId, chapter.number, chapter.title);
  const folder = path.basename(dir);
  const tmp = path.join(os.tmpdir(), `changjuan-${bookId}-ch${chapterNumber}-${Date.now()}.zip`);
  zipDirectory(dir, tmp, folder);
  const buffer = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return { filename: `${folder}.zip`, buffer };
}

export function exportChapterMarkdown(bookId: string, chapterNumber: number, kind = "chapter_body"): { filename: string; buffer: Buffer } {
  mustBookTitle(bookId);
  syncBook(bookId);
  const chapter = db.prepare("SELECT * FROM chapters WHERE book_id = ? AND number = ?").get(bookId, chapterNumber) as
    | ChapterRow
    | undefined;
  if (!chapter) throw new Error(`没有第 ${chapterNumber} 章`);
  const file = absolutePath(bookId, kind, chapterNumber, chapter.title);
  const body = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from("");
  const name = KIND_FILE[kind] ?? "正文.md";
  return { filename: `${pad(chapterNumber)}-${sanitizeTitle(chapter.title)}-${name}`, buffer: body };
}
