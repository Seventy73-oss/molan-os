/**
 * G2 StoryLedger (Node parity): publication pointer, memory proposals,
 * book epoch / idempotency, invalidate-on-republish.
 */
import { skillsForScene } from "./skills";
import { createHash, randomUUID } from "node:crypto";
import { db } from "./db";
import { HttpError, saveRevision } from "./engine";
import {
  enrichAcceptedOperations,
  invalidateKnowledgeAndHooksForPublication,
} from "./storyState";

const PROTOCOL_VERSION = 1;
const PROPOSAL_SCHEMA = "molan.memory-proposal/v1";

function nowIso() {
  return new Date().toISOString();
}

function hashRequest(v: unknown) {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

function ensureBookHead(bookId: string) {
  db.prepare(
    `INSERT INTO story_book_heads (book_id, story_epoch, fact_set_version, protocol_version, updated_at)
     VALUES (?, 0, 0, ?, ?)
     ON CONFLICT(book_id) DO NOTHING`,
  ).run(bookId, PROTOCOL_VERSION, nowIso());
}

function mustBook(bookId: string) {
  const row = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId) as { id: string } | undefined;
  if (!row) throw new HttpError(404, "书不存在");
}

function chapterRow(bookId: string, chapterId: string) {
  const row = db
    .prepare("SELECT id, number FROM chapters WHERE id = ? AND book_id = ?")
    .get(chapterId, bookId) as { id: string; number: number } | undefined;
  if (!row) throw new HttpError(404, "章节不存在");
  return row;
}

function chapterByNumber(bookId: string, number: number) {
  const row = db
    .prepare("SELECT id, number FROM chapters WHERE book_id = ? AND number = ?")
    .get(bookId, number) as { id: string; number: number } | undefined;
  if (!row) throw new HttpError(404, `没有第 ${number} 章`);
  return row;
}

function assertBodyRevision(bookId: string, chapterId: string, bodyRevisionId: string) {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM artifact_revisions r
       JOIN artifacts a ON a.id = r.artifact_id
       WHERE r.id = ? AND a.book_id = ? AND a.chapter_id = ? AND a.kind = 'chapter_body'`,
    )
    .get(bodyRevisionId, bookId, chapterId) as { ok: number } | undefined;
  if (!row) throw new HttpError(400, "bodyRevisionId 不属于本章正文修订");
}

function activePublication(bookId: string, chapterId: string) {
  return db
    .prepare(
      `SELECT id, body_revision_id AS bodyRevisionId, publication_version AS publicationVersion, memory_state AS memoryState
       FROM chapter_publications WHERE book_id = ? AND chapter_id = ? AND status = 'active'`,
    )
    .get(bookId, chapterId) as
    | { id: string; bodyRevisionId: string; publicationVersion: number; memoryState: string }
    | undefined;
}

function lookupIdempotency(bookId: string, key: string) {
  return db
    .prepare(
      `SELECT request_hash AS requestHash, result_json AS resultJson
       FROM story_operation_results WHERE book_id = ? AND idempotency_key = ?`,
    )
    .get(bookId, key) as { requestHash: string; resultJson: string } | undefined;
}

function storeIdempotency(bookId: string, key: string, hash: string, result: unknown) {
  db.prepare(
    `INSERT INTO story_operation_results (book_id, idempotency_key, request_hash, result_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(bookId, key, hash, JSON.stringify(result), nowIso());
}

export function getBookHead(bookId: string) {
  mustBook(bookId);
  ensureBookHead(bookId);
  const row = db
    .prepare(
      `SELECT story_epoch AS storyEpoch, fact_set_version AS factSetVersion,
              protocol_version AS protocolVersion, updated_at AS updatedAt
       FROM story_book_heads WHERE book_id = ?`,
    )
    .get(bookId) as {
    storyEpoch: number;
    factSetVersion: number;
    protocolVersion: number;
    updatedAt: string;
  };
  return { bookId, ...row };
}

export function currentBodyRevisionId(bookId: string, chapterNumber: number): string | null {
  const row = db
    .prepare(
      `SELECT a.current_revision_id AS id FROM artifacts a
       JOIN chapters c ON c.id = a.chapter_id
       WHERE a.book_id = ? AND a.kind = 'chapter_body' AND c.number = ?`,
    )
    .get(bookId, chapterNumber) as { id: string | null } | undefined;
  return row?.id ?? null;
}

export function chapterHasActivePublication(bookId: string, chapterNumber: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM chapter_publications p
       JOIN chapters c ON c.id = p.chapter_id
       WHERE p.book_id = ? AND c.number = ? AND p.status = 'active'`,
    )
    .get(bookId, chapterNumber) as { ok: number } | undefined;
  return Boolean(row);
}

export function bookHasAnyPublication(bookId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM chapter_publications WHERE book_id = ? AND status = 'active' LIMIT 1`)
    .get(bookId) as { ok: number } | undefined;
  return Boolean(row);
}

