import { randomUUID } from "node:crypto";
import { db } from "../db";
import { distillChat, distillationReadiness } from "./appAi";
import { chunkChapters, distillMessages, parseDistillation } from "./distill";
import { ReferenceError } from "./errors";
import { fetchSource, novelCatalog, parseChapter, type RemoteChapter } from "./source";
import { addSourceChapter, CARD_KINDS, createSource, jobOwned, jobView, LIMITS, now, sourceOwned, type CardKind, type ChapterRow, type JobRow } from "./store";

const active = new Map<string, AbortController>();
function assertCapacity(owner: string) {
  if (db.prepare("SELECT id FROM novel_jobs WHERE owner_id = ? AND status IN ('running', 'queued')").get(owner)) throw new ReferenceError(409, "job_running", "请先完成或取消当前任务");
  const count = db.prepare("SELECT COUNT(*) AS n FROM novel_jobs WHERE status IN ('running', 'queued')").get() as { n: number };
  if (Number(count.n) >= 2 || active.size >= 2) throw new ReferenceError(429, "worker_busy", "参考处理队列已满，请稍后重试");
  const day = new Date(Date.now() - 86400000).toISOString();
  const daily = db.prepare("SELECT COUNT(*) AS n FROM novel_jobs WHERE owner_id = ? AND created_at > ?").get(owner, day) as { n: number };
  const global = db.prepare("SELECT COUNT(*) AS n FROM novel_jobs WHERE created_at > ?").get(day) as { n: number };
  if (Number(daily.n) >= LIMITS.dailyJobs || Number(global.n) >= 60) throw new ReferenceError(429, "daily_limit", "已达今日参考处理上限，请明天再试");
}
function insertJob(owner: string, sourceId: string, kind: "download" | "distill", selection: unknown[], focus: string[], total: number) {
  const id = randomUUID(); const at = now();
  db.prepare("INSERT INTO novel_jobs (id, owner_id, source_id, kind, status, selection_json, focus_json, progress, total, error, model_label, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, '', ?, 0, ?, ?)")
    .run(id, owner, sourceId, kind, JSON.stringify(selection), JSON.stringify(focus), total, kind === "distill" ? distillationReadiness().modelLabel : "", at, at);
  return jobOwned(owner, id);
}
function selectedChapters(owner: string, sourceId: string, ids: unknown): ChapterRow[] {
  sourceOwned(owner, sourceId);
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== "string")) throw new ReferenceError(400, "invalid_selection", "请选择 1 至 200 章");
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new ReferenceError(400, "invalid_selection", "选择列表包含重复章节");
  const chapters = (db.prepare("SELECT * FROM novel_chapters WHERE source_id = ? AND owner_id = ? ORDER BY ordinal").all(sourceId, owner) as ChapterRow[]).filter(c => unique.has(c.id));
  if (chapters.length !== unique.size) throw new ReferenceError(404, "not_found", "部分章节不存在或无权访问");
  return chapters;
}
export function createDistillation(owner: string, sourceId: string, chapterIds: unknown, focuses: unknown) {
  if (!distillationReadiness().configured) throw new ReferenceError(503, "ai_not_configured", "蒸馏模型尚未配置");
  if (!Array.isArray(focuses) || !focuses.length || focuses.length > 4 || focuses.some(f => !CARD_KINDS.includes(f as CardKind))) throw new ReferenceError(400, "invalid_focus", "请选择开局、结构、节奏或文风");
  const chapters = selectedChapters(owner, sourceId, chapterIds); const chunks = chunkChapters(chapters);
  assertCapacity(owner);
  const row = insertJob(owner, sourceId, "distill", chapters.map(c => c.id), [...new Set(focuses)] as string[], chunks.length);
  launch(row); return jobView(row);
}
export async function createDownload(owner: string, url: string, selectedUrls: unknown, rights: boolean) {
  if (!rights) throw new ReferenceError(400, "rights_required", "请确认有权使用并分析所选内容");
  if (!Array.isArray(selectedUrls) || !selectedUrls.length || selectedUrls.length > LIMITS.downloadChapters || selectedUrls.some(x => typeof x !== "string")) throw new ReferenceError(400, "invalid_selection", "每次可下载 1 至 200 章");
  assertCapacity(owner);
  const catalog = await novelCatalog(url);
  const unique = new Set(selectedUrls); const selected = catalog.chapters.filter(c => unique.has(c.url));
  if (selected.length !== unique.size) throw new ReferenceError(400, "invalid_selection", "只能下载当前目录中实际存在的章节");
  assertCapacity(owner);
  const row = db.transaction(() => {
    const source = createSource(owner, { title: catalog.title, author: catalog.author, originKind: "web", sourceUrl: catalog.url, note: "用户确认有权使用；第三方 HTTP 书源，内容待自行核对" });
    return insertJob(owner, source.id, "download", selected, [], selected.length);
  })();
  launch(row); return jobView(row);
}

