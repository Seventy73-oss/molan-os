// @ts-nocheck
import fs from "node:fs";
const B = "http://127.0.0.1:8787";
const j = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d }; };
const R = {}; const save = () => fs.writeFileSync("/workspace/changjuan/data/acc60/live-d2.json", JSON.stringify(R, null, 1));
const D = "fc26c4cc-1243-4e0a-adc7-d2a38ebfc60b";
let t = Date.now();
const rv = await j("POST", `/api/books/${D}/scene-runs`, { scene: "review", chapterNumber: 5, instruction: "审查本章与设定卡、前文是否矛盾，逐条列出" });
R.D9 = { st: rv.s, ms: Date.now() - t, text: rv.d?.text, err: rv.s !== 200 ? rv.d : undefined }; save(); console.log("D9", rv.s);
// D7 近窗口：15 万字背景卡 + 关键设定
const bk = (await j("POST", "/api/books", { title: "ACC60-D7近窗口", targetChapters: 2, wordsPerChapter: 800, style: "第一人称" })).d.book;
const filler = "港口编年史：某年某月，某船靠岸，卸下杂货若干，天气阴。".repeat(5500);
await j("POST", `/api/books/${bk.id}/bible`, { kind: "lore", name: "港口编年史", summary: "背景资料", details: filler });
await j("POST", `/api/books/${bk.id}/bible`, { kind: "character", name: "沈鹭", summary: "主角“我”，右手缺一根小指，名字叫沈鹭。", details: "关键设定：右手缺小指；随身带一只蓝色搪瓷杯。" });
const pv = (await j("GET", `/api/books/${bk.id}/context-preview?scene=chapter_body&chapterNumber=1`)).d;
R.D7_preview = pv?.budgetEstimate; save(); console.log("D7 preview", JSON.stringify(pv?.budgetEstimate));
t = Date.now();
const g = await j("POST", `/api/books/${bk.id}/scene-runs`, { scene: "chapter_body", chapterNumber: 1, instruction: "写第1章：我在码头喝茶，约800字，自然写出主角身体特征和随身物" });
R.D7 = { st: g.s, ms: Date.now() - t, err: g.s !== 200 ? g.d : undefined, finger: /小指/.test(g.d?.text || ""), cup: /搪瓷|蓝.{0,3}杯/.test(g.d?.text || ""), usage: (await j("GET", `/api/books/${bk.id}/usage`)).d?.summary };
save(); console.log("D7", JSON.stringify(R.D7)); console.log("DONE");
