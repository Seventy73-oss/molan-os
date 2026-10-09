import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { dataDir, db, replaceSqliteFromPhysicalBackup } from "./db";
import { sqliteSchema } from "./db/schema";
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

type BookSnapshot = {
  book: Record<string, unknown>;
  chapters: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  revisions: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  bible: Record<string, unknown>[];
  hooks: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
};

/** Durable import-recovery dir: survives process kill between wipe and restore. */
export function importRecoveryDir() {
  return path.join(dataDir, "import-recovery");
}


function recoveryFile(bookId: string) {
  return path.join(importRecoveryDir(), `${bookId}.json`);
}

/**
 * Per-book physical backup path (isolated SQLite dump of one book only).
 * Does NOT copy the whole shared DB — restore cannot nuke other books.
 * Documented in docs/STORAGE_LEASE.md
 */
export function physicalBackupDbPath(bookId: string) {
  return path.join(importRecoveryDir(), `${bookId}.book.phys.sqlite`);
}

function physicalPendingMarker(bookId: string) {
  return path.join(importRecoveryDir(), `${bookId}.book.phys.pending`);
}

/** Legacy whole-DB paths (phase9); still recovered if present. */
function legacyWholeDbPhysPath(bookId: string) {
  return path.join(importRecoveryDir(), `${bookId}.sqlite.phys`);
}
function legacyWholeDbPending(bookId: string) {
  return path.join(importRecoveryDir(), `${bookId}.phys.pending`);
}

function insertRows(dump: InstanceType<typeof Database>, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]!);
  const stmt = dump.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  );
  const tx = dump.transaction((batch: Record<string, unknown>[]) => {
    for (const row of batch) stmt.run(...cols.map((c) => row[c] as string | number | null | bigint));
  });
  tx(rows);
}

/**
 * Write a per-book SQLite dump (physical isolation) before overwrite wipe.
 * Works on any driver: reads via snapshotBook from live DbClient.
 * Returns dump path or null if book missing.
 */
export function writePhysicalSqliteBackup(bookId: string): string | null {
  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId) as { id: string } | undefined;
  if (!book) return null;
  const snap = snapshotBook(bookId);
  const dir = importRecoveryDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = physicalBackupDbPath(bookId);
  try {
    fs.unlinkSync(dest);
  } catch {
    /* ignore */
  }
  const dump = new Database(dest);
  try {
    dump.exec(sqliteSchema());
    // Ensure lease columns exist on writing_jobs in dump schema baseline
    try {
      dump.exec("ALTER TABLE writing_jobs ADD COLUMN lease_owner TEXT");
    } catch {
      /* ignore */
    }
    try {
      dump.exec("ALTER TABLE writing_jobs ADD COLUMN lease_until TEXT");
    } catch {
      /* ignore */
    }
    try {
      dump.exec("ALTER TABLE artifact_revisions ADD COLUMN source_revision_id TEXT");
    } catch {
      /* ignore */
    }
    insertRows(dump, "books", [snap.book]);
    insertRows(dump, "chapters", snap.chapters);
    insertRows(dump, "artifacts", snap.artifacts.map((a) => ({ ...a, current_revision_id: null })));
    insertRows(dump, "artifact_revisions", snap.revisions);
    for (const a of snap.artifacts) {
      if (a.current_revision_id) {
        dump.prepare("UPDATE artifacts SET current_revision_id = ? WHERE id = ?").run(a.current_revision_id, a.id);
      }
    }
    insertRows(dump, "messages", snap.messages);
    insertRows(dump, "bible_cards", snap.bible);
    insertRows(dump, "hook_marks", snap.hooks);
    insertRows(dump, "writing_jobs", snap.jobs);
    dump.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    dump.close();
  }
  fs.writeFileSync(
    physicalPendingMarker(bookId),
    JSON.stringify({
      bookId,
      dest,
      kind: "per-book",
      at: new Date().toISOString(),
    }),
    "utf8",
  );
  return dest;
}

