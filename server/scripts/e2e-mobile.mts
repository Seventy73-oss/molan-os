// @ts-nocheck — page.evaluate bodies use DOM types
/**
 * H5 mobile browser E2E (Playwright, touch emulation). Temp SQLite + local-draft.
 * iPhone 13 (390x844) + small Android (360x780): library → open book → 目录 drawer → edit →
 * touch-select → bubble actions → 改写 → 助手 sheet → send → 停止 → 工具 full-screen drawer.
 * Run: npm run test:e2e:mobile
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpDb = path.join(os.tmpdir(), `molan-mobile-e2e-${Date.now()}.sqlite`);
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
    check("移动端 E2E 服务就绪", true, `api=${apiPort} web=${webPort}`);
    browser = await chromium.launch({ headless: true });

    const created = await fetch(`${apiUrl}/api/books`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `移动E2E ${Date.now()}`, genre: "测试", logline: "" }),
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

    const devicesToRun = [
      { name: "iPhone13", viewport: { width: 390, height: 844 }, full: true },
      { name: "Android360", viewport: { width: 360, height: 780 }, full: false },
    ];
    for (const dev of devicesToRun) {
      const ctx = await browser.newContext({ viewport: dev.viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      page.setDefaultTimeout(20_000);
      page.on("dialog", (d) => void d.accept().catch(() => undefined));
      const tag = dev.name;
      const noOverflow = async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

      await page.goto(webUrl + "/", { waitUntil: "networkidle" });
      check(`${tag} 书库加载`, await page.getByRole("heading", { name: "书稿", exact: true }).isVisible());
      check(`${tag} 书库无横向溢出`, await noOverflow());
      const cardW = await page.locator(".book-card").first().evaluate((el) => el.getBoundingClientRect().width);
      check(`${tag} 书卡单列`, cardW > dev.viewport.width * 0.8, `w=${Math.round(cardW)}`);
      const vpMeta = await page.locator('meta[name="viewport"]').getAttribute("content");
      check(`${tag} viewport meta 含 viewport-fit=cover`, /viewport-fit=cover/.test(vpMeta || ""), vpMeta || "");

      await page.locator(".book-card").filter({ hasText: "移动E2E" }).first().tap();
      await page.waitForURL(/\/books\//);
      const tabbar = page.locator("nav.m-tabbar");
      await tabbar.waitFor({ state: "visible" });
      check(`${tag} 底部面板栏可见`, true);
      check(`${tag} 工作室无横向溢出`, await noOverflow());
      const tabH = await tabbar.locator(".m-tab").first().evaluate((el) => el.getBoundingClientRect().height);
      check(`${tag} 面板栏点按区 ≥44px`, tabH >= 44, `h=${tabH}`);
      const centerW = await page.locator("section.center").evaluate((el) => el.getBoundingClientRect().width);
      check(`${tag} 正文单栏占满`, centerW >= dev.viewport.width - 2, `w=${centerW}`);
      const railHidden = await page.locator("aside.sidebar.rail").evaluate((el) => el.getBoundingClientRect().right <= 0);
      check(`${tag} 目录默认收起`, railHidden);

      // 目录 drawer → pick 第1章正文
      await tabbar.getByRole("button", { name: "目录" }).tap();
      await page.waitForTimeout(350);
      const railOpen = await page.locator("aside.sidebar.rail").evaluate((el) => el.getBoundingClientRect().left >= -1);
      check(`${tag} 目录抽屉滑出`, railOpen);
      const bodyItem = page.locator("aside.sidebar.rail button.tree-item").filter({ hasText: "正文" }).first();
      if (!(await bodyItem.isVisible().catch(() => false))) {
        await page.locator("aside.sidebar.rail button.tree-item").filter({ hasText: /^0?1/ }).first().tap().catch(() => undefined);
      }
      await page.locator("aside.sidebar.rail button.tree-item").filter({ hasText: "正文" }).first().tap();
      await page.waitForTimeout(400);
      const railClosed = await page.locator("aside.sidebar.rail").evaluate((el) => el.getBoundingClientRect().right <= 0);
      check(`${tag} 选章后抽屉自动收起`, railClosed);

      const ms = page.locator(".manuscript").first();
      await ms.waitFor({ state: "visible" });
      for (let i = 0; i < 40; i++) {
        if (((await ms.innerText().catch(() => "")) || "").includes("远方")) break;
        await page.waitForTimeout(250);
      }
      check(`${tag} 正文载入`, ((await ms.innerText()) || "").includes("远方"));
      const proseFs = await ms.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      check(`${tag} 正文字号 ≥16px`, proseFs >= 16, `${proseFs}px`);

      // Touch edit: tap at end, type
      await ms.tap();
      await page.keyboard.press("End");
      await page.keyboard.type("风停了。");
      check(`${tag} 触屏编辑输入`, ((await ms.innerText()) || "").includes("风停了"));

      // Long-press style selection (programmatic range over first paragraph, like a touch select)
      await ms.evaluate((el) => {
        const p = el.querySelector("p") || el;
        const r = document.createRange();
        r.selectNodeContents(p);
        const s = window.getSelection()!;
        s.removeAllRanges();
        s.addRange(r);
      });
      const bubble = page.locator(".sel-bubble");
      const bubbleOk = await bubble.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
      check(`${tag} 触屏选区气泡出现`, bubbleOk);
      if (bubbleOk) {
        const box = await bubble.boundingBox();
        const inView = !!box && box.x >= 0 && box.x + box.width <= dev.viewport.width + 1 && box.y + box.height <= dev.viewport.height;
        check(`${tag} 气泡在视口内且贴底`, inView && box!.y > dev.viewport.height / 2, JSON.stringify(box));
        for (const label of ["改写", "续写", "润色", "加强对白"]) {
          const b = bubble.getByRole("button", { name: label, exact: true });
          const bb = await b.boundingBox().catch(() => null);
          check(`${tag} 气泡「${label}」可点(≥40px)`, !!bb && bb.height >= 40, bb ? `h=${bb.height}` : "missing");
        }
        check(`${tag} 气泡「对助手说」入口`, await bubble.getByText("对助手说").first().isVisible().catch(() => false));
        if (dev.full) {
          const before = (await ms.innerText()) || "";
          const resp = page.waitForResponse((r) => r.url().includes("/selection-rewrite") && r.request().method() === "POST", { timeout: 45_000 });
          await bubble.getByRole("button", { name: "改写", exact: true }).tap();
          const r = await resp.catch(() => null);
          check(`${tag} 触屏「改写」API`, !!r && r.ok(), r ? String(r.status()) : "no response");
          let after = before;
          for (let i = 0; i < 40; i++) {
            after = (await ms.innerText()) || "";
            if (after !== before) break;
            await page.waitForTimeout(250);
          }
          check(`${tag} 改写写回正文`, after !== before);
        }
      }
      await page.evaluate(() => window.getSelection()?.removeAllRanges());

      // 助手 sheet
      await tabbar.getByRole("button", { name: "助手" }).tap();
      await page.waitForTimeout(350);
      const ta = page.locator("footer.composer textarea");
      const taBox = await ta.boundingBox();
      check(`${tag} 助手面板输入框在视口内`, !!taBox && taBox.y + taBox.height <= dev.viewport.height - 56, JSON.stringify(taBox));
      const taFs = await ta.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      check(`${tag} 输入框字号 ≥16px（防 iOS 缩放）`, taFs >= 16, `${taFs}px`);

      if (dev.full) {
        // switch to outline so the stream writes 全书大纲
        await tabbar.getByRole("button", { name: "目录" }).tap();
        await page.locator("aside.sidebar.rail button.tree-item").filter({ hasText: "全书大纲" }).first().tap();
        await page.waitForTimeout(300);
        await tabbar.getByRole("button", { name: "助手" }).tap();
        await ta.fill("写全书大纲");
        const started = page.waitForResponse((r) => r.url().includes("/chat/stream") && r.request().method() === "POST", { timeout: 30_000 }).catch(() => null);
        await page.locator("footer.composer button.send").tap();
        const inlineStop = await page.locator("button.stream-stop-inline").first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
        check(`${tag} 助手面板内流式状态+停止可见`, inlineStop);
        // go back to 正文: floating status bar with 停止 must be reachable
        await tabbar.getByRole("button", { name: "正文" }).tap();
        const floatStop = page.locator(".m-stream .m-stream-stop");
        const floatOk = await floatStop.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
        check(`${tag} 正文页浮动「停止」可见`, floatOk);
        const cancelResp = page.waitForResponse((r) => /\/cancel/.test(r.url()), { timeout: 10_000 }).catch(() => null);
        if (floatOk) await floatStop.tap({ timeout: 3_000 }).catch(() => undefined);
        await started;
        const cr = await cancelResp;
        let idle = false;
        for (let i = 0; i < 40; i++) {
          if (!(await page.locator(".m-stream").isVisible().catch(() => false))) { idle = true; break; }
          await page.waitForTimeout(250);
        }
        check(`${tag} 触屏停止→取消请求`, !!cr || idle, cr ? cr.url().replace(apiUrl, "") : "busy cleared");
        check(`${tag} 停止后忙态解除`, idle);
        const outline = (await (await fetch(`${apiUrl}/api/books/${bookId}`)).text());
        check(`${tag} 停止后大纲未被覆盖`, outline.includes("MOBILE_SEED"));
      }

      // 工具抽屉全屏
      await tabbar.getByRole("button", { name: "正文" }).tap();
      await page.locator(".doc-tools button").filter({ hasText: "工具" }).tap();
      const drawer = page.locator(".tools-drawer");
      await drawer.waitFor({ state: "visible" });
      const db = await drawer.boundingBox();
      check(`${tag} 工具抽屉全屏`, !!db && db.width >= dev.viewport.width - 1 && db.x <= 0.5 && db.y <= 0.5, JSON.stringify(db));
      for (const t of ["版本", "人物态", "伏笔", "上下文"]) {
        const tb = drawer.getByRole("button", { name: t, exact: true }).or(drawer.getByRole("tab", { name: t, exact: true })).first();
        const ok = await tb.isVisible().catch(() => false);
        if (ok) await tb.tap().catch(() => undefined);
        check(`${tag} 工具「${t}」可切换`, ok && (await noOverflow()));
      }
      await drawer.getByRole("button", { name: "关闭" }).first().tap();
      check(`${tag} 工具抽屉可关闭`, !(await drawer.isVisible().catch(() => false)));

      for (const r of ["skills", "models"]) {
        await page.goto(`${webUrl}/${r}`, { waitUntil: "networkidle" });
        check(`${tag} ${r} 页无横向溢出`, await noOverflow());
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
