// @ts-nocheck
// ACC60 非模型 API 用例：A/B/E/F/G/I
import { spawn } from "node:child_process";
import fs from "node:fs";
const B = "http://127.0.0.1:8787";
const req = async (base, m, p, b, h = {}) => { const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json", ...h }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d, t }; };
const j = (m, p, b, h) => req(B, m, p, b, h);
const R = {};
// A1/A3 access token: second instance on 8799 with temp DB
const tmp = fs.mkdtempSync("/tmp/acc60-");
const child = spawn("npx", ["tsx", "server/src/index.ts"], { env: { ...process.env, PORT: "8799", MOLAN_ACCESS_TOKEN: "acc60-token-xyz", MOLAN_SQLITE_PATH: tmp + "/t.sqlite", MOLAN_JOB_INTERVAL_MS: "999999" }, stdio: "ignore" });
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); try { await fetch("http://127.0.0.1:8799/api/health"); break; } catch {} }
const T = "http://127.0.0.1:8799";
const noTok = await req(T, "POST", "/api/books/x/chat", { message: "写第1章" });
const badTok = await req(T, "GET", "/api/books", null, { authorization: "Bearer wrong" });
const okTok = await req(T, "GET", "/api/books", null, { authorization: "Bearer acc60-token-xyz" });
const usageT = await req(T, "GET", "/api/usage/summary", null, { authorization: "Bearer acc60-token-xyz" });
R.A3 = { noTokChat: noTok.s, badTok: badTok.s, okTok: okTok.s, usage: usageT.d };
child.kill();
// A2/I3 cross-book id
const b1 = (await j("POST", "/api/books", { title: "ACC60-A书" })).d.book;
const b2 = (await j("POST", "/api/books", { title: "ACC60-B书" })).d.book;
const ch = await j("GET", `/api/books/${b1.id}/chapters/1`);
const fake = await j("GET", `/api/books/00000000-0000-0000-0000-000000000000`);
const revs1 = await j("GET", `/api/books/${b1.id}/artifacts/revisions?kind=chapter_body&chapterNumber=1`);
await j("PUT", `/api/books/${b1.id}/artifacts`, { kind: "chapter_body", chapterNumber: 1, body: "A书秘密正文" });
const rv = await j("GET", `/api/books/${b1.id}/artifacts/revisions?kind=chapter_body&chapterNumber=1`);
const revId = rv.d?.revisions?.[0]?.id;
const cross = await j("GET", `/api/books/${b2.id}/artifacts/revisions/${revId}`);
const crossRestore = await j("POST", `/api/books/${b2.id}/artifacts/revisions/${revId}/restore`, {});
R.A2 = { fakeBook: fake.s, fakeLeak: /秘密/.test(fake.t), revId: !!revId, crossGet: cross.s, crossLeak: /A书秘密/.test(cross.t), crossRestore: crossRestore.s };
// B1-B3
const blist = await j("GET", "/api/books");
R.B1 = { first: blist.d?.books?.[0]?.title };
const t200 = "长".repeat(200), t201 = "长".repeat(201);
const ok200 = await j("POST", "/api/books", { title: t200 });
const no201 = await j("POST", "/api/books", { title: t201 });
const emo = await j("POST", "/api/books", { title: "雾港😀𪚥\u3000全角　空格" });
const emoBack = await j("GET", `/api/books/${emo.d?.book?.id}`);
R.B2 = { ok200: ok200.s, len200: [...(ok200.d?.book?.title || "")].length, no201: no201.s, msg: no201.d, emoji: emoBack.d?.book?.title };
const only = await j("POST", "/api/books", { title: "仅书名" });
const empty = await j("POST", "/api/books", { title: "  " });
R.B3 = { onlyTitle: only.s, genre: only.d?.book?.genre, emptyTitle: empty.s, emptyMsg: empty.d };
// B6 delete
const del = await j("DELETE", `/api/books/${only.d.book.id}`);
const after = await j("GET", `/api/books/${only.d.book.id}`);
R.B6 = { del: del.s, after: after.s };
// B7 two tabs CAS on bible card? use artifact CAS
const s0 = await j("PUT", `/api/books/${b2.id}/artifacts`, { kind: "book_setup", body: "档案v1" });
const base = s0.d?.revisionId;
const tabA = await j("PUT", `/api/books/${b2.id}/artifacts`, { kind: "book_setup", body: "档案-标签A", expectedRevisionId: base });
const tabB = await j("PUT", `/api/books/${b2.id}/artifacts`, { kind: "book_setup", body: "档案-标签B", expectedRevisionId: base });
R.B7 = { a: tabA.s, aConf: tabA.d?.conflicted, b: tabB.s, bConf: tabB.d?.conflicted ?? tabB.d };
// E1-E5
const e = (await j("POST", "/api/books", { title: "ACC60-E", targetChapters: 4 })).d.book;
for (let n = 1; n <= 4; n++) await j("PUT", `/api/books/${e.id}/artifacts`, { kind: "chapter_body", chapterNumber: n, body: `第${n}章正文标记E${n}` });
const add = await j("POST", `/api/books/${e.id}/chapters`, { title: "插入章" });
const delMid = await j("DELETE", `/api/books/${e.id}/chapters/2`);
const chs = await j("GET", `/api/books/${e.id}/chapters`);
const bodies = [];
for (const c of chs.d?.chapters || []) { const x = await j("GET", `/api/books/${e.id}/chapters/${c.number}`); bodies.push([c.number, c.title, JSON.stringify(x.d).match(/E\d/)?.[0] || null]); }
R.E1E2 = { add: add.s, addNumber: add.d?.number ?? add.d?.chapter?.number, delMid: delMid.s, chapters: bodies };
const s1 = await j("PUT", `/api/books/${e.id}/artifacts`, { kind: "chapter_body", chapterNumber: 1, body: "改A" });
const s2 = await j("PUT", `/api/books/${e.id}/artifacts`, { kind: "chapter_body", chapterNumber: 1, body: "改A" });
const s3 = await j("PUT", `/api/books/${e.id}/artifacts`, { kind: "chapter_body", chapterNumber: 1, body: "改B" });
R.E4 = { r1: s1.d?.revision, r2: s2.d?.revision, unchanged: s2.d?.unchanged, r3: s3.d?.revision };
const rl = await j("GET", `/api/books/${e.id}/artifacts/revisions?kind=chapter_body&chapterNumber=1`);
const revA = rl.d?.revisions?.find((x) => x.revision === s1.d?.revision)?.id;
const back = await j("POST", `/api/books/${e.id}/artifacts/revisions/${revA}/restore`, {});
const cur1 = JSON.stringify((await j("GET", `/api/books/${e.id}/chapters/1`)).d);
const edit = await j("PUT", `/api/books/${e.id}/artifacts`, { kind: "chapter_body", chapterNumber: 1, body: "回滚后继续编辑" });
const rl2 = await j("GET", `/api/books/${e.id}/artifacts/revisions?kind=chapter_body&chapterNumber=1`);
const revB = rl2.d?.revisions?.find((x) => x.revision === s3.d?.revision)?.id;
const back2 = await j("POST", `/api/books/${e.id}/artifacts/revisions/${revB}/restore`, {});
const cur2 = JSON.stringify((await j("GET", `/api/books/${e.id}/chapters/1`)).d);
R.E5 = { restore1: back.s, hasA: /改A/.test(cur1), edit: edit.s, restore2: back2.s, hasB: /改B/.test(cur2) };
// F
const f = (await j("POST", "/api/books", { title: "ACC60/F:书*名?<>|", targetChapters: 2 })).d.book;
const txt = "第一段：中文标点，“引号”——破折号……English words 😀 生僻字𪚥𠀾龘";
await j("PUT", `/api/books/${f.id}/artifacts`, { kind: "chapter_body", chapterNumber: 1, body: txt });
await j("PUT", `/api/books/${f.id}/artifacts`, { kind: "chapter_body", chapterNumber: 2, body: "第二章内容" });
const zr = await fetch(`${B}/api/books/${f.id}/export.zip`);
const zbuf = Buffer.from(await zr.arrayBuffer());
fs.writeFileSync(tmp + "/f.zip", zbuf);
const md = await fetch(`${B}/api/books/${f.id}/chapters/1/export.md`);
const mdText = await md.text();
R.F = { zip: zr.status, zipDisp: zr.headers.get("content-disposition"), md: md.status, mdDisp: md.headers.get("content-disposition"), mdHasAll: mdText.includes(txt), fffd: mdText.includes("\uFFFD"), zipPath: tmp + "/f.zip", mdHead: mdText.slice(0, 200) };
// G1/G2/G7
const g1 = await j("POST", `/api/books/${b2.id}/chat`, { message: "   " });
const g2 = await j("POST", `/api/books/${b2.id}/chat`, { message: "字".repeat(50000) });
const g7a = await j("POST", `/api/books`, { title: "\u200b\u200b" });
const g7b = await j("POST", `/api/books`, { title: "a".repeat(5000) });
const g7c = await fetch(B + "/api/books", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad json" });
const g7cT = await g7c.text();
const g7d = await j("PUT", `/api/books/${b2.id}/artifacts`, { kind: "chapter_body", chapterNumber: 99999, body: "x" });
const g7e = await j("PUT", `/api/books/${b2.id}/artifacts`, { kind: "../../etc", body: "x" });
R.G = { g1: [g1.s, g1.d], g2: [g2.s, g2.d], zw: [g7a.s, g7a.d], longNoSpace: [g7b.s, typeof g7b.d === "object" ? g7b.d.error : g7b.t.slice(0, 80)], badJson: [g7c.status, g7cT.slice(0, 120)], badCh: [g7d.s, g7d.t.slice(0, 120)], badKind: [g7e.s, g7e.t.slice(0, 120)], stackLeak: [g7cT, g7d.t, g7e.t].some((x) => /at .*\.ts:\d+|node_modules/.test(x)) };
// I4: responses no key / internal
const prov = await j("GET", "/api/settings/provider");
const routes = await j("GET", "/api/scene-routes");
const all = prov.t + routes.t + (await j("GET", "/api/books")).t + (await j("GET", "/api/health")).t;
R.I4 = { keyLeak: /sk-[0-9a-f]{20,}/.test(all), hint: prov.d?.apiKeyHint, healthDbPath: (await j("GET", "/api/health")).d?.db?.detail };
console.log(JSON.stringify(R, null, 1));
fs.writeFileSync("/workspace/changjuan/data/acc60/api.json", JSON.stringify(R, null, 1));
