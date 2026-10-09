import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { SceneId } from "./agent/adapter";
import { listAgentCapabilities } from "./agent/runtime";
import { db, getDbInfo, initDb } from "./db";
import { getWorkerStatus, startJobWorker, withJobLock } from "./jobs/worker";
import {
  addChapter,
  autoSetup,
  chat,
  createBook,
  deleteBook,
  deleteChapter,
  createJob,
  executeScene,
  getBookPayload,
  getJob,
  HttpError,
  listBooks,
  listJobs,
  listMessages,
  renameChapter,
  retryJob,
  rewriteSelection,
  saveRevision,
  setJobStatus,
  tickJob,
  updateBook,
} from "./engine";
import { listHooks, markHook } from "./hooks";
import { importBookFromZipBuffer } from "./importBook";
import { listUsage, usageSummary } from "./usage";
import {
  bookProgress,
  createBibleCard,
  deleteBibleCard,
  diffRevisions,
  getRevisionBody,
  listBibleCards,
  listRevisions,
  parseReviewIssues,
  searchBook,
  updateBibleCard,
} from "./features";
import { sseJson, streamChat, streamSceneRun, streamSelectionRewrite } from "./streamSupport";
import { exportBookZip, exportChapterMarkdown, exportChapterZip, readArtifactFile, syncAllBooks, syncBook } from "./manuscripts";
import { getModelsList, providerView, refreshModels, saveProvider, testProvider } from "./provider";
import { isUserPack, loadUserPackPrompt, readSkillFile, reloadSkills, skillDescription, skillPromptMeta, toSkillTexts, userPackDefaultMax, userPackSources, type SkillRow } from "./skills";

const SCENES = new Set<SceneId>([
  "topic",
  "book_setup",
  "outline",
  "chapter_outline",
  "chapter_body",
  "review",
  "humanize",
  "memory_extract",
  "chat",
]);

const app = new Hono();
app.use("/api/*", cors());

/** Durable flush for postgres/pglite after mutating API calls. */
app.use("/api/*", async (c, next) => {
  await next();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    try {
      await db.flush();
    } catch (error) {
      console.error("[db] flush failed", error);
    }
  }
});

app.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
  console.error(error);
  return c.json({ error: error.message || "服务器错误" }, 500);
});


function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item: unknown): item is string => typeof item === "string");
}

function sceneOf(value: unknown): SceneId {
  if (typeof value === "string" && SCENES.has(value as SceneId)) return value as SceneId;
  throw new HttpError(400, "未知场景");
}

app.get("/api/health", (c) => {
  const info = getDbInfo();
  return c.json({
    ok: true,
    db: info,
    jobsWorker: getWorkerStatus(),
  });
});

app.get("/api/jobs/worker", (c) => c.json(getWorkerStatus()));

app.get("/api/agent/runtime", (c) => c.json(listAgentCapabilities()));

app.get("/api/books", (c) => c.json({ books: listBooks() }));

app.delete("/api/books/:id", (c) => {
  deleteBook(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/books", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = typeof body.title === "string" ? body.title : "";
  const created = createBook({
    title,
    genre: typeof body.genre === "string" ? body.genre : "",
    logline: typeof body.logline === "string" ? body.logline : "",
    style: typeof body.style === "string" ? body.style : "",
    targetChapters: typeof body.targetChapters === "number" ? body.targetChapters : undefined,
    wordsPerChapter: typeof body.wordsPerChapter === "number" ? body.wordsPerChapter : undefined,
    idempotencyKey: c.req.header("Idempotency-Key"),
  });
  return c.json(created.payload, created.reused ? 200 : 201);
});

app.post("/api/books/auto-setup", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const brief = typeof body.brief === "string" ? body.brief : "";
  return c.json(await autoSetup(brief), 201);
});

app.get("/api/books/:id", (c) => {
  const id = c.req.param("id");
  try {
    syncBook(id);
  } catch (error) {
    console.error("manuscript sync failed", error);
  }
  return c.json(getBookPayload(id));
});

app.patch("/api/books/:id", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  return c.json(
    updateBook(c.req.param("id"), {
      title: typeof body.title === "string" ? body.title : undefined,
      genre: typeof body.genre === "string" ? body.genre : undefined,
      logline: typeof body.logline === "string" ? body.logline : undefined,
      style: typeof body.style === "string" ? body.style : undefined,
      targetChapters: typeof body.targetChapters === "number" ? body.targetChapters : undefined,
      wordsPerChapter: typeof body.wordsPerChapter === "number" ? body.wordsPerChapter : undefined,
      confirmTrim: body.confirmTrim === true,
    }),
  );
});

