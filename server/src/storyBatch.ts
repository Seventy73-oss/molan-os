/**
 * G5: batch memory-ready with approval gates, cancel, cost caps.
 * Never auto-writes canon without StoryLedger proposal apply.
 * Never enables unconstrained multi-agent tool orchestration.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { HttpError } from "./httpError";
import { createMemoryProposal, getBookHead, getProposal } from "./story";
import { publishCheck } from "./storyPack";
import { listForeshadowing, storyImpact } from "./storyState";

function nowIso() {
  return new Date().toISOString();
}

function mustBook(bookId: string) {
  const row = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId) as { id: string } | undefined;
  if (!row) throw new HttpError(404, "书不存在");
}

export type BatchConfig = {
  fromChapter: number;
  toChapter: number;
  strictMemoryReady: boolean;
  autoExtract: boolean;
  /** Default false. Even if true, major ops never auto-apply. */
  autoApplyNonMajor: boolean;
  majorChangeRequiresApproval: boolean;
  maxChapters: number;
  maxModelCalls: number;
};

export type BatchItem = {
  chapterNumber: number;
  chapterId: string | null;
  publicationId: string | null;
  memoryState: string | null;
  status:
    | "ready"
    | "blocked_no_publication"
    | "needs_extract"
    | "extract_queued"
    | "needs_approval"
    | "paused_cost"
    | "skipped"
    | "error";
  proposalId: string | null;
  majorOps: string[];
  note: string;
};

type Progress = {
  items: BatchItem[];
  modelCalls: number;
  cursorChapter: number | null;
  gate: string | null;
};

function defaultConfig(partial: Partial<BatchConfig> & { fromChapter: number; toChapter: number }): BatchConfig {
  const from = Math.floor(partial.fromChapter);
  const to = Math.floor(partial.toChapter);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < from) {
    throw new HttpError(400, "fromChapter/toChapter 无效");
  }
  const maxChapters = Math.min(Math.max(1, Math.floor(partial.maxChapters ?? 50)), 200);
  if (to - from + 1 > maxChapters) {
    throw new HttpError(400, `章节跨度超过 maxChapters=${maxChapters}`);
  }
  return {
    fromChapter: from,
    toChapter: to,
    strictMemoryReady: partial.strictMemoryReady !== false,
    autoExtract: Boolean(partial.autoExtract),
    autoApplyNonMajor: Boolean(partial.autoApplyNonMajor),
    majorChangeRequiresApproval: partial.majorChangeRequiresApproval !== false,
    maxChapters,
    maxModelCalls: Math.min(Math.max(0, Math.floor(partial.maxModelCalls ?? 20)), 200),
  };
}

function isMajorOp(op: Record<string, unknown>): boolean {
  const kind = String(op.kind ?? "");
  if (op.requiresAuthorApproval === true) return true;
  if (kind.startsWith("foreshadow_")) return true;
  if (kind === "character_state_change") return true;
  if (kind === "summary_update") return false;
  return Boolean(op.requiresAuthorApproval);
}

