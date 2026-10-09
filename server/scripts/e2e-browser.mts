/**
 * Phase-4 browser E2E (Playwright Chromium).
 * Spawns API + Vite on free ports with a temp SQLite DB; exercises Library → Studio →
 * selection rewrite bubble + streaming chat write (local-draft) → Skills/Models.
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
    const crumbLoc = page.locator(".crumb-current");
    await crumbLoc.waitFor({ state: "visible", timeout: 20_000 });
    // Wait until Studio finishes loading title (placeholder is "…").
    for (let i = 0; i < 40; i++) {
      const cur = ((await crumbLoc.textContent()) || "").trim();
      if (cur && cur !== "…") break;
      await page.waitForTimeout(250);
    }
    const crumb = await crumbLoc.textContent().catch(() => "");
    check("工作室显示书名", (crumb || "").includes("浏览器E2E"), crumb || undefined);

    const composer = await page.locator("footer.composer textarea").isVisible().catch(() => false);
    check("工作室对话输入框可见", composer);

    // --- Selection rewrite bubble (local-draft) ---
    const bookIdMatch = page.url().match(/\/books\/([0-9a-f-]+)/i);
    const bookId = bookIdMatch?.[1] || "";
    check("工作室 URL 含书 id", Boolean(bookId), page.url());
    const seedBody =
      "他不禁看着远方，宛如陷入沉思。茶还没凉，门外已经安静下来。";
    if (bookId) {
      const put = await fetch(`${apiUrl}/api/books/${bookId}/artifacts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "chapter_body",
          chapterNumber: 1,
          body: seedBody,
          source: "human",
          scene: "chapter_body",
        }),
      });
      check("API 预置第1章正文", put.ok, String(put.status));
      await page.reload({ waitUntil: "networkidle" });
      await page.locator("footer.composer textarea").waitFor({ state: "visible", timeout: 20_000 });
      // defaultDoc prefers chapter_body with content
      const ms = page.locator(".manuscript.ProseMirror, .manuscript").first();
      await ms.waitFor({ state: "visible", timeout: 20_000 });
      for (let i = 0; i < 40; i++) {
        const t = ((await ms.innerText().catch(() => "")) || "").trim();
        if (t.includes("不禁") || t.includes("远方")) break;
        await page.waitForTimeout(250);
      }
      const beforeText = ((await ms.innerText().catch(() => "")) || "").trim();
      check("正文载入编辑器", beforeText.includes("不禁") || beforeText.includes("远方"), beforeText.slice(0, 80));

      await ms.click();
      await page.keyboard.press("Control+A");
      const bubble = page.locator(".sel-bubble");
      await bubble.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
      const bubbleVisible = await bubble.isVisible().catch(() => false);
      check("选区改写气泡出现", bubbleVisible);

      if (bubbleVisible) {
        const rewriteResp = page.waitForResponse(
          (r) =>
            r.url().includes("/selection-rewrite") &&
            (r.request().method() === "POST"),
          { timeout: 30_000 },
        );
        await bubble.getByRole("button", { name: "改写", exact: true }).click();
        let rewriteOk = false;
        try {
          const resp = await rewriteResp;
          rewriteOk = resp.ok();
          check("选区改写流式/API 响应", rewriteOk, `status=${resp.status()}`);
        } catch (e) {
          check("选区改写流式/API 响应", false, e instanceof Error ? e.message : String(e));
        }
        // Wait for local-draft notice or text change
        for (let i = 0; i < 60; i++) {
          const notice = ((await page.locator(".toast-notice").textContent().catch(() => "")) || "");
          const after = ((await ms.innerText().catch(() => "")) || "").trim();
          if (/本地草稿|选区/.test(notice) || (after && after !== beforeText && !after.includes("不禁"))) break;
          await page.waitForTimeout(250);
        }
        const afterText = ((await ms.innerText().catch(() => "")) || "").trim();
        const changed =
          Boolean(afterText) &&
          (afterText !== beforeText || !afterText.includes("不禁") || afterText.includes("望着") || afterText.includes("像"));
        check("选区改写写回正文", changed, afterText.slice(0, 100));
      } else {
        check("选区改写流式/API 响应", false, "bubble missing");
        check("选区改写写回正文", false, "bubble missing");
      }

      // --- Streaming chat write (local-draft outline) ---
      const chatBox = page.locator("footer.composer textarea");
      await chatBox.fill("写全书大纲");
      const chatResp = page.waitForResponse(
        (r) => r.url().includes("/chat/stream") && r.request().method() === "POST",
        { timeout: 90_000 },
      );
      await page.locator("footer.composer button.send").click();
      // Stream status should appear
      const statusSeen = await page
        .getByText(/助手正在写|本地草稿|正在写/)
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      check("流式对话出现状态提示", statusSeen);
      let chatOk = false;
      try {
        const resp = await chatResp;
        chatOk = resp.ok();
        check("流式对话 chat/stream 响应", chatOk, `status=${resp.status()}`);
      } catch (e) {
        check("流式对话 chat/stream 响应", false, e instanceof Error ? e.message : String(e));
      }
      // Wait until busy clears / notice or outline opens
      for (let i = 0; i < 120; i++) {
        const notice = ((await page.locator(".toast-notice").textContent().catch(() => "")) || "");
        const busy = await page.locator("footer.composer .composer-box.busy").isVisible().catch(() => false);
        if (/已写入/.test(notice) || !busy) break;
        await page.waitForTimeout(500);
      }
      const writeNotice = ((await page.locator(".toast-notice").textContent().catch(() => "")) || "");
      // Also verify outline via API
      const bookPayload = (await (await fetch(`${apiUrl}/api/books/${bookId}`)).json()) as {
        artifacts: { kind: string; body?: string }[];
      };
      const outline = bookPayload.artifacts.find((a) => a.kind === "book_outline" && (a.body || "").trim());
      check(
        "流式对话写入全书大纲",
        Boolean(outline?.body && outline.body.trim().length > 20) || /已写入/.test(writeNotice),
        writeNotice.slice(0, 80) || `outlineLen=${outline?.body?.length ?? 0}`,
      );
    } else {
      check("API 预置第1章正文", false, "no bookId");
      check("正文载入编辑器", false);
      check("选区改写气泡出现", false);
      check("选区改写流式/API 响应", false);
      check("选区改写写回正文", false);
      check("流式对话出现状态提示", false);
      check("流式对话 chat/stream 响应", false);
      check("流式对话写入全书大纲", false);
    }

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