app.post("/api/books/import", async (c) => {
  const contentType = c.req.header("content-type") || "";
  let conflict: "new_book" | "overwrite" | "skip" = "new_book";
  let title: string | undefined;
  let buffer: Buffer | null = null;
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    const file = form.file;
    if (typeof form.conflict === "string" && ["new_book", "overwrite", "skip"].includes(form.conflict)) {
      conflict = form.conflict as typeof conflict;
    }
    if (typeof form.title === "string") title = form.title;
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      buffer = Buffer.from(await (file as File).arrayBuffer());
    }
  } else {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    if (typeof body.conflict === "string" && ["new_book", "overwrite", "skip"].includes(body.conflict)) {
      conflict = body.conflict as typeof conflict;
    }
    if (typeof body.title === "string") title = body.title;
    if (typeof body.zipBase64 === "string") {
      buffer = Buffer.from(body.zipBase64, "base64");
    }
  }
  if (!buffer?.length) throw new HttpError(400, "请上传 zip 书稿");
  const result = importBookFromZipBuffer(buffer, { conflict, title });
  return c.json({ ...result, book: getBookPayload(result.bookId) }, result.skipped ? 200 : 201);
});

app.get("/api/books/:id/artifacts/file", (c) => {
  const id = c.req.param("id");
  const kind = c.req.query("kind") || "";
  const raw = c.req.query("chapterNumber");
  const chapterNumber = raw && raw !== "null" && raw !== "" ? Number(raw) : null;
  if (!kind) throw new HttpError(400, "缺少稿件类型");
  if (chapterNumber != null && !Number.isFinite(chapterNumber)) throw new HttpError(400, "章节号无效");
  try {
    const body = readArtifactFile(id, kind, chapterNumber);
    return c.json({ kind, chapterNumber, body, path: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读文件失败";
    throw new HttpError(404, message);
  }
});

app.get("/api/books/:id/export.zip", (c) => {
  try {
    const { filename, buffer } = exportBookZip(c.req.param("id"));
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";
    throw new HttpError(400, message);
  }
});

app.get("/api/books/:id/chapters/:number/export.zip", (c) => {
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) throw new HttpError(400, "章节号无效");
  try {
    const { filename, buffer } = exportChapterZip(c.req.param("id"), number);
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";
    throw new HttpError(400, message);
  }
});

app.get("/api/books/:id/chapters/:number/export.md", (c) => {
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) throw new HttpError(400, "章节号无效");
  try {
    const { filename, buffer } = exportChapterMarkdown(c.req.param("id"), number, "chapter_body");
    return new Response(buffer, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";
    throw new HttpError(400, message);
  }
});


app.post("/api/books/:id/auto-setup", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const brief = typeof body.brief === "string" ? body.brief : "";
  return c.json(await autoSetup(brief, c.req.param("id")), 201);
});

app.post("/api/books/:id/chapters", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = typeof body.title === "string" ? body.title : undefined;
  return c.json(addChapter(c.req.param("id"), title), 201);
});

app.patch("/api/books/:id/chapters/:number", async (c) => {
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) throw new HttpError(400, "章节号无效");
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const title = typeof body.title === "string" ? body.title : "";
  return c.json(renameChapter(c.req.param("id"), number, title));
});

app.delete("/api/books/:id/chapters/:number", (c) => {
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) throw new HttpError(400, "章节号无效");
  return c.json(deleteChapter(c.req.param("id"), number));
});

app.put("/api/books/:id/artifacts", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!kind) throw new HttpError(400, "缺少稿件类型");
  const chapterNumber = typeof body.chapterNumber === "number" ? body.chapterNumber : null;
  const saved = saveRevision({
    bookId: c.req.param("id"),
    kind,
    chapterNumber,
    body: typeof body.body === "string" ? body.body : "",
    source: body.source === "agent" ? "agent" : "human",
    model: typeof body.model === "string" ? body.model : null,
    skillIds: asStrings(body.skillIds),
    scene: typeof body.scene === "string" ? body.scene : null,
  });
  return c.json(saved);
});