function loadBatch(bookId: string, batchId: string) {
  const row = db
    .prepare(
      `SELECT id, book_id AS bookId, kind, status, from_chapter AS fromChapter, to_chapter AS toChapter,
              current_chapter AS currentChapter, config_json AS configJson, progress_json AS progressJson,
              cost_json AS costJson, error, created_at AS createdAt, updated_at AS updatedAt
       FROM story_batches WHERE id = ? AND book_id = ?`,
    )
    .get(batchId, bookId) as
    | {
        id: string;
        bookId: string;
        kind: string;
        status: string;
        fromChapter: number;
        toChapter: number;
        currentChapter: number | null;
        configJson: string;
        progressJson: string;
        costJson: string;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  if (!row) throw new HttpError(404, "批量任务不存在");
  return row;
}

function serializeBatch(row: ReturnType<typeof loadBatch>) {
  const config = JSON.parse(row.configJson) as BatchConfig;
  const progress = JSON.parse(row.progressJson || "{}") as Progress;
  const cost = JSON.parse(row.costJson || "{}") as Record<string, unknown>;
  return {
    id: row.id,
    bookId: row.bookId,
    kind: row.kind,
    status: row.status,
    fromChapter: row.fromChapter,
    toChapter: row.toChapter,
    currentChapter: row.currentChapter,
    config,
    progress,
    cost,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    gates: {
      majorChangeRequiresApproval: config.majorChangeRequiresApproval,
      strictMemoryReady: config.strictMemoryReady,
      autoApplyNonMajor: config.autoApplyNonMajor,
      autoExtract: config.autoExtract,
      unconstrainedAgentOrchestration: false,
      writesOnlyViaStoryLedger: true,
    },
  };
}

export function createMemoryReadyBatch(
  bookId: string,
  partial: Partial<BatchConfig> & { fromChapter: number; toChapter: number },
) {
  mustBook(bookId);
  const config = defaultConfig(partial);
  const id = randomUUID();
  const now = nowIso();
  const progress: Progress = { items: [], modelCalls: 0, cursorChapter: config.fromChapter, gate: null };
  db.prepare(
    `INSERT INTO story_batches
      (id, book_id, kind, status, from_chapter, to_chapter, current_chapter, config_json, progress_json, cost_json, error, created_at, updated_at)
     VALUES (?, ?, 'memory_ready', 'queued', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    bookId,
    config.fromChapter,
    config.toChapter,
    config.fromChapter,
    JSON.stringify(config),
    JSON.stringify(progress),
    JSON.stringify({ modelCalls: 0, maxModelCalls: config.maxModelCalls }),
    now,
    now,
  );
  return serializeBatch(loadBatch(bookId, id));
}

function chapterMeta(bookId: string, chapterNumber: number) {
  const ch = db
    .prepare(`SELECT id, number FROM chapters WHERE book_id = ? AND number = ?`)
    .get(bookId, chapterNumber) as { id: string; number: number } | undefined;
  if (!ch) return { chapterId: null as string | null, publicationId: null as string | null, memoryState: null as string | null, bodyRevisionId: null as string | null };
  const pub = db
    .prepare(
      `SELECT id, memory_state AS memoryState, body_revision_id AS bodyRevisionId
       FROM chapter_publications WHERE book_id = ? AND chapter_id = ? AND status = 'active'`,
    )
    .get(bookId, ch.id) as { id: string; memoryState: string; bodyRevisionId: string } | undefined;
  return {
    chapterId: ch.id,
    publicationId: pub?.id ?? null,
    memoryState: pub?.memoryState ?? null,
    bodyRevisionId: pub?.bodyRevisionId ?? null,
  };
}

function openProposalForPublication(bookId: string, publicationId: string) {
  return db
    .prepare(
      `SELECT id, status, operations_json AS operationsJson FROM memory_proposals
       WHERE book_id = ? AND publication_id = ? AND status IN ('proposed','extracting','queued')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(bookId, publicationId) as { id: string; status: string; operationsJson: string } | undefined;
}

function bodySnippet(bodyRevisionId: string): string {
  const row = db
    .prepare(`SELECT body FROM artifact_revisions WHERE id = ?`)
    .get(bodyRevisionId) as { body: string } | undefined;
  const text = (row?.body || "").trim();
  return text.slice(0, 400) || "（空正文）";
}

/** Advance one chapter (or resume gate). Idempotent per chapter item. */
export function tickMemoryReadyBatch(bookId: string, batchId: string) {
  const row = loadBatch(bookId, batchId);
  if (row.status === "cancelled" || row.status === "done" || row.status === "error") {
    return serializeBatch(row);
  }
  const config = JSON.parse(row.configJson) as BatchConfig;
  const progress = JSON.parse(row.progressJson || "{}") as Progress;
  if (!progress.items) progress.items = [];
  progress.modelCalls = progress.modelCalls || 0;

  const doneChapters = new Set(progress.items.map((i) => i.chapterNumber));
  let chapter = progress.cursorChapter ?? config.fromChapter;
  while (chapter <= config.toChapter && doneChapters.has(chapter)) chapter += 1;

  if (chapter > config.toChapter) {
    const now = nowIso();
    db.prepare(
      `UPDATE story_batches SET status = 'done', current_chapter = ?, progress_json = ?, cost_json = ?, updated_at = ?, error = NULL WHERE id = ?`,
    ).run(
      config.toChapter,
      JSON.stringify({ ...progress, cursorChapter: null, gate: null }),
      JSON.stringify({ modelCalls: progress.modelCalls, maxModelCalls: config.maxModelCalls }),
      now,
      batchId,
    );
    return serializeBatch(loadBatch(bookId, batchId));
  }

  if (progress.modelCalls >= config.maxModelCalls && config.autoExtract) {
    const now = nowIso();
    progress.gate = "cost_cap";
    db.prepare(
      `UPDATE story_batches SET status = 'paused_gate', current_chapter = ?, progress_json = ?, cost_json = ?, updated_at = ?, error = ? WHERE id = ?`,
    ).run(
      chapter,
      JSON.stringify(progress),
      JSON.stringify({ modelCalls: progress.modelCalls, maxModelCalls: config.maxModelCalls }),
      now,
      `已达 maxModelCalls=${config.maxModelCalls}`,
      batchId,
    );
    return serializeBatch(loadBatch(bookId, batchId));
  }

  const meta = chapterMeta(bookId, chapter);
  const item: BatchItem = {
    chapterNumber: chapter,
    chapterId: meta.chapterId,
    publicationId: meta.publicationId,
    memoryState: meta.memoryState,
    status: "skipped",
    proposalId: null,
    majorOps: [],
    note: "",
  };

  if (!meta.chapterId || !meta.publicationId) {
    item.status = "blocked_no_publication";
    item.note = "无活跃定稿；批量记忆不会发明定稿";
    progress.items.push(item);
    progress.cursorChapter = chapter + 1;
    progress.gate = config.strictMemoryReady ? "blocked_no_publication" : null;
    const status = config.strictMemoryReady ? "paused_gate" : "running";
    const now = nowIso();
    db.prepare(
      `UPDATE story_batches SET status = ?, current_chapter = ?, progress_json = ?, cost_json = ?, updated_at = ?, error = ? WHERE id = ?`,
    ).run(
      status,
      chapter,
      JSON.stringify(progress),
      JSON.stringify({ modelCalls: progress.modelCalls, maxModelCalls: config.maxModelCalls }),
      now,
      config.strictMemoryReady ? item.note : null,
      batchId,
    );
    return serializeBatch(loadBatch(bookId, batchId));
  }

  if (meta.memoryState === "ready") {
    item.status = "ready";
    item.note = "记忆已就绪";
    progress.items.push(item);
    progress.cursorChapter = chapter + 1;
    progress.gate = null;
    const now = nowIso();
    const nextStatus = chapter >= config.toChapter ? "done" : "running";
    db.prepare(
      `UPDATE story_batches SET status = ?, current_chapter = ?, progress_json = ?, cost_json = ?, updated_at = ?, error = NULL WHERE id = ?`,
    ).run(
      nextStatus,
      nextStatus === "done" ? chapter : chapter + 1,
      JSON.stringify(progress),
      JSON.stringify({ modelCalls: progress.modelCalls, maxModelCalls: config.maxModelCalls }),
      now,
      batchId,
    );
    return serializeBatch(loadBatch(bookId, batchId));
  }

  // existing open proposal?
  let prop = openProposalForPublication(bookId, meta.publicationId);
  if (!prop && config.autoExtract) {
    // Deterministic local proposal from body — counts as one model/extract slot (cost cap).
    const summary = bodySnippet(meta.bodyRevisionId!);
    const created = createMemoryProposal({
      bookId,
      chapterNumber: chapter,
      sourceRevisionId: meta.bodyRevisionId!,
      summary,
      publicationId: meta.publicationId,
      basisEpoch: getBookHead(bookId).storyEpoch,
      operations: [
        {
          operationId: `batch-summary-${chapter}`,
          kind: "summary_update",
          subjectId: `chapter:${chapter}`,
          field: "chapter_summary",
          proposedValue: { text: summary },
          assertionKind: "explicit",
          evidence: { quote: summary.slice(0, 80) },
          requiresAuthorApproval: true,
        },
      ],
    });
    progress.modelCalls += 1;
    prop = { id: created.id, status: "proposed", operationsJson: JSON.stringify(created.operations ?? []) };
    item.status = "extract_queued";
    item.proposalId = created.id;
    item.note = "已生成记忆提案（待作者批准）；未写正式事实";
  } else if (!prop) {
    item.status = "needs_extract";
    item.note = "记忆未就绪且未开启 autoExtract";
  }

  if (prop) {
    item.proposalId = prop.id;
    let ops: Array<Record<string, unknown>> = [];
    try {
      ops = JSON.parse(prop.operationsJson || "[]");
    } catch {
      ops = [];
    }
    const majors = ops.filter(isMajorOp).map((o) => String(o.operationId ?? o.kind ?? ""));
    item.majorOps = majors;
    if (prop.status === "proposed" && majors.length && config.majorChangeRequiresApproval) {
      item.status = "needs_approval";
      item.note = `重大变化待审批：${majors.join(",")}`;
      progress.items.push(item);
      progress.cursorChapter = chapter;
      progress.gate = "needs_approval";
      const now = nowIso();
      db.prepare(
        `UPDATE story_batches SET status = 'paused_gate', current_chapter = ?, progress_json = ?, cost_json = ?, updated_at = ?, error = ? WHERE id = ?`,
      ).run(
        chapter,
        JSON.stringify(progress),
        JSON.stringify({ modelCalls: progress.modelCalls, maxModelCalls: config.maxModelCalls }),
        now,
        item.note,
        batchId,
      );
      return serializeBatch(loadBatch(bookId, batchId));
    }

    // Optional auto-apply of non-major only (still via StoryLedger applyProposal path — caller must apply; we refuse silent canon write here)
    if (config.autoApplyNonMajor) {
      item.note =
        (item.note ? item.note + "；" : "") +
        "autoApplyNonMajor=true 但不在批量内静默写正式事实；请走 /memory/proposals/:id/apply";
    }
  }

  if (config.strictMemoryReady && item.status !== "ready") {
    progress.items.push(item);
    progress.cursorChapter = chapter;
    progress.gate = item.status;
    const now = nowIso();
    db.prepare(
      `UPDATE story_batches SET status = 'paused_gate', current_chapter = ?, progress_json = ?, cost_json = ?, updated_at = ?, error = ? WHERE id = ?`,
    ).run(
      chapter,
      JSON.stringify(progress),
      JSON.stringify({ modelCalls: progress.modelCalls, maxModelCalls: config.maxModelCalls }),
      now,
      item.note || "严格模式：记忆未就绪",
      batchId,
    );
    return serializeBatch(loadBatch(bookId, batchId));
  }

  progress.items.push(item);
  progress.cursorChapter = chapter + 1;
  progress.gate = null;
  const now = nowIso();
  const nextStatus = chapter >= config.toChapter ? "done" : "running";
  db.prepare(
    `UPDATE story_batches SET status = ?, current_chapter = ?, progress_json = ?, cost_json = ?, updated_at = ?, error = NULL WHERE id = ?`,
  ).run(
    nextStatus,
    nextStatus === "done" ? chapter : chapter + 1,
    JSON.stringify(progress),
    JSON.stringify({ modelCalls: progress.modelCalls, maxModelCalls: config.maxModelCalls }),
    now,
    batchId,
  );
  return serializeBatch(loadBatch(bookId, batchId));
}

export function getMemoryReadyBatch(bookId: string, batchId: string) {
  return serializeBatch(loadBatch(bookId, batchId));
}

export function cancelMemoryReadyBatch(bookId: string, batchId: string) {
  const row = loadBatch(bookId, batchId);
  if (row.status === "done") return serializeBatch(row);
  const now = nowIso();
  const progress = JSON.parse(row.progressJson || "{}") as Progress;
  progress.gate = "cancelled";
  db.prepare(
    `UPDATE story_batches SET status = 'cancelled', progress_json = ?, updated_at = ?, error = ? WHERE id = ?`,
  ).run(JSON.stringify(progress), now, "作者取消", batchId);
  return serializeBatch(loadBatch(bookId, batchId));
}

/** After author applies a proposal, resume past needs_approval gate. */
export function resumeMemoryReadyBatch(bookId: string, batchId: string) {
  const row = loadBatch(bookId, batchId);
  if (row.status === "cancelled" || row.status === "done") return serializeBatch(row);
  const progress = JSON.parse(row.progressJson || "{}") as Progress;
  const chapter = progress.cursorChapter ?? row.currentChapter ?? row.fromChapter;
  const meta = chapterMeta(bookId, chapter);
  if (meta.memoryState === "ready") {
    // mark last needs_approval item ready if present
    for (let i = progress.items.length - 1; i >= 0; i--) {
      if (progress.items[i].chapterNumber === chapter && progress.items[i].status === "needs_approval") {
        progress.items[i].status = "ready";
        progress.items[i].note = "作者已批准，记忆就绪";
        progress.items[i].memoryState = "ready";
        break;
      }
    }
    progress.cursorChapter = chapter + 1;
    progress.gate = null;
    const now = nowIso();
    db.prepare(
      `UPDATE story_batches SET status = 'running', current_chapter = ?, progress_json = ?, updated_at = ?, error = NULL WHERE id = ?`,
    ).run(chapter + 1, JSON.stringify(progress), now, batchId);
  } else {
    const now = nowIso();
    db.prepare(
      `UPDATE story_batches SET status = 'running', progress_json = ?, updated_at = ?, error = NULL WHERE id = ?`,
    ).run(JSON.stringify({ ...progress, gate: null }), now, batchId);
  }
  return tickMemoryReadyBatch(bookId, batchId);
}

/** Read-only consistency review — never writes. */
export function readonlyStoryReview(bookId: string, chapterNumber: number | null) {
  mustBook(bookId);
  const findings: Array<{ id: string; level: "info" | "warn" | "blocker"; message: string }> = [];
  findings.push({
    id: "readonly",
    level: "info",
    message: "只读审查器：不改正文、不定稿、不批准提案；写回须走 StoryLedger。",
  });
  findings.push({
    id: "no_agent_orchestration",
    level: "info",
    message: "禁止无约束多 Agent 工具编排；本接口不注册 tools。",
  });

  if (chapterNumber && chapterNumber > 0) {
    const pc = publishCheck(bookId, chapterNumber);
    for (const c of pc.checks) {
      findings.push({
        id: `publish:${c.id}`,
        level: c.level === "blocker" ? "blocker" : c.pass ? "info" : "warn",
        message: c.message,
      });
    }
    const ch = db
      .prepare(`SELECT id FROM chapters WHERE book_id = ? AND number = ?`)
      .get(bookId, chapterNumber) as { id: string } | undefined;
    if (ch) {
      const imp = storyImpact(bookId, ch.id);
      findings.push({
        id: "impact",
        level: imp.draftDiverges ? "warn" : "info",
        message: `影响报告：将失效事实 ${imp.wouldInvalidate.facts.length}，后章可能需复核 ${imp.subsequentChaptersPossiblyStale.length}（不自动改正文）`,
      });
    }
    const hooks = listForeshadowing(bookId, chapterNumber);
    const open = hooks.filter((h) => h.status === "planted" || h.status === "developed");
    findings.push({
      id: "open_hooks",
      level: open.length ? "warn" : "info",
      message: `未回收伏笔 ${open.length}（计划回收≠已回收）`,
    });
  } else {
    findings.push({ id: "chapter", level: "warn", message: "未指定 chapterNumber，仅返回原则性说明" });
  }

  return {
    writable: false,
    agentOrchestration: false,
    toolsRegistered: false,
    chapterNumber,
    findings,
    note: "专门审查器使用只读 Interface；任何写回仍走定稿 / 提案批准 / 幂等。",
  };
}

/** Explicit refuse endpoint for unconstrained agent orchestration. */
export function refuseAgentOrchestration(bookId: string, body: Record<string, unknown> = {}) {
  void bookId;
  const asked =
    body.tools != null ||
    body.enableTools != null ||
    body.autonomous != null ||
    body.orchestration != null ||
    body.agents != null ||
    body.multiAgent != null;
  throw new HttpError(
    422,
    asked
      ? "拒绝无约束多 Agent / 工具编排。批量记忆与审查不得绕过定稿、版本、知识过滤、幂等与作者审批。写回请用 StoryLedger（finalize / proposals apply）。"
      : "墨兰写作不提供自主 Agent 编排接口。请使用场景写作、定稿与记忆提案审批。详见 docs/PI_RUNTIME.md 与 G5 说明。",
  );
}

export function getProposalMajorOps(bookId: string, proposalId: string) {
  const p = getProposal(bookId, proposalId);
  const ops = (p.operations as Array<Record<string, unknown>>) || [];
  return ops.filter(isMajorOp);
}