export type FinalizeInput = {
  bookId: string;
  chapterId: string;
  bodyRevisionId: string;
  /** Must be present: null = expect none; string = expect that id. Undefined = error. */
  expectedPublicationId: string | null | undefined;
  expectedCurrentRevisionId?: string | null;
  expectedStoryEpoch?: number | null;
  idempotencyKey: string;
  acceptedBy?: string;
};

export function finalizeChapter(input: FinalizeInput) {
  mustBook(input.bookId);
  ensureBookHead(input.bookId);
  const chapter = chapterRow(input.bookId, input.chapterId);
  const fingerprint = {
    op: "finalize",
    bookId: input.bookId,
    chapterId: input.chapterId,
    bodyRevisionId: input.bodyRevisionId,
    expectedPublicationId: input.expectedPublicationId,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId ?? null,
    expectedStoryEpoch: input.expectedStoryEpoch ?? null,
  };
  const reqHash = hashRequest(fingerprint);
  const prev = lookupIdempotency(input.bookId, input.idempotencyKey);
  if (prev) {
    if (prev.requestHash !== reqHash) {
      throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED: 同键不同参数");
    }
    return JSON.parse(prev.resultJson);
  }

  if (input.expectedPublicationId === undefined) {
    throw new HttpError(400, "expectedPublicationId 必须显式传入（null 表示尚无定稿）");
  }

  assertBodyRevision(input.bookId, chapter.id, input.bodyRevisionId);
  const current = currentBodyRevisionId(input.bookId, chapter.number);
  if (
    input.expectedCurrentRevisionId != null &&
    current !== input.expectedCurrentRevisionId
  ) {
    throw new HttpError(409, "REVISION_CONFLICT: 正文 current 与预期不符");
  }

  const head = getBookHead(input.bookId);
  if (
    input.expectedStoryEpoch != null &&
    input.expectedStoryEpoch !== head.storyEpoch
  ) {
    throw new HttpError(409, "STORY_EPOCH_CONFLICT: 故事版本已变化");
  }

  const active = activePublication(input.bookId, chapter.id);
  if (input.expectedPublicationId === null) {
    if (active) throw new HttpError(409, "REVISION_CONFLICT: 已有活跃定稿，请传入 expectedPublicationId");
  } else if (!active || active.id !== input.expectedPublicationId) {
    throw new HttpError(409, "REVISION_CONFLICT: 活跃定稿与预期不符");
  }

  const now = nowIso();
  const pubId = randomUUID();
  let nextVersion = 1;
  let supersededId: string | null = null;

  const run = db.transaction(() => {
    if (active) {
      db.prepare(`UPDATE chapter_publications SET status = 'superseded' WHERE id = ?`).run(active.id);
      db.prepare(
        `UPDATE story_facts SET status = 'invalidated' WHERE publication_id = ? AND status = 'active'`,
      ).run(active.id);
      db.prepare(
        `UPDATE story_fact_sets SET status = 'invalidated' WHERE publication_id = ? AND status = 'active'`,
      ).run(active.id);
      invalidateKnowledgeAndHooksForPublication(active.id);
      db.prepare(
        `UPDATE memory_proposals SET status = 'stale', updated_at = ?
         WHERE book_id = ? AND chapter_id = ? AND status IN ('queued','extracting','proposed')`,
      ).run(now, input.bookId, chapter.id);
      supersededId = active.id;
      nextVersion = active.publicationVersion + 1;
    }

    db.prepare(
      `INSERT INTO chapter_publications
        (id, book_id, chapter_id, body_revision_id, publication_version, status, memory_state, accepted_at, accepted_by)
       VALUES (?, ?, ?, ?, ?, 'active', 'pending', ?, ?)`,
    ).run(
      pubId,
      input.bookId,
      chapter.id,
      input.bodyRevisionId,
      nextVersion,
      now,
      input.acceptedBy ?? "author",
    );

    const newEpoch = head.storyEpoch + 1;
    db.prepare(`UPDATE story_book_heads SET story_epoch = ?, updated_at = ? WHERE book_id = ?`).run(
      newEpoch,
      now,
      input.bookId,
    );

    const outboxId = randomUUID();
    const dedup = `memory_extract:${pubId}`;
    const payload = JSON.stringify({
      publicationId: pubId,
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      bodyRevisionId: input.bodyRevisionId,
      basisEpoch: newEpoch,
    });
    db.prepare(
      `UPDATE story_outbox SET status = 'obsolete', updated_at = ?
       WHERE book_id = ? AND kind = 'memory_extract'
         AND status IN ('queued','running','retry_wait')`,
    ).run(now, input.bookId);
    db.prepare(
      `INSERT INTO story_outbox
        (id, book_id, dedup_key, kind, payload_json, status, attempt, next_run_at, lease_generation, created_at, updated_at)
       VALUES (?, ?, ?, 'memory_extract', ?, 'queued', 0, ?, 0, ?, ?)
       ON CONFLICT(book_id, dedup_key) DO UPDATE SET
         status = 'queued', payload_json = excluded.payload_json, updated_at = excluded.updated_at,
         next_run_at = excluded.next_run_at, attempt = 0, last_error_code = NULL`,
    ).run(outboxId, input.bookId, dedup, payload, now, now, now);

    const result = {
      publicationId: pubId,
      bodyRevisionId: input.bodyRevisionId,
      storyEpoch: newEpoch,
      memoryState: "pending",
      publicationVersion: nextVersion,
      affectedFromChapter: chapter.number,
      supersededPublicationId: supersededId,
      outboxId,
      chapterId: chapter.id,
      chapterNumber: chapter.number,
    };
    storeIdempotency(input.bookId, input.idempotencyKey, reqHash, result);
    return result;
  });

  const result = run();
  // Schedule proposal extract asynchronously (local-draft / configured model)
  void schedulePublicationMemoryExtract(input.bookId, chapter.number, input.bodyRevisionId);
  return result;
}

