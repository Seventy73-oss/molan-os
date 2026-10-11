/** Additional full-chain scenarios. Only called by the isolated browser audit. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import type { Page } from "playwright";
import { ORIGINAL_TEXT } from "./reference-test-fixtures.mjs";

type Api = (route: string, method?: string, body?: unknown) => Promise<any>;
type Check = (label: string, ok: unknown) => void;
export type WritingCapture = { model: string; messages: { role: string; content: string }[] };
export const WRITING_TEXT = "清晨，测绘员把昨日的街区图铺在桌上，先比对新旧两张图的比例尺，再逐一核对街角的编号。他发现一条巷子的刻度与记录不符。与其贸然重画，他决定带着量尺回到现场，亲手确认墙上的旧标记。";

export function writingFixture(body: WritingCapture) {
  const scene = body.model.replace("audit-", "");
  const content = scene === "outline" ? "1. 重量现场\n测绘员先核对地图，再前往现场确认差异。"
    : scene === "chapter_outline" ? "第1章 重量现场\n场景一：比对比例尺。场景二：发现编号异常。场景三：亲自丈量。"
    : scene === "review" ? "细节建议：补充测量时的物件触感，不改变已有事实。"
    : scene === "memory_extract" ? "测绘员核对两张街区图，发现巷子刻度不符，决定前往现场丈量。"
    : scene === "chat" ? "可先建立日常基准，再用一个异常推动角色核对与行动。"
    : WRITING_TEXT;
  return { choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 80, completion_tokens: 50, total_tokens: 130 } };
}

export async function fileImportChecks(page: Page, api: Api, check: Check, getAiCalls: () => number) {
  const calls = getAiCalls();
  await page.getByRole("button", { name: "导入文本", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "not-text.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ test binary rejected") });
  await page.getByRole("alert").waitFor();
  check("browser rejects executable file without uploading or calling AI", (await page.getByRole("alert").innerText()).includes("TXT") && getAiCalls() === calls);
  const gbText = ORIGINAL_TEXT.replaceAll("雨夜", "编码");
  const gb = execFileSync("python3", ["-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read().decode('utf-8').encode('gb18030'))"], { input: gbText });
  for (const file of [
    { name: "完整链路-UTF8.md", mimeType: "text/markdown", buffer: Buffer.from("\uFEFF" + ORIGINAL_TEXT.replace(/^第/gm, "## 第").replaceAll("\n", "\r\n")), title: "完整链路-UTF8", marker: "雨停的时候" },
    { name: "完整链路-GB18030.txt", mimeType: "text/plain", buffer: gb, title: "完整链路-GB18030", marker: "旧站台" },
  ]) {
    await page.getByRole("button", { name: "导入文本", exact: true }).click();
    await page.getByLabel("资料标题").fill("");
    await page.locator('input[type="file"]').setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
    await page.waitForFunction(`document.querySelector('.ref-fields input')?.value === ${JSON.stringify(file.title)}`);
    check(`${file.title} decoded without replacement characters`, (await page.getByLabel("或粘贴原文").inputValue()).includes(file.marker) && !(await page.getByLabel("或粘贴原文").inputValue()).includes("\uFFFD"));
    await page.getByLabel("我有权使用并分析这些内容；只提炼写作方法，不复制原作。").check();
    await page.getByRole("button", { name: "导入并选择章节" }).click();
    await page.locator(".ref-reader-head h2").filter({ hasText: file.title }).waitFor();
    const source = (await api("/api/references")).sources.find((s: any) => s.title === file.title);
    const detail = await api(`/api/references/sources/${source.id}`);
    check(`${file.title} imports two chapters through browser and persists`, detail.chapters.length === 2 && getAiCalls() === calls);
    await api(`/api/references/sources/${source.id}`, "DELETE");
  }
  await page.reload(); await page.locator(".ref-source").filter({ hasText: "审计用原创短篇" }).click();
  await page.locator(".ref-reader-head h2").filter({ hasText: "审计用原创短篇" }).waitFor();
}

export async function sourceSearchChecks(page: Page, api: Api, check: Check, bookId: string, captures: WritingCapture[], getAiCalls: () => number) {
  const beforeDownload = getAiCalls();
  await page.getByRole("button", { name: "搜索小说", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索书名或作者", exact: true }).fill("水浒传");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const book = page.locator(".ref-search-result").filter({ has: page.locator("strong", { hasText: /^水浒传$/ }) }).first();
  await book.waitFor({ timeout: 45000 }); await book.click();
  await page.locator(".ref-catalog h2").filter({ hasText: /^水浒传$/ }).waitFor({ timeout: 45000 });
  check("real source UI search opens chapter catalog", await page.locator(".ref-catalog .ref-chapter-list input").count() >= 100);
  const button = page.getByRole("button", { name: "下载到私人参考库", exact: true });
  check("source UI download is gated before chapter and rights selection", await button.isDisabled());
  await page.locator(".ref-catalog .ref-chapter-list input").first().check();
  check("source UI chapter selection still requires rights", await button.isDisabled());
  await page.getByLabel("我有权使用并分析这些内容；只提炼写作方法，不复制原作。").check();
  await button.click(); await page.locator(".ref-reader-head h2").filter({ hasText: /^水浒传$/ }).waitFor({ timeout: 45000 });
  let source: any, detail: any, job: any;
  for (let i = 0; i < 120; i++) {
    const index = await api("/api/references"); source = index.sources.find((s: any) => s.title === "水浒传");
    job = index.jobs.find((j: any) => j.sourceId === source?.id && j.kind === "download");
    if (job && !["queued", "running"].includes(job.status)) break;
    await new Promise(r => setTimeout(r, 400));
  }
  assert.equal(job?.status, "completed", "real source download job completes");
  detail = await api(`/api/references/sources/${source.id}`);
  await page.locator(".ref-chapter-list input").first().waitFor();
  check("UI search-to-download persists exactly the selected real chapter", detail.chapters.length === 1 && detail.chapters[0].charCount > 1000 && await page.locator(".ref-chapter-list input").count() === 1);
  const original = await api(`/api/references/sources/${source.id}/chapters/${detail.chapters[0].id}`);
  check("downloaded chapter is readable source text, not navigation", original.body.length > 1000 && !original.body.includes("未予显示"));
  check("real source download itself never invokes a model", getAiCalls() === beforeDownload);
  // Extend the exact downloaded source through distillation, review, binding and writing.
  for (const label of ["开局", "结构", "节奏"]) await page.locator(".ref-focus").getByLabel(label, { exact: true }).uncheck();
  await page.getByRole("button", { name: "用 Qwen3.8 Flash 蒸馏", exact: true }).click();
  await page.locator(".ref-method-card").first().waitFor({ timeout: 15000 });
  detail = await api(`/api/references/sources/${source.id}`);
  check("real downloaded chapter reaches mock distillation through UI selection", getAiCalls() === beforeDownload + 1 && detail.cards.length === 1 && detail.cards[0].kind === "style" && detail.cards[0].evidence[0].chapterId === detail.chapters[0].id);
  const card = detail.cards[0];
  check("download-chain method evidence matches stored original range", original.body.slice(card.evidence[0].from, card.evidence[0].to) === card.evidence[0].quote);
  await page.getByLabel("供哪本书的 Agent 参考？").selectOption(bookId);
  await page.locator(".ref-method-card").getByRole("button", { name: "审阅通过", exact: true }).click();
  await page.locator(".ref-method-card").getByRole("button", { name: "撤回审阅", exact: true }).waitFor();
  await page.getByLabel("我同意将选中的方法卡提供给当前单实例写作工作区；原文仍私有。").check();
  await page.locator(".ref-method-card").getByRole("button", { name: "供本书参考", exact: true }).click();
  await page.locator(".ref-method-card").getByRole("button", { name: "已供本书参考 · 取消", exact: true }).waitFor();
  const beforeWriting = captures.length;
  const result = await api(`/api/books/${bookId}/scene-runs`, "POST", { scene: "humanize", chapterNumber: 1, instruction: "仅借鉴方法，不照抄外部原文。" });
  const request = captures.slice(beforeWriting).find(c => c.model === "audit-humanize"); assert.ok(request);
  const prompt = request.messages.map(m => m.content).join("\n");
  check("search-download-distill-review-bind-write chain reaches adapter with source method only", prompt.includes(card.id) && prompt.includes("水浒传") && !prompt.includes(card.evidence[0].quote) && !prompt.includes(original.body) && Boolean(result.saved?.revisionId));
  const sourceEntry = page.locator(".ref-source").filter({ has: page.locator("strong", { hasText: /^水浒传$/ }) });
  assert.equal(await sourceEntry.count(), 1, "the source being deleted is visibly present");
  await page.getByRole("button", { name: "删除来源", exact: true }).click();
  const deleteResponse = page.waitForResponse(r => r.request().method() === "DELETE" && r.url().endsWith(`/api/references/sources/${source.id}`));
  await page.getByRole("button", { name: "确认删除来源", exact: true }).click();
  assert.ok((await deleteResponse).ok(), "source DELETE acknowledged before next writer request");
  await sourceEntry.waitFor({ state: "detached" });
  const afterDelete = captures.length;
  await api(`/api/books/${bookId}/scene-runs`, "POST", { scene: "humanize", chapterNumber: 1 });
  const next = captures.slice(afterDelete).find(c => c.model === "audit-humanize"); assert.ok(next);
  check("UI source deletion removes method from next writer call without deleting manuscript", next.messages.every(m => !m.content.includes(card.id)) && Boolean((await api(`/api/books/${bookId}`)).book));
}

export async function writingChainChecks(input: { page: Page; api: Api; check: Check; bookId: string; sourceId: string; sqlite: string; captures: WritingCapture[] }) {
  const { page, api, check, bookId: bid, sourceId: sid, sqlite, captures } = input;
  assert.ok(sqlite.startsWith("/tmp/molan-reference-browser-") && sqlite.endsWith("/isolated.sqlite"), "only isolated database may be inspected");
  const db = new Database(sqlite, { readonly: true });
  try {
    const detail = await api(`/api/references/sources/${sid}`);
    const cards = detail.cards as any[];
    const style = cards.find(c => c.kind === "style"); assert.ok(style);
    const facts = () => (db.prepare("SELECT COUNT(*) AS n FROM story_facts WHERE book_id = ?").get(bid) as { n: number }).n;
    const bible = () => (db.prepare("SELECT COUNT(*) AS n FROM bible_cards WHERE book_id = ?").get(bid) as { n: number }).n;
    const initialFacts = facts(), initialBible = bible();
    for (const c of cards) {
      if (!c.approved) await api(`/api/references/cards/${c.id}`, "PATCH", { approved: true });
      if (!c.bookIds.includes(bid)) await api(`/api/references/cards/${c.id}/books/${bid}`, "PUT", { enabled: true, shareConfirmed: true });
    }
    const scenes = ["outline", "chapter_outline", "chapter_body", "review", "humanize", "memory_extract", "chat"];
    await api("/api/scene-routes", "PUT", { routes: scenes.map(scene => ({ scene, provider: "openai", modelId: `audit-${scene}`, thinkingIntensity: "off" })) });
    const snapshot = (scene: string) => db.prepare("SELECT rendered_text, manifest_json FROM context_snapshots WHERE book_id = ? AND scene = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(bid, scene) as { rendered_text: string; manifest_json: string };
    async function run(scene: string, expectedCards: number) {
      const before = captures.length;
      const result = await api(`/api/books/${bid}/scene-runs`, "POST", { scene, chapterNumber: 1, instruction: "完整链路隔离验收：只写测绘员的原创街区故事，不能照搬参考来源。" });
      const request = captures.slice(before).find(c => c.model === `audit-${scene}`); assert.ok(request, `${scene} reached writing adapter HTTP endpoint`);
      const prompt = request.messages.map(m => m.content).join("\n");
      const snap = snapshot(scene); const manifest = JSON.parse(snap.manifest_json);
      check(`${scene} executes adapter and saves actual context with ${expectedCards} scene-filtered methods`, manifest.counts.references === expectedCards && (expectedCards ? prompt.includes("【外部写作方法参考 · 非本书事实】") : !prompt.includes("【外部写作方法参考 · 非本书事实】")));
      check(`${scene} adapter never receives raw source or evidence quote`, !prompt.includes(ORIGINAL_TEXT) && cards.every(c => c.evidence.every((e: any) => !prompt.includes(e.quote))));
      check(`${scene} result uses isolated adapter rather than local-draft fallback`, result.modelUsed === `audit-${scene}` && result.text.length > 10 && (scene === "chat" || Boolean(result.saved?.revisionId)));
      return result;
    }
    check("review and binding do not create story facts or bible cards", facts() === initialFacts && bible() === initialBible);
    await run("outline", 2); await run("chapter_outline", 3); await run("chapter_body", 2);
    await run("review", 2); const polished = await run("humanize", 1); await run("chat", 4);
    await new Promise(r => setTimeout(r, 450));
    const extractionRequests = captures.filter(c => c.model === "audit-memory_extract");
    check("background memory extraction runs but excludes all reference cards", extractionRequests.length > 0 && extractionRequests.every(c => !c.messages.some(m => m.content.includes("【外部写作方法参考 · 非本书事实】") || cards.some(card => m.content.includes(card.id)))));
    check("generated manuscript does not copy source passage or canonize external methods", !polished.text.includes(cards[0].evidence[0].quote) && facts() === initialFacts && bible() === initialBible);
    // Finalization and approval are separate generated API calls.
    let status = await api(`/api/books/${bid}/story/status?chapterNumber=1`);
    await api(`/api/books/${bid}/story/chapters/${status.chapterId}/finalize`, "POST", { bodyRevisionId: status.currentRevisionId, expectedPublicationId: null, expectedCurrentRevisionId: status.currentRevisionId, expectedStoryEpoch: status.storyEpoch, idempotencyKey: `reference-chain-finalize-${bid}` });
    for (let i = 0; i < 100; i++) { status = await api(`/api/books/${bid}/story/status?chapterNumber=1`); if (status.openProposal && status.publication?.memoryState === "proposed") break; await new Promise(r => setTimeout(r, 100)); }
    check("finalization yields a pending proposal, not automatic formal memory", status.publication?.memoryState === "proposed" && Boolean(status.openProposal) && facts() === initialFacts);
    const proposal = await api(`/api/books/${bid}/story/memory/proposals/${status.openProposal.id}`);
    check("memory proposal uses manuscript facts, not reference provenance or quote", !JSON.stringify(proposal).includes(sid) && cards.every(c => !JSON.stringify(proposal).includes(c.id) && c.evidence.every((e: any) => !JSON.stringify(proposal).includes(e.quote))));
    await api(`/api/books/${bid}/story/memory/proposals/${proposal.id}/apply`, "POST", { acceptedOperationIds: proposal.operations.map((o: any) => o.operationId), expectedSourceRevisionId: proposal.sourceRevisionId, expectedStoryEpoch: status.storyEpoch, idempotencyKey: `reference-chain-approve-${bid}` });
    status = await api(`/api/books/${bid}/story/status?chapterNumber=1`);
    check("formal memory becomes ready only after explicit proposal approval", status.publication?.memoryState === "ready" && !status.openProposal);
    // Revoke through the visible UI and inspect the very next actual model request.
    await page.reload(); await page.locator(".ref-source").filter({ hasText: "审计用原创短篇" }).click();
    await page.getByLabel("供哪本书的 Agent 参考？").selectOption(bid);
    const styleUi = page.locator(".ref-method-card").filter({ hasText: "style：先给可核对的异常" });
    await styleUi.getByRole("button", { name: "撤回审阅", exact: true }).click();
    await styleUi.getByRole("button", { name: "审阅通过", exact: true }).waitFor();
    await run("humanize", 0);
    check("revoking review removes grants before the next adapter call", !(await api(`/api/references/sources/${sid}`)).cards.find((c: any) => c.id === style.id).bookIds.length);
    await api(`/api/references/cards/${style.id}`, "PATCH", { approved: true });
    await run("humanize", 0);
    check("re-approval alone never silently restores a removed grant", snapshot("humanize").rendered_text.indexOf(style.id) === -1);
    await api(`/api/references/cards/${style.id}/books/${bid}`, "PUT", { enabled: true, shareConfirmed: true }); await run("humanize", 1);
    await api(`/api/references/cards/${style.id}/books/${bid}`, "PUT", { enabled: false }); await run("humanize", 0);
    check("explicit unlink takes effect on the next real adapter request", snapshot("humanize").rendered_text.indexOf(style.id) === -1);
    await api(`/api/references/cards/${style.id}/books/${bid}`, "PUT", { enabled: true, shareConfirmed: true });
    await page.reload(); await page.locator(".ref-method-card").first().waitFor();
  } finally { db.close(); }
}
