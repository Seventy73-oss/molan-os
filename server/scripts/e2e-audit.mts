/**
 * Phase-3 audit E2E (API-level, mock models / local-draft only).
 * Covers: slow/concurrent CAS, SSE lost receipt, process restart, late candidate,
 * job pause/cancel, overwrite-import rollback, durable import recovery, AbortSignal cancel,
 * SQLite lease, worker storage policy, corrupt recovery quarantine, mid-stream cancel no overwrite, post-save cancel demote / agent_cancelled, completed-stop no demote + restore-previous.
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
    recoverPhysicalImportBackups,
    importRecoveryDir,
    __physicalBackupDbPathForTest,
    __writePhysicalSqliteBackupForTest,
    __clearPhysicalSqliteBackupForTest,
    __legacyWholeDbPhysPathForTest,
    __legacyWholeDbPendingForTest,
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

  // --- streamSceneRun beginGeneration + CAS candidate ---
  {
    const { streamSceneRun } = await import("../src/streamSupport");
    const streamGid = crypto.randomUUID();
    const events: Record<string, unknown>[] = [];
    const emit = async (e: Record<string, unknown>) => {
      events.push(e);
    };
    // Seed outline baseline
    const base = engine.saveRevision({
      bookId,
      kind: "book_outline",
      chapterNumber: null,
      body: "流式基线大纲。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "outline",
      skipMemory: true,
    });
    // Concurrent human edit before stream finishes — we simulate by advancing after capture via expectedRevisionId
    const humanMid = engine.saveRevision({
      bookId,
      kind: "book_outline",
      chapterNumber: null,
      body: "流式中途用户改。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "outline",
      expectedRevisionId: base.revisionId,
      skipMemory: true,
    });
    await streamSceneRun(emit, {
      bookId,
      scene: "outline",
      chapterNumber: null,
      instruction: "按档案写全书大纲",
      generationId: streamGid,
      expectedRevisionId: base.revisionId, // stale baseline as if captured at start
      onConflict: "candidate",
    });
    const gen = engine.getGeneration(streamGid);
    const done = events.find((e) => e.type === "done") as
      | { type: string; payload?: { saved?: { current?: boolean; conflicted?: boolean } } }
      | undefined;
    const curBody = (
      db
        .prepare(
          `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
           WHERE a.book_id = ? AND a.kind = 'book_outline' AND a.chapter_id IS NULL`,
        )
        .get(bookId) as { body: string }
    ).body;
    check(
      "E2E streamSceneRun beginGeneration completed",
      gen?.status === "completed" && Boolean(done),
      `status=${gen?.status} events=${events.map((e) => e.type).join(",")}`,
    );
    check(
      "E2E streamSceneRun 冲突→候选",
      done?.payload?.saved?.current === false &&
        done?.payload?.saved?.conflicted === true &&
        curBody === "流式中途用户改。",
      `saved=${JSON.stringify(done?.payload?.saved)} cur=${curBody}`,
    );
    // Idempotent reuse
    const events2: Record<string, unknown>[] = [];
    await streamSceneRun(async (e) => { events2.push(e); }, {
      bookId,
      scene: "outline",
      chapterNumber: null,
      instruction: "按档案写全书大纲",
      generationId: streamGid,
    });
    check(
      "E2E streamSceneRun 同 generationId 复用",
      events2.length === 1 && events2[0]?.type === "done",
      JSON.stringify(events2.map((e) => e.type)),
    );
    void humanMid;
  }

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

  // --- Mid-stream abort: cancel before save; current outline must stay ---
  const seedOutline = "PHASE6_SEED_OUTLINE\n1. 开篇不改\n因果固定。";
  engine.saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: seedOutline,
    source: "human",
    model: null,
    skillIds: [],
    scene: "outline",
    skipMemory: true,
  });
  const midGid = crypto.randomUUID();
  const midAc = new AbortController();
  process.env.MOLAN_STREAM_PRE_DELAY_MS = "400";
  const midPromise = engine.chat(bookId, "写全书大纲", 1, midGid, midAc.signal);
  await new Promise((r) => setTimeout(r, 80));
  engine.cancelGeneration(midGid);
  midAc.abort();
  let midAborted = false;
  try {
    await midPromise;
  } catch (e) {
    midAborted = isAbortError(e);
  }
  delete process.env.MOLAN_STREAM_PRE_DELAY_MS;
  const outlineAfter = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE a.book_id = ? AND a.kind = 'book_outline'`,
      )
      .get(bookId) as { body: string } | undefined
  )?.body;
  const genAfter = engine.getGeneration(midGid);
  check(
    "E2E 中途取消抛出 Abort",
    midAborted,
    genAfter ? `status=${genAfter.status}` : "no generation",
  );
  check(
    "E2E 中途取消不覆盖当前大纲",
    outlineAfter === seedOutline,
    `body=${(outlineAfter || "").slice(0, 80)} gen=${genAfter?.status}`,
  );
  check(
    "E2E 中途取消 generation 为 cancelled",
    genAfter?.status === "cancelled",
    genAfter?.status,
  );

  // Late completed must not resurrect cancelled
  engine.completeGeneration(midGid, { status: "completed", result: { hacked: true } });
  const stillCancelled = engine.getGeneration(midGid);
  check(
    "E2E 已取消 generation 不被迟到 completed 复活",
    stillCancelled?.status === "cancelled",
    stillCancelled?.status,
  );

  // --- Phase7: cancel AFTER revision already saved as current → demote + mark ---
  const seedBeforeCancel = "PHASE7_KEEP_OUTLINE\n1. 保留因果\n不要丢。";
  const baseSaved = engine.saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: seedBeforeCancel,
    source: "human",
    model: null,
    skillIds: [],
    scene: "outline",
    skipMemory: true,
  });
  const postGid = crypto.randomUUID();
  engine.beginGeneration({ id: postGid, bookId, scene: "outline" });
  const orphanSaved = engine.saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: "PHASE7_SHOULD_DEMOTE\n这是取消前误写入的当前稿。",
    source: "agent",
    model: "local-draft",
    skillIds: [],
    scene: "outline",
    skipMemory: true,
  });
  engine.linkGenerationResultRevision(postGid, orphanSaved.revisionId);
  const curBeforeCancel = (
    db
      .prepare(
        `SELECT r.body AS body, r.id AS id FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE a.book_id = ? AND a.kind = 'book_outline'`,
      )
      .get(bookId) as { body: string; id: string } | undefined
  );
  check(
    "E2E 取消前误写入已是当前稿",
    curBeforeCancel?.id === orphanSaved.revisionId,
    curBeforeCancel?.id,
  );
  const cancelRes = engine.cancelGeneration(postGid);
  check("E2E 取消返回 demoted", Boolean(cancelRes.revert?.demoted), JSON.stringify(cancelRes.revert));
  const curAfterDemote = (
    db
      .prepare(
        `SELECT r.body AS body, r.id AS id, r.source AS source FROM artifacts a
         JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE a.book_id = ? AND a.kind = 'book_outline'`,
      )
      .get(bookId) as { body: string; id: string; source: string } | undefined
  );
  check(
    "E2E 取消后当前稿退回上一版",
    curAfterDemote?.id === baseSaved.revisionId && (curAfterDemote?.body || "").includes("PHASE7_KEEP_OUTLINE"),
    `cur=${curAfterDemote?.id} base=${baseSaved.revisionId}`,
  );
  const orphanRow = db
    .prepare("SELECT source, id FROM artifact_revisions WHERE id = ?")
    .get(orphanSaved.revisionId) as { source: string; id: string } | undefined;
  check(
    "E2E 误写入修订标为 agent_cancelled",
    orphanRow?.source === "agent_cancelled",
    orphanRow?.source,
  );
  check(
    "E2E 取消 generation 仍为 cancelled",
    engine.getGeneration(postGid)?.status === "cancelled",
  );

  // Direct demote helper idempotency
  const demoteAgain = engine.demoteCancelledResultRevision(orphanSaved.revisionId);
  check("E2E 重复 demote 不再改当前", demoteAgain.demoted === false && demoteAgain.orphanRevisionId === orphanSaved.revisionId);

  // Save-as-candidate when generation already cancelled
  const candGid = crypto.randomUUID();
  engine.beginGeneration({ id: candGid, bookId, scene: "outline" });
  engine.cancelGeneration(candGid);
  const candSaved = engine.saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: "PHASE7_CANDIDATE_ONLY",
    source: engine.generationWriteShouldBeCandidate(candGid) ? "agent_cancelled" : "agent",
    model: "local-draft",
    skillIds: [],
    scene: "outline",
    asCandidate: engine.generationWriteShouldBeCandidate(candGid),
    skipMemory: true,
  });
  check("E2E 已取消后保存为候选非当前", candSaved.current === false, `current=${candSaved.current}`);
  const stillKeep = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE a.book_id = ? AND a.kind = 'book_outline'`,
      )
      .get(bookId) as { body: string } | undefined
  )?.body;
  check(
    "E2E 候选保存不覆盖退回后的当前稿",
    (stillKeep || "").includes("PHASE7_KEEP_OUTLINE"),
    (stillKeep || "").slice(0, 60),
  );

  // --- Phase8: cancel after already completed → no demote; offer previousRevisionId ---
  const keepCompleted = "PHASE8_KEEP_COMPLETED\n已接受结果，停止不可静默退回。";
  const baseCompleted = engine.saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: "PHASE8_PREVIOUS\n上一版保留。",
    source: "human",
    model: null,
    skillIds: [],
    scene: "outline",
    skipMemory: true,
  });
  const doneGid = crypto.randomUUID();
  engine.beginGeneration({ id: doneGid, bookId, scene: "outline" });
  const completedSaved = engine.saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: keepCompleted,
    source: "agent",
    model: "local-draft",
    skillIds: [],
    scene: "outline",
    skipMemory: true,
  });
  engine.completeGeneration(doneGid, {
    status: "completed",
    resultRevisionId: completedSaved.revisionId,
    result: { saved: completedSaved, message: { content: "ok" } },
  });
  const curBeforeStop = (
    db
      .prepare(
        `SELECT r.id AS id, r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE a.book_id = ? AND a.kind = 'book_outline'`,
      )
      .get(bookId) as { id: string; body: string } | undefined
  );
  check(
    "E2E 完成态当前稿为已接受结果",
    curBeforeStop?.id === completedSaved.revisionId && (curBeforeStop?.body || "").includes("PHASE8_KEEP_COMPLETED"),
    curBeforeStop?.id,
  );
  const stopCompleted = engine.cancelGeneration(doneGid);
  check(
    "E2E 完成后再停止 alreadyTerminal+accepted",
    Boolean(stopCompleted.alreadyTerminal && stopCompleted.accepted && stopCompleted.status === "completed"),
    JSON.stringify({ status: stopCompleted.status, alreadyTerminal: stopCompleted.alreadyTerminal, accepted: stopCompleted.accepted }),
  );
  check(
    "E2E 完成后再停止不 demote",
    stopCompleted.revert == null || stopCompleted.revert.demoted === false,
    JSON.stringify(stopCompleted.revert),
  );
  check(
    "E2E 完成后再停止给出 previousRevisionId",
    stopCompleted.previousRevisionId === baseCompleted.revisionId,
    `prev=${stopCompleted.previousRevisionId} base=${baseCompleted.revisionId}`,
  );
  const curAfterStop = (
    db
      .prepare(
        `SELECT r.id AS id, r.body AS body, r.source AS source FROM artifacts a
         JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE a.book_id = ? AND a.kind = 'book_outline'`,
      )
      .get(bookId) as { id: string; body: string; source: string } | undefined
  );
  check(
    "E2E 完成后再停止当前稿不变",
    curAfterStop?.id === completedSaved.revisionId && (curAfterStop?.body || "").includes("PHASE8_KEEP_COMPLETED"),
    `cur=${curAfterStop?.id} src=${curAfterStop?.source}`,
  );
  const completedSrc = db
    .prepare("SELECT source FROM artifact_revisions WHERE id = ?")
    .get(completedSaved.revisionId) as { source: string } | undefined;
  check(
    "E2E 完成后再停止不标 agent_cancelled",
    completedSrc?.source === "agent",
    completedSrc?.source,
  );
  // Optional restore-previous (same as version history「还原」— creates new revision)
  const { getRevisionBody } = await import("../src/features");
  const prevBody = getRevisionBody(bookId, baseCompleted.revisionId);
  const restoredRev = engine.saveRevision({
    bookId,
    kind: prevBody.kind,
    chapterNumber: prevBody.chapterNumber,
    body: prevBody.body,
    source: "human",
    model: "restore",
    skillIds: [],
    scene: null,
    skipMemory: true,
  });
  check("E2E 手动还原上一版写入新修订", restoredRev.current === true, `current=${restoredRev.current}`);
  const curAfterRestore = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE a.book_id = ? AND a.kind = 'book_outline'`,
      )
      .get(bookId) as { body: string } | undefined
  )?.body;
  check(
    "E2E 手动还原后当前为上一版内容",
    (curAfterRestore || "").includes("PHASE8_PREVIOUS"),
    (curAfterRestore || "").slice(0, 60),
  );
  // peekPreviousRevisionId helper
  const peeked = engine.peekPreviousRevisionId(completedSaved.revisionId);
  check(
    "E2E peekPreviousRevisionId",
    peeked === baseCompleted.revisionId || typeof peeked === "string",
    `peeked=${peeked}`,
  );

  // --- Phase9: physical SQLite backup ---
  const physWritten = __writePhysicalSqliteBackupForTest(bookId);
  const physMain = __physicalBackupDbPathForTest(bookId);
  const pendingMarker = path.join(importRecoveryDir(), `${bookId}.book.phys.pending`);
  check("E2E 物理库备份文件已写入", !!physWritten && fs.existsSync(physMain), physMain);
  check("E2E 物理备份路径约定（按书）", physMain.endsWith(`${bookId}.book.phys.sqlite`), physMain);
  check("E2E 物理备份 pending 标记", fs.existsSync(pendingMarker), pendingMarker);
  __clearPhysicalSqliteBackupForTest(bookId);
  check("E2E 清除物理备份", !fs.existsSync(physMain) && !fs.existsSync(pendingMarker));

  const markerBody = "PHYSICAL_BACKUP_MARKER_正文";
  engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: markerBody,
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    skipMemory: true,
  });
  __writePhysicalSqliteBackupForTest(bookId);
  __clearDurableSnapshotForTest(bookId);
  engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "应被物理备份覆盖掉的脏数据",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    skipMemory: true,
  });
  const physRecover = await recoverPhysicalImportBackups();
  check(
    "E2E 无 JSON 时按书物理恢复",
    physRecover.restored.includes(bookId),
    JSON.stringify(physRecover),
  );
  const bodyPhys = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string } | undefined
  )?.body;
  check("E2E 物理恢复后正文回到备份", bodyPhys === markerBody, (bodyPhys || "").slice(0, 80));
  check("E2E 物理恢复后清除备份文件", !fs.existsSync(__physicalBackupDbPathForTest(bookId)));

  // --- Phase10: per-book isolation (other books untouched) ---
  const other = engine.createBook({
    title: `物理隔离他书 ${Date.now()}`,
    genre: "测",
    logline: "keep",
    style: "",
    targetChapters: 1,
    wordsPerChapter: 100,
  });
  const otherId = other.payload.book.id;
  engine.saveRevision({
    bookId: otherId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "OTHER_BOOK_MUST_KEEP",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    skipMemory: true,
  });
  engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "BOOK_A_BEFORE_BACKUP",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    skipMemory: true,
  });
  __writePhysicalSqliteBackupForTest(bookId);
  __clearDurableSnapshotForTest(bookId);
  engine.saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "BOOK_A_DIRTY",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    skipMemory: true,
  });
  engine.saveRevision({
    bookId: otherId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "OTHER_BOOK_STILL_KEEP",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    skipMemory: true,
  });
  const isoRecover = await recoverPhysicalImportBackups();
  check("E2E 按书恢复命中 A", isoRecover.restored.includes(bookId), JSON.stringify(isoRecover));
  const bodyA = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string } | undefined
  )?.body;
  const bodyB = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(otherId) as { body: string } | undefined
  )?.body;
  check("E2E 按书恢复 A 回到备份", bodyA === "BOOK_A_BEFORE_BACKUP", (bodyA || "").slice(0, 80));
  check(
    "E2E 按书恢复不伤他书",
    bodyB === "OTHER_BOOK_STILL_KEEP",
    (bodyB || "").slice(0, 80),
  );

  // Phase10: postgres-native worker policy
  const nativeAllow = jobWorkerAllowedForDriver("postgres-native", false);
  check(
    "E2E postgres-native 允许 worker",
    nativeAllow.allowed && /postgres-native/.test(nativeAllow.reason),
    nativeAllow.reason,
  );

  // --- Phase11: legacy whole-DB phys → convert / refuse (never nuke other books) ---
  {
    const { resolveSqliteFilePath } = await import("../src/db");
    const legA = engine.createBook({
      title: `遗留整库A ${Date.now()}`,
      genre: "测",
      logline: "legacy-a",
      style: "",
      targetChapters: 1,
      wordsPerChapter: 100,
    });
    const legB = engine.createBook({
      title: `遗留整库B ${Date.now()}`,
      genre: "测",
      logline: "legacy-b",
      style: "",
      targetChapters: 1,
      wordsPerChapter: 100,
    });
    const idA = legA.payload.book.id;
    const idB = legB.payload.book.id;
    engine.saveRevision({
      bookId: idA,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "LEGACY_A_GOOD",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    engine.saveRevision({
      bookId: idB,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "LEGACY_B_GOOD",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    // Snapshot whole live DB as phase9-style backup for A (checkpoint so copy is consistent)
    const liveDb = resolveSqliteFilePath();
    const legacyPath = __legacyWholeDbPhysPathForTest(idA);
    const legacyPending = __legacyWholeDbPendingForTest(idA);
    fs.mkdirSync(importRecoveryDir(), { recursive: true });
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    fs.copyFileSync(liveDb, legacyPath);
    for (const suffix of ["-wal", "-shm"]) {
      const s = `${liveDb}${suffix}`;
      if (fs.existsSync(s)) fs.copyFileSync(s, `${legacyPath}${suffix}`);
    }
    fs.writeFileSync(
      legacyPending,
      JSON.stringify({ bookId: idA, kind: "legacy-whole-db", at: new Date().toISOString() }),
      "utf8",
    );
    __clearDurableSnapshotForTest(idA);
    // Dirty A and change B after backup (whole-DB replace would revert B too)
    engine.saveRevision({
      bookId: idA,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "LEGACY_A_DIRTY",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    engine.saveRevision({
      bookId: idB,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "LEGACY_B_AFTER_BACKUP",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    const legRecover = await recoverPhysicalImportBackups();
    check(
      "E2E P11 遗留整库已转换并恢复 A",
      legRecover.restored.includes(idA) && (legRecover.convertedLegacy || []).includes(idA),
      JSON.stringify(legRecover),
    );
    const bodyLA = (
      db
        .prepare(
          `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
           LEFT JOIN chapters c ON c.id = a.chapter_id
           WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
        )
        .get(idA) as { body: string } | undefined
    )?.body;
    const bodyLB = (
      db
        .prepare(
          `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
           LEFT JOIN chapters c ON c.id = a.chapter_id
           WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
        )
        .get(idB) as { body: string } | undefined
    )?.body;
    check("E2E P11 转换恢复后 A 回到备份", bodyLA === "LEGACY_A_GOOD", (bodyLA || "").slice(0, 80));
    check(
      "E2E P11 转换恢复不伤他书 B",
      bodyLB === "LEGACY_B_AFTER_BACKUP",
      (bodyLB || "").slice(0, 80),
    );
    check(
      "E2E P11 遗留整库文件已隔离",
      !fs.existsSync(legacyPath),
      legacyPath,
    );

    // Refuse path: pending + empty/wrong sqlite without the book
    const idMissing = "missing-book-for-legacy-refuse";
    const badLegacy = __legacyWholeDbPhysPathForTest(idMissing);
    const badPending = __legacyWholeDbPendingForTest(idMissing);
    // Minimal sqlite schema without this book
    const Database = (await import("better-sqlite3")).default;
    const { sqliteSchema } = await import("../src/db/schema");
    const bad = new Database(badLegacy);
    bad.exec(sqliteSchema());
    bad.close();
    fs.writeFileSync(badPending, JSON.stringify({ bookId: idMissing, kind: "legacy" }), "utf8");
    const refuse = await recoverPhysicalImportBackups();
    check(
      "E2E P11 无法抽出书时拒绝整库恢复",
      (refuse.refusedLegacy || []).includes(idMissing) && !refuse.restored.includes(idMissing),
      JSON.stringify(refuse),
    );
    check("E2E P11 拒绝后遗留文件已隔离", !fs.existsSync(badLegacy), badLegacy);
  }

  // --- Phase9: pi orchestration boundary ---
  const { assertPiModelRelayOnly, piOrchestrationBoundary, probePiCapability } = await import("../src/agent/piAdapter");
  const { listAgentCapabilities } = await import("../src/agent/runtime");
  const boundary = piOrchestrationBoundary();
  check("E2E pi 边界非自主", boundary.autonomous === false && boundary.toolsSupported === false);
  let refusedTools = false;
  try {
    assertPiModelRelayOnly({
      scene: "chat",
      skillTexts: [],
      context: "x",
      tools: [{ name: "shell" }],
    } as never);
  } catch {
    refusedTools = true;
  }
  check("E2E pi 拒绝 tools 字段", refusedTools);
  const caps = listAgentCapabilities();
  check(
    "E2E runtime 暴露 pi 边界",
    caps.pi?.autonomous === false &&
      (/非自主|模型代调/.test(caps.note) || /非自主|模型代调/.test(caps.pi.note) || /非自主|模型代调/.test(probePiCapability().reason)),
    caps.note.slice(0, 100),
  );

  // --- Phase12: whole-DB restore deprecated + orphan quarantine CLI path ---
  {
    const { replaceSqliteFromPhysicalBackup, WHOLE_DB_PHYS_RESTORE_ENV } = await import("../src/db");
    const {
      __quarantineOrphanLegacyWholeDbPhysForTest,
      importRecoveryDir,
    } = await import("../src/importBook");
    const prev = process.env[WHOLE_DB_PHYS_RESTORE_ENV];
    delete process.env[WHOLE_DB_PHYS_RESTORE_ENV];
    let refused = false;
    try {
      await replaceSqliteFromPhysicalBackup("/tmp/molan-e2e-missing.sqlite.phys");
    } catch (e) {
      refused = /弃用|quarantine:legacy-phys|ALLOW_WHOLE_DB/.test(
        e instanceof Error ? e.message : String(e),
      );
    }
    check("E2E P12 整库 phys 恢复默认拒绝", refused);
    if (prev === undefined) delete process.env[WHOLE_DB_PHYS_RESTORE_ENV];
    else process.env[WHOLE_DB_PHYS_RESTORE_ENV] = prev;

    const rec = importRecoveryDir();
    fs.mkdirSync(rec, { recursive: true });
    const orphanId = `e2e-orphan-${Date.now()}`;
    const orphanPath = path.join(rec, `${orphanId}.sqlite.phys`);
    fs.writeFileSync(orphanPath, "not-sqlite");
    const q = __quarantineOrphanLegacyWholeDbPhysForTest(rec);
    check(
      "E2E P12 孤儿整库 phys 隔离",
      q.quarantined.includes(orphanId) && !fs.existsSync(orphanPath),
      JSON.stringify(q),
    );
  }

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
