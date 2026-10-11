// @ts-nocheck — browser-context evaluate code
/** H5 audit: screenshots + metrics against a running web (default live 5173). */
import { chromium, devices } from "playwright";
import fs from "node:fs";
const web = process.env.WEB || "http://127.0.0.1:5173";
const tag = process.env.TAG || "before";
const book = process.env.BOOK || "01a45327-d403-4f90-a2fb-c508cc8f1265";
const out = "docs/h5";
const vps = [
  { name: "iphone13", vp: { width: 390, height: 844 } },
  { name: "android360", vp: { width: 360, height: 780 } },
  { name: "ipad768", vp: { width: 768, height: 1024 } },
];
const report: any = {};
const b = await chromium.launch();
for (const v of vps) {
  const ctx = await b.newContext({ viewport: v.vp, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: devices["iPhone 13"].userAgent });
  const p = await ctx.newPage();
  async function measure(label: string) {
    const m = await p.evaluate(() => {
      const de = document.documentElement;
      const small: string[] = [];
      document.querySelectorAll("button,a,[role=button],input,select,textarea").forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden") return;
        if (r.height < 32 || r.width < 32) small.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().split(" ")[0]}:${(el.textContent||"").trim().slice(0,8)}(${Math.round(r.width)}x${Math.round(r.height)})`);
      });
      const tinyInputs: string[] = [];
      document.querySelectorAll("input,textarea,select").forEach((el) => {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width && fs < 16) tinyInputs.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().split(" ")[0]}(${fs}px)`);
      });
      const wide: string[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width && r.right > window.innerWidth + 2 && getComputedStyle(el).position !== "fixed") wide.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().split(" ")[0]}`);
      });
      return { scrollW: de.scrollWidth, innerW: window.innerWidth, overflowX: de.scrollWidth > window.innerWidth + 1, smallTargets: small.length, smallSample: small.slice(0, 12), tinyInputs: [...new Set(tinyInputs)], wide: [...new Set(wide)].slice(0, 10) };
    });
    (report[v.name] ||= {})[label] = m;
  }
  await p.goto(web + "/", { waitUntil: "networkidle" });
  await measure("library");
  if (v.name === "iphone13") await p.screenshot({ path: `${out}/${tag}-library.png` });
  for (const r of ["skills", "models"]) {
    await p.goto(`${web}/${r}`, { waitUntil: "networkidle" });
    await measure(r);
    if (v.name === "iphone13") await p.screenshot({ path: `${out}/${tag}-${r}.png` });
  }
  await p.goto(`${web}/books/${book}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await measure("studio");
  if (v.name === "iphone13") {
    await p.screenshot({ path: `${out}/${tag}-studio-editor.png` });
    const tab = p.locator(".m-tab", { hasText: "助手" });
    if (await tab.count()) await tab.click();
    else await p.locator("footer.composer textarea").scrollIntoViewIfNeeded().catch(() => {});
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/${tag}-assistant.png` });
    const doc = p.locator(".m-tab", { hasText: "正文" });
    if (await doc.count()) await doc.click();
    // select a paragraph text
    const para = p.locator(".manuscript p").nth(1);
    await para.scrollIntoViewIfNeeded().catch(() => {});
    await para.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); });
    await p.waitForTimeout(600);
    const bub = await p.locator(".sel-bubble").boundingBox().catch(() => null);
    (report[v.name] ||= {}).bubble = bub;
    await p.screenshot({ path: `${out}/${tag}-selection-bubble.png` });
    const tools = p.locator(".doc-tools button", { hasText: "工具" });
    await tools.click().catch(() => {});
    await p.waitForTimeout(400);
    await measure("tools");
    await p.screenshot({ path: `${out}/${tag}-tools.png` });
  }
  await ctx.close();
}
await b.close();
fs.writeFileSync(`${out}/${tag}-metrics.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1).slice(0, 6000));
