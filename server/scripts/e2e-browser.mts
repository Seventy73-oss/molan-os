/**
 * Phase-4 browser E2E (Playwright Chromium).
 * Spawns API + Vite on free ports with a temp SQLite DB; exercises Library → Studio →
 * selection bubble matrix +「对助手说」custom + mid-stream abort + streaming chat write (local-draft) → Skills/Models.
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
        MOLAN_STREAM_PRE_DELAY_MS: "700",
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
    page.on("dialog", (dialog) => {
      void dialog.accept().catch(() => undefined);
    });

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

    // --- Selection bubble action matrix (local-draft) ---
    const bookIdMatch = page.url().match(/\/books\/([0-9a-f-]+)/i);
    const bookId = bookIdMatch?.[1] || "";
    check("工作室 URL 含书 id", Boolean(bookId), page.url());

    async function seedChapterBody(body: string) {
      const put = await fetch(`${apiUrl}/api/books/${bookId}/artifacts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "chapter_body",
          chapterNumber: 1,
          body,
          source: "human",
          scene: "chapter_body",
        }),
      });
      if (!put.ok) throw new Error(`seed body ${put.status}`);
      await page.reload({ waitUntil: "networkidle" });
      await page.locator("footer.composer textarea").waitFor({ state: "visible", timeout: 20_000 });
      const ms = page.locator(".manuscript.ProseMirror, .manuscript").first();
      await ms.waitFor({ state: "visible", timeout: 20_000 });
      for (let i = 0; i < 40; i++) {
        const t = ((await ms.innerText().catch(() => "")) || "").trim();
        if (t.length > 8) break;
        await page.waitForTimeout(250);
      }
      return ms;
    }

    async function selectAllAndBubble(ms: ReturnType<typeof page.locator>) {
      await ms.click();
      await page.keyboard.press("Control+A");
      const bubble = page.locator(".sel-bubble");
      await bubble.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
      return bubble;
    }

    if (bookId) {
      const seedRewrite =
        "他不禁看着远方，宛如陷入沉思。茶还没凉，门外已经安静下来。";
      let ms = await seedChapterBody(seedRewrite);
      check("API 预置第1章正文", true);
      const beforeRewrite = ((await ms.innerText().catch(() => "")) || "").trim();
      check("正文载入编辑器", beforeRewrite.includes("不禁") || beforeRewrite.includes("远方"), beforeRewrite.slice(0, 80));

      let bubble = await selectAllAndBubble(ms);
      let bubbleVisible = await bubble.isVisible().catch(() => false);
      check("选区改写气泡出现", bubbleVisible);

      const matrix: {
        label: string;
        name: string;
        seed: string;
        assert: (before: string, after: string) => boolean;
        hint: string;
      }[] = [
        {
          label: "改写",
          name: "选区「改写」",
          seed: seedRewrite,
          assert: (before, after) =>
            Boolean(after) &&
            (after !== before || !after.includes("不禁") || after.includes("望着") || after.includes("像")),
          hint: "rewrite",
        },
        {
          label: "续写",
          name: "选区「续写」",
          seed: "门轴轻响了一下。",
          assert: (before, after) =>
            after.length > before.length && (/茶杯|窗外|话还没落完|旧板/.test(after) || after.includes(before.slice(0, 4))),
          hint: "continue",
        },
        {
          label: "润色",
          name: "选区「润色」",
          seed: "他不禁看着远方，宛如陷入沉思。",
          assert: (_b, after) => !after.includes("不禁") && (after.includes("像") || after.includes("看着") || after.includes("望着") || after.length > 0),
          hint: "polish",
        },
        {
          label: "加强对白",
          name: "选区「加强对白」",
          seed: "她站在廊檐下，风把衣角掀起一点。",
          assert: (_b, after) => /[“”]/.test(after) || after.includes("你就说一句实话"),
          hint: "dialogue",
        },
      ];

      for (let i = 0; i < matrix.length; i++) {
        const item = matrix[i]!;
        try {
          if (i > 0) {
            ms = await seedChapterBody(item.seed);
          }
          const beforeText = ((await ms.innerText().catch(() => "")) || "").trim();
          bubble = await selectAllAndBubble(ms);
          bubbleVisible = await bubble.isVisible().catch(() => false);
          if (!bubbleVisible) {
            check(`${item.name} 气泡`, false, "bubble missing");
            check(`${item.name} API`, false, "bubble missing");
            check(`${item.name} 写回`, false, "bubble missing");
            continue;
          }
          if (i !== 0) check(`${item.name} 气泡`, true);
          const btn = bubble.getByRole("button", { name: item.label, exact: true });
          await btn.waitFor({ state: "visible", timeout: 5_000 });
          const respPromise = page.waitForResponse(
            (r) => r.url().includes("/selection-rewrite") && r.request().method() === "POST",
            { timeout: 45_000 },
          ).catch((e: unknown) => e);
          await btn.click({ force: true });
          const respOrErr = await respPromise;
          if (respOrErr && typeof respOrErr === "object" && "ok" in respOrErr && typeof (respOrErr as { ok: () => boolean }).ok === "function") {
            const resp = respOrErr as { ok: () => boolean; status: () => number };
            check(`${item.name} API`, resp.ok(), `status=${resp.status()}`);
          } else {
            const msg = respOrErr instanceof Error ? respOrErr.message : String(respOrErr);
            check(`${item.name} API`, false, msg.slice(0, 120));
          }
          for (let j = 0; j < 80; j++) {
            const after = ((await ms.innerText().catch(() => "")) || "").trim();
            if (after && item.assert(beforeText, after)) break;
            await page.waitForTimeout(250);
          }
          const afterText = ((await ms.innerText().catch(() => "")) || "").trim();
          check(`${item.name} 写回`, item.assert(beforeText, afterText), afterText.slice(0, 100));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          check(`${item.name} 气泡`, false, msg.slice(0, 120));
          check(`${item.name} API`, false, msg.slice(0, 120));
          check(`${item.name} 写回`, false, msg.slice(0, 120));
        }
      }

      // --- Phase7: bubble「对助手说…」custom instruction path ---
      try {
        const customSeed = "他不禁看着远方，宛如陷入沉思。茶还没凉。";
        ms = await seedChapterBody(customSeed);
        const beforeCustom = ((await ms.innerText().catch(() => "")) || "").trim();
        bubble = await selectAllAndBubble(ms);
        const customBubbleOk = await bubble.isVisible().catch(() => false);
        check("对助手说 气泡", customBubbleOk);
        if (customBubbleOk) {
          await bubble.getByRole("button", { name: "对助手说…", exact: true }).click({ force: true });
          const prompt = bubble.locator("textarea");
          await prompt.waitFor({ state: "visible", timeout: 5_000 });
          await prompt.fill("语气再冷一点，去掉不禁和宛如，别解释动机");
          const customRespPromise = page.waitForResponse(
            (r) => r.url().includes("/selection-rewrite") && r.request().method() === "POST",
            { timeout: 45_000 },
          ).catch((e: unknown) => e);
          await bubble.getByRole("button", { name: "应用到选区", exact: true }).click({ force: true });
          const customRespOrErr = await customRespPromise;
          if (customRespOrErr && typeof customRespOrErr === "object" && "ok" in customRespOrErr) {
            const resp = customRespOrErr as { ok: () => boolean; status: () => number; request: () => { postData: () => string | null } };
            check("对助手说 API", resp.ok(), `status=${resp.status()}`);
            let instructionOk = false;
            try {
              const body = JSON.parse(resp.request().postData() || "{}") as { instruction?: string };
              instructionOk = Boolean(body.instruction && /冷一点|不禁|宛如/.test(body.instruction));
            } catch {
              instructionOk = false;
            }
            check("对助手说 指令入参", instructionOk);
          } else {
            const msg = customRespOrErr instanceof Error ? customRespOrErr.message : String(customRespOrErr);
            check("对助手说 API", false, msg.slice(0, 120));
            check("对助手说 指令入参", false, "no response");
          }
          for (let j = 0; j < 80; j++) {
            const after = ((await ms.innerText().catch(() => "")) || "").trim();
            if (after && after !== beforeCustom && !after.includes("不禁")) break;
            await page.waitForTimeout(250);
          }
          const afterCustom = ((await ms.innerText().catch(() => "")) || "").trim();
          check(
            "对助手说 写回",
            Boolean(afterCustom) && !afterCustom.includes("不禁") && (afterCustom !== beforeCustom || afterCustom.includes("没再多说") || afterCustom.includes("像")),
            afterCustom.slice(0, 100),
          );
        } else {
          check("对助手说 API", false, "bubble missing");
          check("对助手说 指令入参", false, "bubble missing");
          check("对助手说 写回", false, "bubble missing");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        check("对助手说 气泡", false, msg.slice(0, 120));
        check("对助手说 API", false, msg.slice(0, 120));
        check("对助手说 指令入参", false, msg.slice(0, 120));
        check("对助手说 写回", false, msg.slice(0, 120));
      }

      // --- Mid-stream abort: seed outline, start write, click 停止 before delay ends ---
      const seedOutline = "PHASE6_BROWSER_SEED\n1. 开篇保留\n因果不动。";
      const putOutline = await fetch(`${apiUrl}/api/books/${bookId}/artifacts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "book_outline",
          chapterNumber: null,
          body: seedOutline,
          source: "human",
          scene: "outline",
        }),
      });
      check("API 预置全书大纲", putOutline.ok, String(putOutline.status));

      const chatBoxAbort = page.locator("footer.composer textarea");
      await chatBoxAbort.fill("写全书大纲");
      const streamStarted = page
        .waitForResponse(
          (r) => r.url().includes("/chat/stream") && r.request().method() === "POST",
          { timeout: 30_000 },
        )
        .catch(() => null);
      await page.locator("footer.composer button.send").click();
      // Wait for stop control during PRE_DELAY window
      const stopBtn = page.locator("button.stream-stop-inline").filter({ hasText: "停止" });
      const stopSeen = await stopBtn
        .first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      check("流式中途出现停止按钮", stopSeen);
      if (stopSeen) {
        await stopBtn.first().click({ force: true });
      }
      await streamStarted;
      for (let i = 0; i < 40; i++) {
        const busy = await page.locator("footer.composer .composer-box.busy").isVisible().catch(() => false);
        const notice = ((await page.locator(".toast-notice").textContent().catch(() => "")) || "");
        if (!busy || /已停止/.test(notice)) break;
        await page.waitForTimeout(200);
      }
      const stopNotice = ((await page.locator(".toast-notice").textContent().catch(() => "")) || "");
      const bookAfterAbort = (await (await fetch(`${apiUrl}/api/books/${bookId}`)).json()) as {
        artifacts: { kind: string; body?: string }[];
      };
      const outlineAfterAbort = bookAfterAbort.artifacts.find((a) => a.kind === "book_outline");
      const outlineKept = (outlineAfterAbort?.body || "").includes("PHASE6_BROWSER_SEED");
      check(
        "中途停止后大纲未被覆盖",
        outlineKept,
        `notice=${stopNotice.slice(0, 60)} body=${(outlineAfterAbort?.body || "").slice(0, 60)}`,
      );
      check(
        "中途停止提示或忙态解除",
        /已停止/.test(stopNotice) || !(await page.locator("footer.composer .composer-box.busy").isVisible().catch(() => false)),
        stopNotice.slice(0, 80),
      );

      // --- Streaming chat write (local-draft outline) after abort window ---
      const chatBox = page.locator("footer.composer textarea");
      await chatBox.fill("写全书大纲");
      const chatResp = page.waitForResponse(
        (r) => r.url().includes("/chat/stream") && r.request().method() === "POST",
        { timeout: 90_000 },
      );
      await page.locator("footer.composer button.send").click();
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
      for (let i = 0; i < 120; i++) {
        const notice = ((await page.locator(".toast-notice").textContent().catch(() => "")) || "");
        const busy = await page.locator("footer.composer .composer-box.busy").isVisible().catch(() => false);
        if (/已写入/.test(notice) || !busy) break;
        await page.waitForTimeout(500);
      }
      const writeNotice = ((await page.locator(".toast-notice").textContent().catch(() => "")) || "");
      const bookPayload = (await (await fetch(`${apiUrl}/api/books/${bookId}`)).json()) as {
        artifacts: { kind: string; body?: string }[];
      };
      const outline = bookPayload.artifacts.find((a) => a.kind === "book_outline" && (a.body || "").trim());
      const outlineFresh =
        Boolean(outline?.body && outline.body.trim().length > 20 && !outline.body.includes("PHASE6_BROWSER_SEED")) ||
        /已写入/.test(writeNotice);
      check(
        "流式对话写入全书大纲",
        outlineFresh,
        writeNotice.slice(0, 80) || `outlineLen=${outline?.body?.length ?? 0}`,
      );
    } else {
      check("API 预置第1章正文", false, "no bookId");
      check("正文载入编辑器", false);
      check("选区改写气泡出现", false);
      check("选区「改写」 API", false);
      check("选区「改写」 写回", false);
      check("选区「续写」 气泡", false);
      check("选区「续写」 API", false);
      check("选区「续写」 写回", false);
      check("选区「润色」 气泡", false);
      check("选区「润色」 API", false);
      check("选区「润色」 写回", false);
      check("选区「加强对白」 气泡", false);
      check("选区「加强对白」 API", false);
      check("选区「加强对白」 写回", false);
      check("API 预置全书大纲", false);
      check("流式中途出现停止按钮", false);
      check("中途停止后大纲未被覆盖", false);
      check("中途停止提示或忙态解除", false);
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