export function chapterStoryStatus(bookId: string, chapterId: string) {
  mustBook(bookId);
  ensureBookHead(bookId);
  const chapter = chapterRow(bookId, chapterId);
  const current = currentBodyRevisionId(bookId, chapter.number);
  const active = activePublication(bookId, chapter.id);
  const head = getBookHead(bookId);
  const proposal = db
    .prepare(
      `SELECT id, status FROM memory_proposals
       WHERE book_id = ? AND chapter_id = ? AND status = 'proposed'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(bookId, chapter.id) as { id: string; status: string } | undefined;
  return {
    bookId,
    chapterId: chapter.id,
    chapterNumber: chapter.number,
    storyEpoch: head.storyEpoch,
    factSetVersion: head.factSetVersion,
    currentRevisionId: current,
    publication: active
      ? {
          id: active.id,
          bodyRevisionId: active.bodyRevisionId,
          publicationVersion: active.publicationVersion,
          memoryState: active.memoryState,
          status: "active",
        }
      : null,
    draftDivergesFromPublication: Boolean(
      current && active && current !== active.bodyRevisionId,
    ),
    openProposal: proposal ?? null,
    mode: active ? "published_only" : "legacy_current",
  };
}

export function chapterStoryStatusByNumber(bookId: string, number: number) {
  const chapter = chapterByNumber(bookId, number);
  return chapterStoryStatus(bookId, chapter.id);
}

export function createMemoryProposal(opts: {
  bookId: string;
  chapterNumber: number;
  sourceRevisionId: string;
  summary: string;
  publicationId?: string | null;
  basisEpoch: number;
  operations?: Array<Record<string, unknown>>;
}) {
  mustBook(opts.bookId);
  ensureBookHead(opts.bookId);
  const chapter = chapterByNumber(opts.bookId, opts.chapterNumber);
  assertBodyRevision(opts.bookId, chapter.id, opts.sourceRevisionId);
  if (opts.publicationId) {
    const pub = db
      .prepare(`SELECT body_revision_id AS body, status FROM chapter_publications WHERE id = ? AND book_id = ?`)
      .get(opts.publicationId, opts.bookId) as { body: string; status: string } | undefined;
    if (!pub || pub.status !== "active" || pub.body !== opts.sourceRevisionId) {
      throw new HttpError(409, "PROPOSAL_STALE: 定稿已替换或源修订不匹配");
    }
  }
  const ops = opts.operations?.length
    ? opts.operations
    : [
        {
          operationId: "op-summary",
          kind: "summary_update",
          subjectId: `chapter:${opts.chapterNumber}`,
          field: "chapter_summary",
          proposedValue: { text: opts.summary },
          assertionKind: "explicit",
          evidence: { quote: opts.summary.slice(0, 120) },
          requiresAuthorApproval: true,
        },
      ];
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO memory_proposals
      (id, book_id, chapter_id, publication_id, source_revision_id, basis_epoch,
       schema_version, status, summary, operations_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
  ).run(
    id,
    opts.bookId,
    chapter.id,
    opts.publicationId ?? null,
    opts.sourceRevisionId,
    opts.basisEpoch,
    PROPOSAL_SCHEMA,
    opts.summary,
    JSON.stringify(ops),
    now,
    now,
  );
  if (opts.publicationId) {
    db.prepare(`UPDATE chapter_publications SET memory_state = 'proposed' WHERE id = ? AND status = 'active'`).run(
      opts.publicationId,
    );
    const dedup = `memory_extract:${opts.publicationId}`;
    db.prepare(`UPDATE story_outbox SET status = 'completed', updated_at = ? WHERE book_id = ? AND dedup_key = ?`).run(
      now,
      opts.bookId,
      dedup,
    );
  }
  return {
    id,
    bookId: opts.bookId,
    chapterId: chapter.id,
    chapterNumber: opts.chapterNumber,
    publicationId: opts.publicationId ?? null,
    sourceRevisionId: opts.sourceRevisionId,
    basisEpoch: opts.basisEpoch,
    status: "proposed",
    summary: opts.summary,
    operations: ops,
  };
}

export function getProposal(bookId: string, proposalId: string) {
  mustBook(bookId);
  const row = db
    .prepare(
      `SELECT id, chapter_id AS chapterId, publication_id AS publicationId,
              source_revision_id AS sourceRevisionId, basis_epoch AS basisEpoch,
              status, summary, operations_json AS operationsJson, decision_json AS decisionJson,
              created_at AS createdAt
       FROM memory_proposals WHERE id = ? AND book_id = ?`,
    )
    .get(proposalId, bookId) as
    | {
        id: string;
        chapterId: string;
        publicationId: string | null;
        sourceRevisionId: string;
        basisEpoch: number;
        status: string;
        summary: string;
        operationsJson: string;
        decisionJson: string | null;
        createdAt: string;
      }
    | undefined;
  if (!row) throw new HttpError(404, "提案不存在");
  return {
    id: row.id,
    bookId,
    chapterId: row.chapterId,
    publicationId: row.publicationId,
    sourceRevisionId: row.sourceRevisionId,
    basisEpoch: row.basisEpoch,
    status: row.status,
    summary: row.summary,
    operations: JSON.parse(row.operationsJson || "[]"),
    decision: row.decisionJson ? JSON.parse(row.decisionJson) : null,
    createdAt: row.createdAt,
    schemaVersion: PROPOSAL_SCHEMA,
  };
}

export function applyProposal(input: {
  bookId: string;
  proposalId: string;
  acceptedOperationIds: string[];
  expectedSourceRevisionId: string;
  expectedStoryEpoch?: number | null;
  idempotencyKey: string;
}) {
  mustBook(input.bookId);
  ensureBookHead(input.bookId);
  const fingerprint = {
    op: "apply_proposal",
    bookId: input.bookId,
    proposalId: input.proposalId,
    acceptedOperationIds: input.acceptedOperationIds,
    expectedSourceRevisionId: input.expectedSourceRevisionId,
    expectedStoryEpoch: input.expectedStoryEpoch ?? null,
  };
  const reqHash = hashRequest(fingerprint);
  const prev = lookupIdempotency(input.bookId, input.idempotencyKey);
  if (prev) {
    if (prev.requestHash !== reqHash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED: 同键不同参数");
    return JSON.parse(prev.resultJson);
  }

  const proposal = getProposal(input.bookId, input.proposalId);
  if (proposal.status !== "proposed") {
    throw new HttpError(409, `PROPOSAL_STALE: 提案状态为 ${proposal.status}，不能批准`);
  }
  if (proposal.sourceRevisionId !== input.expectedSourceRevisionId) {
    throw new HttpError(409, "PROPOSAL_STALE: 源修订与预期不符");
  }
  if (proposal.publicationId) {
    const pub = db
      .prepare(`SELECT body_revision_id AS body, status FROM chapter_publications WHERE id = ?`)
      .get(proposal.publicationId) as { body: string; status: string } | undefined;
    if (!pub || pub.status !== "active" || pub.body !== proposal.sourceRevisionId) {
      db.prepare(`UPDATE memory_proposals SET status = 'stale', updated_at = ? WHERE id = ?`).run(
        nowIso(),
        input.proposalId,
      );
      throw new HttpError(409, "PROPOSAL_STALE: 定稿已变化");
    }
  }
  const head = getBookHead(input.bookId);
  if (input.expectedStoryEpoch != null && input.expectedStoryEpoch !== head.storyEpoch) {
    throw new HttpError(409, "STORY_EPOCH_CONFLICT: 故事版本已变化");
  }

  const ops = proposal.operations as Array<Record<string, unknown>>;
  const accepted = ops.filter((op) =>
    input.acceptedOperationIds.includes(String(op.operationId ?? "")),
  );
  if (!accepted.length) throw new HttpError(400, "未选择任何可接受的操作");

  let summaryText = proposal.summary;
  for (const op of accepted) {
    if (op.kind === "summary_update") {
      const text = (op.proposedValue as { text?: string } | undefined)?.text;
      if (typeof text === "string") summaryText = text;
    }
  }

  const chapter = chapterRow(input.bookId, proposal.chapterId);
  const saved = saveRevision({
    bookId: input.bookId,
    kind: "chapter_memory",
    chapterNumber: chapter.number,
    chapterId: chapter.id,
    body: summaryText,
    source: "story_ledger",
    model: "author_accepted",
    skillIds: skillsForScene("memory_extract").map((s) => s.id),
    scene: "memory_extract",
    sourceRevisionId: proposal.sourceRevisionId,
    skipMemory: true,
  });

  const result = db.transaction(() => {
    const now = nowIso();
    const rejected = ops
      .map((op) => String(op.operationId ?? ""))
      .filter((id) => id && !input.acceptedOperationIds.includes(id));
    const decision = {
      acceptedOperationIds: input.acceptedOperationIds,
      rejectedOperationIds: rejected,
      at: now,
    };
    db.prepare(
      `UPDATE memory_proposals SET status = 'accepted', decision_json = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(decision), now, input.proposalId);

    const factSetId = randomUUID();
    const nextVer = head.factSetVersion + 1;
    db.prepare(
      `INSERT INTO story_fact_sets
        (id, book_id, publication_id, source_revision_id, version, status, proposal_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      factSetId,
      input.bookId,
      proposal.publicationId,
      proposal.sourceRevisionId,
      nextVer,
      input.proposalId,
      now,
    );
    const factIdsByOp = new Map<string, string>();
    for (const op of accepted) {
      const factId = randomUUID();
      const opId = String(op.operationId ?? "");
      if (opId) factIdsByOp.set(opId, factId);
      db.prepare(
        `INSERT INTO story_facts
          (id, fact_set_id, book_id, subject, predicate, value_json, evidence_quote,
           source_revision_id, publication_id, effective_from_chapter, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        factId,
        factSetId,
        input.bookId,
        String(op.subjectId ?? ""),
        String(op.field ?? op.kind ?? ""),
        JSON.stringify(op.proposedValue ?? {}),
        String((op.evidence as { quote?: string } | undefined)?.quote ?? ""),
        proposal.sourceRevisionId,
        proposal.publicationId,
        chapter.number,
        now,
      );
    }
    enrichAcceptedOperations({
      bookId: input.bookId,
      factSetId,
      chapterNumber: chapter.number,
      sourceRevisionId: proposal.sourceRevisionId,
      publicationId: proposal.publicationId,
      acceptedOps: accepted,
      factIdsByOp,
    });
    db.prepare(
      `UPDATE story_book_heads SET fact_set_version = ?, story_epoch = story_epoch + 1, updated_at = ? WHERE book_id = ?`,
    ).run(nextVer, now, input.bookId);
    if (proposal.publicationId) {
      db.prepare(`UPDATE chapter_publications SET memory_state = 'ready' WHERE id = ?`).run(proposal.publicationId);
    }
    const newEpoch = (
      db.prepare(`SELECT story_epoch AS e FROM story_book_heads WHERE book_id = ?`).get(input.bookId) as {
        e: number;
      }
    ).e;
    const out = {
      proposalId: input.proposalId,
      status: "accepted",
      factSetId,
      factSetVersion: nextVer,
      storyEpoch: newEpoch,
      memoryRevisionId: saved.revisionId,
      acceptedOperationIds: input.acceptedOperationIds,
      memoryState: "ready",
    };
    storeIdempotency(input.bookId, input.idempotencyKey, reqHash, out);
    return out;
  })();

  return result;
}

