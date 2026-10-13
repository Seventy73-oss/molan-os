import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import { enUS } from "../../web/locales/en-US";
import { zhCN } from "../../web/locales/zh-CN";

const base = process.env.MOLAN_AUDIT_URL || "http://127.0.0.1:3000";
const output = process.env.MOLAN_AUDIT_OUTPUT || "/tmp/molan-import-audit";
fs.mkdirSync(output, { recursive: true });
const created: string[] = [];
let passed = 0;
function check(name: string, ok: boolean, detail = "") {
  assert.ok(ok, `${name}: ${detail}`);
  passed++;
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
async function poll(fn: () => Promise<boolean>, message: string) {
  for (let i = 0; i < 70; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(message);
}
type ElementBounds = { x: number; y: number; width: number; height: number; bottom: number; right: number };
type LayoutMetrics = {
  viewport: { width: number; height: number };
  overflow: number;
  bodyOverflow: number;
  header: ElementBounds | null;
  locale: ElementBounds | null;
  center: ElementBounds | null;
  tabbar: ElementBounds | null;
  bottomTab: ElementBounds | null;
  editor: ElementBounds | null;
  topPadding: number;
};
async function geometry(page: Page, mobile: boolean, label: string) {
  // Browser snippets are strings because the server tsconfig intentionally excludes DOM globals.
  const metrics = await page.evaluate<LayoutMetrics>(`(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right } : null;
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      overflow: document.documentElement.scrollWidth - innerWidth,
      bodyOverflow: document.body.scrollWidth - innerWidth,
      header: rect(".topbar"), locale: rect(".locale-select"), center: rect(".center"), tabbar: rect(".m-tabbar"),
      bottomTab: rect(".m-tab"), editor: rect(".ProseMirror"),
      topPadding: parseFloat(getComputedStyle(document.querySelector(".topbar")).paddingTop),
    };
  })()`);
  fs.writeFileSync(`${output}/${label}-metrics.json`, JSON.stringify(metrics, null, 2));
  check(`${label}: no page overflow`, metrics.overflow <= 1 && metrics.bodyOverflow <= 1, JSON.stringify(metrics));
  check(`${label}: language control stays in viewport`, Boolean(metrics.locale && metrics.locale.x >= 0 && metrics.locale.right <= metrics.viewport.width));
  if (mobile) {
    check(`${label}: top inset has one owner`, metrics.topPadding === 32 && Boolean(metrics.locale && metrics.locale.y >= 32));
    check(`${label}: bottom controls clear host inset`, Boolean(metrics.bottomTab && metrics.bottomTab.bottom <= metrics.viewport.height - 27));
    check(`${label}: manuscript clears bottom chrome`, Boolean(metrics.center && metrics.tabbar && metrics.center.bottom <= metrics.tabbar.y + 1));
  }
}

const browser = await chromium.launch({ headless: true });
try {
  check("locale dictionaries have identical nonempty keys", JSON.stringify(Object.keys(enUS).sort()) === JSON.stringify(Object.keys(zhCN).sort()) && Object.values(enUS).every(Boolean) && Object.values(zhCN).every(Boolean));
  for (const mobile of [false, true]) {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const en = locale === "en-US";
      const label = `${mobile ? "mobile" : "desktop"}-${locale}`;
      const context = await browser.newContext({ viewport: mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 }, locale });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("dialog", (dialog) => { void dialog.accept(); });
      await page.addInitScript(`(() => {
        localStorage.setItem("molan.locale", ${JSON.stringify(locale)});
      })()`);
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: en ? "Manuscripts" : "书稿", exact: true }).waitFor();
      check(`${label}: correct document language`, await page.locator("html").getAttribute("lang") === locale);
      await page.locator(".library-actions .btn.primary").click();
      await page.locator("form.card-form").waitFor();
      const title = `Import audit ${label} ${Date.now()}`;
      await page.locator("form.card-form input").nth(0).fill(title);
      await page.locator("form.card-form input").nth(1).fill(en ? "Mystery" : "悬疑");
      await page.locator("form.card-form textarea").fill(en ? "A manuscript persistence test." : "用于验证书稿持久化。 ");
      await page.locator("form.card-form button[type=submit]").click();
      await page.waitForURL(/\/books\/[^/]+$/);
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      created.push(id);
      await page.locator(".studio:not(.empty-studio)").waitFor();
      check(`${label}: manual book creation`, await page.locator(".crumb-current").textContent() === title);
      await page.getByRole("button", { name: en ? "Write it yourself" : "自己写", exact: true }).click();
      const text = en ? "The brass watch stopped at seventeen past three.\n\nShe waited at the harbor." : "铜表停在三点十七分。\n\n她在港口等候。";
      await page.locator(".ProseMirror").fill(text);
      await poll(async () => (await page.locator(".save-state").textContent())?.includes(en ? "Unsaved" : "未保存") ?? false, "Dirty state missing");
      check(`${label}: localized unsaved state`, true);
      await page.locator(".doc-tools").getByRole("button", { name: en ? /^Save/ : /^保存/ }).click();
      await poll(async () => (await page.locator(".save-state").textContent())?.trim() === (en ? "Saved" : "已保存"), "Saved state missing");
      const book = await (await context.request.get(`${base}/api/books/${id}`)).json();
      check(`${label}: saved to server`, book.artifacts.some((a: { body: string }) => a.body.includes(text.split("\n")[0])));
      // Switch in place while dirty: no remount, no loss of text, dynamic save state changes.
      await page.locator(".ProseMirror").press("End");
      await page.locator(".ProseMirror").pressSequentially(" test");
      const beforeSwitch = await page.locator(".ProseMirror").innerText();
      await page.locator(".locale-select").selectOption(en ? "zh-CN" : "en-US");
      check(`${label}: locale changes preserve unsaved manuscript`, await page.locator(".ProseMirror").innerText() === beforeSwitch);
      check(`${label}: dynamic status switches language`, (await page.locator(".save-state").textContent())?.trim() === (en ? "未保存" : "Unsaved"));
      await page.locator(".locale-select").selectOption(locale);
      await page.locator(".doc-tools").getByRole("button", { name: en ? /^Save/ : /^保存/ }).click();
      await poll(async () => (await page.locator(".save-state").textContent())?.trim() === (en ? "Saved" : "已保存"), "Second save failed");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".ProseMirror").waitFor();
      check(`${label}: manuscript persists after reload`, (await page.locator(".ProseMirror").innerText()).includes(text.split("\n")[0]));
      check(`${label}: locale stored`, await page.evaluate(() => localStorage.getItem("molan.locale")) === locale);
      await geometry(page, mobile, label);
      await page.screenshot({ path: `${output}/${label}-studio.png` });
      await page.getByRole("button", { name: en ? "Tools" : "工具", exact: true }).click();
      await page.getByRole("dialog", { name: en ? "Writing tools" : "写作工具" }).waitFor();
      if (mobile) {
        const drawerMetrics = await page.evaluate<{ top: number; closeTop: number }>(`(() => ({
          top: document.querySelector(".tools-drawer").getBoundingClientRect().top,
          closeTop: document.querySelector(".drawer-close").getBoundingClientRect().top,
        }))()`);
        check(`${label}: drawer controls remain visible`, drawerMetrics.top >= -1 && drawerMetrics.closeTop >= 0);
      }
      await page.getByRole("button", { name: en ? "Versions" : "版本", exact: true }).click();
      await poll(async () => (await page.locator(".rev-item").count()) > 0, "Version history missing");
      check(`${label}: revision history works`, true);
      await page.screenshot({ path: `${output}/${label}-tools.png` });
      await page.getByRole("button", { name: en ? "Close tools panel" : "关闭工具面板", exact: true }).click();
      if (mobile) await page.locator(".m-tabbar").getByRole("button", { name: en ? "Assistant" : "助手", exact: true }).click();
      await page.locator(".composer textarea").fill("写全书大纲");
      await page.locator(".composer").getByRole("button", { name: en ? "Send" : "发送", exact: true }).click();
      await poll(async () => {
        const data = await (await context.request.get(`${base}/api/books/${id}`)).json();
        return data.artifacts.some((a: { kind: string; body: string }) => a.kind === "book_outline" && a.body.length > 50);
      }, "Local draft generation did not save an outline");
      check(`${label}: local draft stream saves book outline`, true);
      if (mobile) await page.locator(".m-tabbar").getByRole("button", { name: en ? "Manuscript" : "正文", exact: true }).click();
      await poll(async () => (await page.locator(".save-state").textContent())?.trim() === (en ? "Saved" : "已保存"), "Generation did not settle");
      check(`${label}: no runtime errors`, errors.length === 0, errors.join("; "));
      await context.close();
    }
  }
  // A separate context verifies persistence without an init script forcing a preference.
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator(".locale-select").selectOption("en-US");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Manuscripts", exact: true }).waitFor();
  check("language preference survives a real reload", await page.locator("html").getAttribute("lang") === "en-US");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  await page.getByRole("radio", { name: /^Dark\b/ }).click();
  check("imported appearance settings preserved", await page.locator("html").getAttribute("data-theme") === "dark");
  await page.locator(".locale-select").selectOption("zh-CN");
  await page.getByRole("heading", { name: "外观", exact: true }).waitFor();
  check("settings switch back to Chinese", await page.locator("html").getAttribute("lang") === "zh-CN");
  await page.locator(".locale-select").selectOption("system");
  check("system language choice exposed and persisted", await page.evaluate(() => localStorage.getItem("molan.locale")) === "system");
  await context.close();
  console.log(`\n${passed}/${passed} import checks passed`);
} finally {
  for (const id of created) await fetch(`${base}/api/books/${id}`, { method: "DELETE" }).catch(() => undefined);
  await browser.close();
}
