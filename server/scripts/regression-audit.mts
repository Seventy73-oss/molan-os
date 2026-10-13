/**
 * Phase 1–2 audit regression tests. Uses temp SQLite + mock logic only.
 * Run: MOLAN_SQLITE_PATH=/tmp/molan-reg.sqlite npx tsx server/scripts/regression-audit.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUuid } from "../../web/lib/uuid";

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
  // Simulate a browser on an HTTP LAN origin: getRandomValues exists, randomUUID does not.
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const randomBytes = crypto.getRandomValues.bind(crypto);
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: randomBytes },
  });
  try {
    const ids = Array.from({ length: 64 }, () => createUuid());
    check(
      "HTTP LAN 可生成唯一 UUID v4",
      ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) &&
        new Set(ids).size === ids.length,
    );
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }

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
  // The SQLite is isolated, but manuscript mirrors use the shared data directory.
  // Clean only IDs read from this newly created test DB, after async work exits.
  if (db.driver !== "sqlite" || process.env.MOLAN_SQLITE_PATH !== tmpDb) throw new Error("Regression database must remain isolated");
  const { deleteBookFiles } = await import("../src/manuscripts");
  process.once("exit", () => {
    const ownBooks = db.prepare("SELECT id FROM books").all() as { id: string }[];
    for (const { id } of ownBooks) deleteBookFiles(id);
    console.log(`Cleaned ${ownBooks.length} isolated regression manuscript mirrors.`);
  });

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

  {
    const { selectionSkillScene } = await import("../src/skills");
    const { rewriteSelection } = await import("../src/engine");
    const selOutline = skillsForScene(selectionSkillScene("outline")).map((r) => r.id);
    check(
      "SKILL 选区改写 outline 文档挂大纲包、不挂 humanize",
      !selOutline.includes("humanize") && selOutline.includes("volume-arcs") && selOutline.includes("structure-skeleton"),
      selOutline.join(","),
    );
    const selCo = skillsForScene(selectionSkillScene("chapter_outline")).map((r) => r.id);
    check("SKILL 选区改写 chapter_outline 不挂 humanize", !selCo.includes("humanize") && selCo.includes("opening-cards"), selCo.join(","));
    const selBody = (await rewriteSelection({ bookId, selection: "他说：“走。”", instruction: "润色", scene: "chapter_body" })) as { skills: { id: string }[] };
    const selBodyIds = selBody.skills.map((s) => s.id);
    check("SKILL 选区改写正文挂 humanize+style-corpus", selBodyIds.includes("humanize") && selBodyIds.includes("style-corpus"), selBodyIds.join(","));
    const selOut2 = (await rewriteSelection({ bookId, selection: "第一卷：起势", instruction: "润色", scene: "outline" })) as { skills: { id: string }[] };
    const selOut2Ids = selOut2.skills.map((s) => s.id);
    check("SKILL 选区改写 API outline 不挂 humanize", !selOut2Ids.includes("humanize") && selOut2Ids.includes("volume-arcs"), selOut2Ids.join(","));
  }

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


  // --- outbound model fetch limited retry (network / 4xx+5xx; never abort) ---
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
    check("retryable status 401", isRetryableHttpStatus(401) === true);
    check("retryable status 403", isRetryableHttpStatus(403) === true);
    check("retryable status 429", isRetryableHttpStatus(429) === true);
    check("retryable status 400", isRetryableHttpStatus(400) === true);
    check("not retryable 200", isRetryableHttpStatus(200) === false);
    check("not retryable 399", isRetryableHttpStatus(399) === false);

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

    // 401 then recover (4xx also retries)
    let hits401 = 0;
    const server401 = http.createServer((_req, res) => {
      hits401 += 1;
      if (hits401 <= 2) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("nope");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hits: hits401 }));
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
      const body = (await res.json()) as { ok?: boolean; hits?: number };
      check(
        "401 自动重试后成功",
        res.status === 200 && body.ok === true && hits401 === 3,
        `status=${res.status} hits=${hits401} body=${JSON.stringify(body)}`,
      );
    } finally {
      await new Promise<void>((resolve, reject) => server401.close((e) => (e ? reject(e) : resolve())));
    }

    // 429 then recover
    let hits429 = 0;
    const server429 = http.createServer((_req, res) => {
      hits429 += 1;
      if (hits429 <= 1) {
        res.writeHead(429, { "Content-Type": "text/plain" });
        res.end("slow down");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server429.listen(0, "127.0.0.1", resolve));
    const port429 = (server429.address() as { port: number }).port;
    try {
      const res = await secureFetch(`http://127.0.0.1:${port429}/v1/ping`, {
        method: "GET",
        withApiKey: false,
        timeoutMs: 5_000,
        retries: 2,
        retryBackoffMs: 0,
      });
      check(
        "429 自动重试后成功",
        res.status === 200 && hits429 === 2,
        `status=${res.status} hits=${hits429}`,
      );
      await res.text();
    } finally {
      await new Promise<void>((resolve, reject) => server429.close((e) => (e ? reject(e) : resolve())));
    }

    // Persistent 400 exhausts retries and returns last 400 (no silent downgrade)
    let hits400 = 0;
    const server400 = http.createServer((_req, res) => {
      hits400 += 1;
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad");
    });
    await new Promise<void>((resolve) => server400.listen(0, "127.0.0.1", resolve));
    const port400 = (server400.address() as { port: number }).port;
    try {
      const res = await secureFetch(`http://127.0.0.1:${port400}/v1/ping`, {
        method: "GET",
        withApiKey: false,
        timeoutMs: 5_000,
        retries: 2,
        retryBackoffMs: 0,
      });
      check(
        "持续 4xx 耗尽重试仍返回 400",
        res.status === 400 && hits400 === 3,
        `status=${res.status} hits=${hits400}`,
      );
      await res.text();
    } finally {
      await new Promise<void>((resolve, reject) => server400.close((e) => (e ? reject(e) : resolve())));
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

    // Abort mid-retry: do not continue after cancel
    let hitsAbort = 0;
    const serverAbort = http.createServer((_req, res) => {
      hitsAbort += 1;
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("busy");
    });
    await new Promise<void>((resolve) => serverAbort.listen(0, "127.0.0.1", resolve));
    const portAbort = (serverAbort.address() as { port: number }).port;
    const ac = new AbortController();
    let abortThrew = false;
    let abortName = "";
    try {
      const p = secureFetch(`http://127.0.0.1:${portAbort}/v1/ping`, {
        method: "GET",
        withApiKey: false,
        timeoutMs: 5_000,
        retries: 2,
        retryBackoffMs: 50,
        signal: ac.signal,
      });
      // Cancel during backoff after first response
      setTimeout(() => ac.abort(), 10);
      await p;
    } catch (e) {
      abortThrew = true;
      abortName = e instanceof Error ? e.name : "";
      const msg = e instanceof Error ? e.message : String(e);
      if (!abortName) abortName = msg;
    } finally {
      await new Promise<void>((resolve, reject) => serverAbort.close((e) => (e ? reject(e) : resolve())));
    }
    check(
      "取消后不继续重试",
      abortThrew && hitsAbort <= 2 && (/AbortError|已取消|aborted/i.test(abortName) || ac.signal.aborted),
      `hits=${hitsAbort} name=${abortName}`,
    );

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



  // --- T01 context bible / memory / hooks + source match ---
  {
    const { createBook, saveRevision, buildContext } = await import("../src/engine");
    const { createBibleCard } = await import("../src/features");
    const { previewContext } = await import("../src/contextSnapshot");
    const { db: regDb } = await import("../src/db");

    const book = createBook({
      title: "T01上下文书",
      genre: "测试",
      targetChapters: 3,
      wordsPerChapter: 800,
    });
    const bookId = book.payload.book.id as string;
    createBibleCard(bookId, { kind: "character", name: "林舟", summary: "城门守卫", details: "左手旧伤" });
    const body1 = saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "林舟守在城门，看见旧徽记。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    const body1Id = body1.revisionId;
    saveRevision({
      bookId,
      kind: "chapter_memory",
      chapterNumber: 1,
      body: "未回收：城门旧徽记\n摘要：林舟见徽记变色。",
      source: "agent",
      model: null,
      skillIds: [],
      scene: "memory_extract",
      sourceRevisionId: body1Id,
      skipMemory: true,
    });
    saveRevision({
      bookId,
      kind: "chapter_outline",
      chapterNumber: 1,
      body: "未回收：旧徽记之谜",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_outline",
      skipMemory: true,
    });

    const ctx = buildContext(bookId, 2, "续写第二章", { scene: "chapter_body", persist: true });
    const hasBible = ctx.includes("【设定卡】") && ctx.includes("林舟");
    const hasMemory = ctx.includes("【前文记忆】") && ctx.includes("林舟见徽记");
    const hasHook = ctx.includes("【未回收钩子】") && /旧徽记/.test(ctx);
    check("T01 三栏上下文注入设定卡", hasBible);
    check(
      "T01 三栏上下文注入前文记忆",
      hasMemory,
      hasMemory ? undefined : ctx.slice(Math.max(0, ctx.indexOf("【前文记忆】")), Math.max(0, ctx.indexOf("【前文记忆】")) + 240),
    );
    check("T01 三栏上下文注入未回收钩子", hasHook);

    saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "林舟已经离开城门。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    const ctxStale = buildContext(bookId, 2, "续写", { scene: "chapter_body", persist: false });
    check("T01 源版本不匹配的记忆不注入", !ctxStale.includes("林舟见徽记"));

    const legacy = saveRevision({
      bookId,
      kind: "chapter_memory",
      chapterNumber: 1,
      body: "legacy记忆：城门风很大。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "memory_extract",
      sourceRevisionId: null,
      skipMemory: true,
    });
    regDb.prepare("UPDATE artifact_revisions SET source_revision_id = NULL WHERE id = ?").run(legacy.revisionId);
    const ctxLegacy = buildContext(bookId, 2, "续写", { scene: "chapter_body", persist: false });
    check(
      "T01 legacy_current 记忆可注入并标注",
      ctxLegacy.includes("legacy记忆") && ctxLegacy.includes("legacy_current"),
    );

    const preview = previewContext(bookId, 2);
    check(
      "T01 context-preview 返回缺失提示结构",
      Array.isArray(preview.missing) && Boolean(preview.manifest?.counts),
    );
    const snap = regDb
      .prepare("SELECT COUNT(*) AS n FROM context_snapshots WHERE book_id = ?")
      .get(bookId) as { n: number };
    check("T01 生成时写入 ContextSnapshot", snap.n >= 1, `n=${snap.n}`);
  }



  // --- G2 publication / proposal / epoch / invalidate ---
  {
    const { createBook, saveRevision } = await import("../src/engine");
    const {
      finalizeChapter,
      createMemoryProposal,
      applyProposal,
      getProposal,
      chapterStoryStatusByNumber,
      getBookHead,
    } = await import("../src/story");
    const { formatMemoriesForContextParts } = await import("../src/features");
    const { db: regDb } = await import("../src/db");

    const book = createBook({ title: "G2定稿书", genre: "测试", logline: "", style: "", targetChapters: 3, wordsPerChapter: 800 });
    const bookId = book.payload.book.id as string;
    const ch1 = book.payload.chapters.find((c: { number: number }) => c.number === 1)!;

    const bodyA = saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "林舟左手受伤，鲜血染红了衣袖。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });

    // T04: candidate body does not affect formal story (no publication yet)
    saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "候选：林舟毫发无伤。",
      source: "agent",
      model: "test",
      skillIds: [],
      scene: "chapter_body",
      asCandidate: true,
      skipMemory: true,
    });
    const head0 = getBookHead(bookId);
    check("T04/G2 候选不创建定稿", head0.storyEpoch === 0);

    // First finalize
    const fin1 = finalizeChapter({
      bookId,
      chapterId: ch1.id,
      bodyRevisionId: bodyA.revisionId,
      expectedPublicationId: null,
      expectedCurrentRevisionId: bodyA.revisionId,
      expectedStoryEpoch: 0,
      idempotencyKey: "g2-fin-1",
    });
    check("T06/G2 首次定稿 memory pending", fin1.memoryState === "pending" && fin1.storyEpoch === 1);

    // T08 idempotent same key
    const fin1b = finalizeChapter({
      bookId,
      chapterId: ch1.id,
      bodyRevisionId: bodyA.revisionId,
      expectedPublicationId: null,
      expectedCurrentRevisionId: bodyA.revisionId,
      expectedStoryEpoch: 0,
      idempotencyKey: "g2-fin-1",
    });
    check("T08/G2 同键同参定稿幂等", fin1b.publicationId === fin1.publicationId && fin1b.storyEpoch === 1);

    // T09 same key different params
    let reused = false;
    try {
      finalizeChapter({
        bookId,
        chapterId: ch1.id,
        bodyRevisionId: bodyA.revisionId,
        expectedPublicationId: null,
        expectedCurrentRevisionId: "other",
        expectedStoryEpoch: 0,
        idempotencyKey: "g2-fin-1",
      });
    } catch (e: any) {
      reused = String(e?.message || e).includes("IDEMPOTENCY_KEY_REUSED");
    }
    check("T09/G2 同键异参拒绝", reused);

    // Create proposal manually (extract async may race)
    const proposal = createMemoryProposal({
      bookId,
      chapterNumber: 1,
      sourceRevisionId: bodyA.revisionId,
      summary: "事实：林舟左手受伤。",
      publicationId: fin1.publicationId,
      basisEpoch: fin1.storyEpoch,
    });
    check("G2 提案 status=proposed", proposal.status === "proposed");

    const applied = applyProposal({
      bookId,
      proposalId: proposal.id,
      acceptedOperationIds: ["op-summary"],
      expectedSourceRevisionId: bodyA.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g2-apply-1",
    });
    check("G2 批准后 memory ready", applied.memoryState === "ready");

    const stReady = chapterStoryStatusByNumber(bookId, 1);
    check("G2 status memoryState ready", stReady.publication?.memoryState === "ready");

    // T05: save new draft without replacing publication — formal memory still matches publication
    const bodyB = saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "草稿改写：林舟没有受伤。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    const stDraft = chapterStoryStatusByNumber(bookId, 1);
    check("T05/G2 草稿与定稿分歧", stDraft.draftDivergesFromPublication === true);
    check("T05/G2 定稿指针仍为旧修订", stDraft.publication?.bodyRevisionId === bodyA.revisionId);

    // Memory for ch1 should still inject for ch2 because source matches publication not current
    const memParts = formatMemoriesForContextParts(bookId, 2);
    check(
      "T05/G2 正式上下文仍用定稿记忆",
      memParts.text.includes("林舟左手受伤") && !memParts.text.includes("没有受伤"),
      memParts.text.slice(0, 200),
    );

    // T06 replace publication → invalidate old facts, memory pending
    const fin2 = finalizeChapter({
      bookId,
      chapterId: ch1.id,
      bodyRevisionId: bodyB.revisionId,
      expectedPublicationId: fin1.publicationId,
      expectedCurrentRevisionId: bodyB.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g2-fin-2",
    });
    check("T06/G2 替换定稿 memory pending", fin2.memoryState === "pending");
    const invalidated = (
      regDb.prepare(`SELECT COUNT(*) AS n FROM story_facts WHERE book_id = ? AND status = 'invalidated'`).get(bookId) as { n: number }
    ).n;
    check("T06/G2 旧事实立即失效", invalidated >= 1, `n=${invalidated}`);

    // Old memory no longer matches new publication → excluded
    const memAfter = formatMemoriesForContextParts(bookId, 2);
    check(
      "T06/G2 旧记忆因源不匹配被排除",
      !memAfter.text.includes("林舟左手受伤") || memAfter.excluded.some((e) => e.reason === "superseded_source"),
    );

    // T07: cannot create proposal against wrong publication source
    let createStaleBlocked = false;
    let staleApply = false;
    try {
      createMemoryProposal({
        bookId,
        chapterNumber: 1,
        sourceRevisionId: bodyA.revisionId,
        summary: "应失败",
        publicationId: fin2.publicationId,
        basisEpoch: 0,
      });
    } catch (e: any) {
      createStaleBlocked = String(e?.message || e).includes("PROPOSAL_STALE") || String(e?.message || e).includes("定稿");
    }
    check("T07/G2 源不匹配不能建提案", createStaleBlocked);

    const propB = createMemoryProposal({
      bookId,
      chapterNumber: 1,
      sourceRevisionId: bodyB.revisionId,
      summary: "新定稿记忆：林舟没有受伤。",
      publicationId: fin2.publicationId,
      basisEpoch: fin2.storyEpoch,
    });
    // Replace publication again to stale propB
    const bodyC = saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "第三次定稿正文。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    finalizeChapter({
      bookId,
      chapterId: ch1.id,
      bodyRevisionId: bodyC.revisionId,
      expectedPublicationId: fin2.publicationId,
      expectedCurrentRevisionId: bodyC.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g2-fin-3",
    });
    try {
      applyProposal({
        bookId,
        proposalId: propB.id,
        acceptedOperationIds: ["op-summary"],
        expectedSourceRevisionId: bodyB.revisionId,
        expectedStoryEpoch: getBookHead(bookId).storyEpoch,
        idempotencyKey: "g2-apply-stale",
      });
    } catch (e: any) {
      staleApply = String(e?.message || e).includes("PROPOSAL_STALE");
    }
    check("T07/G2 定稿变化后批准返回 stale", staleApply);

    // Missing expectedPublicationId
    let missing = false;
    try {
      finalizeChapter({
        bookId,
        chapterId: ch1.id,
        bodyRevisionId: bodyC.revisionId,
        expectedPublicationId: undefined as unknown as null,
        idempotencyKey: "g2-fin-missing",
      });
    } catch (e: any) {
      missing = String(e?.message || e).includes("expectedPublicationId");
    }
    check("G2 expectedPublicationId 必填", missing);

    void getProposal;
  }



  // --- G3 character state / foreshadow provenance / knowledge / impact ---
  {
    const {
      finalizeChapter,
      createMemoryProposal,
      applyProposal,
      getBookHead,
    } = await import("../src/story");
    const {
      projectCharacterState,
      listForeshadowing,
      filterFactsByKnowledge,
      storyImpact,
      listStoryCharacters,
    } = await import("../src/storyState");
    const { createBibleCard } = await import("../src/features");
    const { db: regDb } = await import("../src/db");

    const book = createBook({
      title: "G3状态书",
      genre: "测试",
      logline: "",
      style: "",
      targetChapters: 10,
      wordsPerChapter: 800,
    });
    const bookId = book.payload.book.id as string;
    const card = createBibleCard(bookId, {
      kind: "character",
      name: "林舟",
      summary: "主角",
      details: "持剑客",
    });
    const charId = card.id;

    // Ensure chapters 1,5,6,8 exist via body saves
    function body(n: number, text: string) {
      return saveRevision({
        bookId,
        kind: "chapter_body",
        chapterNumber: n,
        body: text,
        source: "human",
        model: null,
        skillIds: [],
        scene: "chapter_body",
        skipMemory: true,
      });
    }
    const b1 = body(1, "第一章：林舟在城门。");
    const b5 = body(5, "第五章：林舟左手受伤。");
    const b6 = body(6, "第六章：续写。");
    const b8 = body(8, "第八章：林舟左手痊愈。");

    const ch5 = regDb.prepare("SELECT id FROM chapters WHERE book_id = ? AND number = 5").get(bookId) as { id: string };
    const fin5 = finalizeChapter({
      bookId,
      chapterId: ch5.id,
      bodyRevisionId: b5.revisionId,
      expectedPublicationId: null,
      expectedCurrentRevisionId: b5.revisionId,
      expectedStoryEpoch: 0,
      idempotencyKey: "g3-fin-5",
    });
    const prop5 = createMemoryProposal({
      bookId,
      chapterNumber: 5,
      sourceRevisionId: b5.revisionId,
      summary: "林舟左手受伤。",
      publicationId: fin5.publicationId,
      basisEpoch: fin5.storyEpoch,
      operations: [
        {
          operationId: "op-summary",
          kind: "summary_update",
          subjectId: `chapter:5`,
          field: "chapter_summary",
          proposedValue: { text: "林舟左手受伤。" },
          assertionKind: "explicit",
          evidence: { quote: "左手受伤" },
          requiresAuthorApproval: true,
        },
        {
          operationId: "op-injury",
          kind: "character_state_change",
          subjectId: charId,
          field: "injury",
          proposedValue: { part: "left_hand", state: "injured" },
          assertionKind: "explicit",
          audience: "reader",
          evidence: { quote: "林舟的左手已经抬不起来。" },
          requiresAuthorApproval: true,
        },
        {
          operationId: "op-secret",
          kind: "character_state_change",
          subjectId: charId,
          field: "knows_fact",
          proposedValue: { secret: "旧徽记来历" },
          assertionKind: "explicit",
          audience: "author",
          evidence: { quote: "他想起旧徽记。" },
          requiresAuthorApproval: true,
        },
        {
          operationId: "op-hook",
          kind: "foreshadow_planted",
          subjectId: "hook-city-gate",
          field: "foreshadow",
          proposedValue: { description: "城门守卫识出了旧徽记", plannedPayoffChapter: 10 },
          assertionKind: "inferred",
          audience: "reader",
          evidence: { quote: "守卫盯着那枚旧徽记。" },
          requiresAuthorApproval: true,
        },
      ],
    });
    applyProposal({
      bookId,
      proposalId: prop5.id,
      acceptedOperationIds: ["op-summary", "op-injury", "op-secret", "op-hook"],
      expectedSourceRevisionId: b5.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g3-apply-5",
    });

    // ch8 heal
    const ch8 = regDb.prepare("SELECT id FROM chapters WHERE book_id = ? AND number = 8").get(bookId) as { id: string };
    const fin8 = finalizeChapter({
      bookId,
      chapterId: ch8.id,
      bodyRevisionId: b8.revisionId,
      expectedPublicationId: null,
      expectedCurrentRevisionId: b8.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g3-fin-8",
    });
    const prop8 = createMemoryProposal({
      bookId,
      chapterNumber: 8,
      sourceRevisionId: b8.revisionId,
      summary: "林舟左手痊愈。",
      publicationId: fin8.publicationId,
      basisEpoch: fin8.storyEpoch,
      operations: [
        {
          operationId: "op-heal",
          kind: "character_state_change",
          subjectId: charId,
          field: "injury",
          proposedValue: { part: "left_hand", state: "healed" },
          assertionKind: "explicit",
          audience: "reader",
          evidence: { quote: "左手已无大碍。" },
          requiresAuthorApproval: true,
        },
      ],
    });
    applyProposal({
      bookId,
      proposalId: prop8.id,
      acceptedOperationIds: ["op-heal"],
      expectedSourceRevisionId: b8.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g3-apply-8",
    });

    // T03: writing ch6 must not see ch8 healed
    const st6 = projectCharacterState(bookId, charId, 6, "author");
    const injury6 = st6.dynamic.injury as { state?: string } | undefined;
    check("T03/G3 第6章不见第8章痊愈", injury6?.state === "injured", JSON.stringify(st6.dynamic));

    const st9 = projectCharacterState(bookId, charId, 9, "author");
    const injury9 = st9.dynamic.injury as { state?: string } | undefined;
    check("T03/G3 第9章可见痊愈", injury9?.state === "healed", JSON.stringify(st9.dynamic));

    // T14: character/reader knowledge gate hides author secret
    const readerState = projectCharacterState(bookId, charId, 6, "reader");
    const hasSecretReader = JSON.stringify(readerState.dynamic).includes("旧徽记来历");
    check("T14/G3 读者模式不注入作者秘密", !hasSecretReader, JSON.stringify(readerState.dynamic));
    check(
      "T14/G3 读者模式排除 knowledge_gate",
      readerState.excluded.some((e) => e.reason === "knowledge_gate"),
      JSON.stringify(readerState.excluded),
    );
    const authorState = projectCharacterState(bookId, charId, 6, "author");
    check(
      "T14/G3 作者模式可见秘密",
      JSON.stringify(authorState.dynamic).includes("旧徽记来历"),
      JSON.stringify(authorState.dynamic),
    );

    // T15: planned payoff chapter 10 does not make hook paid_off at ch6
    const foreshadow6 = listForeshadowing(bookId, 6);
    const gate = foreshadow6.find((h) => h.hookStableId === "hook-city-gate");
    check("T15/G3 伏笔已种植", gate?.status === "planted", JSON.stringify(gate));
    check("T15/G3 计划回收不等于 paid_off", gate?.status !== "paid_off" && gate?.plannedPayoffChapter === 10);

    // Future-only planned without plant shouldn't be paid_off either — add planned-only hook via direct event? 
    // Already covered: planted + plannedPayoff stays planted.

    // Impact of republish ch5
    const impact = storyImpact(bookId, ch5.id);
    check("G3 impact 列出将失效事实", impact.wouldInvalidate.facts.length >= 1);
    check("G3 impact 不自动改正文", impact.autoRewriteSubsequentBodies === false);
    check(
      "G3 impact 后章可能需复核",
      impact.subsequentChaptersPossiblyStale.some((c) => c.chapterNumber === 8),
      JSON.stringify(impact.subsequentChaptersPossiblyStale),
    );

    const chars = listStoryCharacters(bookId, 6);
    check("G3 人物列表含动态", chars.some((c) => c.id === charId && (c.dynamic as any)?.injury?.state === "injured"));

    void b1;
    void b6;
    void filterFactsByKnowledge;
  }



  // --- G4 story pack export/import (T21/T22) + publish-check ---
  {
    const {
      finalizeChapter,
      createMemoryProposal,
      applyProposal,
      getBookHead,
    } = await import("../src/story");
    const { createBibleCard } = await import("../src/features");
    const { db: regDb } = await import("../src/db");
    const {
      exportStoryPackZip,
      importStoryPackFromZipBuffer,
      validateStoryPackDir,
      publishCheck,
      STORY_PACK_FORMAT,
    } = await import("../src/storyPack");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const book = createBook({
      title: "G4故事包书",
      genre: "测试",
      logline: "",
      style: "",
      targetChapters: 4,
      wordsPerChapter: 600,
    });
    const bookId = book.payload.book.id as string;
    const card = createBibleCard(bookId, {
      kind: "character",
      name: "林舟",
      summary: "主角",
      details: "持剑",
    });
    const body1 = saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "第一章：林舟入城。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    const ch1 = regDb.prepare("SELECT id FROM chapters WHERE book_id = ? AND number = 1").get(bookId) as { id: string };
    const fin = finalizeChapter({
      bookId,
      chapterId: ch1.id,
      bodyRevisionId: body1.revisionId,
      expectedPublicationId: null,
      expectedCurrentRevisionId: body1.revisionId,
      expectedStoryEpoch: 0,
      idempotencyKey: "g4-fin-1",
    });
    const prop = createMemoryProposal({
      bookId,
      chapterNumber: 1,
      sourceRevisionId: body1.revisionId,
      summary: "林舟入城。",
      publicationId: fin.publicationId,
      basisEpoch: fin.storyEpoch,
      operations: [
        {
          operationId: "op-sum",
          kind: "summary_update",
          subjectId: "chapter:1",
          field: "chapter_summary",
          proposedValue: { text: "林舟入城。" },
          assertionKind: "explicit",
          evidence: { quote: "入城" },
          requiresAuthorApproval: true,
        },
        {
          operationId: "op-loc",
          kind: "character_state_change",
          subjectId: card.id,
          field: "location",
          proposedValue: { place: "城门" },
          assertionKind: "explicit",
          audience: "reader",
          evidence: { quote: "林舟入城" },
          requiresAuthorApproval: true,
        },
      ],
    });
    applyProposal({
      bookId,
      proposalId: prop.id,
      acceptedOperationIds: ["op-sum", "op-loc"],
      expectedSourceRevisionId: body1.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g4-apply-1",
    });

    const exported = exportStoryPackZip(bookId, { includeSecrets: true });
    check("G4 导出故事包非空", exported.buffer.length > 100);
    check("G4 manifest format", exported.manifest.format === STORY_PACK_FORMAT);

    const imported = importStoryPackFromZipBuffer(exported.buffer);
    check("T22/G4 导入成新书", imported.bookId !== bookId);
    const pubs = regDb
      .prepare(`SELECT COUNT(*) AS n FROM chapter_publications WHERE book_id = ? AND status = 'active'`)
      .get(imported.bookId) as { n: number };
    check("T22/G4 定稿恢复", pubs.n >= 1, `n=${pubs.n}`);
    const facts = regDb
      .prepare(`SELECT COUNT(*) AS n FROM story_facts WHERE book_id = ? AND status = 'active'`)
      .get(imported.bookId) as { n: number };
    check("T22/G4 事实恢复", facts.n >= 1, `n=${facts.n}`);
    const head = getBookHead(imported.bookId);
    check("T22/G4 故事 epoch 恢复", head.storyEpoch >= 1);

    const origPubs = regDb
      .prepare(`SELECT COUNT(*) AS n FROM chapter_publications WHERE book_id = ? AND status = 'active'`)
      .get(bookId) as { n: number };
    check("T22/G4 原书定稿仍在", origPubs.n >= 1);

    const beforeCount = (regDb.prepare(`SELECT COUNT(*) AS n FROM books`).get() as { n: number }).n;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "molan-g4-t21-"));
    const zipPath = path.join(tmp, "pack.zip");
    fs.writeFileSync(zipPath, exported.buffer);
    const extractDir = path.join(tmp, "x");
    fs.mkdirSync(extractDir);
    execFileSync(
      "python3",
      ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2])", zipPath, extractDir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const factsPath = path.join(extractDir, "story/facts.json");
    const factsJson = JSON.parse(fs.readFileSync(factsPath, "utf8")) as Array<Record<string, unknown>>;
    if (factsJson[0]) factsJson[0].book_id = "other-book-id-should-fail";
    fs.writeFileSync(factsPath, JSON.stringify(factsJson, null, 2));
    let crossRejected = false;
    try {
      validateStoryPackDir(extractDir);
    } catch (e: any) {
      const msg = String(e?.message || e);
      crossRejected = msg.includes("跨书") || msg.includes("hash") || msg.includes("大小");
    }
    check("T21/G4 跨书或篡改在 validate 拒绝", crossRejected);

    const slipZip = path.join(tmp, "slip.zip");
    execFileSync(
      "python3",
      [
        "-c",
        "import zipfile,sys; zf=zipfile.ZipFile(sys.argv[1],'w'); zf.writestr('../evil.txt','nope'); zf.writestr('manifest.json','{}'); zf.close()",
        slipZip,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let slipBlocked = false;
    try {
      importStoryPackFromZipBuffer(fs.readFileSync(slipZip));
    } catch (e: any) {
      slipBlocked = /非法|穿越|slip|拒绝|失败/i.test(String(e?.message || e));
    }
    check("T21/G4 非法 ZIP 被拒", slipBlocked);
    const afterCount = (regDb.prepare(`SELECT COUNT(*) AS n FROM books`).get() as { n: number }).n;
    check("T21/G4 拒收后现有书数量不减", afterCount >= beforeCount);

    const pc = publishCheck(bookId, 1);
    check("G4 publish-check 无阻断或仅警告", pc.blockers.length === 0);
    check("G4 publish-check 返回预算估算", Boolean(pc.context?.budgetEstimate && pc.context.budgetEstimate.approxTokens >= 0));
    const pcEmpty = publishCheck(bookId, 3);
    check(
      "G4 publish-check 无定稿有阻断",
      pcEmpty.ok === false && pcEmpty.blockers.some((b) => b.includes("定稿")),
      JSON.stringify(pcEmpty.blockers),
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- G5 views + batch memory gates + no agent orchestration ---
  {
    const { db: regDb } = await import("../src/db");
    const { storyRelationView, storyTimelineView, storyHookView } = await import("../src/storyViews");
    const {
      createMemoryReadyBatch,
      tickMemoryReadyBatch,
      cancelMemoryReadyBatch,
      resumeMemoryReadyBatch,
      readonlyStoryReview,
      refuseAgentOrchestration,
    } = await import("../src/storyBatch");
    const {
      finalizeChapter,
      createMemoryProposal,
      applyProposal,
      getBookHead,
    } = await import("../src/story");
    const { HttpError } = await import("../src/httpError");

    const { createBibleCard } = await import("../src/features");
    const book = createBook({
      title: "G5图谱书",
      genre: "测试",
      logline: "关系与批量",
      style: "",
      targetChapters: 3,
      wordsPerChapter: 600,
    });
    const bookId = book.payload.book.id as string;
    const cardA = createBibleCard(bookId, { kind: "character", name: "林舟", summary: "主角", details: "" });
    const cardB = createBibleCard(bookId, { kind: "character", name: "守卫", summary: "配角", details: "" });
    const charA = cardA.id as string;
    const charB = cardB.id as string;

    const ch1 = regDb.prepare("SELECT id FROM chapters WHERE book_id = ? AND number = 1").get(bookId) as {
      id: string;
    };
    const body1 = saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 1,
      body: "林舟在城门遇见守卫，两人结为同盟。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    const fin1 = finalizeChapter({
      bookId,
      chapterId: ch1.id,
      bodyRevisionId: body1.revisionId,
      expectedPublicationId: null,
      expectedCurrentRevisionId: body1.revisionId,
      expectedStoryEpoch: 0,
      idempotencyKey: "g5-fin-1",
    });
    const prop1 = createMemoryProposal({
      bookId,
      chapterNumber: 1,
      sourceRevisionId: body1.revisionId,
      summary: "林舟与守卫结盟。",
      publicationId: fin1.publicationId,
      basisEpoch: fin1.storyEpoch,
      operations: [
        {
          operationId: "op-summary",
          kind: "summary_update",
          subjectId: "chapter:1",
          field: "chapter_summary",
          proposedValue: { text: "林舟与守卫结盟。" },
          assertionKind: "explicit",
          evidence: { quote: "结为同盟" },
          requiresAuthorApproval: true,
        },
        {
          operationId: "op-rel",
          kind: "character_state_change",
          subjectId: charA,
          field: "relation",
          proposedValue: { target: charB, type: "ally" },
          assertionKind: "explicit",
          audience: "reader",
          evidence: { quote: "结为同盟" },
          requiresAuthorApproval: true,
        },
        {
          operationId: "op-hook",
          kind: "foreshadow_planted",
          subjectId: "hook-gate",
          field: "foreshadow",
          proposedValue: { description: "城门旧徽记", plannedPayoffChapter: 9 },
          assertionKind: "inferred",
          evidence: { quote: "城门" },
          requiresAuthorApproval: true,
        },
      ],
    });
    applyProposal({
      bookId,
      proposalId: prop1.id,
      acceptedOperationIds: ["op-summary", "op-rel", "op-hook"],
      expectedSourceRevisionId: body1.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g5-apply-1",
    });

    const rel = storyRelationView(bookId, 2);
    check("G5 关系图 derived", rel.derived === true);
    check("G5 关系图权威表", rel.authority.includes("story_facts") && rel.authority.includes("bible_cards"));
    check("G5 关系边存在", rel.edges.some((e) => e.source === charA && e.target === charB), JSON.stringify(rel.edges));
    check("G5 关系节点含人物", rel.nodes.some((n) => n.id === charA));

    const tl = storyTimelineView(bookId, null);
    check("G5 时间线含定稿事件", tl.events.some((e) => e.kind === "publication"));
    check("G5 时间线含伏笔事件", tl.events.some((e) => String(e.kind).startsWith("foreshadow_")));
    check("G5 时间线含关系事实", tl.events.some((e) => e.kind === "fact_relation" || e.kind === "fact_character_state"));

    const hv = storyHookView(bookId, 2);
    check("G5 伏笔视图同源", hv.derived === true && hv.authority.includes("hook_events"));
    check("G5 伏笔未把计划当回收", hv.hooks.some((h) => h.status === "planted" && h.plannedPayoffChapter === 9));

    // Batch: chapter 2 has no publication → blocked gate
    let batch = createMemoryReadyBatch(bookId, {
      fromChapter: 2,
      toChapter: 2,
      autoExtract: false,
      strictMemoryReady: true,
      maxModelCalls: 3,
    });
    batch = tickMemoryReadyBatch(bookId, batch.id);
    check("G5 批量无定稿暂停", batch.status === "paused_gate", batch.status);
    check(
      "G5 批量无定稿条目",
      batch.progress.items.some((i: { status: string }) => i.status === "blocked_no_publication"),
    );

    // Batch on ch1 already ready
    batch = createMemoryReadyBatch(bookId, {
      fromChapter: 1,
      toChapter: 1,
      autoExtract: false,
      strictMemoryReady: true,
    });
    batch = tickMemoryReadyBatch(bookId, batch.id);
    check("G5 批量已就绪完成", batch.status === "done" && batch.progress.items[0]?.status === "ready");

    // autoExtract on ch2 after finalize → needs_approval (no silent apply)
    const ch2 = regDb.prepare("SELECT id FROM chapters WHERE book_id = ? AND number = 2").get(bookId) as {
      id: string;
    };
    const body2 = saveRevision({
      bookId,
      kind: "chapter_body",
      chapterNumber: 2,
      body: "第二章草稿。",
      source: "human",
      model: null,
      skillIds: [],
      scene: "chapter_body",
      skipMemory: true,
    });
    finalizeChapter({
      bookId,
      chapterId: ch2.id,
      bodyRevisionId: body2.revisionId,
      expectedPublicationId: null,
      expectedCurrentRevisionId: body2.revisionId,
      expectedStoryEpoch: getBookHead(bookId).storyEpoch,
      idempotencyKey: "g5-fin-2",
    });
    batch = createMemoryReadyBatch(bookId, {
      fromChapter: 2,
      toChapter: 2,
      autoExtract: true,
      strictMemoryReady: true,
      majorChangeRequiresApproval: true,
      maxModelCalls: 5,
    });
    batch = tickMemoryReadyBatch(bookId, batch.id);
    check("G5 批量抽取后待审批", batch.status === "paused_gate" && batch.progress.gate === "needs_approval", batch.status);
    check("G5 批量未静默写正式记忆", batch.progress.items.some((i: { status: string; proposalId: string | null }) => i.status === "needs_approval" && Boolean(i.proposalId)));
    const beforeFacts = (
      regDb.prepare(`SELECT COUNT(*) AS n FROM story_facts WHERE book_id = ? AND status = 'active'`).get(bookId) as {
        n: number;
      }
    ).n;
    // cancel path
    const cancelled = cancelMemoryReadyBatch(bookId, batch.id);
    check("G5 批量可取消", cancelled.status === "cancelled");
    const afterFacts = (
      regDb.prepare(`SELECT COUNT(*) AS n FROM story_facts WHERE book_id = ? AND status = 'active'`).get(bookId) as {
        n: number;
      }
    ).n;
    check("G5 取消不改正式事实", afterFacts === beforeFacts);

    // cost cap
    batch = createMemoryReadyBatch(bookId, {
      fromChapter: 2,
      toChapter: 2,
      autoExtract: true,
      strictMemoryReady: true,
      maxModelCalls: 0,
    });
    batch = tickMemoryReadyBatch(bookId, batch.id);
    check("G5 成本上限暂停", batch.status === "paused_gate" && batch.progress.gate === "cost_cap", JSON.stringify(batch.progress));

    const review = readonlyStoryReview(bookId, 1);
    check("G5 只读审查不可写", review.writable === false && review.agentOrchestration === false);
    check("G5 只读审查有发现", review.findings.length >= 2);

    let refused = false;
    let code = 0;
    try {
      refuseAgentOrchestration(bookId, { tools: [{ name: "write" }], autonomous: true });
    } catch (e) {
      refused = true;
      code = e instanceof HttpError ? e.status : 0;
    }
    check("G5 拒绝多 Agent 编排", refused && code === 422, `code=${code}`);

    // resume after apply on a fresh batch
    batch = createMemoryReadyBatch(bookId, {
      fromChapter: 2,
      toChapter: 2,
      autoExtract: true,
      strictMemoryReady: true,
      maxModelCalls: 5,
    });
    batch = tickMemoryReadyBatch(bookId, batch.id);
    const proposalId = batch.progress.items.find((i) => Boolean(i.proposalId))?.proposalId as string;
    if (proposalId) {
      applyProposal({
        bookId,
        proposalId,
        acceptedOperationIds: [`batch-summary-2`],
        expectedSourceRevisionId: body2.revisionId,
        expectedStoryEpoch: getBookHead(bookId).storyEpoch,
        idempotencyKey: "g5-apply-batch-2",
      });
      batch = resumeMemoryReadyBatch(bookId, batch.id);
      check(
        "G5 批准后恢复可完成",
        batch.status === "done" || batch.progress.items.some((i: { status: string }) => i.status === "ready"),
        batch.status,
      );
    } else {
      check("G5 批准后恢复可完成", false, "missing proposalId");
    }
  }

  // ACC60 验收修复
  {
    const eng = await import("../src/engine");
    const oa = await import("../src/agent/openai");
    let msg = "";
    try { eng.createBook({ title: "长".repeat(201) }); } catch (e) { msg = (e as Error).message; }
    check("ACC60 B2 书名超 200 字明确报错", /最多 200/.test(msg), msg);
    const bk = eng.createBook({ title: "ACC60删书" }).payload.book;
    db.prepare("INSERT INTO generations (id, book_id, scene, status, created_at, updated_at) VALUES (?, ?, 'chat', 'completed', ?, ?)").run(crypto.randomUUID(), bk.id, new Date().toISOString(), new Date().toISOString());
    const a = eng.saveRevision({ bookId: bk.id, kind: "chapter_body", chapterNumber: 1, body: "同一段", source: "human", model: null, skillIds: [], scene: null });
    const b = eng.saveRevision({ bookId: bk.id, kind: "chapter_body", chapterNumber: 1, body: "同一段", source: "human", model: null, skillIds: [], scene: null });
    check("ACC60 E4 相同内容保存不产生垃圾版本", a.revisionId === b.revisionId, `${a.revision}/${b.revision}`);
    eng.deleteBook(bk.id);
    const left = (db.prepare("SELECT COUNT(*) AS n FROM generations WHERE book_id = ?").get(bk.id) as { n: number }).n;
    check("ACC60 B6 删书清理 generations 不留孤儿", left === 0, String(left));
    let err = "";
    try { oa.assertNotTruncated("length"); } catch (e) { err = (e as Error).message; }
    check("ACC60 C2 finish_reason=length 报错不存半截稿", /截断/.test(err), err);
    const body = oa.buildCompletionBody({ scene: "chapter_body", thinkingIntensity: "low", skillTexts: [], context: "", instruction: "x" } as never, "m", true);
    check("ACC60 C6 长文场景超时 300s / 其他 120s", oa.modelTimeoutMs({ scene: "chapter_body" }) === 300000 && oa.modelTimeoutMs({ scene: "probe" }) === 120000);
    let zw = "";
    try { eng.createBook({ title: "\u200b\u200b" }); } catch (e) { zw = (e as Error).message; }
    check("ACC60 G7 零宽字符书名视为空", /要有书名/.test(zw), zw);
    check("ACC60 C2 正文场景 max_tokens≥16384 + 流式 usage", (body.max_tokens as number) >= 16384 && Boolean(body.stream_options), String(body.max_tokens));
  }

  // ---- ACC60 D4 硬约束（停表 fixture）----
  {
    const { createBook, saveRevision, buildContext, executeScene } = await import("../src/engine");
    const { createBibleCard } = await import("../src/features");
    const hc = await import("../src/hardConstraints");
    const bk = createBook({ title: "D4停表", genre: "悬疑", targetChapters: 5, wordsPerChapter: 800 });
    const bid = bk.payload.book.id as string;
    createBibleCard(bid, {
      kind: "prop",
      name: "铜表",
      summary: "父亲遗物，表盖刻“渡”",
      details: "硬约束：铜表停在三点十七分，指针永不再走 ｜禁：指针*走、秒针*走、分针*走、指针还在游、分针爬、滴答",
    });
    saveRevision({ bookId: bid, kind: "book_profile", chapterNumber: null, body: "第一人称。\n硬约束：叙述者“我”怕深水，从不主动下水", source: "human", model: null, skillIds: [], scene: "book_setup", skipMemory: true });
    const list = hc.listHardConstraints(bid);
    check("D4 解析设定卡+档案硬约束", list.length === 2 && list[0].forbid.length === 6 && list[1].source.kind === "book_profile", JSON.stringify(list.map((x) => x.text)));
    const ctx = buildContext(bid, 1, "写");
    check("D4 【硬约束】独立段且位于上下文最前", ctx.startsWith("【硬约束】") && ctx.includes("铜表停在三点十七分") && ctx.includes("怕深水"));
    const bad = "我掀开表盖，指针还在游，分针爬到二十。\n夜里我听见秒针还在走。";
    const good = "我掀开表盖，指针没有走，仍是三点十七分。秒针早就不走了。";
    const r1 = hc.checkTextAgainstConstraints(bad, list);
    check("D4 预检命中停表违例并带原文引用", r1.violations.length >= 3 && r1.violations.every((v) => v.constraintId === "H1") && r1.violations.some((v) => v.quote.includes("秒针还在走")), JSON.stringify(r1.violations.map((v) => v.quote)));
    const r2 = hc.checkTextAgainstConstraints(good, list);
    check("D4 否定句不误报（指针没有走/不走了）", r2.violations.length === 0, JSON.stringify(r2.violations));
    check("D4 无禁词约束标 needs_review", r2.needsReview.includes("H2"));
    saveRevision({ bookId: bid, kind: "chapter_body", chapterNumber: 4, body: bad, source: "human", model: null, skillIds: [], scene: "chapter_body", skipMemory: true });
    const rv = hc.formatHardConstraintsForReview(bid, bad);
    check("D4 审核指令逐条列出硬约束并附预检引用", rv.includes("H1. 铜表停在三点十七分") && rv.includes("H2.") && rv.includes("秒针还在走") && rv.includes("不得省略"));
    let big = "";
    createBibleCard(bid, { kind: "place", name: "超长", details: `硬约束：${"雾".repeat(7000)}` });
    try { buildContext(bid, 1, "写"); } catch (e) { big = (e as Error).message; }
    check("D4 硬约束超预算报错不静默截断", /不可截断/.test(big), big);
    const b2 = createBook({ title: "D4停表2", genre: "悬疑", targetChapters: 2, wordsPerChapter: 400 });
    const bid2 = b2.payload.book.id as string;
    createBibleCard(bid2, { kind: "prop", name: "铜表", details: "硬约束：铜表停在三点十七分 ｜禁：秒针*走" });
    const out = await executeScene({ bookId: bid2, scene: "chapter_body", chapterNumber: 1, instruction: "写" });
    check("D4 生成后回传 hardConstraintCheck", Boolean(out.hardConstraintCheck) && out.hardConstraintCheck!.checked === 1);
    const pg = (await import("../src/engine")).postGenerationHardCheck(bid2, "chapter_body", "秒针又走了一格");
    check("D4 生成后预检标违例", pg!.violations.length === 1);
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