export function rejectProposal(bookId: string, proposalId: string, reason?: string | null) {
  mustBook(bookId);
  const row = db
    .prepare(`SELECT status, publication_id AS publicationId FROM memory_proposals WHERE id = ? AND book_id = ?`)
    .get(proposalId, bookId) as { status: string; publicationId: string | null } | undefined;
  if (!row) throw new HttpError(404, "提案不存在");
  if (row.status !== "proposed" && row.status !== "queued") {
    throw new HttpError(409, `PROPOSAL_STALE: 提案状态为 ${row.status}`);
  }
  const now = nowIso();
  db.prepare(
    `UPDATE memory_proposals SET status = 'rejected', decision_json = ?, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify({ rejected: true, reason: reason ?? null, at: now }), now, proposalId);
  if (row.publicationId) {
    db.prepare(
      `UPDATE chapter_publications SET memory_state = 'needs_review' WHERE id = ? AND status = 'active'`,
    ).run(row.publicationId);
  }
  return { proposalId, status: "rejected" };
}

/** Async extract → proposal (does not write chapter_memory). */
export async function schedulePublicationMemoryExtract(
  bookId: string,
  chapterNumber: number,
  sourceRevisionId: string,
) {
  try {
    await new Promise((r) => setTimeout(r, 60));
    const meta = db
      .prepare(
        `SELECT p.id AS publicationId, h.story_epoch AS basisEpoch
         FROM chapter_publications p
         JOIN chapters c ON c.id = p.chapter_id
         JOIN story_book_heads h ON h.book_id = p.book_id
         WHERE p.book_id = ? AND c.number = ? AND p.status = 'active' AND p.body_revision_id = ?`,
      )
      .get(bookId, chapterNumber, sourceRevisionId) as
      | { publicationId: string; basisEpoch: number }
      | undefined;
    if (!meta) return;

    const { executeScene } = await import("./engine");
    // Run extract but we need the text without persisting — use executeScene then
    // if it persisted, we still create proposal from body and that's ok for Node MVP:
    // better: call with a hack via local adapter.
    // Minimal: executeScene writes memory; we then read it, create proposal, and
    // leave chapter_memory only becoming "formal" on accept by overwriting with accepted text.
    // For stricter parity with Rust skip_persist, pass a marker via instruction.
    const result = await executeScene({
      bookId,
      scene: "memory_extract",
      chapterNumber,
      instruction: "",
      sourceRevisionId,
      skipMemory: true,
      skipPersist: true,
    });
    const summary = String((result as { text?: string }).text ?? "").trim();
    if (!summary) {
      db.prepare(`UPDATE chapter_publications SET memory_state = 'failed' WHERE id = ?`).run(meta.publicationId);
      return;
    }
    createMemoryProposal({
      bookId,
      chapterNumber,
      sourceRevisionId,
      summary,
      publicationId: meta.publicationId,
      basisEpoch: meta.basisEpoch,
    });
  } catch (e) {
    console.error("[story] publication memory extract failed", e);
  }
}

export { storyImpact } from "./storyState";