app.post("/api/books/:id/scene-runs", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const result = await executeScene({
    bookId: c.req.param("id"),
    scene: sceneOf(body.scene),
    chapterNumber: typeof body.chapterNumber === "number" ? body.chapterNumber : null,
    instruction: typeof body.instruction === "string" ? body.instruction : "",
    skillIds: Array.isArray(body.skillIds) ? asStrings(body.skillIds) : undefined,
  });
  return c.json(result);
});


app.post("/api/books/:id/selection-rewrite", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const sceneRaw = typeof body.scene === "string" ? body.scene : "";
  const scene = SCENES.has(sceneRaw as SceneId) ? (sceneRaw as SceneId) : undefined;
  const result = await rewriteSelection({
    bookId: c.req.param("id"),
    selection: typeof body.selection === "string" ? body.selection : "",
    instruction: typeof body.instruction === "string" ? body.instruction : "",
    scene,
  });
  return c.json(result);
});

app.post("/api/books/:id/scene-runs/stream", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  return sseJson(c, async (emit) => {
    await streamSceneRun(emit, {
      bookId: c.req.param("id"),
      scene: sceneOf(body.scene),
      chapterNumber: typeof body.chapterNumber === "number" ? body.chapterNumber : null,
      instruction: typeof body.instruction === "string" ? body.instruction : "",
      skillIds: Array.isArray(body.skillIds) ? asStrings(body.skillIds) : undefined,
    });
  });
});

app.post("/api/books/:id/selection-rewrite/stream", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const sceneRaw = typeof body.scene === "string" ? body.scene : "";
  const scene = SCENES.has(sceneRaw as SceneId) ? (sceneRaw as SceneId) : undefined;
  return sseJson(c, async (emit) => {
    await streamSelectionRewrite(emit, {
      bookId: c.req.param("id"),
      selection: typeof body.selection === "string" ? body.selection : "",
      instruction: typeof body.instruction === "string" ? body.instruction : "",
      scene,
    });
  });
});

app.post("/api/books/:id/chat", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const message = typeof body.message === "string" ? body.message : "";
  return c.json(await chat(c.req.param("id"), message));
});

app.post("/api/books/:id/chat/stream", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const message = typeof body.message === "string" ? body.message : "";
  return sseJson(c, async (emit) => {
    await streamChat(emit, c.req.param("id"), message);
  });
});

app.get("/api/books/:id/messages", (c) => c.json({ messages: listMessages(c.req.param("id")) }));

app.get("/api/books/:id/jobs", (c) => c.json({ jobs: listJobs(c.req.param("id")) }));

app.post("/api/books/:id/jobs", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const job = createJob(
    c.req.param("id"),
    typeof body.fromChapter === "number" ? body.fromChapter : undefined,
    typeof body.toChapter === "number" ? body.toChapter : undefined,
    {
      autoReview: body.autoReview === true,
      maxRetries: typeof body.maxRetries === "number" ? body.maxRetries : undefined,
    },
  );
  return c.json(job, 201);
});

app.get("/api/jobs/:id", (c) => c.json(getJob(c.req.param("id"))));

app.post("/api/jobs/:id/tick", async (c) => {
  const id = c.req.param("id");
  const result = await withJobLock(id, () => tickJob(id));
  if (!result) return c.json({ job: getJob(id), advanced: false, locked: true });
  return c.json(result);
});

app.patch("/api/jobs/:id", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const status = typeof body.status === "string" ? body.status : "";
  return c.json(setJobStatus(c.req.param("id"), status));
});

app.post("/api/jobs/:id/retry", (c) => c.json(retryJob(c.req.param("id"))));

function skillJson(row: SkillRow) {
  const raw = readSkillFile(row.path);
  return {
    id: row.id,
    name: row.name,
    scene: row.scene,
    role: row.role,
    path: row.path,
    enabled: row.enabled === 1,
    description: skillDescription(raw),
    body: raw,
  };
}


app.get("/api/books/:id/progress", (c) => c.json(bookProgress(c.req.param("id"))));

app.get("/api/books/:id/search", (c) => {
  const q = c.req.query("q") ?? "";
  return c.json({ query: q, hits: searchBook(c.req.param("id"), q) });
});

