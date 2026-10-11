// @ts-nocheck
// ACC60 E6/H5/H6(缩短)/F5 实测：50k 单章编辑延迟、20 万字书首屏、内存
import { chromium } from "playwright";
const B = "http://127.0.0.1:8787", W = "http://127.0.0.1:5173";
const j = async (m: string, p: string, b?: unknown) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, d: await r.json().catch(() => null) as any }; };
const para = "雾从江面压过来，天光只剩一层灰白。我站在跳板前，靴底碾碎了一层薄霜。“船不会说谎。”😀𪚥\n\n";
const big = (n: number) => para.repeat(Math.ceil(n / para.length)).slice(0, n);
const out: Record<string, unknown> = {};
const bk = (await j("POST", "/api/books", { title: "ACC60-20万字", targetChapters: 10, wordsPerChapter: 20000 })).d.book;
for (let n = 1; n <= 10; n++) await j("PUT", `/api/books/${bk.id}/artifacts`, { kind: "chapter_body", chapterNumber: n, body: big(20000) });
let t = Date.now(); const ex = await fetch(`${B}/api/books/${bk.id}/export.zip`); const buf = Buffer.from(await ex.arrayBuffer());
out.F5 = { ms: Date.now() - t, bytes: buf.length, status: ex.status, rssMB: Math.round(Number((await (await fetch(B + "/api/health")).ok)) && 0) };
const browser = await chromium.launch({ headless: true });
out.browser = browser.version();
const page = await browser.newPage();
t = Date.now();
await page.goto(`${W}/books/${bk.id}`, { waitUntil: "domcontentloaded" });
const ms = page.locator(".manuscript.ProseMirror, .ProseMirror").first();
await ms.waitFor({ timeout: 60000 });
out.H5_ttiMs = Date.now() - t; console.log("tti", out.H5_ttiMs);
const len = await ms.evaluate((el) => (el.textContent || "").length);
out.E6_editorChars = len;
await ms.click(); await page.keyboard.press("Control+End");
const lat: number[] = [];
for (let i = 0; i < 20; i++) { const s = Date.now(); await page.keyboard.type("字"); await page.evaluate(() => new Promise(requestAnimationFrame)); lat.push(Date.now() - s); }
lat.sort((a, b) => a - b);
out.E6_keyLatencyMs = { p50: lat[10], p95: lat[18], max: lat[19] };
const sel = await page.evaluate(() => { const s = getSelection(); return s?.anchorNode?.textContent?.slice(-3); });
out.E6_cursorTail = sel;
const heap0 = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? null);
const t0 = Date.now(); const samples: number[] = [];
while (Date.now() - t0 < Number(process.env.ACC_IDLE_MS || 180000)) { await page.waitForTimeout(30000); samples.push(await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0)); }
out.H6_heapMB = [heap0, ...samples].map((x) => Math.round((x ?? 0) / 1e5) / 10);
const fps = await page.evaluate(`new Promise((res)=>{const el=document.scrollingElement;let f=0;const s=performance.now();function st(){f++;el.scrollTop+=200;if(performance.now()-s<2000)requestAnimationFrame(st);else res(f/2)}requestAnimationFrame(st)})`);
out.H5_scrollFps = fps;
const e6 = (await j("POST", "/api/books", { title: "ACC60-E6-5万字单章", targetChapters: 1, wordsPerChapter: 50000 })).d.book;
await j("PUT", `/api/books/${e6.id}/artifacts`, { kind: "chapter_body", chapterNumber: 1, body: big(50000) });
const p2 = await browser.newPage();
await p2.goto(`${W}/books/${e6.id}`, { waitUntil: "domcontentloaded" });
const m2 = p2.locator(".manuscript.ProseMirror, .ProseMirror").first();
await m2.waitFor({ timeout: 60000 });
out.E6b_chars = await m2.evaluate((el) => (el.textContent || "").length);
await m2.click(); await p2.keyboard.press("Control+End");
const l2: number[] = [];
for (let i = 0; i < 20; i++) { const s = Date.now(); await p2.keyboard.type("字"); await p2.evaluate("new Promise(requestAnimationFrame)"); l2.push(Date.now() - s); }
l2.sort((a, b) => a - b);
out.E6b_keyLatencyMs = { p50: l2[10], p95: l2[18], max: l2[19] };
out.E6b_tail = await p2.evaluate("(m=>m&&m.textContent.slice(-5))(document.querySelector('.ProseMirror'))");
await j("DELETE", `/api/books/${e6.id}`);
await browser.close();
await j("DELETE", `/api/books/${bk.id}`);
console.log(JSON.stringify(out, null, 1));
