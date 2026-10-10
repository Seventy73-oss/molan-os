/**
 * G4: self-contained story pack export / validate-then-commit import (always new book).
 * Layout: manifest.json + manuscript/ + story/ + provenance/ + views/
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db";
import { HttpError } from "./httpError";
import { createBook } from "./engine";
import { syncBook } from "./manuscripts";
import { estimateContextBudget, previewContext } from "./contextSnapshot";
import { chapterStoryStatusByNumber, getBookHead } from "./story";

export const STORY_PACK_FORMAT = "molan.story-pack/v1";
export const STORY_PACK_VERSION = 1;

const IMPORT_LIMITS = {
  maxEntries: Number(process.env.MOLAN_IMPORT_MAX_ENTRIES || 4000),
  maxTotalBytes: Number(process.env.MOLAN_IMPORT_MAX_TOTAL_BYTES || 80 * 1024 * 1024),
  maxFileBytes: Number(process.env.MOLAN_IMPORT_MAX_FILE_BYTES || 8 * 1024 * 1024),
  maxRatio: Number(process.env.MOLAN_IMPORT_MAX_RATIO || 200),
  timeoutMs: Number(process.env.MOLAN_IMPORT_TIMEOUT_MS || 120_000),
};

type Row = Record<string, unknown>;

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function mustBook(bookId: string): Row {
  const row = db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as Row | undefined;
  if (!row) throw new HttpError(404, "书不存在");
  return row;
}

function selectAll(sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function selectOne(sql: string, ...params: unknown[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

function writeJson(dir: string, rel: string, data: unknown): { rel: string; bytes: number; sha256: string } {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(full, text, "utf8");
  const buf = Buffer.from(text, "utf8");
  return { rel: rel.replace(/\\/g, "/"), bytes: buf.length, sha256: sha256(buf) };
}

function writeText(dir: string, rel: string, text: string): { rel: string; bytes: number; sha256: string } {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, "utf8");
  const buf = Buffer.from(text, "utf8");
  return { rel: rel.replace(/\\/g, "/"), bytes: buf.length, sha256: sha256(buf) };
}

function zipDir(sourceDir: string, zipPath: string) {
  const script = `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            zf.write(path, path.relative_to(root).as_posix())
`;
  execFileSync("python3", ["-c", script, sourceDir, zipPath], { stdio: ["ignore", "pipe", "pipe"] });
}

function safeExtractZip(zipPath: string, dest: string) {
  const script = `
import pathlib, stat, sys, zipfile
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
`;
  try {
    execFileSync(
      "python3",
      [
        "-c",
        script,
        zipPath,
        dest,
        String(IMPORT_LIMITS.maxEntries),
        String(IMPORT_LIMITS.maxTotalBytes),
        String(IMPORT_LIMITS.maxFileBytes),
        String(IMPORT_LIMITS.maxRatio),
      ],
      { timeout: IMPORT_LIMITS.timeoutMs, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e);
    if (msg.includes("zip slip") || msg.includes("absolute") || msg.includes("symlink")) {
      throw new HttpError(400, "非法 ZIP：路径穿越或符号链接被拒绝");
    }
    if (msg.includes("too many") || msg.includes("too large") || msg.includes("bomb")) {
      throw new HttpError(400, "非法 ZIP：体积或条目超限");
    }
    throw new HttpError(400, `ZIP 解压失败：${msg.slice(0, 200)}`);
  }
}

/** Collect manuscript + story + provenance for one book. */
export function collectStoryPackPayload(bookId: string, opts?: { includeSecrets?: boolean }) {
  const includeSecrets = opts?.includeSecrets === true;
  const book = mustBook(bookId);
  const chapters = selectAll("SELECT * FROM chapters WHERE book_id = ? ORDER BY number", bookId);
  const artifacts = selectAll("SELECT * FROM artifacts WHERE book_id = ?", bookId);
  const artIds = artifacts.map((a) => String(a.id));
  const revisions: Row[] = [];
  for (const id of artIds) {
    revisions.push(...selectAll("SELECT * FROM artifact_revisions WHERE artifact_id = ?", id));
  }
  const bible = selectAll("SELECT * FROM bible_cards WHERE book_id = ? ORDER BY created_at", bookId);
  const hooks = selectAll("SELECT * FROM hook_marks WHERE book_id = ?", bookId);
  const head = selectOne("SELECT * FROM story_book_heads WHERE book_id = ?", bookId) || {
    book_id: bookId,
    story_epoch: 0,
    fact_set_version: 0,
    protocol_version: 1,
    updated_at: new Date().toISOString(),
  };
  const publications = selectAll("SELECT * FROM chapter_publications WHERE book_id = ?", bookId);
  const factSets = selectAll("SELECT * FROM story_fact_sets WHERE book_id = ?", bookId);
  let facts = selectAll("SELECT * FROM story_facts WHERE book_id = ?", bookId);
  if (!includeSecrets) {
    // Drop author-only secrets from ordinary share packs
    facts = facts.filter((f) => String(f.audience || "author") !== "author");
  }
  const proposals = selectAll(
    "SELECT * FROM memory_proposals WHERE book_id = ? AND status IN ('accepted','proposed','stale','rejected')",
    bookId,
  );
  const hookEvents = selectAll("SELECT * FROM hook_events WHERE book_id = ?", bookId);
  let knowledgeEvents = selectAll("SELECT * FROM story_knowledge_events WHERE book_id = ?", bookId);
  if (!includeSecrets) {
    knowledgeEvents = knowledgeEvents.filter((e) => String(e.audience) !== "author");
  }
  const bibleRevs = selectAll(
    `SELECT * FROM bible_card_revisions WHERE book_id = ?`,
    bookId,
  );
  const opResults = selectAll("SELECT * FROM story_operation_results WHERE book_id = ?", bookId);

  // Ensure published body revisions are present even if somehow orphaned
  const neededRevIds = new Set(
    publications.map((p) => String(p.body_revision_id)).filter(Boolean),
  );
  const have = new Set(revisions.map((r) => String(r.id)));
  for (const rid of neededRevIds) {
    if (!have.has(rid)) {
      const row = selectOne("SELECT * FROM artifact_revisions WHERE id = ?", rid);
      if (row) revisions.push(row);
    }
  }

  return {
    book,
    chapters,
    artifacts,
    revisions,
    bible,
    hooks,
    head,
    publications,
    factSets,
    facts,
    proposals,
    hookEvents,
    knowledgeEvents,
    bibleRevs,
    opResults,
    includeSecrets,
  };
}

