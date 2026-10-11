/** Mock failure/cancel/process-restart browser cases for isolated audit only. */
import assert from "node:assert/strict";
import type { Page } from "playwright";
type Api = (route: string, method?: string, body?: unknown) => Promise<any>;
type Mode = "ok" | "credit" | "hold";
export async function resilienceChecks(input: { page: Page; api: Api; check: (name: string, ok: unknown) => void; sourceId: string; setMode: (mode: Mode) => void; calls: () => number; restart: () => Promise<void> }) {
  const { page, api, check, sourceId: sid, setMode, calls, restart } = input;
  const beforeCards = (await api(`/api/references/sources/${sid}`)).cards.length;
  async function openSource() {
    await page.reload(); await page.locator(".ref-source").filter({ hasText: "审计用原创短篇" }).click();
    await page.locator(".ref-reader-head h2").filter({ hasText: "审计用原创短篇" }).waitFor();
    if (!(await page.locator(".ref-distill-panel").getAttribute("open"))) {
      if (!await page.locator(".ref-distill-panel").evaluate((el: any) => el.open)) await page.locator(".ref-distill-panel summary").click();
    }
  }
  async function currentJob() {
    return (await api("/api/references")).jobs.find((j: any) => j.sourceId === sid);
  }
  async function start(mode: Mode) {
    setMode(mode); await openSource(); const before = calls();
    await page.getByRole("button", { name: "用 Qwen3.8 Flash 蒸馏", exact: true }).click();
    for (let i = 0; i < 100 && calls() === before; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(calls(), before + 1, "UI created exactly one model request");
    return currentJob();
  }
  try {
    await start("credit");
    const failure = page.locator(".ref-job").filter({ hasText: "app_ai_unavailable" }).first();
    await failure.waitFor({ timeout: 15000 });
    check("mock 402 is visible in persistent job UI without fake cards", (await failure.innerText()).includes("Eazo AI 额度不足") && (await api(`/api/references/sources/${sid}`)).cards.length === beforeCards);
    await page.locator(".locale-select").selectOption("en-US");
    check("mock 402 status translates for English readers", /credit|unavailable/i.test(await failure.innerText()));
    await page.locator(".locale-select").selectOption("zh-CN");
    const chargedCalls = calls(); await page.reload(); await failure.waitFor();
    check("reload never retries a failed paid-model job", calls() === chargedCalls);
    const cancel = await start("hold");
    await page.locator(".ref-jobs").getByRole("button", { name: "取消", exact: true }).waitFor({ timeout: 10000 });
    await page.locator(".ref-jobs").getByRole("button", { name: "取消", exact: true }).click();
    await page.locator(".ref-jobs").getByRole("button", { name: "取消", exact: true }).waitFor({ state: "detached" });
    check("cancel through UI persists cancelled state and retains prior cards", (await api(`/api/references/jobs/${cancel.id}`)).status === "cancelled" && (await api(`/api/references/sources/${sid}`)).cards.length === beforeCards);
    const interrupted = await start("hold"); const beforeRestart = calls();
    await restart();
    await page.reload(); await page.locator(".ref-job").filter({ hasText: "已中断" }).first().waitFor({ timeout: 15000 });
    check("actual API process restart marks in-flight job interrupted", (await api(`/api/references/jobs/${interrupted.id}`)).status === "interrupted");
    await page.waitForTimeout(700);
    check("process restart never replays paid request and keeps prior cards", calls() === beforeRestart && (await api(`/api/references/sources/${sid}`)).cards.length === beforeCards);
  } finally { setMode("ok"); }
}
