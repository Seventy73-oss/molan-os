// @ts-nocheck
// ACC60 D 组复跑（D4 硬约束修复后）：真实模型 6 章 + 旧雾港样本复核
import fs from "node:fs";
const B = "http://127.0.0.1:8787";
const j = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d }; };
const OUT = "/workspace/changjuan/data/acc60/D4fix"; fs.mkdirSync(OUT, { recursive: true });
const R = {}; const save = () => fs.writeFileSync(OUT + "/result.json", JSON.stringify(R, null, 1));
const HC_WATCH = "硬约束：铜表停在三点十七分，指针永不再走，全书任何时刻都不能写它走动或嘀嗒 ｜禁：指针*走、秒针*走、分针*走、时针*走、指针还在游、分针爬、秒针跳、指针*动、滴答、嘀嗒";
const HC_WRIST = "硬约束：铜表一直戴在林砚左手腕上，不放进口袋 ｜禁：揣进*兜、从*兜里*表、口袋里的铜表、表*塞进*口袋";
const MODE = process.argv[2] || "all";
if (MODE === "old" || MODE === "all") {
  const D = "fc26c4cc-1243-4e0a-adc7-d2a38ebfc60b";
  const cards = (await j("GET", `/api/books/${D}/bible`)).d.cards;
  const ex = cards.find((c) => c.name === "铜表·硬约束");
  if (ex) await j("PATCH", `/api/books/${D}/bible/${ex.id}`, { details: HC_WATCH });
  else await j("POST", `/api/books/${D}/bible`, { kind: "prop", name: "铜表·硬约束", summary: "", details: HC_WATCH });
  R.old = {};
  for (const n of [4, 5]) {
    R.old[`pre${n}`] = (await j("GET", `/api/books/${D}/hard-constraints/check?chapterNumber=${n}`)).d;
    const t = Date.now();
    const rv = await j("POST", `/api/books/${D}/scene-runs`, { scene: "review", chapterNumber: n, instruction: "审查本章与设定卡、前文是否矛盾，逐条列出" });
    R.old[`review${n}`] = { st: rv.s, ms: Date.now() - t, text: rv.d?.text, err: rv.s !== 200 ? rv.d : undefined };
    save(); console.log("old review", n, rv.s, R.old[`pre${n}`]?.violations?.length);
  }
}
if (MODE === "new" || MODE === "all") {
  const bk = (await j("POST", "/api/books", { title: "ACC60-D雾港·硬约束复跑", genre: "悬疑", logline: "第一人称：码头验货员林砚追查一艘失踪货船", style: "第一人称“我”叙述，冷峻克制", targetChapters: 6, wordsPerChapter: 2500 })).d.book;
  R.bookId = bk.id; save();
  await j("POST", `/api/books/${bk.id}/bible`, { kind: "character", name: "林砚", summary: "主角“我”，28岁，码头验货员。", details: "口头禅：“船不会说谎。”习惯动作：思考时用拇指摩挲左手腕上的旧铜表。致命弱点：怕深水（幼年溺水），一靠近没顶的水就手脚发僵。时间：深秋十一月，地点：雾港南码头。" });
  await j("POST", `/api/books/${bk.id}/bible`, { kind: "item", name: "铜表", summary: "林砚左腕旧铜表，表盖内刻“渡”字，停在三点十七分。", details: `第1章出现，后续线索：失踪货船“渡远号”船长的遗物。\n${HC_WATCH}\n${HC_WRIST}` });
  R.constraints = (await j("GET", `/api/books/${bk.id}/hard-constraints`)).d;
  const plan = [
    "第1章：深秋雾港南码头，我验货时发现渡远号空箱；必须写出我的口头禅“船不会说谎。”、摩挲铜表动作，并点明铜表停在三点十七分、表盖刻“渡”字；写出我怕深水的致命弱点。",
    "第2章：我夜访船东老宋；埋下伏笔：老宋书桌上一枚缺角的黄铜船钉，他慌忙藏起。",
    "第3章：我在仓库对账，找到渡远号最后一次出港记录，时间是三点十七分。",
    "第4章：我重新审视那块铜表，必须明确引用第1章的同一块铜表（刻“渡”字、停在三点十七分），把它与渡远号联系起来。",
    "第5章：我被迫潜入没顶的海水下的旧泊位（直面怕深水的致命弱点），并在水下找到与第2章老宋藏起的同款缺角黄铜船钉，回收伏笔。",
    "第6章：真相：老宋凿沉渡远号；我在码头对质，结尾说出“船不会说谎。”",
  ];
  R.ch = [];
  for (let n = 1; n <= 6; n++) {
    const t = Date.now(); let r;
    for (let a = 0; a < 2; a++) {
      r = await j("POST", `/api/books/${bk.id}/scene-runs`, { scene: "chapter_body", chapterNumber: n, instruction: plan[n - 1] + " 用第一人称“我”，正文约2500字，只写小说正文，不要复述上一章，不要提纲。" });
      if (r.s === 200) break;
    }
    const text = r.d?.text || "";
    fs.writeFileSync(`${OUT}/chapter-${n}.txt`, text);
    R.ch.push({ n, st: r.s, ms: Date.now() - t, chars: Array.from(text.replace(/\s/g, "")).length, hc: r.d?.hardConstraintCheck, err: r.s !== 200 ? r.d : undefined });
    save(); console.log("ch", n, r.s, R.ch.at(-1).chars, r.d?.hardConstraintCheck?.violations?.length);
  }
  R.newReview = {};
  for (const n of [4, 5]) {
    const t = Date.now();
    const rv = await j("POST", `/api/books/${bk.id}/scene-runs`, { scene: "review", chapterNumber: n, instruction: "审查本章与设定卡、前文是否矛盾，逐条列出" });
    R.newReview[n] = { st: rv.s, ms: Date.now() - t, text: rv.d?.text };
    save(); console.log("new review", n, rv.s);
  }
}
console.log("DONE");