export function exportStoryPackZip(
  bookId: string,
  opts?: { includeSecrets?: boolean },
): { filename: string; buffer: Buffer; manifest: Row } {
  const payload = collectStoryPackPayload(bookId, opts);
  const title = String(payload.book.title || "untitled");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "molan-story-pack-"));
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const record = (meta: { rel: string; bytes: number; sha256: string }) => {
    files[meta.rel] = { sha256: meta.sha256, bytes: meta.bytes };
  };

  try {
    record(writeJson(tmpRoot, "manuscript/book.json", payload.book));
    record(writeJson(tmpRoot, "manuscript/chapters.json", payload.chapters));
    record(writeJson(tmpRoot, "manuscript/artifacts.json", payload.artifacts));
    record(writeJson(tmpRoot, "manuscript/revisions.json", payload.revisions));
    record(writeJson(tmpRoot, "manuscript/bible_cards.json", payload.bible));
    record(writeJson(tmpRoot, "manuscript/hook_marks.json", payload.hooks));

    record(writeJson(tmpRoot, "story/book_head.json", payload.head));
    record(writeJson(tmpRoot, "story/publications.json", payload.publications));
    record(writeJson(tmpRoot, "story/fact_sets.json", payload.factSets));
    record(writeJson(tmpRoot, "story/facts.json", payload.facts));
    record(writeJson(tmpRoot, "story/proposals.json", payload.proposals));
    record(writeJson(tmpRoot, "story/hook_events.json", payload.hookEvents));
    record(writeJson(tmpRoot, "story/knowledge_events.json", payload.knowledgeEvents));
    record(writeJson(tmpRoot, "story/bible_card_revisions.json", payload.bibleRevs));

    record(
      writeJson(tmpRoot, "provenance/schema.json", {
        format: STORY_PACK_FORMAT,
        packageVersion: STORY_PACK_VERSION,
        extractor: "molan.story-pack",
        includeSecrets: payload.includeSecrets,
      }),
    );
    record(
      writeJson(tmpRoot, "provenance/approvals.json", {
        operationResults: payload.opResults,
        note: "作者审批与幂等结果；导入时书 ID 会重映射",
      }),
    );
    record(
      writeJson(tmpRoot, "provenance/id_map.json", {
        sourceBookId: bookId,
        note: "导入时生成新 ID；此文件仅为导出溯源",
      }),
    );

    const viewMd = [
      `# ${title}`,
      "",
      `导出格式：${STORY_PACK_FORMAT}`,
      `故事 epoch：${(payload.head as any).story_epoch ?? 0}`,
      `章节：${payload.chapters.length} · 定稿：${payload.publications.length} · 事实：${payload.facts.length}`,
      `含作者秘密：${payload.includeSecrets ? "是" : "否"}`,
      "",
      "本目录为可读派生视图；权威状态在 manuscript/ 与 story/。",
      "",
    ].join("\n");
    record(writeText(tmpRoot, "views/README.md", viewMd));
    const chapterLines = payload.chapters
      .map((c) => `- 第${c.number}章 ${c.title}`)
      .join("\n");
    record(writeText(tmpRoot, "views/chapters.md", `# 章目\n\n${chapterLines}\n`));

    const manifest = {
      format: STORY_PACK_FORMAT,
      packageVersion: STORY_PACK_VERSION,
      exportedAt: new Date().toISOString(),
      sourceBookId: bookId,
      title,
      storyEpoch: Number((payload.head as any).story_epoch ?? 0),
      includeSecrets: payload.includeSecrets,
      counts: {
        chapters: payload.chapters.length,
        artifacts: payload.artifacts.length,
        revisions: payload.revisions.length,
        publications: payload.publications.length,
        facts: payload.facts.length,
        hookEvents: payload.hookEvents.length,
        knowledgeEvents: payload.knowledgeEvents.length,
        proposals: payload.proposals.length,
      },
      files,
      note: "自包含故事包：导入默认成新书并重映射 ID；不含 API Key / 会话凭据",
    };
    // Write manifest last so files map is complete (manifest itself hashed after write for outer check)
    const manText = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(tmpRoot, "manifest.json"), manText, "utf8");

    syncBook(bookId); // keep md mirror warm; pack itself is DB-authoritative
    const zipPath = path.join(os.tmpdir(), `molan-story-${bookId}-${Date.now()}.zip`);
    zipDir(tmpRoot, zipPath);
    const buffer = fs.readFileSync(zipPath);
    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
    const safeTitle = title.replace(/[^\w\u4e00-\u9fff\-]+/g, "_").slice(0, 40) || "book";
    return { filename: `${safeTitle}.story-pack.zip`, buffer, manifest: manifest as Row };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function readJsonFile<T = unknown>(root: string, rel: string): T {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) throw new HttpError(400, `故事包缺少文件：${rel}`);
  try {
    return JSON.parse(fs.readFileSync(full, "utf8")) as T;
  } catch {
    throw new HttpError(400, `故事包 JSON 无效：${rel}`);
  }
}