app.get("/api/books/:id/artifacts/revisions", (c) => {
  const kind = c.req.query("kind") ?? "";
  if (!kind) throw new HttpError(400, "缺少稿件类型");
  const raw = c.req.query("chapterNumber");
  const chapterNumber = raw === undefined || raw === "" || raw === "null" ? null : Number(raw);
  if (chapterNumber != null && !Number.isFinite(chapterNumber)) throw new HttpError(400, "章节号无效");
  return c.json({ revisions: listRevisions(c.req.param("id"), kind, chapterNumber) });
});

app.get("/api/books/:id/artifacts/revisions/:revId", (c) => {
  return c.json(getRevisionBody(c.req.param("id"), c.req.param("revId")));
});

app.get("/api/books/:id/artifacts/revisions/:revId/diff", (c) => {
  const against = c.req.query("against") || null;
  return c.json(diffRevisions(c.req.param("id"), c.req.param("revId"), against));
});

app.post("/api/books/:id/artifacts/revisions/:revId/restore", async (c) => {
  const body = getRevisionBody(c.req.param("id"), c.req.param("revId"));
  const saved = saveRevision({
    bookId: c.req.param("id"),
    kind: body.kind,
    chapterNumber: body.chapterNumber,
    body: body.body,
    source: "human",
    model: "restore",
    skillIds: [],
    scene: null,
  });
  return c.json({ saved, body });
});

app.get("/api/books/:id/review-issues", (c) => {
  const raw = c.req.query("chapterNumber");
  const chapterNumber = raw ? Number(raw) : NaN;
  if (!Number.isFinite(chapterNumber)) throw new HttpError(400, "章节号无效");
  const payload = getBookPayload(c.req.param("id"));
  const art = payload.artifacts.find(
    (a) => a.kind === "review_report" && a.chapterNumber === chapterNumber,
  );
  const body = art?.body ?? "";
  return c.json({ chapterNumber, issues: parseReviewIssues(body), body });
});

app.get("/api/books/:id/bible", (c) => c.json({ cards: listBibleCards(c.req.param("id")) }));

app.post("/api/books/:id/bible", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const card = createBibleCard(c.req.param("id"), {
    kind: typeof body.kind === "string" ? body.kind : "character",
    name: typeof body.name === "string" ? body.name : "",
    summary: typeof body.summary === "string" ? body.summary : "",
    details: typeof body.details === "string" ? body.details : "",
  });
  return c.json(card, 201);
});

app.patch("/api/books/:id/bible/:cardId", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const card = updateBibleCard(c.req.param("id"), c.req.param("cardId"), {
    kind: typeof body.kind === "string" ? body.kind : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    summary: typeof body.summary === "string" ? body.summary : undefined,
    details: typeof body.details === "string" ? body.details : undefined,
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined,
  });
  return c.json(card);
});

app.delete("/api/books/:id/bible/:cardId", (c) => {
  return c.json(deleteBibleCard(c.req.param("id"), c.req.param("cardId")));
});

app.get("/api/books/:id/hooks", (c) => c.json({ hooks: listHooks(c.req.param("id")) }));

app.patch("/api/books/:id/hooks", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) throw new HttpError(400, "缺少钩子 key");
  const status = typeof body.status === "string" ? body.status : "marked";
  if (!["open", "recycled", "marked"].includes(status)) throw new HttpError(400, "状态无效");
  const hook = markHook(
    c.req.param("id"),
    key,
    status as "open" | "recycled" | "marked",
    typeof body.recycledChapter === "number" ? body.recycledChapter : null,
    typeof body.note === "string" ? body.note : "",
  );
  return c.json({ hook, hooks: listHooks(c.req.param("id")) });
});

app.get("/api/usage", (c) => {
  const bookId = c.req.query("bookId") || undefined;
  const limit = Number(c.req.query("limit") || 50);
  return c.json({
    entries: listUsage({ bookId: bookId || null, limit: Number.isFinite(limit) ? limit : 50 }),
    summary: usageSummary(bookId || null),
  });
});

app.get("/api/usage/summary", (c) => {
  const bookId = c.req.query("bookId") || undefined;
  return c.json(usageSummary(bookId || null));
});

app.get("/api/books/:id/usage", (c) => {
  const id = c.req.param("id");
  return c.json({
    entries: listUsage({ bookId: id, limit: 80 }),
    summary: usageSummary(id),
  });
});


