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
  const {
    routeMessage,
    saveRevision,
    createBook,
    beginGeneration,
    getGeneration,
    completeGeneration,
    setJobStatus,
    createJob,
    getJob,
    executeScene,
    currentRevisionIdFor,
  } = await import("../src/engine");
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
  const prevAllowHosts = process.env.MOLAN_ALLOWED_BASE_HOSTS;
  process.env.MOLAN_ALLOWED_BASE_HOSTS = "47.108.232.192";
  try {
    check(
      "T08 显式白名单 HTTP+Key 放行",
      assertSafeBaseUrl("http://47.108.232.192:54483/v1", { withApiKey: true }).startsWith("http://"),
    );
  } finally {
    if (prevAllowHosts === undefined) delete process.env.MOLAN_ALLOWED_BASE_HOSTS;
    else process.env.MOLAN_ALLOWED_BASE_HOSTS = prevAllowHosts;
  }

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

  // Phase9: pi boundary + lease predicate
  const { assertPiModelRelayOnly, piOrchestrationBoundary, probePiCapability } = await import("../src/agent/piAdapter");
  const { wouldAcquireLease } = await import("../src/jobs/lease");
  check("P9 pi 边界 autonomous=false", piOrchestrationBoundary().autonomous === false);
  check("P9 pi capability 文案含非自主或代调", /非自主|模型代调/.test(probePiCapability().reason));
  let p9refuse = false;
  try {
    assertPiModelRelayOnly({ scene: "chat", skillTexts: [], context: "", enableTools: true } as never);
  } catch {
    p9refuse = true;
  }
  check("P9 pi 拒绝 enableTools", p9refuse);
  check(
    "P9 lease 谓词：过期可抢",
    wouldAcquireLease(
      { status: "running", lease_owner: "old", lease_until: new Date(Date.now() - 1000).toISOString() },
      "new",
      new Date().toISOString(),
    ) === true,
  );

  // Phase10: sqlCompat + worker policy for native PG + per-book phys path
  const { qmarksToDollar } = await import("../src/db/sqlCompat");
  const q = qmarksToDollar("SELECT a FROM t WHERE x = ? AND y = '?' AND z = ?");
  check("P10 ?→$ 跳过字符串内问号", q.text === "SELECT a FROM t WHERE x = $1 AND y = '?' AND z = $2" && q.count === 2, q.text);
  const { jobWorkerAllowedForDriver } = await import("../src/jobs/worker");
  const native = jobWorkerAllowedForDriver("postgres-native", false);
  check("P10 postgres-native 允许 worker", native.allowed === true, native.reason);
  const mirror = jobWorkerAllowedForDriver("postgres", false);
  check("P10 镜像 postgres 仍默认拒开", mirror.allowed === false);
  const { physicalBackupDbPath } = await import("../src/importBook");
  check(
    "P10 物理备份路径按书隔离",
    physicalBackupDbPath("abc").endsWith("abc.book.phys.sqlite"),
    physicalBackupDbPath("abc"),
  );

  // Phase11: legacy path + migrate tooling (sqlite-side, no PG required)
  const { legacyWholeDbPhysPath, quarantineOrphanLegacyWholeDbPhys } = await import("../src/importBook");
  const { MIGRATE_TABLE_ORDER, countSqliteMigrateTables } = await import("../src/db/migrateSqliteToPg");
  check(
    "P11 遗留整库路径仍可识别",
    legacyWholeDbPhysPath("abc").endsWith("abc.sqlite.phys"),
    legacyWholeDbPhysPath("abc"),
  );
  check(
    "P11 迁移表顺序含 books 与 generations",
    MIGRATE_TABLE_ORDER[0] === "books" && MIGRATE_TABLE_ORDER.includes("generations"),
    MIGRATE_TABLE_ORDER.join(","),
  );
  const counts = countSqliteMigrateTables(tmpDb);
  check(
    "P11 countSqliteMigrateTables 可读",
    typeof counts.books === "number" && counts.books >= 0,
    JSON.stringify(counts),
  );

  // Phase12: whole-DB restore gate + orphan quarantine + sync flag semantics
  const {
    replaceSqliteFromPhysicalBackup,
    wholeDbPhysRestoreAllowed,
    WHOLE_DB_PHYS_RESTORE_ENV,
  } = await import("../src/db");
  const prevAllow = process.env[WHOLE_DB_PHYS_RESTORE_ENV];
  delete process.env[WHOLE_DB_PHYS_RESTORE_ENV];
  check("P12 默认禁止整库 phys 恢复", wholeDbPhysRestoreAllowed() === false);
  let refusedWhole = false;
  let refuseMsg = "";
  try {
    await replaceSqliteFromPhysicalBackup("/tmp/does-not-exist-molan.sqlite.phys");
  } catch (e) {
    refusedWhole = true;
    refuseMsg = e instanceof Error ? e.message : String(e);
  }
  check(
    "P12 replaceSqlite 无开关时拒绝",
    refusedWhole && /弃用|ALLOW_WHOLE_DB|quarantine:legacy-phys/.test(refuseMsg),
    refuseMsg.slice(0, 120),
  );
  process.env[WHOLE_DB_PHYS_RESTORE_ENV] = "1";
  check("P12 显式开关允许整库恢复标记", wholeDbPhysRestoreAllowed() === true);
  if (prevAllow === undefined) delete process.env[WHOLE_DB_PHYS_RESTORE_ENV];
  else process.env[WHOLE_DB_PHYS_RESTORE_ENV] = prevAllow;

  const qDir = path.join(os.tmpdir(), `molan-qphys-${Date.now()}`);
  fs.mkdirSync(qDir, { recursive: true });
  const orphanPhys = path.join(qDir, "orphan-book.sqlite.phys");
  // minimal invalid sqlite so convert fails → quarantine
  fs.writeFileSync(orphanPhys, "not-a-sqlite-db");
  const qres = quarantineOrphanLegacyWholeDbPhys(qDir);
  check(
    "P12 孤儿整库 phys 被扫描",
    qres.scanned.some((p) => p.endsWith("orphan-book.sqlite.phys")),
    JSON.stringify(qres),
  );
  check(
    "P12 无法转换则隔离",
    qres.quarantined.includes("orphan-book") && !fs.existsSync(orphanPhys),
    JSON.stringify(qres),
  );
  // cleanup quarantine under qDir/legacy-quarantine
  try {
    fs.rmSync(qDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }


  // --- Skill attachScenes matrix (user packs primary) ---
  const { reloadSkills, skillsForScene, isUserPack, userPackIdsForScene } = await import("../src/skills");
  reloadSkills();
  const expectPacks: Record<string, string[]> = {
    outline: ["novel-craft", "structure-skeleton", "volume-arcs"],
    chapter_body: ["humanize", "style-corpus"],
    humanize: ["humanize", "style-corpus"],
    chat: ["novel-craft", "opening-cards"],
    chapter_outline: ["novel-craft", "opening-cards"],
    review: ["humanize"],
  };
  for (const [scene, exp] of Object.entries(expectPacks)) {
    const got = skillsForScene(scene)
      .filter((r) => isUserPack(r.id))
      .map((r) => r.id)
      .sort();
    const want = [...exp].sort();
    check(
      `SKILL ${scene} 用户包`,
      JSON.stringify(got) === JSON.stringify(want) &&
        skillsForScene(scene).filter((r) => isUserPack(r.id)).every((r) => r.role === "primary"),
      `got=${got.join(",")}`,
    );
    check(
      `SKILL ${scene} 无串味`,
      !(scene === "outline" || scene === "chapter_outline" || scene === "chat") ||
        !got.includes("humanize"),
    );
  }
  // Explicit skillIds must NOT strip stage user packs
  const bodyWithIds = skillsForScene("chapter_body", ["prose-expand"]).map((r) => r.id);
  check(
    "SKILL skillIds 仍强制挂 humanize+style",
    bodyWithIds.includes("humanize") && bodyWithIds.includes("style-corpus") && bodyWithIds.includes("prose-expand"),
    bodyWithIds.join(","),
  );
  const outlineNoHuman = skillsForScene("outline", ["book-outline"]).map((r) => r.id);
  check(
    "SKILL outline 显式 ids 仍无 humanize",
    !outlineNoHuman.includes("humanize") && outlineNoHuman.includes("volume-arcs"),
    outlineNoHuman.join(","),
  );
  check(
    "SKILL userPackIdsForScene(outline)",
    JSON.stringify(userPackIdsForScene("outline").sort()) ===
      JSON.stringify(["novel-craft", "structure-skeleton", "volume-arcs"].sort()),
  );
  // Explicit skillIds must filter by attachScenes (no cross-stage hard-hang)
  const outlineCross = skillsForScene("outline", ["humanize", "book-outline", "volume-arcs"]).map((r) => r.id);
  check(
    "SKILL outline 显式 humanize 被 attachScenes 过滤",
    !outlineCross.includes("humanize") && outlineCross.includes("volume-arcs") && outlineCross.includes("book-outline"),
    outlineCross.join(","),
  );
  const chatCross = skillsForScene("chat", ["style-corpus", "novel-craft"]).map((r) => r.id);
  check(
    "SKILL chat 显式 style-corpus 被过滤",
    !chatCross.includes("style-corpus") && chatCross.includes("novel-craft"),
    chatCross.join(","),
  );

  // --- AI write baseline CAS → candidate ---
  const bodyBase = saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "用户当前稿。",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    expectedRevisionId: currentRevisionIdFor(bookId, "chapter_body", 1),
    skipMemory: true,
  });
  const captured = currentRevisionIdFor(bookId, "chapter_body", 1);
  check("CAS 捕获写前基线", captured === bodyBase.revisionId);

  // Concurrent human save advances current
  const humanDuring = saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "用户中途保存。",
    source: "human",
    model: null,
    skillIds: [],
    scene: "chapter_body",
    expectedRevisionId: captured,
    skipMemory: true,
  });
  check("CAS 中途人类保存成功", humanDuring.current === true);

  // Late AI with stale baseline → candidate (not 409, not overwrite)
  const lateAi = saveRevision({
    bookId,
    kind: "chapter_body",
    chapterNumber: 1,
    body: "迟到的 AI 结果。",
    source: "agent",
    model: "local-draft",
    skillIds: [],
    scene: "chapter_body",
    expectedRevisionId: captured,
    onConflict: "candidate",
    skipMemory: true,
  });
  const stillHuman = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         LEFT JOIN chapters c ON c.id = a.chapter_id
         WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = 1`,
      )
      .get(bookId) as { body: string }
  ).body;
  check(
    "CAS AI 冲突落候选不盖当前",
    lateAi.current === false && lateAi.conflicted === true && stillHuman === "用户中途保存。",
    `current=${lateAi.current} conflicted=${lateAi.conflicted} body=${stillHuman}`,
  );

  // onConflict throw still 409
  let threw409 = false;
  try {
    saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "应 409",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      expectedRevisionId: captured,
      onConflict: "throw",
      skipMemory: true,
    });
  } catch (e: unknown) {
    threw409 = e instanceof Error && /冲突|409/.test(e.message);
  }
  check("CAS onConflict=throw 仍 409", threw409);

  // executeScene captures baseline at start (local-draft) — concurrent save → candidate
  saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: "旧大纲。",
    source: "human",
    model: null,
    skillIds: [],
    scene: "outline",
    expectedRevisionId: null,
    skipMemory: true,
  });
  // Simulate: capture happens inside executeScene; we race by saving after starting would need delay.
  // Instead call executeScene then verify it used baseline — if we pre-bump current before call,
  // executeScene captures the bumped id and writes as current (matching). So test via saveRevision path above
  // plus executeScene happy path writes current when no race:
  const sceneRun = await executeScene({
    bookId,
    scene: "outline",
    chapterNumber: null,
    instruction: "按档案写全书大纲",
  });
  check(
    "executeScene 无冲突写当前",
    Boolean(sceneRun.saved?.current) && Boolean(sceneRun.saved?.revisionId),
    JSON.stringify(sceneRun.saved),
  );
  // Race: capture baseline, human advances, then save with that baseline via executeScene override
  const beforeRace = currentRevisionIdFor(bookId, "book_outline", null);
  saveRevision({
    bookId,
    kind: "book_outline",
    chapterNumber: null,
    body: "用户改大纲。",
    source: "human",
    model: null,
    skillIds: [],
    scene: "outline",
    expectedRevisionId: beforeRace,
    skipMemory: true,
  });
  const raced = await executeScene({
    bookId,
    scene: "outline",
    chapterNumber: null,
    instruction: "按档案写全书大纲",
    expectedRevisionId: beforeRace, // stale, as if captured at start
    onConflict: "candidate",
  });
  const outlineCur = (
    db
      .prepare(
        `SELECT r.body AS body FROM artifacts a JOIN artifact_revisions r ON r.id = a.current_revision_id
         WHERE a.book_id = ? AND a.kind = 'book_outline' AND a.chapter_id IS NULL`,
      )
      .get(bookId) as { body: string }
  ).body;
  check(
    "executeScene 冲突→候选保用户稿",
    raced.saved?.current === false &&
      raced.saved?.conflicted === true &&
      outlineCur === "用户改大纲。",
    `saved=${JSON.stringify(raced.saved)} cur=${outlineCur.slice(0, 40)}`,
  );


  // --- outbound model fetch limited retry (network / 5xx only; never 4xx) ---
  {
    const http = await import("node:http");
    const {
      secureFetch,
      isRetryableHttpStatus,
      isRetryableNetworkError,
    } = await import("../src/outbound");
    const prevLocal = process.env.MOLAN_ALLOW_LOCAL_LLM;
    process.env.MOLAN_ALLOW_LOCAL_LLM = "1";
    const restoreLocal = () => {
      if (prevLocal === undefined) delete process.env.MOLAN_ALLOW_LOCAL_LLM;
      else process.env.MOLAN_ALLOW_LOCAL_LLM = prevLocal;
    };

    check("retryable status 503", isRetryableHttpStatus(503) === true);
    check("retryable status 500", isRetryableHttpStatus(500) === true);
    check("not retryable 401", isRetryableHttpStatus(401) === false);
    check("not retryable 403", isRetryableHttpStatus(403) === false);
    check("not retryable 429", isRetryableHttpStatus(429) === false);
    check("not retryable 400", isRetryableHttpStatus(400) === false);

    const abortErr = new Error("已取消");
    abortErr.name = "AbortError";
    check("abort not retryable", isRetryableNetworkError(abortErr) === false);
    const fetchFailed = new TypeError("fetch failed");
    (fetchFailed as Error & { cause?: { code: string } }).cause = { code: "ECONNREFUSED" };
    check("ECONNREFUSED retryable", isRetryableNetworkError(fetchFailed) === true);
    check(
      "SSRF message not retryable",
      isRetryableNetworkError(new Error("出站目标 x 解析到内网地址，已拒绝")) === false,
    );

    // Local mock: fail twice with 503 then 200
    let hits503 = 0;
    const server503 = http.createServer((_req, res) => {
      hits503 += 1;
      if (hits503 <= 2) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("busy");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hits: hits503 }));
    });
    await new Promise<void>((resolve) => server503.listen(0, "127.0.0.1", resolve));
    const port503 = (server503.address() as { port: number }).port;
    const url503 = `http://127.0.0.1:${port503}/v1/ping`;
    try {
      const res = await secureFetch(url503, {
        method: "GET",
        withApiKey: false,
        timeoutMs: 5_000,
        retries: 2,
        retryBackoffMs: 0,
      });
      const body = (await res.json()) as { ok?: boolean; hits?: number };
      check(
        "5xx 自动重试后成功",
        res.status === 200 && body.ok === true && hits503 === 3,
        `status=${res.status} hits=${hits503} body=${JSON.stringify(body)}`,
      );
    } finally {
      await new Promise<void>((resolve, reject) => server503.close((e) => (e ? reject(e) : resolve())));
    }

    // 401 must not retry
    let hits401 = 0;
    const server401 = http.createServer((_req, res) => {
      hits401 += 1;
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("nope");
    });
    await new Promise<void>((resolve) => server401.listen(0, "127.0.0.1", resolve));
    const port401 = (server401.address() as { port: number }).port;
    try {
      const res = await secureFetch(`http://127.0.0.1:${port401}/v1/ping`, {
        method: "GET",
        withApiKey: false,
        timeoutMs: 5_000,
        retries: 2,
        retryBackoffMs: 0,
      });
      check(
        "401 不重试立刻返回",
        res.status === 401 && hits401 === 1,
        `status=${res.status} hits=${hits401}`,
      );
      await res.text();
    } finally {
      await new Promise<void>((resolve, reject) => server401.close((e) => (e ? reject(e) : resolve())));
    }

    // Persistent 503 exhausts retries and returns last 503 (no silent downgrade)
    let hitsFail = 0;
    const serverFail = http.createServer((_req, res) => {
      hitsFail += 1;
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("down");
    });
    await new Promise<void>((resolve) => serverFail.listen(0, "127.0.0.1", resolve));
    const portFail = (serverFail.address() as { port: number }).port;
    try {
      const res = await secureFetch(`http://127.0.0.1:${portFail}/v1/ping`, {
        method: "GET",
        withApiKey: false,
        timeoutMs: 5_000,
        retries: 2,
        retryBackoffMs: 0,
      });
      check(
        "持续 5xx 耗尽重试仍返回 503",
        res.status === 503 && hitsFail === 3,
        `status=${res.status} hits=${hitsFail}`,
      );
      await res.text();
    } finally {
      await new Promise<void>((resolve, reject) => serverFail.close((e) => (e ? reject(e) : resolve())));
    }

    // Network refusal retries then throws (no local fallback)
    let netThrew = false;
    let netMsg = "";
    try {
      await secureFetch("http://127.0.0.1:9/v1/ping", {
        method: "GET",
        withApiKey: false,
        timeoutMs: 2_000,
        retries: 2,
        retryBackoffMs: 0,
      });
    } catch (e) {
      netThrew = true;
      netMsg = e instanceof Error ? e.message : String(e);
    }
    check(
      "网络失败耗尽重试仍抛错",
      netThrew && !/local-draft|静默|降级/i.test(netMsg),
      netMsg.slice(0, 120),
    );
    restoreLocal();
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
