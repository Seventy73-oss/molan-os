import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireAuth, type User } from "@eazo/sdk/server";
import { distillationReadiness } from "./appAi";
import { ReferenceError, requiredText } from "./errors";
import { cancelReferenceJob, createDistillation, createDownload } from "./jobs";
import { novelCatalog, searchNovels, SOURCE_NAME } from "./source";
import { approveCard, bindCard, chapterText, deleteSource, exportSource, importText, jobOwned, jobView, LIMITS, listReferences, sourceDetail } from "./store";

export const referenceRoutes = new Hono<{ Variables: { referenceUser: User } }>();
const r = referenceRoutes;
const bursts = new Map<string, { at: number; count: number }>();
r.use("*", async (c, next) => {
  const auth = requireAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: "请登录 Eazo 后使用参考库", code: "authentication_required" }, 401);
  if (!auth.user.id || ["undefined", "null"].includes(auth.user.id)) return c.json({ error: "登录状态无效", code: "authentication_required" }, 401);
  c.set("referenceUser", auth.user);
  c.header("Cache-Control", "private, no-store");
  await next();
});
r.use("*", bodyLimit({ maxSize: 8_100_000, onError: c => c.json({ error: "请求超过 8 MB 限制", code: "request_too_large" }, 413) }));
r.use("*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) || ["/search", "/catalog"].includes(c.req.path.replace(/^\/api\/references/, ""))) {
    const owner = c.get("referenceUser").id; const t = Date.now(); const hit = bursts.get(owner);
    if (!hit || t - hit.at > 60000) { if (bursts.size > 1000) bursts.clear(); bursts.set(owner, { at: t, count: 1 }); }
    else if (++hit.count > 90) return c.json({ error: "操作太频繁，请稍后重试", code: "rate_limited" }, 429);
  }
  await next();
});
r.onError((error, c) => {
  if (error instanceof ReferenceError) return c.json({ error: error.message, code: error.code }, error.status as 400);
  // Reference endpoints never leak raw network/provider/internal exceptions.
  return c.json({ error: "参考库处理失败，请稍后重试", code: "reference_failed" }, 500);
});
async function jsonBody(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await req.json(); } catch { throw new ReferenceError(400, "invalid_json", "请求内容不是有效 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReferenceError(400, "invalid_json", "请求格式不正确");
  const object = value as Record<string, unknown>;
  for (const key of ["model_key", "modelKey", "baseUrl", "apiKey", "ownerId", "userId", "viewer_user_id"]) {
    if (key in object) throw new ReferenceError(400, "server_owned_field", "身份和模型配置只能由服务端确定");
  }
  return object;
}
r.get("/", c => c.json({ ...listReferences(c.get("referenceUser").id), ai: distillationReadiness(), limits: LIMITS, sourceName: SOURCE_NAME }));
r.get("/search", async c => c.json({ books: await searchNovels(requiredText(c.req.query("q"), 80, "搜索词"), c.req.raw.signal), sourceName: SOURCE_NAME }));
r.get("/catalog", async c => c.json(await novelCatalog(requiredText(c.req.query("url"), 500, "目录地址"), c.req.raw.signal)));
r.post("/import", async c => c.json(importText(c.get("referenceUser").id, await jsonBody(c.req)), 201));
r.post("/download", async c => {
  const body = await jsonBody(c.req);
  return c.json(await createDownload(c.get("referenceUser").id, requiredText(body.url, 500, "目录地址"), body.chapterUrls, body.rightsConfirmed === true), 202);
});
r.get("/sources/:id", c => c.json(sourceDetail(c.get("referenceUser").id, c.req.param("id"))));
r.get("/sources/:id/chapters/:chapterId", c => c.json(chapterText(c.get("referenceUser").id, c.req.param("id"), c.req.param("chapterId"))));
r.get("/sources/:id/export", c => {
  const out = exportSource(c.get("referenceUser").id, c.req.param("id"));
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="reference.txt"; filename*=UTF-8''${encodeURIComponent(out.title.replace(/[\r\n]/g, "").slice(0, 80))}.txt`);
  return c.body(out.text);
});
r.delete("/sources/:id", c => { deleteSource(c.get("referenceUser").id, c.req.param("id")); return c.json({ ok: true }); });
r.post("/sources/:id/distill", async c => {
  const body = await jsonBody(c.req);
  return c.json(createDistillation(c.get("referenceUser").id, c.req.param("id"), body.chapterIds, body.focus), 202);
});
r.get("/jobs/:id", c => c.json(jobView(jobOwned(c.get("referenceUser").id, c.req.param("id")))));
r.post("/jobs/:id/cancel", c => c.json(cancelReferenceJob(c.get("referenceUser").id, c.req.param("id"))));
r.patch("/cards/:id", async c => {
  const body = await jsonBody(c.req);
  if (typeof body.approved !== "boolean") throw new ReferenceError(400, "invalid_input", "需要明确审阅状态");
  return c.json(approveCard(c.get("referenceUser").id, c.req.param("id"), body.approved));
});
r.put("/cards/:id/books/:bookId", async c => {
  const body = await jsonBody(c.req);
  if (typeof body.enabled !== "boolean") throw new ReferenceError(400, "invalid_input", "需要明确引用状态");
  return c.json(bindCard(c.get("referenceUser").id, c.req.param("id"), c.req.param("bookId"), body.enabled, body.shareConfirmed === true));
});
