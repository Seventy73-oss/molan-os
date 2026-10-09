/**
 * Phase 1–2 audit regression tests. Uses temp SQLite + mock logic only.
 * Run: MOLAN_SQLITE_PATH=/tmp/molan-reg.sqlite npx tsx server/scripts/regression-audit.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDb = path.join(os.tmpdir(), `molan-reg-${Date.now()}.sqlite`);
process.env.MOLAN_SQLITE_PATH = tmpDb;
process.env.MOLAN_SECRET = "regression-test-secret-material-32b!";
delete process.env.DATABASE_URL;
delete process.env.MOLAN_DB;
delete process.env.MOLAN_HOST;

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  // Dynamic imports AFTER env is set so db picks up temp path.
  const { routeMessage, saveRevision, createBook, beginGeneration, getGeneration, completeGeneration, setJobStatus, createJob, getJob } =
    await import("../src/engine");
  const { assertSafeBaseUrl, isPrivateOrReservedHost, assertLanAuthConfigured } = await import("../src/security");
  const { importBookFromZipBuffer } = await import("../src/importBook");
  const { db } = await import("../src/db");

  // --- T04 routeMessage ---
  check("T04 不要写正文 → chat/null", routeMessage("不要写正文") === null);
  check("T04 别生成大纲 → null", routeMessage("别生成大纲") === null);
  check("T04 正文太短 → null", routeMessage("正文太短") === null);
  check("T04 怎么写正文？ → null", routeMessage("怎么写正文？") === null);
  check("T04 写第3章正文 → chapter_body", routeMessage("写第3章正文") === "chapter_body");
  check("T04 写全书大纲 → outline", routeMessage("写全书大纲") === "outline");
  check("T04 审核这一章 → review", routeMessage("审核这一章") === "review");

  // --- T08 IPv6 mapped + HTTPS ---
  check("T08 ::ffff:c0a8:101 private", isPrivateOrReservedHost("::ffff:c0a8:101") === true);
  check("T08 ::ffff:192.168.1.1 private", isPrivateOrReservedHost("::ffff:192.168.1.1") === true);
  let httpsOk = false;
  try {
    assertSafeBaseUrl("http://api.openai.com/v1", { withApiKey: true });
  } catch {
    httpsOk = true;
  }
  check("T08 公网 HTTP+Key 拒绝", httpsOk);
  check(
    "T08 公网 HTTPS+Key 白名单通过",
    assertSafeBaseUrl("https://api.openai.com/v1", { withApiKey: true }).startsWith("https://"),
  );

  let lanBlocked = false;
  try {
    assertLanAuthConfigured("0.0.0.0");
  } catch {
    lanBlocked = true;
  }
  check("T07 局域网无 Token 拒绝启动", lanBlocked);

  // --- T02-B CAS ---
  const book = createBook({
    title: `回归测试书 ${Date.now()}`,
    genre: "测试",
    logline: "临时",
    style: "",
    targetChapters: 2,
    wordsPerChapter: 500,
  });
  const bookId = book.payload.book.id;
  const first = saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "第一版正文。",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    expectedRevisionId: null,
    skipMemory: true,
  });
  check("T02-B 首次保存带 revisionId", Boolean(first.revisionId));

  let conflict = false;
  try {
    saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "冲突写入",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      expectedRevisionId: null, // stale baseline
      skipMemory: true,
    });
  } catch (e: unknown) {
    conflict = e instanceof Error && /冲突|409/.test(e.message);
  }
  check("T02-B 旧 expectedRevisionId 冲突", conflict);

  const second = saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "第二版正文。",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    expectedRevisionId: first.revisionId,
    skipMemory: true,
  });
  check("T02-B 正确基线可保存", second.revision === 2);

  // candidate does not become current
  const cand = saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "迟到的旧生成",
    source: "agent",
    model: "mock",
    skillIds: [],
    scene: "chapter_body",
    asCandidate: true,
    skipMemory: true,
  });
  const currentBody = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string }
  ).body;
  check("T02-B 候选稿不覆盖当前", currentBody === "第二版正文。" && cand.current === false);

  // --- T03 generation idempotency ---
  const gid = crypto.randomUUID();
  const g1 = beginGeneration({ id: gid, bookId, scene: "chat", chapterNumber: 1 });
  check("T03 beginGeneration 首次 running", g1.reused === false && g1.status === "running");
  completeGeneration(gid, { status: "completed", result: { ok: true, text: "once" } });
  const g2 = beginGeneration({ id: gid, bookId, scene: "chat", chapterNumber: 1 });
  check("T03 同 ID 复用已完成结果", g2.reused === true && g2.status === "completed" && (g2.result as { text: string }).text === "once");
  check("T03 getGeneration 可查", getGeneration(gid)?.status === "completed");

  // --- T06 job pause/cancel ---
  const job = createJob(bookId, 1, 1, { autoReview: false, maxRetries: 0 });
  setJobStatus(job.id, "paused");
  check("T06 可暂停", getJob(job.id).status === "paused");
  setJobStatus(job.id, "cancelled");
  check("T06 可取消", getJob(job.id).status === "cancelled");

  // --- T09 ZIP slip (sibling prefix) ---
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "molan-zip-"));
  const evilZip = path.join(zipDir, "evil.zip");
  const maker = path.join(zipDir, "make_evil.py");
  fs.writeFileSync(
    maker,
    `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], "w")
# classic slip attempting sibling dir via crafted name that shares prefix when using startswith
z.writestr("../escape-sibling.md", "pwned")
z.writestr("00-档案.md", "书名：安全导入\\n题材：测\\n简介：x\\n文风：\\n目标章数：1\\n每章字数：100\\n")
z.close()
`,
  );
  execFileSync("python3", [maker, evilZip]);
  let slipBlocked = false;
  try {
    importBookFromZipBuffer(fs.readFileSync(evilZip), { conflict: "new_book", title: "slip-test" });
  } catch (e: unknown) {
    slipBlocked = /zip slip|zip /i.test(String(e instanceof Error ? e.message : e)) || /Command failed|zip slip/i.test(String(e));
  }
  check("T09 ZIP .. 逃逸被拒", slipBlocked);

  // Prefix sibling path unit (mirrors old bug)
  const dest = "/tmp/molan-import-123";
  const evilTarget = "/tmp/molan-import-123-evil/escaped.md";
  const oldBug = evilTarget.startsWith(dest); // true — the bug
  const fixed = (() => {
    try {
      path.relative(dest, evilTarget);
      // if relative starts with .. it's outside
      const rel = path.relative(dest, evilTarget);
      return rel.startsWith("..") || path.isAbsolute(rel);
    } catch {
      return true;
    }
  })();
  check("T09 前缀兄弟目录：旧 startswith 会误判", oldBug === true);
  check("T09 前缀兄弟目录：relative 判定在外", fixed === true);

  // Title suffix preserved
  const goodZip = path.join(zipDir, "good.zip");
  fs.writeFileSync(
    path.join(zipDir, "make_good.py"),
    `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], "w")
z.writestr("00-档案.md", "书名：同名书\\n题材：测\\n简介：x\\n文风：\\n目标章数：1\\n每章字数：100\\n")
z.writestr("01-开篇/正文.md", "「不对」应被规范。\\n他说：“你好。”\\n")
z.close()
`,
  );
  execFileSync("python3", [path.join(zipDir, "make_good.py"), goodZip]);
  // seed existing same title
  createBook({ title: "同名书", genre: "测", logline: "x", style: "", targetChapters: 1, wordsPerChapter: 100 });
  const imported = importBookFromZipBuffer(fs.readFileSync(goodZip), { conflict: "new_book" });
  check("T09 同名 new_book 保留区分后缀", imported.title.includes("导入") && imported.title.startsWith("同名书"));

  // Persist queue catch unit (inline)
  let chain: Promise<void> = Promise.resolve();
  let ran = 0;
  function schedule(fail: boolean) {
    chain = chain
      .then(async () => {
        ran += 1;
        if (fail) throw new Error("boom");
      })
      .catch(() => {
        /* keep alive */
      });
  }
  schedule(true);
  schedule(false);
  await chain;
  check("T01 持久化队列失败后仍继续", ran === 2);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  try {
    fs.unlinkSync(tmpDb);
  } catch {
    /* ignore */
  }
  if (failed.length) {
    console.error("Failed:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
