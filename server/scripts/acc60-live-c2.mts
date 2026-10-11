// @ts-nocheck
import fs from "node:fs";
const B = "http://127.0.0.1:8787";
const j = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d }; };
const len = (t) => [...String(t || "").replace(/\s/g, "")].length;
const R = {}; const save = () => fs.writeFileSync("/workspace/changjuan/data/acc60/live-c2.json", JSON.stringify(R, null, 1));
const step = async (k, f) => { const t = Date.now(); try { R[k] = await f(); } catch (e) { R[k] = { err: String(e) }; } R[k + "_ms"] = Date.now() - t; console.log(k, JSON.stringify(R[k]).slice(0, 400)); save(); };
await step("C6", async () => {
  const c = (await j("POST", "/api/books", { title: "ACC60-C6b", targetChapters: 1, wordsPerChapter: 3000 })).d.book;
  const r = await j("POST", `/api/books/${c.id}/scene-runs`, { scene: "chapter_body", chapterNumber: 1, instruction: "写一段雪夜驿站的小说正文" });
  return { st: r.s, len3000: len(r.d?.text), err: r.s !== 200 ? r.d : undefined };
});
await step("B4B5", async () => {
  const as = await j("POST", `/api/books/auto-setup`, { brief: "民国上海，女侦探查一桩钟表行命案" });
  const id = as.d?.book?.id ?? as.d?.payload?.book?.id ?? as.d?.id;
  const cards = (await j("GET", `/api/books/${id}/bible`)).d?.cards || [];
  const d = (await j("GET", `/api/books/${id}`)).d;
  const ch = cards.find((c) => c.kind === "character");
  let edited = null;
  if (ch) edited = await j("PATCH", `/api/books/${id}/bible/${ch.id}`, { details: (ch.details || "") + "\n【作者修订】此人左眼戴黑色眼罩，说话前总先咳两声。" });
  const cards2 = (await j("GET", `/api/books/${id}/bible`)).d?.cards || [];
  const r = await j("POST", `/api/books/${id}/scene-runs`, { scene: "chapter_body", chapterNumber: 1, instruction: `写第1章，${ch?.name ?? "主角"}出场并说话` });
  const t = r.d?.text || "";
  return { autoSetup: as.s, keys: Object.keys(as.d || {}), err: as.s >= 300 ? as.d : undefined, cards: cards.map((c) => c.kind + ":" + c.name), artifactKinds: [...new Set((d?.artifacts || []).map((a) => a.kind))], editedStatus: edited?.s, persisted: cards2.some((c) => /眼罩/.test(c.details || "")), name: ch?.name, gen: r.s, followsPatch: /眼罩/.test(t), cough: /咳/.test(t) };
});
console.log("DONE");
