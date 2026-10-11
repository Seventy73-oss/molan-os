// @ts-nocheck
import fs from "node:fs"; import { execSync } from "node:child_process";
const B = "http://127.0.0.1:8787";
const j = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d }; };
const R = {};
// F5 非重复 20 万字
const bk = (await j("POST", "/api/books", { title: "ACC60-F5随机", targetChapters: 10, wordsPerChapter: 20000 })).d.book;
const rnd = (n) => { let s = ""; for (let i = 0; i < n; i++) { s += String.fromCharCode(0x4e00 + Math.floor(Math.random() * 20000)); if (i % 80 === 79) s += "。\n\n"; } return s; };
for (let n = 1; n <= 10; n++) await j("PUT", `/api/books/${bk.id}/artifacts`, { kind: "chapter_body", chapterNumber: n, body: rnd(20000) });
let t = Date.now(); const z = await fetch(`${B}/api/books/${bk.id}/export.zip`); const buf = Buffer.from(await z.arrayBuffer());
R.F5 = { ms: Date.now() - t, bytes: buf.length, st: z.status };
fs.writeFileSync("/tmp/f5.zip", buf);
const out = execSync("rm -rf /tmp/f5 && mkdir /tmp/f5 && cd /tmp/f5 && unzip -q /tmp/f5.zip && cat */*/正文.md | wc -m").toString().trim();
R.F5.unzippedChars = Number(out);
const one = await (await fetch(`${B}/api/books/${bk.id}/chapters/3/export.md`)).text();
const z3 = execSync("cat /tmp/f5/*/03-*/正文.md").toString();
R.F3 = { sameCh3: one.trim() === z3.trim() || one.includes(z3.trim().slice(0, 500)), lenOne: one.length, lenZip: z3.length };
await j("DELETE", `/api/books/${bk.id}`);
// B5 编辑档案后生成
const b = (await j("POST", "/api/books", { title: "ACC60-B5", targetChapters: 2, wordsPerChapter: 800, style: "第三人称" })).d.book;
await j("PUT", `/api/books/${b.id}/artifacts`, { kind: "book_profile", body: "# 档案\n\n主角：顾惊寒，女侦探。\n【作者修订】顾惊寒左眼戴黑色眼罩，说话前总先咳两声。" });
const g = await j("POST", `/api/books/${b.id}/scene-runs`, { scene: "chapter_body", chapterNumber: 1, instruction: "写第1章：顾惊寒走进钟表行勘查并与伙计对话，约800字" });
R.B5 = { st: g.s, eyepatch: /眼罩/.test(g.d?.text || ""), cough: /咳/.test(g.d?.text || "") };
console.log(JSON.stringify(R));
