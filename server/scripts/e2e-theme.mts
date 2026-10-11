// @ts-nocheck — page.evaluate bodies use DOM types
/**
 * 配色主题 E2E：设置页切换、即时生效、刷新持久化、无闪烁、跟随系统、theme-color、对比度；并输出 docs/themes 截图。
 * Run: npm run test:e2e:theme
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpDb = path.join(os.tmpdir(), `molan-theme-e2e-${Date.now()}.sqlite`);
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function waitForUrl(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      fetch(url)
        .then((r) => {
          if (r.ok || r.status === 404) resolve();
          else if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting ${url} status=${r.status}`));
          else setTimeout(tick, 250);
        })
        .catch(() => {
          if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting ${url}`));
          else setTimeout(tick, 250);
        });
    };
    tick();
  });
}

function spawnLogged(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const prefix = `[${label}] `;
  child.stdout?.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n").filter(Boolean)) console.log(prefix + line);
  });
  child.stderr?.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n").filter(Boolean)) console.log(prefix + line);
  });
  return child;
}

async function killTree(child: ChildProcess | null) {
  if (!child?.pid) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const apiPort = await freePort();
  const webPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;

  let apiProc: ChildProcess | null = null;
  let webProc: ChildProcess | null = null;
  let browser = null as Awaited<ReturnType<typeof chromium.launch>> | null;

  try {
    apiProc = spawnLogged(
      "npx",
      ["tsx", "server/src/index.ts"],
      {
        MOLAN_SQLITE_PATH: tmpDb,
        MOLAN_SECRET: "browser-e2e-secret-material-32b!!",
        PORT: String(apiPort),
        MOLAN_HOST: "127.0.0.1",
        MOLAN_JOB_INTERVAL_MS: "60000",
        MOLAN_CORS_ORIGINS: webUrl,
        MOLAN_STREAM_PRE_DELAY_MS: "4000",
        DATABASE_URL: "",
        MOLAN_DB: "",
      },
      "api",
    );
    webProc = spawnLogged(
      "npx",
      ["vite", "--host", "127.0.0.1", "--port", String(webPort)],
      {
        MOLAN_WEB_HOST: "127.0.0.1",
        MOLAN_WEB_PORT: String(webPort),
        MOLAN_API_PROXY: apiUrl,
      },
      "web",
    );

    await waitForUrl(`${apiUrl}/api/books`);
    await waitForUrl(webUrl);
    check("主题 E2E 服务就绪", true, `api=${apiPort} web=${webPort}`);
    browser = await chromium.launch({ headless: true });

    const created = await fetch(`${apiUrl}/api/books`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `配色E2E ${Date.now()}`, genre: "测试", logline: "" }),
    });
    const bookId = ((await created.json()) as { book: { id: string } }).book.id;
    check("API 建书", created.ok && Boolean(bookId));
    const put = (kind: string, body: string, chapterNumber: number | null, scene: string) =>
      fetch(`${apiUrl}/api/books/${bookId}/artifacts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, chapterNumber, body, source: "human", scene }),
      });
    check("API 预置正文", (await put("chapter_body", "他不禁看着远方，宛如陷入沉思。茶还没凉，门外已经安静下来。", 1, "chapter_body")).ok);
    check("API 预置大纲", (await put("book_outline", "MOBILE_SEED\n1. 开篇保留", null, "outline")).ok);
    const shots = path.join(root, "docs/themes");
    fs.mkdirSync(shots, { recursive: true });
    const themes = ["light", "dark", "paper", "green", "molan", "ash", "mist", "sakura", "night", "contrast", "ancient"];
    const devs = [
      { name: "desktop", viewport: { width: 1280, height: 800 }, mobile: false },
      { name: "mobile", viewport: { width: 390, height: 844 }, mobile: true },
    ];
    for (const dev of devs) {
      const ctx = await browser.newContext({ viewport: dev.viewport, isMobile: dev.mobile, hasTouch: dev.mobile, colorScheme: "light" });
      const page = await ctx.newPage();
      page.setDefaultTimeout(20_000);
      const tag = dev.name;
      const cur = () => page.evaluate(() => document.documentElement.dataset.theme);
      await page.goto(webUrl + "/", { waitUntil: "networkidle" });
      check(`${tag} 默认跟随系统=light`, (await cur()) === "light");
      await page.getByRole("link", { name: "设置" }).first().click();
      await page.waitForURL(/\/settings/);
      const rg = page.getByRole("radiogroup", { name: "配色选择" });
      await rg.waitFor({ state: "visible" }).catch(() => undefined);
      check(`${tag} 设置页有配色选择`, await rg.isVisible());
      check(`${tag} 12 个配色选项`, (await page.locator(".theme-opt").count()) === 12);
      check(`${tag} 标题为外观`, (await page.locator("#theme-h").textContent())?.trim() === "外观");
      for (const t of themes) {
        await page.locator(`.theme-opt[data-theme-id="${t}"]`).click();
        check(`${tag} 切到 ${t} 即时生效`, (await cur()) === t);
        const tc = await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute("content"));
        check(`${tag} ${t} theme-color 已设`, Boolean(tc && tc.startsWith("#")));
        await page.reload({ waitUntil: "domcontentloaded" });
        check(`${tag} ${t} 刷新后保持`, (await cur()) === t);
        // contrast of body text
        const ratio = (await page.evaluate(`(() => {
          const parse = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
          const lum = (c) => { const a = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; };
          const cs = getComputedStyle(document.body);
          const l1 = lum(parse(cs.color)), l2 = lum(parse(cs.backgroundColor));
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        })()`)) as number;
        check(`${tag} ${t} 正文对比度 ≥4.5`, ratio >= 4.5, ratio.toFixed(2));
        const sec = (await page.evaluate(`(() => {
          const parse = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
          const lum = (c) => { const a = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; };
          const bgOf = (el) => { while (el) { const b = getComputedStyle(el).backgroundColor; const al = b.startsWith("rgba") ? Number((b.match(/[\\d.]+/g) || [])[3]) : 1; if (b && al >= 0.8) return b; el = el.parentElement; } return getComputedStyle(document.body).backgroundColor; };
          const cr = (el) => { const l1 = lum(parse(getComputedStyle(el).color)), l2 = lum(parse(bgOf(el))); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
          const sel = [".theme-desc", ".sub", ".eyebrow", ".size-opt small", ".topbar .tabs a"];
          let min = 99, who = "";
          for (const q of sel) { const el = document.querySelector(q); if (!el) continue; const r = cr(el); if (r < min) { min = r; who = q; } }
          return [min, who];
        })()`)) as [number, string];
        check(`${tag} ${t} 次要文字/标签对比度 ≥4.5`, sec[0] >= 4.5, `${sec[0].toFixed(2)} ${sec[1]}`);
        await page.goto(`${webUrl}/books/${bookId}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(400);
        check(`${tag} ${t} 工作室保持主题`, (await cur()) === t);
        await page.screenshot({ path: path.join(shots, `studio-${t}-${tag}.png`) });
        await page.goto(`${webUrl}/settings`, { waitUntil: "networkidle" });
      }
      // no flash: theme present before app script runs
      await page.locator('.theme-opt[data-theme-id="dark"]').click();
      const early = await ctx.newPage();
      await early.route("**/web/main.tsx*", (r) => r.abort());
      await early.goto(webUrl + "/settings", { waitUntil: "domcontentloaded" });
      check(`${tag} 无闪烁：脚本前已是 dark`, (await early.evaluate(() => document.documentElement.dataset.theme)) === "dark");
      await early.close();
      // follow system
      await page.locator('.theme-opt[data-theme-id="system"]').click();
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(100);
      check(`${tag} 跟随系统→dark`, (await cur()) === "dark");
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForTimeout(100);
      check(`${tag} 跟随系统→light`, (await cur()) === "light");
      await page.reload({ waitUntil: "networkidle" });
      check(`${tag} 跟随系统 刷新保持`, (await page.evaluate(() => document.documentElement.dataset.themeChoice)) === "system");
      check(`${tag} 无横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      // ---- 字体 ----
      await page.goto(`${webUrl}/settings`, { waitUntil: "networkidle" });
      check(`${tag} 有字体选择`, (await page.locator(".font-opt").count()) === 7);
      check(`${tag} 有字号选择`, (await page.locator(".size-opt").count()) === 6);
      const edFont = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="appearance-preview"]')!).fontFamily);
      const edSize = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="appearance-preview"]')!).fontSize));
      for (const [f, needle] of [["hei", "PingFang"], ["kai", "Kaiti"], ["fangsong", "Fangsong"], ["song", "Songti"], ["wenkai", "LXGW"], ["system", "system-ui"], ["default", "Noto Serif"]] as const) {
        await page.locator(`.font-opt[data-font-id="${f}"]`).click();
        const ff = await edFont();
        check(`${tag} 字体 ${f} 即时生效`, ff.toLowerCase().includes(needle.toLowerCase()), ff.slice(0, 40));
      }
      await page.locator('.font-opt[data-font-id="wenkai"]').click();
      await page.waitForTimeout(1500);
      check(`${tag} 霞鹜文楷 本地字体已加载`, await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "LXGW WenKai Screen"', "雾港"); }));
      if (dev.name === "desktop") await page.locator(".font-grid").screenshot({ path: path.join(shots, "fonts-compare.png") });
      await page.reload({ waitUntil: "domcontentloaded" });
      check(`${tag} 字体刷新后保持`, (await page.evaluate(() => document.documentElement.dataset.font)) === "wenkai");
      // ---- 字号 ----
      const sizes = { xs: 15, sm: 16.5, md: 18, lg: 20, xl: 22, xxl: 24 } as Record<string, number>;
      let prev = 0, mono = true;
      for (const [z, px] of Object.entries(sizes)) {
        await page.locator(`.size-opt[data-size-id="${z}"]`).click();
        const got = await edSize();
        const want = dev.mobile ? Math.min(Math.max(px, 16), 23) : px;
        check(`${tag} 字号 ${z} 生效`, Math.abs(got - want) < 0.6, `${got}px`);
        if (got < prev) mono = false;
        prev = got;
      }
      check(`${tag} 字号单调递增`, mono);
      if (dev.mobile) check(`${tag} 手机正文 ≥16px（最小档）`, true);
      await page.reload({ waitUntil: "domcontentloaded" });
      check(`${tag} 字号刷新后保持`, (await page.evaluate(() => document.documentElement.dataset.fs)) === "xxl");
      const early2 = await ctx.newPage();
      await early2.route("**/web/main.tsx*", (r) => r.abort());
      await early2.goto(webUrl + "/settings", { waitUntil: "domcontentloaded" });
      const pre = await early2.evaluate(() => [document.documentElement.dataset.font, document.documentElement.dataset.fs]);
      check(`${tag} 无闪烁：脚本前已有字体/字号`, pre[0] === "wenkai" && pre[1] === "xxl", pre.join(","));
      await early2.close();
      await page.goto(`${webUrl}/books/${bookId}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      const msz = await page.evaluate(() => { const m = document.querySelector(".manuscript"); return m ? parseFloat(getComputedStyle(m).fontSize) : 0; });
      check(`${tag} 工作室正文应用特大字号`, msz >= 23 - 0.6, `${msz}px`);
      if (dev.mobile) await page.screenshot({ path: path.join(shots, "size-xxl-mobile.png") });
      else await page.screenshot({ path: path.join(shots, "font-wenkai-xxl-desktop.png") });
      // reset
      await page.evaluate(() => { localStorage.setItem("molan.font", "default"); localStorage.setItem("molan.fontSize", "md"); });
      await ctx.close();
    }
    // 360 宽 + 特大字号 不溢出；字号对比截图
    {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, colorScheme: "light" });
      const page = await ctx.newPage();
      await page.goto(webUrl + "/settings", { waitUntil: "domcontentloaded" });
      for (const z of ["xs", "md", "xxl"]) {
        await page.evaluate((zz) => { localStorage.setItem("molan.fontSize", zz); localStorage.setItem("molan.font", "default"); }, z);
        for (const url of [`${webUrl}/settings`, `${webUrl}/books/${bookId}`, `${webUrl}/`]) {
          await page.goto(url, { waitUntil: "networkidle" });
          await page.waitForTimeout(300);
          const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          check(`360 宽 字号${z} ${new URL(url).pathname} 无横向溢出`, ov <= 1, `${ov}px`);
          if (url.includes("/books/")) await page.screenshot({ path: path.join(shots, `size-${z}-360.png`) });
        }
      }
      await ctx.close();
    }
    await fetch(`${apiUrl}/api/books/${bookId}`, { method: "DELETE" });
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await killTree(webProc);
    await killTree(apiProc);
    for (const p of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("Failed:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
