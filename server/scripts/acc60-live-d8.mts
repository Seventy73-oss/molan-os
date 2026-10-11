// @ts-nocheck
// ACC60 D8：真实模型写满 ≥10 万字后重生成第 3 章，核对全书设定。可续跑：进度在 data/acc60/d8/state.json
import fs from "node:fs";
const B = "http://127.0.0.1:8787";
const j = async (m, p, b) => { try { return await j0(m, p, b); } catch (e) { return { s: 0, d: { fetchError: String(e?.cause?.code || e) } }; } };
const j0 = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d }; };
const OUT = "/workspace/changjuan/data/acc60/d8"; fs.mkdirSync(OUT, { recursive: true });
const SF = OUT + "/state.json";
const S = fs.existsSync(SF) ? JSON.parse(fs.readFileSync(SF, "utf8")) : { startedAt: Date.now(), ch: {}, total: 0 };
const save = () => fs.writeFileSync(SF, JSON.stringify(S, null, 1));
const log = (o) => { fs.appendFileSync(OUT + "/checkpoint.log", new Date().toISOString() + " " + JSON.stringify(o) + "\n"); console.log(JSON.stringify(o)); };
const cc = (t) => Array.from((t || "").replace(/\s/g, "")).length;
const TARGET = 100000, MAXCH = 60;
const HC_WATCH = "硬约束：铜表停在三点十七分，指针永不再走，全书任何时刻都不能写它走动或嘀嗒 ｜禁：指针*走、秒针*走、分针*走、时针*走、指针还在游、分针爬、秒针跳、指针*动、滴答、嘀嗒";
const HC_WRIST = "硬约束：铜表一直戴在林砚左手腕上，不摘下、不放进口袋 ｜禁：揣进*兜、从*兜里*表、口袋里的铜表、表*塞进*口袋、摘下*铜表、把铜表摘";
if (!S.bookId) {
  const bk = (await j("POST", "/api/books", { title: "ACC60-D8雾港·十万字", genre: "悬疑", logline: "第一人称：码头验货员林砚追查失踪货船渡远号，牵出雾港三十年走私案", style: "第一人称“我”叙述，冷峻克制", targetChapters: 44, wordsPerChapter: 2500 })).d.book;
  S.bookId = bk.id; save();
  await j("POST", `/api/books/${bk.id}/bible`, { kind: "character", name: "林砚", summary: "主角“我”，28岁，码头验货员。", details: "口头禅：“船不会说谎。”习惯动作：思考时用拇指摩挲左手腕上的旧铜表。致命弱点：怕深水（幼年溺水），一靠近没顶的水就手脚发僵。时间：故事始于深秋十一月，地点：雾港南码头。" });
  await j("POST", `/api/books/${bk.id}/bible`, { kind: "item", name: "铜表", summary: "林砚左腕旧铜表，表盖内刻“渡”字，停在三点十七分。", details: `渡远号船长的遗物。\n${HC_WATCH}\n${HC_WRIST}` });
  await j("POST", `/api/books/${bk.id}/bible`, { kind: "character", name: "老宋", summary: "船东宋怀山，55岁，右眉有刀疤，抽旱烟。", details: "表面和善，实为走私网首脑之一。" });
  log({ ev: "book", bookId: bk.id });
}
const ID = S.bookId;
const arcs = [
  "雾港南码头验货，发现渡远号空箱", "夜访船东老宋，他藏起一枚缺角黄铜船钉", "仓库对账，找到渡远号最后出港记录三点十七分",
  "码头工人阿青透露渡远号夜里有人上船", "海关旧档案室里缺了一页", "被人跟踪到鱼市", "老宋请我喝酒，试探我知道多少",
  "灯塔看守老周的证词", "在废船坞找到渡远号救生圈", "警察局的韩警官劝我收手", "阿青失踪", "我在阿青租屋找到账本残页",
  "账本指向三十年前的另一艘沉船", "我回忆父亲与渡远号船长的旧事", "雾港台风夜", "台风后海滩冲上来的木箱",
  "老宋手下夜袭我的住处", "我躲进修船厂", "韩警官暗中递来消息", "找到渡远号船长的女儿沈渡", "沈渡讲述铜表来历",
  "我与沈渡查走私线的仓库", "仓库里的冷藏箱", "被困冷库", "脱险后我高烧", "阿青的尸体在防波堤下被发现",
  "葬礼上老宋出现", "我伪装成搬运工混上老宋的货船", "货船上偷听交易", "身份暴露，跳船前的犹豫（怕深水）",
  "被渔民救起", "沈渡带来船厂图纸", "推断渡远号是被凿沉", "去旧泊位勘察，必须下水", "我潜入没顶的海水，找到与老宋同款的缺角船钉",
  "带着船钉找韩警官", "韩警官被调走，内鬼浮现", "我与老宋第一次正面摊牌", "老宋放火烧仓库", "火场救出沈渡",
  "交出账本给省里来的调查组", "老宋出逃被截在码头", "码头对质，真相大白", "尾声：雾散，我站在南码头，说出“船不会说谎。”",
];
const planFor = (n) => `第${n}章：${arcs[n - 1] || `余波：雾港案后续（第${n}章），继续推进人物关系`}。保持全书设定：第一人称“我”（林砚），铜表一直戴在我左手腕、停在三点十七分永不走动；思考时拇指摩挲铜表；口头禅“船不会说谎。”可自然出现；我怕深水；老宋右眉刀疤。`;
for (let n = 1; n <= MAXCH && S.total < TARGET; n++) {
  if (S.ch[n]?.ok) continue;
  const t = Date.now(); let r;
  for (let a = 0; a < 4; a++) {
    r = await j("POST", `/api/books/${ID}/scene-runs`, { scene: "chapter_body", chapterNumber: n, instruction: planFor(n) + " 正文约2500字，只写小说正文，不要复述上一章，不要提纲。" });
    if (r.s === 200 && cc(r.d?.text) > 800) break;
    log({ ev: "retry", n, st: r.s, err: String(JSON.stringify(r.d)).slice(0, 200) });
    await new Promise((z) => setTimeout(z, 15000 * (a + 1)));
  }
  const text = r.d?.text || "";
  if (r.s !== 200 || cc(text) < 800) { log({ ev: "fail", n, st: r.s }); process.exit(2); }
  fs.writeFileSync(`${OUT}/chapter-${n}.txt`, text);
  S.ch[n] = { ok: true, ms: Date.now() - t, chars: cc(text), hcViol: r.d?.hardConstraintCheck?.violations?.length ?? null };
  S.total = Object.values(S.ch).reduce((a, c) => a + (c.chars || 0), 0); save();
  log({ ev: "ch", n, ...S.ch[n], total: S.total });
}
if (S.total < TARGET) { log({ ev: "notEnough", total: S.total }); process.exit(3); }
if (!S.regen) {
  const orig = fs.readFileSync(`${OUT}/chapter-3.txt`, "utf8"); fs.writeFileSync(`${OUT}/ch3-original.txt`, orig);
  const pv = (await j("GET", `/api/books/${ID}/context-preview?scene=chapter_body&chapterNumber=3`)).d;
  fs.writeFileSync(`${OUT}/ch3-context-preview.json`, JSON.stringify(pv, null, 1));
  const t = Date.now(); let r;
  for (let a = 0; a < 4; a++) {
    r = await j("POST", `/api/books/${ID}/scene-runs`, { scene: "chapter_body", chapterNumber: 3, instruction: "重写" + planFor(3) + " 正文约2500字，只写小说正文，不要复述上一章，不要提纲。" });
    if (r.s === 200 && cc(r.d?.text) > 800) break;
    await new Promise((z) => setTimeout(z, 15000 * (a + 1)));
  }
  fs.writeFileSync(`${OUT}/ch3-regen.txt`, r.d?.text || "");
  fs.writeFileSync(`${OUT}/ch3-regen-resp.json`, JSON.stringify({ ...r.d, text: undefined }, null, 1));
  S.regen = { st: r.s, ms: Date.now() - t }; save(); log({ ev: "regen", ...S.regen });
}
const marks = (t) => ({ chars: cc(t), wo: (t.match(/我/g) || []).length, third林砚: (t.match(/林砚(?!”)/g) || []).length, catch: /船不会说谎/.test(t), rub: /摩挲/.test(t), stop317: /三点十七/.test(t), wrist: /左(手)?腕/.test(t), viol: (t.match(/(指针|秒针|分针|时针).{0,4}(走|动|跳|爬|游)|滴答|嘀嗒|摘下.{0,4}表|口袋里的铜表/g) || []), recap: (t.slice(0, 200).match(/上一章/g) || []).length, outline: /^\s*[一二三四五六七八九十0-9]+[、.]/m.test(t) });
const orig = fs.readFileSync(`${OUT}/ch3-original.txt`, "utf8"), regen = fs.readFileSync(`${OUT}/ch3-regen.txt`, "utf8");
S.cmp = { original: marks(orig), regen: marks(regen) };
S.precheck = (await j("GET", `/api/books/${ID}/hard-constraints/check?chapterNumber=3`)).d;
const rv = await j("POST", `/api/books/${ID}/scene-runs`, { scene: "review", chapterNumber: 3, instruction: "审查本章与设定卡、硬约束、前文是否矛盾（人称、铜表、口头禅、怕深水、老宋外貌、季节地点），逐条列出" });
fs.writeFileSync(`${OUT}/ch3-review.txt`, rv.d?.text || JSON.stringify(rv.d));
S.review = { st: rv.s }; S.usage = (await j("GET", `/api/books/${ID}/usage`)).d?.summary; S.doneAt = Date.now(); save();
log({ ev: "done", cmp: S.cmp, precheck: S.precheck?.violations?.length });
