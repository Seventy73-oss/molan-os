/** API/security audit: isolated SQLite, ephemeral auth key, mocked App AI. No real model claims. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fixtureCompletion, fixtureKey, fixtureSession, ORIGINAL_TEXT, type MockMode } from "./reference-test-fixtures.mjs";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "molan-reference-audit-"));
const key = fixtureKey();
Object.assign(process.env, { MOLAN_SQLITE_PATH: path.join(out, "isolated.sqlite"), MOLAN_DATA_DIR: path.join(out, "data"), MOLAN_SECRET: "reference-isolated-audit-secret-only", DATABASE_URL: "", MOLAN_DB: "", EAZO_APP_ID: "isolated-audit-app", EAZO_PRIVATE_KEY: key, EAZO_AI_PROVIDER_MODE: "eazo", EAZO_AI_TEXT_MODEL_KEY: "qwen.qwen3.8-flash", EAZO_APP_AI_API_BASE: "https://app-ai.invalid" });
const { Hono } = await import("hono");
const { db, initDb } = await import("../src/db");
const { referenceRoutes } = await import("../src/references/routes");
const { referenceContext } = await import("../src/references/context");
const { recoverReferenceJobs } = await import("../src/references/jobs");
const { sourceUrl, parseChapter, parseCatalog, parseSearch, cleanHtml } = await import("../src/references/source");
const { chunkChapters, parseDistillation } = await import("../src/references/distill");
const { splitNovelText, hashText, jobOwned } = await import("../src/references/store");
const { buildContext } = await import("../src/engine");
await initDb();
const app = new Hono().route("/api/references", referenceRoutes);
const sessions = { alice: fixtureSession(key, "audit-alice"), bob: fixtureSession(key, "audit-bob"), carol: fixtureSession(key, "audit-carol") };
type Actor = keyof typeof sessions;
let passed = 0, mode: MockMode = "ok", calls = 0, callsInMode = 0;
const requestBodies: Record<string, unknown>[] = [];
function check(name: string, ok: unknown) { assert.ok(ok, name); passed++; console.log("PASS " + name); }
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  assert.equal(String(url), "https://app-ai.invalid/api/app-ai/chat", "Audit forbids non-fixture network");
  calls++; callsInMode++; const body = JSON.parse(String(init?.body)) as Record<string, unknown>; requestBodies.push(body);
  const callMode = mode, part = callsInMode;
  assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${key}`);
  if (callMode === "credit") return new Response('{"detail":{"code":"app_ai_unavailable"},"private":"do-not-leak-upstream"}', { status: 402 });
  if (callMode === "network") throw new Error("do-not-leak-upstream");
  if (callMode === "huge") return new Response("x".repeat(520000));
  if (callMode === "slow" || (callMode === "partial" && part > 1)) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 2000);
    const signal = init?.signal;
    const stop = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
  });
  return Response.json(fixtureCompletion(body, callMode));
}) as typeof fetch;
async function req(route: string, method = "GET", data?: unknown, actor: Actor = "alice") {
  return app.request(`/api/references${route === "/" ? "" : route}`, { method, headers: { "x-eazo-session": sessions[actor], "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
}
async function json(route: string, method = "GET", data?: unknown, actor: Actor = "alice"): Promise<any> { const r = await req(route, method, data, actor); assert.ok(r.ok, `${method} ${route} failed ${r.status}`); return r.json(); }
async function waitJob(id: string, actor: Actor = "alice") {
  for (let i = 0; i < 150; i++) { const job = await json(`/jobs/${id}`, "GET", undefined, actor); if (!["queued", "running"].includes(job.status)) { await new Promise(r => setTimeout(r, 8)); return job; } await new Promise(r => setTimeout(r, 15)); }
  throw Error("Fixture job did not settle");
}
function setMode(next: MockMode) { mode = next; callsInMode = 0; }
async function start(source: any, actor: Actor = "alice") { return json(`/sources/${source.source.id}/distill`, "POST", { chapterIds: source.chapters.map((c: any) => c.id), focus: ["opening", "structure", "pacing", "style"] }, actor); }
const input = { title: "原创审计片段", author: "测试作者", text: ORIGINAL_TEXT, rightsConfirmed: true };
try {
  check("anonymous denied", (await app.request("/api/references/")).status === 401);
  check("malformed session denied", (await app.request("/api/references/", { headers: { "x-eazo-session": "{}" } })).status === 401);
  check("wrong app key denied", (await app.request("/api/references/", { headers: { "x-eazo-session": fixtureSession(fixtureKey(), "audit-alice") } })).status === 401);
  check("invalid user identity denied", (await app.request("/api/references/", { headers: { "x-eazo-session": fixtureSession(key, "undefined") } })).status === 401);
  const initial = await req("/"); check("private responses no-store", initial.headers.get("cache-control") === "private, no-store");
  check("starts empty and configured", ((await initial.json()) as any).sources.length === 0);
  for (const field of ["ownerId", "userId", "viewer_user_id", "model_key", "modelKey", "baseUrl", "apiKey"]) check(`browser ${field} rejected`, (await req("/import", "POST", { ...input, [field]: "untrusted" })).status === 400);
  check("rights confirmation required", (await req("/import", "POST", { ...input, rightsConfirmed: false })).status === 400);
  check("binary executable rejected", (await req("/import", "POST", { ...input, text: "MZ" + "x".repeat(200) })).status === 400);
  check("short text rejected", (await req("/import", "POST", { ...input, text: "too short" })).status === 400);
  check("oversized text rejected", (await req("/import", "POST", { ...input, text: "字".repeat(2000001) })).status === 400);
  const source = await json("/import", "POST", input);
  check("import splits chapters without model calls", source.chapters.length === 2 && calls === 0 && source.cards.length === 0);
  check("no manuscript created by import", (db.prepare("SELECT COUNT(*) AS n FROM books").get() as any).n === 0);
  check("detail does not return source bodies or owner", !JSON.stringify(source).includes("body") && !JSON.stringify(source).includes("owner_id"));
  check("private text only through owned chapter route", (await json(`/sources/${source.source.id}/chapters/${source.chapters[0].id}`)).body.includes("旧站台"));
  const exported = await req(`/sources/${source.source.id}/export`); check("owned TXT export", (await exported.text()).includes("旧站台") && exported.headers.get("content-type")?.includes("text/plain"));
  for (const suffix of ["", "/export", `/chapters/${source.chapters[0].id}`]) {
    const cross = await req(`/sources/${source.source.id}${suffix}`, "GET", undefined, "bob"), missing = await req(`/sources/not-found${suffix}`, "GET", undefined, "bob");
    check(`cross-user read ${suffix || "detail"} indistinguishable`, cross.status === 404 && await cross.text() === await missing.text());
  }
  check("cross-user delete denied", (await req(`/sources/${source.source.id}`, "DELETE", undefined, "bob")).status === 404);
  check("cross-user selection denied", (await req(`/sources/${source.source.id}/distill`, "POST", { chapterIds: [source.chapters[0].id], focus: ["opening"] }, "bob")).status === 404);
  check("duplicate selection rejected", (await req(`/sources/${source.source.id}/distill`, "POST", { chapterIds: [source.chapters[0].id, source.chapters[0].id], focus: ["opening"] })).status === 400);
  const job = await start(source); const completed = await waitJob(job.id);
  check("job completes with real persisted progress (mock AI)", completed.status === "completed" && completed.progress === 1 && completed.tokens === 321 && calls === 1);
  check("fixed model and authenticated billing identity", requestBodies[0]!.model_key === "qwen.qwen3.8-flash" && requestBodies[0]!.viewer_user_id === "audit-alice" && requestBodies[0]!.stream === false);
  const detail = await json(`/sources/${source.source.id}`); check("cards start unapproved and unlinked", detail.cards.length === 4 && detail.cards.every((c: any) => !c.approved && c.bookIds.length === 0));
  for (const card of detail.cards) { const e = card.evidence[0]; const chapter = await json(`/sources/${source.source.id}/chapters/${e.chapterId}`); check(`exact evidence/range/hash ${card.kind}`, chapter.body.slice(e.from, e.to) === e.quote && hashText(chapter.body) === e.hash); }
  const bid = randomUUID(); db.prepare("INSERT INTO books (id, title, created_at) VALUES (?, ?, ?)").run(bid, "隔离测试书稿", new Date().toISOString());
  const styleCard = detail.cards.find((c: any) => c.kind === "style");
  check("unreviewed card cannot bind", (await req(`/cards/${styleCard.id}/books/${bid}`, "PUT", { enabled: true, shareConfirmed: true })).status === 409);
  check("unapproved absent from context", referenceContext(bid, "chapter_body").count === 0);
  check("cross-user card mutation denied", (await req(`/cards/${styleCard.id}`, "PATCH", { approved: true }, "bob")).status === 404);
  check("cross-user job denied", (await req(`/jobs/${job.id}`, "GET", undefined, "bob")).status === 404);
  check("cross-user cancellation denied", (await req(`/jobs/${job.id}/cancel`, "POST", undefined, "bob")).status === 404);
  await json(`/cards/${styleCard.id}`, "PATCH", { approved: true });
  check("review alone not enough for context", referenceContext(bid, "chapter_body").count === 0);
  check("shared-workspace consent required", (await req(`/cards/${styleCard.id}/books/${bid}`, "PUT", { enabled: true })).status === 400);
  await json(`/cards/${styleCard.id}/books/${bid}`, "PUT", { enabled: true, shareConfirmed: true });
  check("approved linked style enters matching scene", referenceContext(bid, "chapter_body").count === 1 && referenceContext(bid, "outline").count === 0);
  check("memory extraction never uses references", referenceContext(bid, "memory_extract").text === "");
  const ctx = buildContext(bid, 1, "写一个原创场景", { scene: "chapter_body", persist: false });
  check("Agent receives method, not raw source or quote", ctx.includes(styleCard.principle) && ctx.includes("非本书事实") && !ctx.includes(styleCard.evidence[0].quote));
  check("author instruction follows reference data", ctx.indexOf("【作者指令】") > ctx.indexOf("【外部写作方法参考"));
  await json(`/cards/${styleCard.id}`, "PATCH", { approved: false });
  check("revocation immediately removes all links", referenceContext(bid, "chapter_body").count === 0 && (await json(`/sources/${source.source.id}`)).cards.find((c: any) => c.id === styleCard.id).bookIds.length === 0);
  for (const [failure, code] of [["credit", "app_ai_unavailable"], ["invalid-json", "invalid_distillation"], ["false-evidence", "unverified_evidence"], ["truncated", "truncated_completion"], ["network", "ai_connection_failed"], ["huge", "ai_response_too_large"]] as const) {
    setMode(failure); const badJob = await start(source), failed = await waitJob(badJob.id);
    check(`${failure} visible and safe`, failed.status === "failed" && failed.error.includes(code) && !failed.error.includes("do-not-leak-upstream"));
    check(`${failure} creates no cards`, (await json(`/sources/${source.source.id}`)).cards.length === 4);
  }
  setMode("slow"); const slow = await start(source);
  check("one active job per user", (await req(`/sources/${source.source.id}/distill`, "POST", { chapterIds: [source.chapters[0].id], focus: ["opening"] })).status === 409);
  check("cannot delete source while active", (await req(`/sources/${source.source.id}`, "DELETE")).status === 409);
  await json(`/jobs/${slow.id}/cancel`, "POST"); const cancelled = await waitJob(slow.id);
  check("cancelled job stays cancelled", cancelled.status === "cancelled");
  check("no cards after cancellation", (await json(`/sources/${source.source.id}`)).cards.length === 4);
  const long = await json("/import", "POST", { ...input, title: "分块取消测试", text: ORIGINAL_TEXT.repeat(35) }, "bob");
  setMode("partial"); const partial = await start(long, "bob");
  for (let i = 0; i < 150; i++) { if ((await json(`/jobs/${partial.id}`, "GET", undefined, "bob")).progress >= 1) break; await new Promise(r => setTimeout(r, 10)); }
  await json(`/jobs/${partial.id}/cancel`, "POST", undefined, "bob"); const kept = await waitJob(partial.id, "bob");
  check("cancel preserves completed chunks without late saves", kept.progress === 1 && kept.status === "cancelled" && (await json(`/sources/${long.source.id}`, "GET", undefined, "bob")).cards.length === 4);
  const callsBeforeRecovery = calls;
  db.prepare("UPDATE novel_jobs SET status = 'running' WHERE id = ?").run(partial.id); recoverReferenceJobs();
  check("restart marks interrupted and never replays paid calls", jobOwned("audit-bob", partial.id).status === "interrupted" && calls === callsBeforeRecovery);
  const s3 = await json("/import", "POST", input, "carol");
  setMode("slow"); const a = await start(source), b = await start(long, "bob");
  check("global concurrency capped", (await req(`/sources/${s3.source.id}/distill`, "POST", { chapterIds: s3.chapters.map((c: any) => c.id), focus: ["opening"] }, "carol")).status === 429);
  await json(`/jobs/${a.id}/cancel`, "POST"); await json(`/jobs/${b.id}/cancel`, "POST", undefined, "bob"); await waitJob(a.id); await waitJob(b.id, "bob");
  // A source deletion must not erase the rolling usage audit or reset quotas.
  const usageBefore = (db.prepare("SELECT COUNT(*) AS n FROM novel_jobs WHERE owner_id = 'audit-bob'").get() as any).n;
  await json(`/sources/${long.source.id}`, "DELETE", undefined, "bob");
  check("delete removes private text, cards and UI history", (await json("/", "GET", undefined, "bob")).sources.length === 0 && (await json("/", "GET", undefined, "bob")).jobs.length === 0 && (db.prepare("SELECT COUNT(*) AS n FROM novel_chapters WHERE source_id = ?").get(long.source.id) as any).n === 0);
  check("delete cannot reset paid-call quotas", (db.prepare("SELECT COUNT(*) AS n FROM novel_jobs WHERE owner_id = 'audit-bob'").get() as any).n === usageBefore && (db.prepare("SELECT selection_json FROM novel_jobs WHERE id = ?").get(partial.id) as any).selection_json === "[]");
  // Synthetic quota history exists only in this isolated database.
  const at = new Date().toISOString();
  for (let i = 0; i < 20; i++) db.prepare("INSERT INTO novel_jobs (id,owner_id,source_id,kind,status,selection_json,total,created_at,updated_at) VALUES (?,?,?,'distill','failed','[]',1,?,?)").run(randomUUID(), "audit-carol", s3.source.id, at, at);
  check("daily quota enforced", (await req(`/sources/${s3.source.id}/distill`, "POST", { chapterIds: s3.chapters.map((c: any) => c.id), focus: ["opening"] }, "carol")).status === 429);
  // Pure validation and source parser checks; no source site or credential network.
  for (const url of ["http://127.0.0.1/book/1/", "http://www.shukuge.com.evil.test/book/1/", "file:///etc/passwd", "http://u:p@www.shukuge.com/book/1/", "http://www.shukuge.com:8080/book/1/", "http://www.shukuge.com/download/1/", "http://www.shukuge.com/book/1/?redirect=evil", "http://www.shukuge.com/book/1/#x"]) check(`SSRF / unsupported URL rejected ${passed}`, (() => { try { sourceUrl(url); return false; } catch { return true; } })());
  check("fixed book, catalog and chapter paths accepted", sourceUrl("/book/1/", "book").pathname === "/book/1/" && sourceUrl("/book/1/index.html").pathname.endsWith("index.html") && sourceUrl("/book/1/2.html", "chapter").pathname.endsWith("2.html"));
  check("HTML script removed and entities decoded", cleanHtml('<script>alert(1)</script><p>A&amp;B</p><br>&#x4e00;') === "A&B\n\n一");
  const nested = `<div id="content"><div class="bottem1">上一章</div><div id="content"><p>${"雨水落在窗台，修表人关上门。".repeat(15)}</p><script>alert(1)</script></div></div>`;
  check("nested chapter parser ignores navigation/script", parseChapter(nested).startsWith("雨水") && !parseChapter(nested).includes("上一章") && !parseChapter(nested).includes("alert"));
  check("restricted / placeholder chapter not downloaded", (() => { try { parseChapter('<div id="content">根据相关法律法规和政策，此章节未予显示。正在手打中，请稍等片刻。</div>'); return false; } catch (e) { return (e as any).code === "source_restricted"; } })());
  const parsedCatalog = parseCatalog('<h1>测试书最新章节</h1><dd><a href="/book/1/2.html">第一章</a></dd><dd><a href="/book/2/3.html">外书</a></dd><dd><a href="/book/1/2.html">重复</a></dd>', 'http://www.shukuge.com/book/1/');
  check("catalog normalizes title, deduplicates and rejects other book", parsedCatalog.title === "测试书" && parsedCatalog.chapters.length === 1);
  check("search only accepts source book links", parseSearch('<div class="listitem clearfix"><a href="/book/1/"><h2>测试书</h2></a>作者：甲<div class="listitem clearfix"><a href="https://evil.test/"><h2>假书</h2></a>').length === 1);
  check("chapter splitter normalizes BOM and line endings", splitNovelText("\uFEFF" + ORIGINAL_TEXT.replace(/\n/g, "\r\n")).length === 2);
  const chapter = { id: "chunk-fixture", owner_id: "audit", source_id: "source", ordinal: 1, title: "分片", body: "字".repeat(16001), source_url: "", char_count: 16001, content_hash: createHash("sha256").update("字".repeat(16001)).digest("hex") };
  const chunks = chunkChapters([chapter]);
  check("chunking loses no characters or ranges", chunks.length === 3 && chunks.reduce((n, c) => n + c.chars, 0) === 16001 && chunks[2]!.segments[0]!.from === 16000 && chunks[2]!.segments[0]!.to === 16001);
  check("budget overflow rejects instead of truncating", (() => { try { chunkChapters([{ ...chapter, body: "字".repeat(48001) }]); return false; } catch { return true; } })());
  check("strict evidence refuses fabricated text", (() => { try { parseDistillation(JSON.stringify({ cards: [{ kind: "opening", segment: 1, quote: "虚构内容不属于原文" }] }), chunks[0]!, ["opening"]); return false; } catch (e) { return (e as any).code === "unverified_evidence"; } })());
  await json(`/cards/${styleCard.id}`, "PATCH", { approved: true }); await json(`/cards/${styleCard.id}/books/${bid}`, "PUT", { enabled: true, shareConfirmed: true });
  await json(`/cards/${styleCard.id}/books/${bid}`, "PUT", { enabled: false }); check("unlink immediately removes agent reference", referenceContext(bid, "chapter_body").count === 0);
  await json(`/cards/${styleCard.id}/books/${bid}`, "PUT", { enabled: true, shareConfirmed: true });
  await json(`/sources/${source.source.id}`, "DELETE"); check("delete removes links but never manuscript", referenceContext(bid, "chapter_body").count === 0 && Boolean(db.prepare("SELECT id FROM books WHERE id = ?").get(bid)));
} finally { globalThis.fetch = originalFetch; await new Promise(r => setTimeout(r, 80)); await db.close(); }
console.log(`${passed}/${passed} reference checks passed; mocked AI, isolated database.`);