app.get("/api/skills", (c) => {
  const rows = db.prepare("SELECT * FROM skills ORDER BY scene, role DESC, id").all() as SkillRow[];
  return c.json({ skills: rows.map(skillJson) });
});

app.patch("/api/skills/:id", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(c.req.param("id")) as SkillRow | undefined;
  if (!row) throw new HttpError(404, "没有这个技能");
  if (typeof body.enabled === "boolean") {
    db.prepare("UPDATE skills SET enabled = ? WHERE id = ?").run(body.enabled ? 1 : 0, row.id);
  }
  const next = db.prepare("SELECT * FROM skills WHERE id = ?").get(row.id) as SkillRow;
  return c.json(skillJson(next));
});

app.post("/api/skills/reload", (c) => {
  const rows = reloadSkills();
  return c.json({ skills: rows.map(skillJson) });
});

app.get("/api/skills/:id/prompt-preview", (c) => {
  const id = c.req.param("id");
  const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
  if (!row) throw new HttpError(404, "没有这个技能");
  const texts = toSkillTexts([row], userPackDefaultMax(id));
  const meta = skillPromptMeta(texts)[0];
  const packPrompt = isUserPack(id) ? loadUserPackPrompt(id) : null;
  return c.json({
    skill: { id: row.id, name: row.name, scene: row.scene, role: row.role, path: row.path, enabled: row.enabled === 1 },
    prompt: meta,
    packChars: packPrompt?.length ?? null,
    packSources: isUserPack(id) ? userPackSources(id) : [row.path],
  });
});

app.get("/api/settings/provider", (c) => c.json(providerView()));

app.put("/api/settings/provider", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  try {
    const next = saveProvider(body);
    if (next.configured) await refreshModels(true).catch(() => null);
    return c.json(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "没有保存";
    throw new HttpError(400, message);
  }
});

app.post("/api/settings/provider/test", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  try {
    const result = await testProvider(body);
    if (result.ok && providerView().configured) {
      await refreshModels(true).catch(() => null);
    }
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "连接失败";
    return c.json({ ok: false, model: "", error: message });
  }
});

app.get("/api/settings/provider/models", (c) => c.json(getModelsList()));

app.post("/api/settings/provider/models/refresh", async (c) => c.json(await refreshModels(true)));

app.get("/api/scene-routes", (c) => {
  const rows = db.prepare("SELECT * FROM scene_routes").all() as {
    scene: string;
    provider: string;
    model_id: string;
    base_url: string | null;
  }[];
  return c.json({
    routes: rows.map((row) => ({
      scene: row.scene,
      provider: row.provider,
      modelId: row.model_id,
      baseUrl: row.base_url,
    })),
  });
});

app.put("/api/scene-routes", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const routes = Array.isArray(body.routes) ? body.routes : [];
  const update = db.prepare(
    `INSERT INTO scene_routes (scene, provider, model_id, base_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scene) DO UPDATE SET provider = excluded.provider, model_id = excluded.model_id, base_url = excluded.base_url`,
  );
  const tx = db.transaction(() => {
    for (const route of routes) {
      if (!route || typeof route !== "object") continue;
      const item = route as Record<string, unknown>;
      const scene = sceneOf(item.scene);
      const provider = item.provider === "openai" ? "openai" : item.provider === "pi" ? "pi" : "local";
      const modelId = typeof item.modelId === "string" && item.modelId.trim() ? item.modelId.trim() : "local-draft";
      const baseUrl = typeof item.baseUrl === "string" && item.baseUrl.trim() ? item.baseUrl.trim() : null;
      update.run(scene, provider, modelId, baseUrl);
    }
  });
  tx();
  const rows = db.prepare("SELECT * FROM scene_routes").all() as {
    scene: string;
    provider: string;
    model_id: string;
    base_url: string | null;
  }[];
  return c.json({
    routes: rows.map((row) => ({
      scene: row.scene,
      provider: row.provider,
      modelId: row.model_id,
      baseUrl: row.base_url,
    })),
  });
});

async function main() {
  await initDb();
  reloadSkills();
  syncAllBooks();
  startJobWorker(Number(process.env.CHANGJUAN_JOB_INTERVAL_MS || 2500));

  const port = Number(process.env.PORT || 8787);
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    const dbInfo = getDbInfo();
    console.log(`长卷 API http://127.0.0.1:${info.port}  db=${dbInfo.driver}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
