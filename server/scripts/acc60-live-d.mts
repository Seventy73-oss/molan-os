// @ts-nocheck
// ACC60 D 组：真实模型连续续写 6 章（第一人称 ~2500 字），输出原文供一致性人工+规则判定
import fs from "node:fs";
const B = "http://127.0.0.1:8787";
const j = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, d: await r.json().catch(() => null) }; };
const OUT = "/workspace/changjuan/data/acc60/D";
fs.mkdirSync(OUT, { recursive: true });
const bk = (await j("POST", "/api/books", { title: "ACC60-D雾港", genre: "悬疑", logline: "第一人称：码头验货员林砚追查一艘失踪货船", style: "第一人称“我”叙述，冷峻克制", targetChapters: 6, wordsPerChapter: 2500 })).d.book;
fs.writeFileSync(OUT + "/book.json", JSON.stringify(bk));
await j("POST", `/api/books/${bk.id}/bible`, { kind: "character", name: "林砚", summary: "主角“我”，28岁，码头验货员。", details: "口头禅：“船不会说谎。”习惯动作：思考时用拇指摩挲左手腕上的旧铜表。致命弱点：怕深水（幼年溺水），一靠近没顶的水就手脚发僵。时间：深秋十一月，地点：雾港南码头。" });
await j("POST", `/api/books/${bk.id}/bible`, { kind: "item", name: "铜表", summary: "林砚左腕旧铜表，表盖内刻“渡”字，停在三点十七分。", details: "第1章出现，后续线索：失踪货船“渡远号”船长的遗物。" });
const plan = [
  "第1章：深秋雾港南码头，我验货时发现渡远号空箱；必须写出我的口头禅“船不会说谎。”、摩挲铜表动作，并点明铜表停在三点十七分、表盖刻“渡”字；写出我怕深水的致命弱点。",
  "第2章：我夜访船东老宋；埋下伏笔：老宋书桌上一枚缺角的黄铜船钉，他慌忙藏起。",
  "第3章：我在仓库对账，找到渡远号最后一次出港记录，时间是三点十七分。",
  "第4章：我重新审视那块铜表，必须明确引用第1章的同一块铜表（刻“渡”字、停在三点十七分），把它与渡远号联系起来。",
  "第5章：我被迫潜入没顶的海水下的旧泊位（直面怕深水的致命弱点），并在水下找到与第2章老宋藏起的同款缺角黄铜船钉，回收伏笔。",
  "第6章：真相：老宋凿沉渡远号；我在码头对质，结尾说出“船不会说谎。”",
];
const log = [];
for (let n = 1; n <= 6; n++) {
  const t = Date.now();
  let r;
  for (let a = 0; a < 2; a++) {
    r = await j("POST", `/api/books/${bk.id}/scene-runs`, { scene: "chapter_body", chapterNumber: n, instruction: plan[n - 1] + " 用第一人称“我”，正文约2500字，只写小说正文，不要复述上一章，不要提纲。" });
    if (r.s === 200) break;
  }
  const art = await j("GET", `/api/books/${bk.id}/chapters/${n}`);
  const body = JSON.stringify(art.d).length ? (art.d?.body ?? art.d?.artifacts?.find?.((x) => x.kind === "chapter_body")?.body ?? "") : "";
  const rec = { n, status: r.s, ms: Date.now() - t, err: r.s !== 200 ? r.d : undefined, keys: Object.keys(r.d || {}) };
  log.push(rec); console.log(JSON.stringify(rec));
  fs.writeFileSync(`${OUT}/resp-${n}.json`, JSON.stringify(r.d));
  fs.writeFileSync(`${OUT}/chapter-${n}.json`, JSON.stringify(art.d));
}
fs.writeFileSync(OUT + "/log.json", JSON.stringify(log, null, 1));
console.log("DONE", bk.id);