function assertBookOwned(rows: Row[], bookId: string, label: string, field = "book_id") {
  for (const row of rows) {
    const bid = row[field] ?? row.bookId;
    if (bid != null && String(bid) !== bookId) {
      throw new HttpError(400, `跨书来源引用被拒绝（${label}）`);
    }
  }
}

/** Validate extracted story pack; throws HttpError. Returns parsed payload. */
export function validateStoryPackDir(root: string): {
  manifest: Row;
  manuscript: {
    book: Row;
    chapters: Row[];
    artifacts: Row[];
    revisions: Row[];
    bible: Row[];
    hooks: Row[];
  };
  story: {
    head: Row;
    publications: Row[];
    factSets: Row[];
    facts: Row[];
    proposals: Row[];
    hookEvents: Row[];
    knowledgeEvents: Row[];
    bibleRevs: Row[];
  };
  provenance: { approvals: Row; schema: Row };
} {
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new HttpError(400, "非法故事包：缺少 manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Row;
  if (manifest.format !== STORY_PACK_FORMAT) {
    throw new HttpError(400, `不支持的故事包格式：${manifest.format}`);
  }
  if (Number(manifest.packageVersion) !== STORY_PACK_VERSION) {
    throw new HttpError(400, `不支持的故事包版本：${manifest.packageVersion}`);
  }
  const sourceBookId = String(manifest.sourceBookId || "");
  if (!sourceBookId) throw new HttpError(400, "manifest 缺少 sourceBookId");

  const files = (manifest.files || {}) as Record<string, { sha256?: string; bytes?: number }>;
  for (const [rel, meta] of Object.entries(files)) {
    if (rel.includes("..") || path.isAbsolute(rel)) {
      throw new HttpError(400, "非法故事包：manifest 路径非法");
    }
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) throw new HttpError(400, `故事包文件缺失：${rel}`);
    const buf = fs.readFileSync(full);
    if (meta.bytes != null && buf.length !== meta.bytes) {
      throw new HttpError(400, `故事包文件大小不匹配：${rel}`);
    }
    if (meta.sha256 && sha256(buf) !== meta.sha256) {
      throw new HttpError(400, `故事包文件 hash 不匹配：${rel}`);
    }
  }

  const book = readJsonFile<Row>(root, "manuscript/book.json");
  if (String(book.id) !== sourceBookId) {
    throw new HttpError(400, "manuscript/book.json 与 manifest.sourceBookId 不一致");
  }
  const chapters = readJsonFile<Row[]>(root, "manuscript/chapters.json");
  const artifacts = readJsonFile<Row[]>(root, "manuscript/artifacts.json");
  const revisions = readJsonFile<Row[]>(root, "manuscript/revisions.json");
  const bible = readJsonFile<Row[]>(root, "manuscript/bible_cards.json");
  const hooks = readJsonFile<Row[]>(root, "manuscript/hook_marks.json");
  const head = readJsonFile<Row>(root, "story/book_head.json");
  const publications = readJsonFile<Row[]>(root, "story/publications.json");
  const factSets = readJsonFile<Row[]>(root, "story/fact_sets.json");
  const facts = readJsonFile<Row[]>(root, "story/facts.json");
  const proposals = readJsonFile<Row[]>(root, "story/proposals.json");
  const hookEvents = readJsonFile<Row[]>(root, "story/hook_events.json");
  const knowledgeEvents = readJsonFile<Row[]>(root, "story/knowledge_events.json");
  const bibleRevs = readJsonFile<Row[]>(root, "story/bible_card_revisions.json");
  const schema = readJsonFile<Row>(root, "provenance/schema.json");
  const approvals = readJsonFile<Row>(root, "provenance/approvals.json");

  for (const list of [chapters, artifacts, bible, hooks, publications, factSets, facts, proposals, hookEvents, knowledgeEvents]) {
    if (!Array.isArray(list)) throw new HttpError(400, "故事包数组字段类型错误");
  }
  assertBookOwned(chapters, sourceBookId, "chapters");
  assertBookOwned(artifacts, sourceBookId, "artifacts");
  assertBookOwned(bible, sourceBookId, "bible_cards");
  assertBookOwned(hooks, sourceBookId, "hook_marks");
  assertBookOwned(publications, sourceBookId, "publications");
  assertBookOwned(factSets, sourceBookId, "fact_sets");
  assertBookOwned(facts, sourceBookId, "facts");
  assertBookOwned(proposals, sourceBookId, "proposals");
  assertBookOwned(hookEvents, sourceBookId, "hook_events");
  assertBookOwned(knowledgeEvents, sourceBookId, "knowledge_events");
  if (String(head.book_id || head.bookId) !== sourceBookId) {
    throw new HttpError(400, "跨书来源引用被拒绝（book_head）");
  }

  const chapterIds = new Set(chapters.map((c) => String(c.id)));
  const artIds = new Set(artifacts.map((a) => String(a.id)));
  const revIds = new Set(revisions.map((r) => String(r.id)));
  for (const rev of revisions) {
    if (!artIds.has(String(rev.artifact_id))) {
      throw new HttpError(400, "修订引用了包外 artifact");
    }
  }
  for (const pub of publications) {
    if (!chapterIds.has(String(pub.chapter_id))) {
      throw new HttpError(400, "定稿引用了包外章节");
    }
    if (!revIds.has(String(pub.body_revision_id))) {
      throw new HttpError(400, "定稿引用了包外修订（正文不自包含）");
    }
  }
  for (const fact of facts) {
    const sid = fact.source_revision_id;
    if (sid && !revIds.has(String(sid))) {
      throw new HttpError(400, "事实引用了包外修订");
    }
  }
  if (schema.format && schema.format !== STORY_PACK_FORMAT) {
    throw new HttpError(400, "provenance/schema 格式不匹配");
  }

  return {
    manifest,
    manuscript: { book, chapters, artifacts, revisions, bible, hooks },
    story: {
      head,
      publications,
      factSets,
      facts,
      proposals,
      hookEvents,
      knowledgeEvents,
      bibleRevs,
    },
    provenance: { approvals, schema },
  };
}