export function clearPhysicalSqliteBackup(bookId: string) {
  const dest = physicalBackupDbPath(bookId);
  for (const p of [
    dest,
    physicalPendingMarker(bookId),
    legacyWholeDbPhysPath(bookId),
    `${legacyWholeDbPhysPath(bookId)}-wal`,
    `${legacyWholeDbPhysPath(bookId)}-shm`,
    legacyWholeDbPending(bookId),
  ]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

export function hasPhysicalSqliteBackup(bookId: string): boolean {
  return fs.existsSync(physicalBackupDbPath(bookId)) || fs.existsSync(legacyWholeDbPhysPath(bookId));
}

/** Read per-book dump back into a BookSnapshot. */
function readPerBookPhysSnapshot(bookId: string, dumpPath: string): BookSnapshot {
  const dump = new Database(dumpPath, { readonly: true });
  try {
    const book = dump.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as Record<string, unknown>;
    if (!book?.id) throw new Error(`per-book dump missing book ${bookId}`);
    const chapters = dump.prepare("SELECT * FROM chapters WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
    const artifacts = dump.prepare("SELECT * FROM artifacts WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
    const artIds = artifacts.map((a) => String(a.id));
    let revisions: Record<string, unknown>[] = [];
    if (artIds.length) {
      const placeholders = artIds.map(() => "?").join(",");
      revisions = dump
        .prepare(`SELECT * FROM artifact_revisions WHERE artifact_id IN (${placeholders})`)
        .all(...artIds) as Record<string, unknown>[];
    }
    const messages = dump.prepare("SELECT * FROM messages WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
    const bible = dump.prepare("SELECT * FROM bible_cards WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
    const hooks = dump.prepare("SELECT * FROM hook_marks WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
    const jobs = dump.prepare("SELECT * FROM writing_jobs WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
    return { book, chapters, artifacts, revisions, messages, bible, hooks, jobs };
  } finally {
    dump.close();
  }
}


/**
 * Write snapshot to disk with temp+rename so a crash mid-write leaves no partial final file.
 * Call BEFORE wipeBookContent on overwrite import.
 */
function writeDurableSnapshot(snap: BookSnapshot) {
  const dir = importRecoveryDir();
  fs.mkdirSync(dir, { recursive: true });
  const bookId = String(snap.book.id);
  const finalPath = recoveryFile(bookId);
  const tmpPath = path.join(dir, `.${bookId}.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(snap);
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, payload, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* some FS (e.g. certain tmpfs) may not support fsync; rename still best-effort */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
}

function clearDurableSnapshot(bookId: string) {
  try {
    fs.unlinkSync(recoveryFile(bookId));
  } catch {
    /* missing is fine */
  }
}

function isValidSnapshot(snap: unknown, expectBookId?: string): snap is BookSnapshot {
  if (!snap || typeof snap !== "object") return false;
  const s = snap as Record<string, unknown>;
  const book = s.book as Record<string, unknown> | undefined;
  if (!book || typeof book !== "object" || typeof book.id !== "string" || !book.id) return false;
  if (expectBookId && book.id !== expectBookId) return false;
  for (const key of ["chapters", "artifacts", "revisions", "messages", "bible", "hooks", "jobs"] as const) {
    if (!Array.isArray(s[key])) return false;
  }
  return true;
}

function quarantineCorrupt(bookId: string, reason: string) {
  const file = recoveryFile(bookId);
  if (!fs.existsSync(file)) return;
  const qdir = path.join(importRecoveryDir(), "corrupt");
  fs.mkdirSync(qdir, { recursive: true });
  const dest = path.join(qdir, `${bookId}.${Date.now()}.json`);
  try {
    fs.renameSync(file, dest);
    console.error(`[import] quarantined corrupt recovery ${bookId} → ${dest} (${reason})`);
  } catch (error) {
    console.error(`[import] failed to quarantine ${bookId}`, error);
  }
}

function cleanupOrphanTmpFiles() {
  const dir = importRecoveryDir();
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      n += 1;
    } catch {
      /* ignore */
    }
  }
  return n;
}

function readDurableSnapshot(bookId: string): BookSnapshot | null {
  const file = recoveryFile(bookId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isValidSnapshot(parsed, bookId)) {
      quarantineCorrupt(bookId, "schema/id mismatch");
      return null;
    }
    return parsed;
  } catch (error) {
    console.error("[import] corrupt recovery snapshot", bookId, error);
    quarantineCorrupt(bookId, error instanceof Error ? error.message : "parse error");
    return null;
  }
}

/**
 * On startup: if an overwrite-import left a recovery file, restore DB+md from it.
 * Manual recovery: copy `data/import-recovery/<bookId>.json` aside, then call this or restore via test helper.
 */
export function recoverInterruptedImports(): {
  restored: string[];
  skipped: string[];
  cleanedTmp: number;
  physicalRestored: string[];
} {
  const dir = importRecoveryDir();
  const restored: string[] = [];
  const skipped: string[] = [];
  const physicalRestored: string[] = [];
  const cleanedTmp = cleanupOrphanTmpFiles();
  if (!fs.existsSync(dir)) return { restored, skipped, cleanedTmp, physicalRestored };
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    // Skip nested corrupt/ directory entries (readdir is not recursive, but be explicit).
    if (name === "corrupt") continue;
    const bookId = name.slice(0, -".json".length);
    const snap = readDurableSnapshot(bookId);
    if (!snap?.book?.id) {
      skipped.push(bookId);
      continue;
    }
    try {
      restoreBookSnapshot(snap);
      clearDurableSnapshot(bookId);
      clearPhysicalSqliteBackup(bookId);
      restored.push(bookId);
      console.warn(`[import] recovered interrupted overwrite import for book ${bookId}`);
    } catch (error) {
      console.error(`[import] recovery failed for ${bookId}; file kept at ${recoveryFile(bookId)}`, error);
      skipped.push(bookId);
    }
  }
  return { restored, skipped, cleanedTmp, physicalRestored };
}

/**
 * After logical JSON recovery (or when JSON is missing), restore from physical backup.
 * Preferred: per-book `.book.phys.sqlite` → restoreBookSnapshot (other books untouched).
 * Legacy: whole-DB `.sqlite.phys` → replaceSqliteFromPhysicalBackup (affects entire DB).
 */
export async function recoverPhysicalImportBackups(): Promise<{ restored: string[]; skipped: string[] }> {
  const dir = importRecoveryDir();
  const restored: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(dir)) return { restored, skipped };

  const pendingIds = new Set<string>();
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".book.phys.pending")) {
      pendingIds.add(name.slice(0, -".book.phys.pending".length));
    } else if (name.endsWith(".phys.pending") && !name.endsWith(".book.phys.pending")) {
      pendingIds.add(name.slice(0, -".phys.pending".length));
    }
  }

  for (const bookId of pendingIds) {
    if (fs.existsSync(recoveryFile(bookId))) {
      skipped.push(bookId);
      continue;
    }
    const perBook = physicalBackupDbPath(bookId);
    const legacy = legacyWholeDbPhysPath(bookId);
    try {
      if (fs.existsSync(perBook)) {
        const snap = readPerBookPhysSnapshot(bookId, perBook);
        // Ensure book row exists (overwrite may have wiped content but kept id, or crash mid-way).
        const exists = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId) as { id: string } | undefined;
        if (!exists) {
          db.prepare(
            `INSERT INTO books (id, title, genre, logline, style, target_chapters, words_per_chapter, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            snap.book.id,
            snap.book.title,
            snap.book.genre,
            snap.book.logline,
            snap.book.style,
            snap.book.target_chapters,
            snap.book.words_per_chapter,
            snap.book.created_at,
          );
        }
        restoreBookSnapshot(snap);
        clearPhysicalSqliteBackup(bookId);
        restored.push(bookId);
        console.warn(`[import] recovered per-book physical dump for ${bookId} (other books untouched)`);
      } else if (fs.existsSync(legacy)) {
        await replaceSqliteFromPhysicalBackup(legacy);
        clearPhysicalSqliteBackup(bookId);
        restored.push(bookId);
        console.warn(
          `[import] recovered LEGACY whole-DB physical backup for ${bookId} (affects entire SQLite file)`,
        );
      } else {
        try {
          fs.unlinkSync(physicalPendingMarker(bookId));
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(legacyWholeDbPending(bookId));
        } catch {
          /* ignore */
        }
        skipped.push(bookId);
      }
    } catch (error) {
      console.error(`[import] physical recovery failed for ${bookId}`, error);
      skipped.push(bookId);
    }
  }
  return { restored, skipped };
}

function snapshotBook(bookId: string): BookSnapshot {
  const book = db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as Record<string, unknown>;
  const chapters = db.prepare("SELECT * FROM chapters WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
  const artifacts = db.prepare("SELECT * FROM artifacts WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
  const artIds = artifacts.map((a) => String(a.id));
  const revisions: Record<string, unknown>[] = [];
  if (artIds.length) {
    const placeholders = artIds.map(() => "?").join(",");
    revisions.push(
      ...(db.prepare(`SELECT * FROM artifact_revisions WHERE artifact_id IN (${placeholders})`).all(...artIds) as Record<
        string,
        unknown
      >[]),
    );
  }
  const messages = db.prepare("SELECT * FROM messages WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
  const bible = db.prepare("SELECT * FROM bible_cards WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
  const hooks = db.prepare("SELECT * FROM hook_marks WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
  const jobs = db.prepare("SELECT * FROM writing_jobs WHERE book_id = ?").all(bookId) as Record<string, unknown>[];
  return { book, chapters, artifacts, revisions, messages, bible, hooks, jobs };
}

function restoreBookSnapshot(snap: BookSnapshot) {
  const bookId = String(snap.book.id);
  db.transaction(() => {
    wipeBookContent(bookId);
    db.prepare("DELETE FROM writing_jobs WHERE book_id = ?").run(bookId);
    // restore book row fields
    db.prepare(
      `UPDATE books SET title = ?, genre = ?, logline = ?, style = ?, target_chapters = ?, words_per_chapter = ? WHERE id = ?`,
    ).run(
      snap.book.title,
      snap.book.genre,
      snap.book.logline,
      snap.book.style,
      snap.book.target_chapters,
      snap.book.words_per_chapter,
      bookId,
    );
    const insCh = db.prepare(
      "INSERT INTO chapters (id, book_id, number, title, status) VALUES (?, ?, ?, ?, ?)",
    );
    for (const ch of snap.chapters) {
      insCh.run(ch.id, ch.book_id, ch.number, ch.title, ch.status);
    }
    const insArt = db.prepare(
      "INSERT INTO artifacts (id, book_id, chapter_id, kind, current_revision_id) VALUES (?, ?, ?, ?, ?)",
    );
    for (const a of snap.artifacts) {
      insArt.run(a.id, a.book_id, a.chapter_id, a.kind, null);
    }
    const insRev = db.prepare(
      `INSERT INTO artifact_revisions
        (id, artifact_id, revision, body, source, model, skill_ids, scene, created_at, source_revision_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of snap.revisions) {
      insRev.run(
        r.id,
        r.artifact_id,
        r.revision,
        r.body,
        r.source,
        r.model,
        r.skill_ids,
        r.scene,
        r.created_at,
        r.source_revision_id ?? null,
      );
    }
    for (const a of snap.artifacts) {
      db.prepare("UPDATE artifacts SET current_revision_id = ? WHERE id = ?").run(a.current_revision_id, a.id);
    }
    const insMsg = db.prepare(
      "INSERT INTO messages (id, book_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const m of snap.messages) {
      insMsg.run(m.id, m.book_id, m.role, m.content, m.meta_json, m.created_at);
    }
    const insBible = db.prepare(
      `INSERT INTO bible_cards (id, book_id, kind, name, summary, details, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of snap.bible) {
      insBible.run(b.id, b.book_id, b.kind, b.name, b.summary, b.details, b.sort_order, b.created_at, b.updated_at);
    }
    const insHook = db.prepare(
      `INSERT INTO hook_marks (id, book_id, hook_key, status, recycled_chapter, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const h of snap.hooks) {
      insHook.run(h.id, h.book_id, h.hook_key, h.status, h.recycled_chapter, h.note, h.updated_at);
    }
    // Restore jobs as cancelled/paused snapshot rows (do not auto-resume).
    if (snap.jobs.length) {
      const cols = Object.keys(snap.jobs[0]!);
      const placeholders = cols.map(() => "?").join(",");
      const insJob = db.prepare(
        `INSERT INTO writing_jobs (${cols.join(",")}) VALUES (${placeholders})`,
      );
      for (const j of snap.jobs) {
        const row: Record<string, unknown> = { ...j, status: j.status === "running" ? "paused" : j.status };
        insJob.run(...cols.map((c) => row[c]));
      }
    }
  })();
  try {
    syncBook(bookId);
  } catch (error) {
    console.error("restore sync failed", error);
  }
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

  let bookId: string = "";
  let reused = false;
  let overwriteSnapshot: BookSnapshot | null = null;
  if (existingId && conflict === "overwrite") {
    overwriteSnapshot = snapshotBook(existingId);
    // Persist BEFORE wipe so a kill mid-import can recover on next boot.
    writeDurableSnapshot(overwriteSnapshot);
    // Secondary: per-book physical SQLite dump (see docs/STORAGE_LEASE.md).
    writePhysicalSqliteBackup(existingId);
  }

  const imported: ImportResult["imported"] = [];

  try {
  if (existingId && conflict === "overwrite") {
    bookId = existingId;
    reused = true;
    db.prepare(
      `UPDATE writing_jobs SET status = 'cancelled', error = COALESCE(error, '导入覆盖前取消') WHERE book_id = ? AND status IN ('running', 'paused', 'error')`,
    ).run(bookId);
    wipeBookContent(bookId);
    if (process.env.MOLAN_IMPORT_FAIL_AFTER_WIPE === "1") {
      throw new Error("injected import failure after wipe");
    }
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
  if (overwriteSnapshot) {
    clearDurableSnapshot(String(overwriteSnapshot.book.id));
    clearPhysicalSqliteBackup(String(overwriteSnapshot.book.id));
  }
  return {
    bookId,
    title: payload.book.title,
    conflict,
    reused,
    skipped: false,
    imported,
    chapters: payload.chapters.length,
  };
  } catch (error) {
    if (overwriteSnapshot) {
      const bid = String(overwriteSnapshot.book.id);
      let restoreOk = false;
      try {
        restoreBookSnapshot(overwriteSnapshot);
        restoreOk = true;
        clearDurableSnapshot(bid);
        clearPhysicalSqliteBackup(bid);
      } catch (restoreError) {
        console.error(
          "import overwrite logical restore failed; per-book physical dump kept for startup recovery",
          restoreError,
        );
        // Keep data/import-recovery/<id>.book.phys.sqlite + .book.phys.pending for recoverPhysicalImportBackups.
      }
      throw new HttpError(
        500,
        restoreOk
          ? `覆盖导入失败，已尝试回滚原书：${error instanceof Error ? error.message : String(error)}`
          : `覆盖导入失败且逻辑回滚未完成；请保留 data/import-recovery/${bid}.json 与 ${bid}.book.phys.sqlite，重启将尝试按书物理恢复：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

/** Keep booksRoot referenced for typecheck / future disk import. */
export function booksRootPath() {
  return booksRoot;
}

/** Test-only: expose snapshot helpers. */
export function __snapshotBookForTest(bookId: string) {
  return snapshotBook(bookId);
}
export function __restoreBookSnapshotForTest(snap: ReturnType<typeof snapshotBook>) {
  restoreBookSnapshot(snap);
}
export function __writeDurableSnapshotForTest(snap: ReturnType<typeof snapshotBook>) {
  writeDurableSnapshot(snap);
}
export function __clearDurableSnapshotForTest(bookId: string) {
  clearDurableSnapshot(bookId);
}
export function __recoveryFileForTest(bookId: string) {
  return recoveryFile(bookId);
}
export function __isValidSnapshotForTest(snap: unknown, expectBookId?: string) {
  return isValidSnapshot(snap, expectBookId);
}
export function __cleanupOrphanTmpFilesForTest() {
  return cleanupOrphanTmpFiles();
}
export function __quarantineCorruptForTest(bookId: string, reason: string) {
  quarantineCorrupt(bookId, reason);
}

export function __physicalBackupDbPathForTest(bookId: string) {
  return physicalBackupDbPath(bookId);
}
export function __writePhysicalSqliteBackupForTest(bookId: string) {
  return writePhysicalSqliteBackup(bookId);
}
export function __clearPhysicalSqliteBackupForTest(bookId: string) {
  clearPhysicalSqliteBackup(bookId);
}
