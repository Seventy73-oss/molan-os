/** Browser E2E with SDK-encrypted test sessions and a local mock AI, all in isolated SQLite. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { chromium, type Page } from "playwright";
import { fixtureCompletion, fixtureKey, fixtureSession, ORIGINAL_TEXT } from "./reference-test-fixtures.mjs";
import { fileImportChecks, sourceSearchChecks, writingChainChecks, writingFixture, type WritingCapture } from "./reference-chain-scenarios.mjs";
import { resilienceChecks } from "./reference-resilience-scenarios.mjs";

const root = process.cwd(), out = fs.mkdtempSync(path.join(os.tmpdir(), "molan-reference-browser-"));
const key = fixtureKey(); const session = fixtureSession(key, "reference-browser-audit");
let aiCalls = 0, passed = 0;
const children: ChildProcess[] = [], errors: string[] = [];
function check(name: string, ok: unknown) { assert.ok(ok, name); passed++; console.log("PASS " + name); }
async function freePort() { return new Promise<number>((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); }); }
const writingCaptures: WritingCapture[] = [];
let aiMode: "ok" | "credit" | "hold" = "ok";
const ai = createServer(async (req, res) => {
  if (!["/api/app-ai/chat", "/v1/chat/completions"].includes(req.url || "")) { res.writeHead(404).end(); return; }
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (req.url === "/v1/chat/completions") {
    assert.match(body.model, /^audit-/); writingCaptures.push(body);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(writingFixture(body))); return;
  }
  aiCalls++;
  assert.equal(body.viewer_user_id, "reference-browser-audit"); assert.equal(body.model_key, "qwen.qwen3.8-flash");
  if (aiMode === "credit") { res.writeHead(402, { "Content-Type": "application/json" }).end(JSON.stringify({ code: "app_ai_unavailable", secret: "do-not-leak-upstream" })); return; }
  if (aiMode === "hold") { await new Promise<void>(resolve => res.once("close", () => resolve())); return; }
  await new Promise(r => setTimeout(r, 250)); res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(fixtureCompletion(body)));
});
await new Promise<void>(resolve => ai.listen(0, "127.0.0.1", resolve));
const apiPort = await freePort(), webPort = await freePort();
const api = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${webPort}`;
function run(args: string[], env: Record<string, string>, logName: string) { const log = fs.openSync(path.join(out, logName), "w"); const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", log, log], detached: true }); children.push(child); return child; }
async function ready(url: string) { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await new Promise(r => setTimeout(r, 150)); } throw Error("Audit service not ready"); }
async function apiJson(route: string, method = "GET", body?: unknown) { const r = await fetch(api + route, { method, headers: { "x-eazo-session": session, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `Fixture API ${method} ${route}: ${r.status}`); return r.json() as Promise<any>; }
async function noOverflow(page: Page, label: string) { await page.waitForTimeout(180); check(label, await page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1")); }
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
const createdBooks: string[] = [];
try {
  const apiEnv = { MOLAN_SQLITE_PATH: path.join(out, "isolated.sqlite"), MOLAN_DATA_DIR: path.join(out, "data"), MOLAN_SECRET: "reference-browser-audit-only", DATABASE_URL: "", MOLAN_DB: "", PORT: String(apiPort), MOLAN_HOST: "127.0.0.1", MOLAN_JOB_INTERVAL_MS: "60000", MOLAN_CORS_ORIGINS: base, MOLAN_ALLOW_LOCAL_LLM: "1", MOLAN_AGENT_RUNTIME: "", CHANGJUAN_AGENT_RUNTIME: "", MOLAN_API_KEY: "isolated-writing-fixture-key", OPENAI_API_KEY: "", OPENAI_BASE_URL: `http://127.0.0.1:${(ai.address() as net.AddressInfo).port}/v1`, MOLAN_BASE_URL: "", MOLAN_NATIVE_PG: "", CHANGJUAN_DB: "", EAZO_APP_ID: "isolated-audit-app", EAZO_PRIVATE_KEY: key, EAZO_AI_PROVIDER_MODE: "eazo", EAZO_AI_TEXT_MODEL_KEY: "qwen.qwen3.8-flash", EAZO_APP_AI_API_BASE: `http://127.0.0.1:${(ai.address() as net.AddressInfo).port}` };
  let apiChild = run(["--import", "tsx", "server/src/index.ts"], apiEnv, "api.log");
  async function restartApi() {
    if (apiChild.pid && apiChild.exitCode === null) {
      const stopped = new Promise(resolve => apiChild.once("exit", resolve));
      process.kill(-apiChild.pid, "SIGTERM"); await stopped;
    }
    apiChild = run(["--import", "tsx", "server/src/index.ts"], apiEnv, "api-restarted.log");
    await ready(api + "/api/health");
  }
  const productionBuild = process.env.MOLAN_REFERENCE_PRODUCTION_AUDIT === "1";
  const webArgs = ["node_modules/vite/bin/vite.js", ...(productionBuild ? ["preview"] : []), "--host", "127.0.0.1", "--port", String(webPort)];
  run(webArgs, { MOLAN_WEB_HOST: "127.0.0.1", MOLAN_WEB_PORT: String(webPort), MOLAN_WEB_PREVIEW_PORT: String(webPort), MOLAN_API_PROXY: api }, "web.log");
  await Promise.all([ready(api + "/api/health"), ready(base)]);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({session}) => { localStorage.setItem("eazo.session", session); localStorage.setItem("molan.locale", "zh-CN"); }, {session});
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  await page.goto(base + "/references"); await page.getByRole("button", {name:"导入第一份文本"}).waitFor();
  check("SDK signed-in hydration reaches private empty library", await page.getByRole("button", {name:"退出登录"}).isVisible());
  await noOverflow(page, "desktop empty no overflow");
  await page.getByRole("button", {name:"导入第一份文本"}).click();
  await page.getByLabel("资料标题").fill("审计用原创短篇"); await page.getByLabel("作者 / 来源署名").fill("审计作者"); await page.getByLabel("或粘贴原文").fill(ORIGINAL_TEXT);
  check("rights gates import button", await page.getByRole("button", {name:"导入并选择章节"}).isDisabled());
  await page.getByLabel("我有权使用并分析这些内容；只提炼写作方法，不复制原作。").check(); await page.getByRole("button", {name:"导入并选择章节"}).click();
  await page.locator(".ref-reader-head h2").filter({hasText:"审计用原创短篇"}).waitFor();
  check("import reaches private chapter reader without model call", aiCalls === 0 && await page.locator(".ref-chapter-list input:checked").count() === 2);
  const index = await apiJson("/api/references"); const sid = index.sources[0].id;
  check("list endpoint works without trailing slash", index.sources.length === 1);
  await page.getByRole("button", {name:"用 Qwen3.8 Flash 蒸馏"}).click(); await page.locator(".ref-method-card").first().waitFor({timeout:15000});
  check("browser distillation persisted through generated API (mock model)", aiCalls === 1 && await page.locator(".ref-method-card").count() === 4);
  const reloadCalls = aiCalls; await page.reload(); await page.locator(".ref-method-card").first().waitFor(); check("reload preserves cards without repeat charges", aiCalls === reloadCalls);
  const first = page.locator(".ref-method-card").first();
  await first.getByRole("button", {name:"核对原文片段"}).click(); await page.locator("dialog[open]").waitFor();
  check("private source evidence dialog displays original passage", (await page.locator("dialog pre").innerText()).includes("旧站台"));
  await page.keyboard.press("Escape"); check("evidence closes on Escape", await page.locator("dialog[open]").count() === 0);
  const download = page.waitForEvent("download"); await page.getByRole("button", {name:"TXT",exact:true}).click(); check("authenticated TXT download", (await download).suggestedFilename().endsWith(".txt"));
  const created = await apiJson("/api/books", "POST", {title:"Reference UI fixture",genre:"测试",targetChapters:1,wordsPerChapter:300});
  const bid = created.payload?.book?.id || created.book?.id; assert.ok(bid); createdBooks.push(bid);
  await page.reload(); await page.locator(".ref-method-card").first().waitFor();
  await page.getByLabel("供哪本书的 Agent 参考？").selectOption(bid);
  const style = page.locator(".ref-method-card").filter({hasText:"style：先给可核对的异常"});
  check("bind disabled before approval", await style.getByRole("button", {name:"供本书参考",exact:true}).isDisabled());
  await style.getByRole("button", {name:"审阅通过",exact:true}).click(); await style.getByRole("button", {name:"撤回审阅",exact:true}).waitFor();
  check("consent still required after approval", await style.getByRole("button", {name:"供本书参考",exact:true}).isDisabled());
  await page.getByLabel("我同意将选中的方法卡提供给当前单实例写作工作区；原文仍私有。").check(); await style.getByRole("button", {name:"供本书参考",exact:true}).click();
  await style.getByRole("button", {name:"已供本书参考 · 取消",exact:true}).waitFor(); check("approved card linked through UI", (await apiJson(`/api/references/sources/${sid}`)).cards.some((c: any) => c.kind === "style" && c.bookIds.includes(bid)));
  await writingChainChecks({ page, api: apiJson, check, bookId: bid, sourceId: sid, sqlite: path.join(out, "isolated.sqlite"), captures: writingCaptures });
  await fileImportChecks(page, apiJson, check, () => aiCalls);
  await page.getByRole("button", {name:"删除来源",exact:true}).click(); check("delete confirmation starts at cancel", await page.getByRole("button", {name:"取消",exact:true}).evaluate((el: any) => el === el.ownerDocument.activeElement)); await page.keyboard.press("Escape"); check("delete Escape closes without removing source", await page.getByRole("group", {name:"删除来源确认"}).count() === 0 && (await apiJson("/api/references")).sources.length === 1);
  check("delete Escape restores trigger focus", await page.getByRole("button", {name:"删除来源",exact:true}).evaluate((el: any) => el === el.ownerDocument.activeElement));
  for (const [width, height, locale, theme] of [[1440,1000,"zh-CN","light"],[1024,820,"en-US","light"],[768,900,"zh-CN","dark"],[390,844,"zh-CN","light"],[360,780,"en-US","dark"],[320,740,"en-US","light"]] as const) {
    await page.setViewportSize({width,height}); await page.locator(".locale-select").selectOption(locale); await page.evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
    await noOverflow(page, `reader ${width}/${locale}/${theme} no overflow`);
    const verify = page.locator(".ref-method-card").first().getByRole("button", {name:locale === "zh-CN" ? "核对原文片段" : "Verify source passage"}); await verify.click(); await page.locator("dialog[open]").waitFor(); await noOverflow(page, `evidence ${width}/${locale} no overflow`); await page.keyboard.press("Escape");
    await page.getByRole("button", {name:locale === "zh-CN" ? "导入文本" : "Import text",exact:true}).click(); await noOverflow(page, `import ${width}/${locale} no overflow`);
    await page.getByRole("button", {name:locale === "zh-CN" ? "搜索小说" : "Find fiction",exact:true}).click(); await noOverflow(page, `search ${width}/${locale} no overflow`);
    await page.getByRole("button", {name:locale === "zh-CN" ? /^我的参考/ : /^My references/}).click();
  }
  await page.setViewportSize({width:390,height:844}); await page.locator(".locale-select").selectOption("zh-CN"); await page.screenshot({path:path.join(out,"private-reader-mobile.png"), fullPage:true});
  // Intercept source reads only for deterministic browser error/empty states;
  // real HTTP source parsing is tested separately with public-domain content.
  await page.route("**/api/references/search?*", route => route.fulfill({status:502, contentType:"application/json",body:JSON.stringify({code:"source_unavailable",error:"书源连接失败、证书无效或响应超限；可改用 TXT / Markdown 导入"})}));
  await page.getByRole("button",{name:"搜索小说",exact:true}).click(); await page.getByRole("textbox",{name:"搜索书名或作者",exact:true}).fill("网络错误测试"); await page.getByRole("button",{name:"搜索",exact:true}).click(); await page.getByRole("alert").waitFor(); check("source failure visible, no fake results", (await page.getByRole("alert").innerText()).includes("书源连接失败") && await page.locator(".ref-search-result").count() === 0);
  await page.locator(".locale-select").selectOption("en-US");
  check("source failure translates without changing source content", (await page.getByRole("alert").innerText()).includes("Import TXT or Markdown instead"));
  await page.locator(".locale-select").selectOption("zh-CN");
  await page.unroute("**/api/references/search?*");
  // Real fixed-source download, now entirely driven through visible browser controls.
  await sourceSearchChecks(page, apiJson, check, bid, writingCaptures, () => aiCalls);
  await resilienceChecks({ page, api: apiJson, check, sourceId: sid, setMode: mode => { aiMode = mode; }, calls: () => aiCalls, restart: restartApi });
  await page.getByRole("button",{name:"退出登录",exact:true}).click(); await page.getByRole("button",{name:"登录 Eazo，打开参考库"}).waitFor();
  check("logout clears SDK session and private view", await page.evaluate("localStorage.getItem('eazo.session') === null") && await page.locator(".ref-method-card").count() === 0);
  // Clear the bootstrap fixture hook: a new context tests a stale/tampered token.
  const invalidContext = await browser.newContext({viewport:{width:390,height:844}});
  await invalidContext.addInitScript(() => localStorage.setItem("eazo.session", JSON.stringify({encryptedData:"stale-invalid"})));
  const invalid = await invalidContext.newPage(); await invalid.goto(base + "/references"); await invalid.getByRole("button",{name:"登录 Eazo，打开参考库"}).waitFor();
  check("invalid stored session is cleared, never a private fallback", await invalid.evaluate("localStorage.getItem('eazo.session') === null"));
  await invalidContext.close();
  const login = page.getByRole("button",{name:"登录 Eazo，打开参考库"}); await page.evaluate("window.scrollTo(0,0)"); const box = await login.boundingBox();
  check("mobile sign-in CTA above bottom navigation", box && box.y + box.height < 780);
  await login.click(); await page.getByRole("dialog",{name:"Welcome"}).waitFor(); await page.getByRole("button",{name:"Continue with email"}).waitFor({timeout:35000});
  check("official standalone SDK login providers load", await page.getByRole("button",{name:"Continue with Google"}).isVisible());
  await page.getByRole("button",{name:"Continue with email"}).click(); check("SDK email sign-in route remains available", await page.getByRole("textbox").count() > 0); await page.keyboard.press("Escape"); await login.waitFor();
  check("cancelling login is not an app error", await page.getByRole("alert").count() === 0);
  // Host bridge simulation uses only the isolated test key and local API.
  // It does not claim to be an actual Eazo mobile-host session.
  const bridgeContext = await browser.newContext({viewport:{width:390,height:844}});
  const bridgeBob = fixtureSession(key, "reference-browser-bob");
  await bridgeContext.addInitScript({content:`(() => {
    const sessions = {alice:${session}, bob:${bridgeBob}};
    let current = 'alice';
    const user = () => current ? {id:current === 'alice' ? 'reference-browser-audit' : 'reference-browser-bob', name:current === 'alice' ? 'Bridge Alice' : 'Bridge Bob', email:null, avatarUrl:null} : null;
    const send = message => window.dispatchEvent(new MessageEvent('message', {data:JSON.stringify({ch:'eazo-sdk',v:1,...message})}));
    window.__referenceAuditHost = {requests:[], switchAccount(next) { current = next; send({t:'evt',name:'auth.changed',data:{authenticated:!!current,user:user()}}); }};
    window.ReactNativeWebView = {postMessage(raw) {
      const m = JSON.parse(raw); if (m.ch !== 'eazo-sdk') return;
      if (m.t === 'ready') { setTimeout(() => send({t:'hello',session:{authenticated:!!current,user:user(),token:null},device:{platform:'mobile',locale:'zh-CN'},capabilities:['auth.*']}), 20); return; }
      if (m.t !== 'req') return;
      window.__referenceAuditHost.requests.push(m.fn);
      setTimeout(() => {
        if (m.fn === 'auth.getSession') send({t:'res',id:m.id,ok:true,data:{session:current ? sessions[current] : null}});
        else if (m.fn === 'auth.requestLogout') { send({t:'res',id:m.id,ok:true,data:{}}); window.__referenceAuditHost.switchAccount(null); }
        else if (m.fn === 'auth.requestLogin') { send({t:'res',id:m.id,ok:true,data:{}}); setTimeout(() => window.__referenceAuditHost.switchAccount('alice'),20); }
        else send({t:'res',id:m.id,ok:false,err:{code:'NOT_SUPPORTED',message:'Fixture does not implement this capability'}});
      }, 5);
    }};
  })();`});
  const bridge = await bridgeContext.newPage(); bridge.on("pageerror", e => errors.push(e.message));
  await bridge.goto(base + "/references"); await bridge.getByText("Bridge Alice",{exact:true}).waitFor(); await bridge.locator(".ref-source").filter({hasText:"审计用原创短篇"}).waitFor();
  check("mobile bridge bootstrap uses authenticated session header", await bridge.evaluate("window.__referenceAuditHost.requests.includes('auth.getSession') && localStorage.getItem('eazo.session') === null"));
  // Hold a real Alice response, switch to Bob, then release the old response.
  let heldResponse: () => void = () => undefined; let seenResponse: () => void = () => undefined;
  const releaseResponse = new Promise<void>(resolve => { heldResponse = resolve; });
  const responseSeen = new Promise<void>(resolve => { seenResponse = resolve; });
  await bridge.route(`**/api/references/sources/${sid}`, async route => { const response = await route.fetch(); seenResponse(); await releaseResponse; await route.fulfill({response}); });
  try {
    await bridge.locator(".ref-source").filter({hasText:"审计用原创短篇"}).click(); await responseSeen;
    await bridge.evaluate("window.__referenceAuditHost.switchAccount('bob')"); await bridge.getByText("Bridge Bob",{exact:true}).waitFor(); await bridge.getByRole("button",{name:"导入第一份文本"}).waitFor();
  } finally { heldResponse(); }
  await bridge.waitForTimeout(300); await bridge.unroute(`**/api/references/sources/${sid}`);
  check("account switch discards late private source response", await bridge.locator(".ref-method-card").count() === 0 && await bridge.locator(".ref-reader-head").count() === 0 && !(await bridge.locator(".ref-source-list").innerText()).includes("审计用原创短篇"));
  await bridge.getByRole("button",{name:"导入第一份文本"}).click(); await bridge.getByLabel("资料标题").fill("Bob private unsent draft"); await bridge.getByLabel("或粘贴原文").fill(ORIGINAL_TEXT);
  await bridge.evaluate("window.__referenceAuditHost.switchAccount('alice')"); await bridge.getByText("Bridge Alice",{exact:true}).waitFor(); await bridge.locator(".ref-source").filter({hasText:"审计用原创短篇"}).waitFor();
  await bridge.getByRole("button",{name:"导入文本",exact:true}).click(); check("account switch clears import draft and consent", await bridge.getByLabel("资料标题").inputValue() === "" && await bridge.getByLabel("或粘贴原文").inputValue() === "");
  await bridge.getByRole("button",{name:"退出登录",exact:true}).click(); await bridge.getByRole("button",{name:"登录 Eazo，打开参考库"}).waitFor();
  check("bridge logout delegates to host and clears private workspace", await bridge.evaluate("window.__referenceAuditHost.requests.includes('auth.requestLogout')") && await bridge.locator(".ref-method-card").count() === 0);
  await bridge.getByRole("button",{name:"登录 Eazo，打开参考库"}).click(); await bridge.getByText("Bridge Alice",{exact:true}).waitFor(); await bridge.locator(".ref-source").filter({hasText:"审计用原创短篇"}).waitFor();
  check("bridge sign-in restores owner library without web login overlay", await bridge.evaluate("window.__referenceAuditHost.requests.includes('auth.requestLogin')") && await bridge.getByRole("dialog",{name:"Welcome"}).count() === 0);
  await bridgeContext.close();
  check("no runtime JS errors", errors.length === 0);
} finally {
  await browser?.close();
  for (const id of createdBooks) { try { await apiJson(`/api/books/${id}`, "DELETE"); } catch { /* isolated cleanup only */ } }
  for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* stopped */ } }
  ai.close();
}
console.log(`${passed}/${passed} reference browser checks passed; mock AI and fixture identity only.`);
