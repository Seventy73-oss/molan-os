/**
 * Phase-3 audit E2E (API-level, mock models / local-draft only).
 * Covers: slow/concurrent CAS, SSE lost receipt, process restart, late candidate,
 * job pause/cancel, overwrite-import rollback, durable import recovery, AbortSignal cancel,
 * SQLite lease, worker storage policy, corrupt recovery quarantine.
 *
 * Run: npm run test:e2e
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDb = path.join(os.tmpdir(), `molan-e2e-${Date.now()}.sqlite`);
process.env.MOLAN_SQLITE_PATH = tmpDb;
process.env.MOLAN_SECRET = "e2e-test-secret-material-32bytes!!";
delete process.env.DATABASE_URL;
delete process.env.MOLAN_DB;
delete process.env.MOLAN_HOST;
delete process.env.MOLAN_IMPORT_FAIL_AFTER_WIPE;

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const engine = await import("../src/engine");
  const {
    importBookFromZipBuffer,
    __snapshotBookForTest,
    __restoreBookSnapshotForTest,
    __writeDurableSnapshotForTest,
    __clearDurableSnapshotForTest,
    __recoveryFileForTest,
    __isValidSnapshotForTest,
    __cleanupOrphanTmpFilesForTest,
    recoverInterruptedImports,
    importRecoveryDir,
  } = await import("../src/importBook");
  const { db } = await import("../src/db");
  const {
    withJobLock,
    tryAcquireJobLease,
    releaseJobLease,
    assertJobWorkerStoragePolicy,
    experimentalPgWorkerAllowed,
    jobWorkerAllowedForDriver,
  } = await import("../src/jobs/worker").then(async () => {
    const worker = await import("../src/jobs/worker");
    return {
      withJobLock: worker.withJobLock,
      tryAcquireJobLease: engine.tryAcquireJobLease,
      releaseJobLease: engine.releaseJobLease,
      assertJobWorkerStoragePolicy: worker.assertJobWorkerStoragePolicy,
      experimentalPgWorkerAllowed: worker.experimentalPgWorkerAllowed,
      jobWorkerAllowedForDriver: worker.jobWorkerAllowedForDriver,
    };
  });
  const { throwIfAborted, isAbortError } = await import("../src/abortUtil");
  const { emitChunked } = await import("../src/agent/openai");

  const book = engine.createBook({
    title: `E2E书 ${Date.now()}`,
    genre: "测",
    logline: "临时",
    style: "",
    targetChapters: 2,
    wordsPerChapter: 400,
  });
  const bookId = book.payload.book.id;

  // --- Concurrent / slow save (CAS) ---
  const r1 = engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "慢请求基线A",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    expectedRevisionId: null,
    skipMemory: true,
  });
  // Simulate concurrent editor B saving with same expectedRevisionId after A already moved on
  engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "用户续写B",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    expectedRevisionId: r1.revisionId,
    skipMemory: true,
  });
  let concurrentConflict = false;
  try {
    engine.saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "慢请求迟到A覆盖",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      expectedRevisionId: r1.revisionId, // stale
      skipMemory: true,
    });
  } catch (e) {
    concurrentConflict = e instanceof Error && /冲突|409/.test(e.message);
  }
  check("E2E 并发/慢保存 CAS 冲突", concurrentConflict);
  const cur = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string }
  ).body;
  check("E2E 慢请求不能盖掉续写", cur === "用户续写B");

  // --- Late old result as candidate ---
  const late = engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "迟到的旧模型结果",
    source: "agent",
    model: "mock-late",
    skillIds: [],
    scene: "chapter_body",
    asCandidate: true,
    skipMemory: true,
  });
  const cur2 = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string }
  ).body;
  check("E2E 迟到旧结果不设当前稿", cur2 === "用户续写B" && late.current === false);

  // --- SSE lost receipt: generation completed server-side; client re-queries, no second call ---
  const gid = crypto.randomUUID();
  engine.beginGeneration({ id: gid, bookId, scene: "chat", chapterNumber: 1 });
  engine.completeGeneration(gid, { status: "completed", result: { message: { content: "once" }, saved: null } });
  const again = engine.beginGeneration({ id: gid, bookId, scene: "chat", chapterNumber: 1 });
  check(
    "E2E SSE丢回执后同 generationId 复用",
    again.reused === true && again.status === "completed" && (again.result as { message: { content: string } }).message.content === "once",
  );
  // Simulate "process restart": re-read via getGeneration (same sqlite file)
  const afterRestart = engine.getGeneration(gid);
  check("E2E 进程重启后 generation 可恢复", afterRestart?.status === "completed");

  // --- AbortSignal chain ---
  const ac = new AbortController();
  ac.abort();
  let aborted = false;
  try {
    throwIfAborted(ac.signal);
  } catch (e) {
    aborted = isAbortError(e);
  }
  check("E2E AbortSignal throwIfAborted", aborted);

  let chunkAborted = false;
  const ac2 = new AbortController();
  const chunkPromise = emitChunked(
    "一二三四五六七八九十",
    async () => {
      /* noop */
    },
    2,
    ac2.signal,
  );
  ac2.abort();
  try {
    await chunkPromise;
  } catch (e) {
    chunkAborted = isAbortError(e);
  }
  // race: may complete before abort if too fast — force abort-first
  const ac3 = new AbortController();
  ac3.abort();
  try {
    await emitChunked("abcdefghij", async () => {}, 1, ac3.signal);
  } catch (e) {
    chunkAborted = chunkAborted || isAbortError(e);
  }
  check("E2E emitChunked 尊重 AbortSignal", chunkAborted);

  const cancelGid = crypto.randomUUID();
  engine.beginGeneration({ id: cancelGid, bookId, scene: "chapter_body", chapterNumber: 1 });
  const cancelled = engine.cancelGeneration(cancelGid);
  check("E2E cancelGeneration", cancelled.status === "cancelled");

  // --- Job pause / cancel ---
  const job = engine.createJob(bookId, 1, 1, { autoReview: false, maxRetries: 0 });
  // Seed outline so tick skips model-heavy outline generation somewhat
  engine.saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: "1. 开篇\n因果。",
    source: "human",
    model: null,
    skillIds: [],
    scene: "outline",
    skipMemory: true,
  });
  // Pause before tick
  engine.setJobStatus(job.id, "paused");
  const pausedTick = await engine.tickJob(job.id);
  check("E2E 暂停后 tick 不推进", pausedTick.advanced === false && pausedTick.job.status === "paused");

  engine.setJobStatus(job.id, "running");
  // Cancel mid-stage semantics: cancel then ensure candidate path
  // First advance outline stage
  const t1 = await engine.tickJob(job.id);
  check("E2E running tick 可推进", t1.advanced === true);

  // Cancel while on chapter_outline — next executeScene saves as candidate if cancelled during call
  // Set cancel after starting: for local-draft sync, cancel before tick of body stage.
  // Move to chapter_body stage if needed
  // Force cancel
  engine.setJobStatus(job.id, "cancelled");
  const bodyBeforeCancel = cur2;
  const cancelledTick = await engine.tickJob(job.id);
  check(
    "E2E 取消后不再推进",
    cancelledTick.advanced === false && cancelledTick.job.status === "cancelled",
  );
  const bodyAfterCancel = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string }
  ).body;
  check("E2E 取消后当前正文不变", bodyAfterCancel === bodyBeforeCancel);

  // --- SQLite lease hardening ---
  const job2 = engine.createJob(bookId, 2, 2, { autoReview: false, maxRetries: 0 });
  const ownerA = "owner-A";
  const ownerB = "owner-B";
  const gotA = tryAcquireJobLease(job2.id, ownerA, 60_000);
  const gotB = tryAcquireJobLease(job2.id, ownerB, 60_000);
  check("E2E SQLite lease 互斥", gotA === true && gotB === false);
  releaseJobLease(job2.id, ownerA);
  const gotB2 = tryAcquireJobLease(job2.id, ownerB, 60_000);
  check("E2E 释放后可再租约", gotB2 === true);
  releaseJobLease(job2.id, ownerB);

  // Dual withJobLock: second returns null
  let ran = 0;
  const p1 = withJobLock(job2.id, async () => {
    ran += 1;
    await new Promise((r) => setTimeout(r, 80));
    return "a";
  }, "lock-1");
  await new Promise((r) => setTimeout(r, 10));
  const p2 = withJobLock(job2.id, async () => {
    ran += 1;
    return "b";
  }, "lock-2");
  const [a, b] = await Promise.all([p1, p2]);
  check("E2E withJobLock 互斥", a === "a" && b === null && ran === 1);

  // --- Overwrite import rollback ---
  // Seed content to overwrite
  engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "覆盖前正文应保留",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    expectedRevisionId: undefined,
    skipMemory: true,
  });
  const titleBefore = (db.prepare("SELECT title FROM books WHERE id = ?").get(bookId) as { title: string }).title;

  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "molan-e2e-zip-"));
  const zipPath = path.join(zipDir, "ow.zip");
  fs.writeFileSync(
    path.join(zipDir, "make.py"),
    `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], "w")
z.writestr("00-档案.md", "书名：${titleBefore}\\n题材：测\\n简介：x\\n文风：\\n目标章数：2\\n每章字数：400\\n")
z.writestr("01-开篇/正文.md", "导入新正文不应留下")
z.close()
`,
  );
  execFileSync("python3", [path.join(zipDir, "make.py"), zipPath]);

  process.env.MOLAN_IMPORT_FAIL_AFTER_WIPE = "1";
  let restored = false;
  try {
    importBookFromZipBuffer(fs.readFileSync(zipPath), { conflict: "overwrite", title: titleBefore });
  } catch (e) {
    restored = /回滚|injected import failure/i.test(String(e instanceof Error ? e.message : e));
  }
  delete process.env.MOLAN_IMPORT_FAIL_AFTER_WIPE;
  const bodyAfterFail = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string } | undefined
  )?.body;
  check(
    "E2E 覆盖导入失败后回滚正文",
    restored && bodyAfterFail === "覆盖前正文应保留",
    bodyAfterFail,
  );

  // Snapshot round-trip unit
  const snap = __snapshotBookForTest(bookId);
  const bodySnap = "快照轮转标记";
  engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: bodySnap,
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    skipMemory: true,
  });
  __restoreBookSnapshotForTest(snap);
  const bodyRestored = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string }
  ).body;
  check("E2E 快照可完整还原", bodyRestored === "覆盖前正文应保留");

  // --- Durable import recovery (crash window) ---
  const snapForCrash = __snapshotBookForTest(bookId);
  __writeDurableSnapshotForTest(snapForCrash);
  const recoveryPath = __recoveryFileForTest(bookId);
  check("E2E 落盘恢复文件已写入", fs.existsSync(recoveryPath), recoveryPath);
  // Simulate wipe without restore (crash window)
  db.prepare("DELETE FROM messages WHERE book_id = ?").run(bookId);
  const mid = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE book_id = ?").get(bookId) as { n: number }
  ).n;
  check("E2E 模拟 wipe 后消息清空", mid === 0);
  const recovered = recoverInterruptedImports();
  check(
    "E2E 启动恢复打断的覆盖导入",
    recovered.restored.includes(bookId) && !fs.existsSync(recoveryPath),
    JSON.stringify(recovered),
  );
  const msgsAfter = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE book_id = ?").get(bookId) as { n: number }
  ).n;
  check("E2E 恢复后消息行数回到快照", msgsAfter === snapForCrash.messages.length, String(msgsAfter));

  // SQLite worker policy allows; clear any leftover
  __clearDurableSnapshotForTest(bookId);
  const policy = assertJobWorkerStoragePolicy();
  check("E2E SQLite 允许任务 worker", policy.allowed && policy.reason === "sqlite", policy.reason);
  const prevFlag = process.env.MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER;
  delete process.env.MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER;
  check("E2E PG worker 默认拒绝开关", experimentalPgWorkerAllowed() === false);
  process.env.MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER = "1";
  check("E2E PG worker 显式允许开关", experimentalPgWorkerAllowed() === true);
  if (prevFlag === undefined) delete process.env.MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER;
  else process.env.MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER = prevFlag;

  // Pure driver refuse (no cluster lease claim)
  const pgRefuse = jobWorkerAllowedForDriver("postgres", false);
  check("E2E Postgres 驱动默认拒开 worker", !pgRefuse.allowed && /拒绝/.test(pgRefuse.reason), pgRefuse.reason);
  const pgliteRefuse = jobWorkerAllowedForDriver("pglite", false);
  check("E2E PGlite 驱动默认拒开 worker", !pgliteRefuse.allowed, pgliteRefuse.reason);
  const pgOptIn = jobWorkerAllowedForDriver("postgres", true);
  check("E2E Postgres 显式 opt-in 才允许", pgOptIn.allowed && /single-process/.test(pgOptIn.reason), pgOptIn.reason);

  // Corrupt recovery quarantine + orphan tmp cleanup
  check("E2E 快照 schema 校验拒绝空对象", __isValidSnapshotForTest({}) === false);
  const badId = `corrupt-e2e-${Date.now()}`;
  const badPath = __recoveryFileForTest(badId);
  fs.mkdirSync(path.dirname(badPath), { recursive: true });
  fs.writeFileSync(badPath, "{not-json", "utf8");
  const afterCorrupt = recoverInterruptedImports();
  check(
    "E2E 损坏恢复文件被跳过并隔离",
    afterCorrupt.skipped.includes(badId) && !fs.existsSync(badPath),
    JSON.stringify(afterCorrupt),
  );
  const corruptDir = path.join(importRecoveryDir(), "corrupt");
  const quarantined = fs.existsSync(corruptDir)
    ? fs.readdirSync(corruptDir).some((n) => n.startsWith(badId))
    : false;
  check("E2E 损坏快照进入 corrupt 目录", quarantined, corruptDir);
  const tmpOrphan = path.join(importRecoveryDir(), `.orphan.${process.pid}.tmp`);
  fs.writeFileSync(tmpOrphan, "x", "utf8");
  const cleaned = __cleanupOrphanTmpFilesForTest();
  check("E2E 清理孤儿 tmp 恢复文件", cleaned >= 1 && !fs.existsSync(tmpOrphan), String(cleaned));

  // Cancelled generation reuse
  let cancelReuse = false;
  try {
    await engine.chat(bookId, "随便聊聊", 1, cancelGid);
  } catch (e) {
    cancelReuse = e instanceof Error && /取消/.test(e.message);
  }
  check("E2E 已取消 generation 不可重放成写入", cancelReuse);

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
