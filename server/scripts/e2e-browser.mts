/**
 * Phase-4 browser E2E (Playwright Chromium).
 * Spawns API + Vite on free ports with a temp SQLite DB; exercises Library → Studio → Skills/Models.
 *
 * Run: npm run test:e2e:browser
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpDb = path.join(os.tmpdir(), `molan-browser-e2e-${Date.now()}.sqlite`);
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
    check("浏览器 E2E 服务就绪", true, `api=${apiPort} web=${webPort}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);

    await page.goto(webUrl, { waitUntil: "networkidle" });
    const hasLibrary = await page.getByRole("heading", { name: "书稿" }).isVisible().catch(() => false);
    check("书库页加载", hasLibrary);

    const title = `浏览器E2E ${Date.now()}`;
    // Prefer UI create; fall back to API+reload if the form path flakes.
    await page.locator(".library-actions").getByRole("button", { name: "新书" }).click();
    await page.locator("form.card-form").waitFor({ state: "visible" });
    const titleInput = page.locator("form.card-form label").filter({ hasText: "书名" }).locator("input");
    await titleInput.click();
    await titleInput.fill(title);
    await page.locator("form.card-form label").filter({ hasText: "题材" }).locator("input").fill("测试");
    const createRespPromise = page.waitForResponse(
      (r) => r.url().includes("/api/books") && r.request().method() === "POST",
      { timeout: 15_000 },
    );
    await page.locator("form.card-form").getByRole("button", { name: "创建", exact: true }).click();
    let createOk = false;
    let createDetail = "";
    try {
      const resp = await createRespPromise;
      createOk = resp.ok();
      createDetail = `status=${resp.status()}`;
      if (!createOk) createDetail += ` body=${(await resp.text()).slice(0, 200)}`;
    } catch (e) {
      createDetail = e instanceof Error ? e.message : String(e);
      const alertText = await page.locator(".alert").textContent().catch(() => "");
      if (alertText) createDetail += ` alert=${alertText}`;
    }
    check("创建新书 API 响应", createOk, createDetail);
    if (createOk) {
      await page.waitForURL(/\/books\/[0-9a-f-]+/i, { timeout: 15_000 });
    } else {
      // API fallback so remaining UI paths still run
      const created = await fetch(`${apiUrl}/api/books`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, genre: "测试", logline: "" }),
      });
      const payload = (await created.json()) as { book: { id: string } };
      await page.goto(`${webUrl}/books/${payload.book.id}`, { waitUntil: "networkidle" });
    }
    const onStudio = /\/books\//.test(page.url());
    check("创建新书进入工作室", onStudio, page.url());

    await page.locator("footer.composer textarea").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".crumb-current");
        const t = el?.textContent?.trim() || "";
        return t.length > 0 && t !== "…";
      },
      { timeout: 20_000 },
    );
    const crumb = await page.locator(".crumb-current").textContent().catch(() => "");
    check("工作室显示书名", (crumb || "").includes("浏览器E2E"), crumb || undefined);

    const composer = await page.locator("footer.composer textarea").isVisible().catch(() => false);
    check("工作室对话输入框可见", composer);

    await page.getByRole("link", { name: "技能" }).click();
    await page.waitForURL(/\/skills/);
    const skillsOk =
      (await page.getByText(/技能|Skill/i).first().isVisible().catch(() => false)) ||
      (await page.locator("h1").first().isVisible().catch(() => false));
    check("技能页可打开", skillsOk);

    await page.getByRole("link", { name: "模型" }).click();
    await page.waitForURL(/\/models/);
    const modelsOk =
      (await page.getByText(/模型|场景/i).first().isVisible().catch(() => false)) ||
      (await page.locator("h1").first().isVisible().catch(() => false));
    check("模型页可打开", modelsOk);

    await page.locator("nav.tabs").getByRole("link", { name: "书库", exact: true }).click();
    try {
      await page.waitForURL("**/", { timeout: 8_000 });
    } catch {
      await page.goto(webUrl + "/", { waitUntil: "domcontentloaded" });
    }
    await page.getByRole("heading", { name: "书稿" }).waitFor({ state: "visible", timeout: 15_000 });
    const back =
      page.url().includes(String(webPort)) &&
      (await page.getByRole("heading", { name: "书稿" }).isVisible().catch(() => false));
    check("返回书库", back, page.url());

    // Cleanup created book via API
    const books = (await (await fetch(`${apiUrl}/api/books`)).json()) as { books: { id: string; title: string }[] };
    const hit = books.books.find((b) => b.title === title);
    if (hit) {
      const del = await fetch(`${apiUrl}/api/books/${hit.id}`, { method: "DELETE" });
      check("清理测试书", del.ok, String(del.status));
    } else {
      check("清理测试书", false, "book not found");
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await killTree(webProc);
    await killTree(apiProc);
    for (const p of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
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