function newId(): string {
  return randomUUID();
}

function remapId(map: Map<string, string>, oldId: string | null | undefined): string | null {
  if (oldId == null || oldId === "") return null;
  const key = String(oldId);
  if (!map.has(key)) map.set(key, newId());
  return map.get(key)!;
}

/** Import story pack as a brand-new book (never overwrite). */
export function importStoryPackFromZipBuffer(
  buffer: Buffer,
  opts?: { title?: string },
): { bookId: string; title: string; idMap: Record<string, string>; counts: Row } {
  const tmpZip = path.join(os.tmpdir(), `molan-sp-in-${Date.now()}.zip`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "molan-sp-extract-"));
  fs.writeFileSync(tmpZip, buffer);
  try {
    safeExtractZip(tmpZip, tmpDir);
    // If single top folder containing manifest, descend
    let root = tmpDir;
    const top = fs.readdirSync(tmpDir).filter((n) => !n.startsWith("."));
    if (top.length === 1 && fs.statSync(path.join(tmpDir, top[0]!)).isDirectory()) {
      const candidate = path.join(tmpDir, top[0]!);
      if (fs.existsSync(path.join(candidate, "manifest.json"))) root = candidate;
    }
    const validated = validateStoryPackDir(root);

    const idMap = new Map<string, string>();
    const srcBook = validated.manuscript.book;
    const title =
      (opts?.title && opts.title.trim()) ||
      `${String(srcBook.title || validated.manifest.title || "导入书")}（故事包）`;

    const created = createBook({
      title,
      genre: String(srcBook.genre || ""),
      logline: String(srcBook.logline || ""),
      style: String(srcBook.style || ""),
      targetChapters: Number(srcBook.target_chapters || srcBook.targetChapters || 12),
      wordsPerChapter: Number(srcBook.words_per_chapter || srcBook.wordsPerChapter || 2000),
    });
    // createBook already inserted a book + default chapters; wipe and rebuild from pack
    const liveBookId = created.payload.book.id as string;
    // Remap: replace createBook id with our mapped id by deleting created and inserting pack
    // Simpler: use liveBookId as the new book, map source→liveBookId
    idMap.set(String(validated.manifest.sourceBookId), liveBookId);

    const wipeStory = db.transaction(() => {
      // clear default chapters/artifacts from createBook
      const arts = selectAll("SELECT id FROM artifacts WHERE book_id = ?", liveBookId);
      for (const a of arts) {
        db.prepare("DELETE FROM artifact_revisions WHERE artifact_id = ?").run(a.id);
      }
      db.prepare("DELETE FROM artifacts WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM chapters WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM bible_cards WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM hook_marks WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM messages WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM context_snapshots WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM story_book_heads WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM chapter_publications WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM memory_proposals WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM story_fact_sets WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM story_facts WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM hook_events WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM story_knowledge_events WHERE book_id = ?").run(liveBookId);
      db.prepare("DELETE FROM story_operation_results WHERE book_id = ?").run(liveBookId);

      db.prepare(
        `UPDATE books SET title = ?, genre = ?, logline = ?, style = ?, target_chapters = ?, words_per_chapter = ? WHERE id = ?`,
      ).run(
        title,
        String(srcBook.genre || ""),
        String(srcBook.logline || ""),
        String(srcBook.style || ""),
        Number(srcBook.target_chapters || 12),
        Number(srcBook.words_per_chapter || 2000),
        liveBookId,
      );

      // chapters
      for (const ch of validated.manuscript.chapters) {
        const nid = remapId(idMap, String(ch.id))!;
        db.prepare(
          `INSERT INTO chapters (id, book_id, number, title, status) VALUES (?, ?, ?, ?, ?)`,
        ).run(nid, liveBookId, Number(ch.number), String(ch.title || ""), String(ch.status || "empty"));
      }

      // artifacts without current first
      for (const a of validated.manuscript.artifacts) {
        const nid = remapId(idMap, String(a.id))!;
        const chId = a.chapter_id != null ? remapId(idMap, String(a.chapter_id)) : null;
        db.prepare(
          `INSERT INTO artifacts (id, book_id, kind, chapter_id, current_revision_id) VALUES (?, ?, ?, ?, NULL)`,
        ).run(nid, liveBookId, String(a.kind), chId);
      }

      for (const r of validated.manuscript.revisions) {
        const nid = remapId(idMap, String(r.id))!;
        const artId = remapId(idMap, String(r.artifact_id))!;
        const srcRev = r.source_revision_id != null ? remapId(idMap, String(r.source_revision_id)) : null;
        db.prepare(
          `INSERT INTO artifact_revisions
           (id, artifact_id, revision, body, source, model, skill_ids, scene, created_at, source_revision_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          artId,
          Number(r.revision || 1),
          String(r.body || ""),
          String(r.source || "import"),
          r.model ?? null,
          String(r.skill_ids || "[]"),
          String(r.scene || ""),
          String(r.created_at || new Date().toISOString()),
          srcRev,
        );
      }

      for (const a of validated.manuscript.artifacts) {
        if (a.current_revision_id) {
          const artId = remapId(idMap, String(a.id))!;
          const cur = remapId(idMap, String(a.current_revision_id))!;
          db.prepare("UPDATE artifacts SET current_revision_id = ? WHERE id = ?").run(cur, artId);
        }
      }

      for (const b of validated.manuscript.bible) {
        const nid = remapId(idMap, String(b.id))!;
        db.prepare(
          `INSERT INTO bible_cards (id, book_id, kind, name, summary, details, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          liveBookId,
          String(b.kind || "character"),
          String(b.name || ""),
          String(b.summary || ""),
          String(b.details || ""),
          String(b.created_at || new Date().toISOString()),
          String(b.updated_at || b.created_at || new Date().toISOString()),
        );
      }

      for (const h of validated.manuscript.hooks) {
        const nid = remapId(idMap, String(h.id))!;
        db.prepare(
          `INSERT INTO hook_marks
           (id, book_id, hook_key, status, recycled_chapter, note, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          liveBookId,
          String(h.hook_key || h.key || ""),
          String(h.status || "open"),
          h.recycled_chapter ?? h.recycledChapter ?? null,
          String(h.note || ""),
          String(h.updated_at || new Date().toISOString()),
        );
      }

      const head = validated.story.head;
      db.prepare(
        `INSERT INTO story_book_heads (book_id, story_epoch, fact_set_version, protocol_version, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        liveBookId,
        Number(head.story_epoch || 0),
        Number(head.fact_set_version || 0),
        Number(head.protocol_version || 1),
        String(head.updated_at || new Date().toISOString()),
      );

      for (const p of validated.story.publications) {
        const nid = remapId(idMap, String(p.id))!;
        const chId = remapId(idMap, String(p.chapter_id))!;
        const bodyRev = remapId(idMap, String(p.body_revision_id))!;
        db.prepare(
          `INSERT INTO chapter_publications
           (id, book_id, chapter_id, body_revision_id, publication_version, status, memory_state, accepted_at, accepted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          liveBookId,
          chId,
          bodyRev,
          Number(p.publication_version || 1),
          String(p.status || "active"),
          String(p.memory_state || "pending"),
          String(p.accepted_at || new Date().toISOString()),
          String(p.accepted_by || "import"),
        );
      }

      for (const fsRow of validated.story.factSets) {
        const nid = remapId(idMap, String(fsRow.id))!;
        const pubId = fsRow.publication_id != null ? remapId(idMap, String(fsRow.publication_id)) : null;
        const srcRev = remapId(idMap, String(fsRow.source_revision_id))!;
        const propId = fsRow.proposal_id != null ? remapId(idMap, String(fsRow.proposal_id)) : null;
        db.prepare(
          `INSERT INTO story_fact_sets
           (id, book_id, publication_id, source_revision_id, version, status, proposal_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          liveBookId,
          pubId,
          srcRev,
          Number(fsRow.version || 1),
          String(fsRow.status || "active"),
          propId,
          String(fsRow.created_at || new Date().toISOString()),
        );
      }

      for (const f of validated.story.facts) {
        const nid = remapId(idMap, String(f.id))!;
        const setId = remapId(idMap, String(f.fact_set_id))!;
        const srcRev = remapId(idMap, String(f.source_revision_id))!;
        const pubId = f.publication_id != null ? remapId(idMap, String(f.publication_id)) : null;
        const charId = f.character_id != null ? remapId(idMap, String(f.character_id)) : null;
        // Remap subject if it looks like a UUID we know
        let subject = String(f.subject || "");
        if (idMap.has(subject)) subject = idMap.get(subject)!;
        db.prepare(
          `INSERT INTO story_facts
           (id, fact_set_id, book_id, subject, predicate, value_json, evidence_quote, source_revision_id,
            publication_id, effective_from_chapter, status, created_at, kind, audience, character_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          setId,
          liveBookId,
          subject,
          String(f.predicate || ""),
          String(f.value_json || "{}"),
          String(f.evidence_quote || ""),
          srcRev,
          pubId,
          f.effective_from_chapter ?? null,
          String(f.status || "active"),
          String(f.created_at || new Date().toISOString()),
          String(f.kind || "generic"),
          String(f.audience || "author"),
          charId,
        );
      }

      for (const p of validated.story.proposals) {
        const nid = remapId(idMap, String(p.id))!;
        const chId = remapId(idMap, String(p.chapter_id))!;
        const pubId = p.publication_id != null ? remapId(idMap, String(p.publication_id)) : null;
        const srcRev = remapId(idMap, String(p.source_revision_id))!;
        db.prepare(
          `INSERT INTO memory_proposals
           (id, book_id, chapter_id, publication_id, source_revision_id, basis_epoch, schema_version,
            status, summary, operations_json, decision_json, diagnostics_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          liveBookId,
          chId,
          pubId,
          srcRev,
          Number(p.basis_epoch || 0),
          String(p.schema_version || "molan.memory-proposal/v1"),
          String(p.status || "accepted"),
          String(p.summary || ""),
          String(p.operations_json || "[]"),
          p.decision_json ?? null,
          p.diagnostics_json ?? null,
          String(p.created_at || new Date().toISOString()),
          String(p.updated_at || new Date().toISOString()),
        );
      }

      for (const e of validated.story.hookEvents) {
        const nid = remapId(idMap, String(e.id))!;
        const pubId = e.publication_id != null ? remapId(idMap, String(e.publication_id)) : null;
        const srcRev = e.source_revision_id != null ? remapId(idMap, String(e.source_revision_id)) : null;
        db.prepare(
          `INSERT INTO hook_events
           (id, book_id, hook_stable_id, event_kind, description, planned_payoff_chapter, effective_chapter,
            publication_id, source_revision_id, evidence_quote, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          liveBookId,
          String(e.hook_stable_id || ""),
          String(e.event_kind || e.event_type || "planted"),
          String(e.description || ""),
          e.planned_payoff_chapter ?? null,
          Number(e.effective_chapter ?? 1),
          pubId,
          srcRev,
          String(e.evidence_quote || ""),
          String(e.status || "active"),
          String(e.created_at || new Date().toISOString()),
        );
      }

      for (const e of validated.story.knowledgeEvents) {
        const nid = remapId(idMap, String(e.id))!;
        if (e.fact_id == null) continue;
        const factId = remapId(idMap, String(e.fact_id))!;
        const charId = e.character_id != null ? remapId(idMap, String(e.character_id)) : null;
        const pubId = e.publication_id != null ? remapId(idMap, String(e.publication_id)) : null;
        const srcRev = e.source_revision_id != null ? remapId(idMap, String(e.source_revision_id)) : null;
        db.prepare(
          `INSERT INTO story_knowledge_events
           (id, book_id, fact_id, audience, character_id, revealed_at_chapter, source_revision_id, publication_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          liveBookId,
          factId,
          String(e.audience || "author"),
          charId,
          Number(e.revealed_at_chapter ?? 1),
          srcRev,
          pubId,
          String(e.status || "active"),
          String(e.created_at || new Date().toISOString()),
        );
      }

      for (const r of validated.story.bibleRevs) {
        const nid = remapId(idMap, String(r.id))!;
        const cardId = remapId(idMap, String(r.card_id))!;
        db.prepare(
          `INSERT INTO bible_card_revisions
           (id, card_id, book_id, content_hash, kind, name, summary, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nid,
          cardId,
          liveBookId,
          String(r.content_hash || ""),
          String(r.kind || ""),
          String(r.name || ""),
          String(r.summary || ""),
          String(r.details || ""),
          String(r.created_at || new Date().toISOString()),
        );
      }
    });
    wipeStory();

    try {
      syncBook(liveBookId);
    } catch {
      /* mirror best-effort */
    }

    const idMapObj: Record<string, string> = {};
    for (const [k, v] of idMap) idMapObj[k] = v;

    return {
      bookId: liveBookId,
      title,
      idMap: idMapObj,
      counts: (validated.manifest.counts || {}) as Row,
    };
  } finally {
    try {
      fs.unlinkSync(tmpZip);
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Publish readiness checks — not just "can click generate". */
export function publishCheck(bookId: string, chapterNumber: number) {
  mustBook(bookId);
  const head = getBookHead(bookId);
  const status = chapterStoryStatusByNumber(bookId, chapterNumber);
  const preview = previewContext(bookId, chapterNumber);
  const checks: Array<{ id: string; pass: boolean; level: "blocker" | "warning" | "info"; message: string }> = [];

  const hasPub = Boolean(status.publication);
  checks.push({
    id: "has_publication",
    pass: hasPub,
    level: hasPub ? "info" : "blocker",
    message: hasPub ? "本章已有活跃定稿" : "本章尚无定稿：请先定稿再发布/续写正式线",
  });

  const memReady = status.publication?.memoryState === "ready";
  checks.push({
    id: "memory_ready",
    pass: !hasPub || memReady,
    level: !hasPub ? "info" : memReady ? "info" : "warning",
    message: !hasPub
      ? "无定稿，跳过记忆检查"
      : memReady
        ? "定稿记忆已就绪"
        : `定稿记忆状态为 ${status.publication?.memoryState || "unknown"}：建议提取并批准提案`,
  });

  const aligned = !status.draftDivergesFromPublication;
  checks.push({
    id: "draft_aligned",
    pass: !hasPub || aligned,
    level: !hasPub ? "info" : aligned ? "info" : "warning",
    message: !hasPub
      ? "无定稿"
      : aligned
        ? "当前稿与定稿一致"
        : "当前草稿与定稿分歧：发布检查仍以定稿为准",
  });

  const missing = preview.missing || [];
  checks.push({
    id: "context_complete",
    pass: missing.length === 0,
    level: missing.length === 0 ? "info" : "warning",
    message: missing.length === 0 ? "上下文资料齐全" : `上下文缺口：${missing[0]}`,
  });

  const openHooks = Number(preview.manifest?.counts?.openHooks || 0);
  checks.push({
    id: "open_hooks",
    pass: true,
    level: openHooks > 0 ? "warning" : "info",
    message: openHooks > 0 ? `有 ${openHooks} 条未回收钩子` : "无未回收钩子告警",
  });

  checks.push({
    id: "story_epoch",
    pass: true,
    level: "info",
    message: `故事 epoch=${head.storyEpoch}`,
  });

  const blockers = checks.filter((c) => !c.pass && c.level === "blocker").map((c) => c.message);
  const warnings = checks.filter((c) => c.level === "warning").map((c) => c.message);

  return {
    bookId,
    chapterNumber,
    ok: blockers.length === 0,
    storyEpoch: head.storyEpoch,
    publication: status.publication
      ? {
          id: status.publication.id,
          bodyRevisionId: status.publication.bodyRevisionId,
          memoryState: status.publication.memoryState,
        }
      : null,
    draftDivergesFromPublication: status.draftDivergesFromPublication,
    context: {
      mode: preview.mode,
      missing: preview.missing,
      counts: preview.manifest?.counts,
      budgetEstimate: estimateContextBudget(preview),
    },
    checks,
    blockers,
    warnings,
    note: "发布检查不自动改正文；关系图/多 Agent 不在本阶段范围",
  };
}