function checkpoint(row: JobRow, signal: AbortSignal) {
  const current = jobOwned(row.owner_id, row.id);
  if (signal.aborted || current.status === "cancelled") throw new ReferenceError(409, "cancelled", "任务已取消");
  sourceOwned(row.owner_id, row.source_id);
}
function launch(row: JobRow) {
  const controller = new AbortController(); active.set(row.id, controller);
  // Persist before expensive work, then detach from the request. Polling reflects completed chunks, not fake token streaming.
  void Promise.resolve().then(async () => {
    await db.flush();
    checkpoint(row, controller.signal);
    db.prepare("UPDATE novel_jobs SET status = 'running', updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'queued'").run(now(), row.id, row.owner_id);
    await db.flush();
    if (row.kind === "download") await runDownload(row, controller.signal);
    else await runDistillation(row, controller.signal);
    checkpoint(row, controller.signal);
    db.prepare("UPDATE novel_jobs SET status = 'completed', updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'running'").run(now(), row.id, row.owner_id);
    await db.flush();
  }).catch(async (error: unknown) => {
    const code = error instanceof ReferenceError ? error.code : "job_failed";
    const cancelled = controller.signal.aborted || code === "cancelled";
    // Never persist arbitrary provider/network exception bodies or credentials.
    const message = error instanceof ReferenceError ? error.message : "处理失败，已完成部分保留，可减少选章后重试";
    db.prepare("UPDATE novel_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status IN ('running', 'queued')")
      .run(cancelled ? "cancelled" : "failed", `${code}: ${message}`, now(), row.id, row.owner_id);
    await db.flush().catch(() => undefined);
  }).finally(() => { active.delete(row.id); });
}
async function runDownload(row: JobRow, signal: AbortSignal) {
  const selected = JSON.parse(row.selection_json) as RemoteChapter[];
  for (let i = 0; i < selected.length; i++) {
    checkpoint(row, signal); const chapter = selected[i]!;
    const body = parseChapter(await fetchSource(chapter.url, signal));
    checkpoint(row, signal);
    db.transaction(() => {
      addSourceChapter(row.owner_id, row.source_id, { ...chapter, body });
      db.prepare("UPDATE novel_jobs SET progress = ?, updated_at = ? WHERE id = ? AND owner_id = ?").run(i + 1, now(), row.id, row.owner_id);
    })();
    await db.flush();
    if (i + 1 < selected.length) await new Promise(resolve => setTimeout(resolve, 500));
  }
}
async function runDistillation(row: JobRow, signal: AbortSignal) {
  const chapters = selectedChapters(row.owner_id, row.source_id, JSON.parse(row.selection_json));
  const source = sourceOwned(row.owner_id, row.source_id); const focus = JSON.parse(row.focus_json) as CardKind[];
  const chunks = chunkChapters(chapters);
  for (let i = 0; i < chunks.length; i++) {
    checkpoint(row, signal); const chunk = chunks[i]!;
    const result = await distillChat({ viewerUserId: row.owner_id, messages: distillMessages(source.title, chunk, focus), signal });
    checkpoint(row, signal);
    // Record charged usage even if schema/evidence validation subsequently rejects the output.
    db.prepare("UPDATE novel_jobs SET tokens = tokens + ?, updated_at = ? WHERE id = ? AND owner_id = ?").run(result.tokens, now(), row.id, row.owner_id);
    await db.flush();
    const cards = parseDistillation(result.text, chunk, focus);
    checkpoint(row, signal);
    db.transaction(() => {
      for (const card of cards) {
        db.prepare("INSERT INTO novel_cards (id, owner_id, source_id, job_id, kind, title, principle, application, caution, evidence_json, stages_json, approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
          .run(randomUUID(), row.owner_id, row.source_id, row.id, card.kind, card.title, card.principle, card.application, card.caution, JSON.stringify(card.evidence), JSON.stringify(card.stages), now());
      }
      db.prepare("UPDATE novel_jobs SET progress = ?, updated_at = ? WHERE id = ? AND owner_id = ?").run(i + 1, now(), row.id, row.owner_id);
    })();
    await db.flush();
  }
}

export function cancelReferenceJob(owner: string, id: string) {
  const row = jobOwned(owner, id);
  if (["queued", "running"].includes(row.status)) {
    db.prepare("UPDATE novel_jobs SET status = 'cancelled', error = '已取消；已完成部分保留，已产生的模型用量不退回', updated_at = ? WHERE id = ? AND owner_id = ? AND status IN ('queued', 'running')").run(now(), id, owner);
    active.get(id)?.abort();
  }
  return jobView(jobOwned(owner, id));
}
export function recoverReferenceJobs() {
  // Restart is never an implicit authorization for another paid call.
  db.prepare("UPDATE novel_jobs SET status = 'interrupted', error = '服务已重启，未自动重试；已完成部分保留，请重新选择剩余内容', updated_at = ? WHERE status IN ('queued', 'running')").run(now());
}

