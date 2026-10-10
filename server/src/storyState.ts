/**
 * G3: character dynamic state, hook events with provenance,
 * author/reader/character knowledge filter, republish impact.
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "./db";
import { HttpError } from "./httpError";

const OVERWRITE_FIELDS = new Set(["location", "injury", "goal"]);
const ACCUMULATE_FIELDS = new Set(["inventory", "relation", "knows_fact"]);
const CHARACTER_STATE_FIELDS = new Set([...OVERWRITE_FIELDS, ...ACCUMULATE_FIELDS]);

function nowIso() {
  return new Date().toISOString();
}

function mustBook(bookId: string) {
  const row = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId) as { id: string } | undefined;
  if (!row) throw new HttpError(404, "书不存在");
}

export type KnowledgeMode = "author" | "reader" | "character";

export type FactRow = {
  id: string;
  subject: string;
  predicate: string;
  valueJson: string;
  evidenceQuote: string;
  sourceRevisionId: string;
  publicationId: string | null;
  effectiveFromChapter: number | null;
  status: string;
  kind: string;
  audience: string;
  characterId: string | null;
};

function listActiveFacts(bookId: string, asOfChapter: number | null): FactRow[] {
  const rows = db
    .prepare(
      `SELECT id, subject, predicate, value_json AS valueJson, evidence_quote AS evidenceQuote,
              source_revision_id AS sourceRevisionId, publication_id AS publicationId,
              effective_from_chapter AS effectiveFromChapter, status,
              COALESCE(kind, 'generic') AS kind,
              COALESCE(audience, 'author') AS audience,
              character_id AS characterId
       FROM story_facts
       WHERE book_id = ? AND status = 'active'
       ORDER BY COALESCE(effective_from_chapter, 0) ASC, created_at ASC`,
    )
    .all(bookId) as FactRow[];
  if (asOfChapter == null) return rows;
  return rows.filter((r) => (r.effectiveFromChapter ?? 0) < asOfChapter);
}

/** Facts visible under knowledge mode (asOf = writing chapter N → history before N). */
export function filterFactsByKnowledge(
  bookId: string,
  facts: FactRow[],
  mode: KnowledgeMode,
  asOfChapter: number | null,
  viewpointCharacterId?: string | null,
): { allowed: FactRow[]; excluded: Array<{ sourceId: string; reason: string }> } {
  const excluded: Array<{ sourceId: string; reason: string }> = [];
  if (mode === "author") {
    return { allowed: facts, excluded };
  }

  const events = db
    .prepare(
      `SELECT fact_id AS factId, audience, character_id AS characterId, revealed_at_chapter AS revealedAt
       FROM story_knowledge_events
       WHERE book_id = ? AND status = 'active'`,
    )
    .all(bookId) as Array<{
    factId: string;
    audience: string;
    characterId: string | null;
    revealedAt: number;
  }>;

  const allowed: FactRow[] = [];
  for (const fact of facts) {
    const audience = fact.audience || "author";
    if (mode === "reader") {
      if (audience === "reader") {
        allowed.push(fact);
        continue;
      }
      const revealed = events.some(
        (e) =>
          e.factId === fact.id &&
          e.audience === "reader" &&
          (asOfChapter == null || e.revealedAt < asOfChapter),
      );
      if (revealed) allowed.push(fact);
      else excluded.push({ sourceId: fact.id, reason: "knowledge_gate" });
      continue;
    }
    // character mode
    const charId = viewpointCharacterId || "";
    if (!charId) {
      excluded.push({ sourceId: fact.id, reason: "knowledge_gate" });
      continue;
    }
    if (fact.characterId === charId && audience !== "author") {
      allowed.push(fact);
      continue;
    }
    const known = events.some(
      (e) =>
        e.factId === fact.id &&
        e.audience === "character" &&
        e.characterId === charId &&
        (asOfChapter == null || e.revealedAt < asOfChapter),
    );
    if (known) allowed.push(fact);
    else excluded.push({ sourceId: fact.id, reason: "knowledge_gate" });
  }
  return { allowed, excluded };
}

export function projectCharacterState(
  bookId: string,
  characterId: string,
  asOfChapter: number | null,
  knowledgeMode: KnowledgeMode = "author",
) {
  mustBook(bookId);
  const facts = listActiveFacts(bookId, asOfChapter).filter(
    (f) => f.subject === characterId && (f.kind === "character_state" || CHARACTER_STATE_FIELDS.has(f.predicate)),
  );
  const { allowed, excluded } = filterFactsByKnowledge(
    bookId,
    facts,
    knowledgeMode,
    asOfChapter,
    characterId,
  );

  const state: Record<string, unknown> = {};
  const inventory: unknown[] = [];
  const relations: unknown[] = [];
  const knows: unknown[] = [];
  const history: Array<Record<string, unknown>> = [];

  for (const f of allowed) {
    let value: unknown = {};
    try {
      value = JSON.parse(f.valueJson || "{}");
    } catch {
      value = { raw: f.valueJson };
    }
    history.push({
      factId: f.id,
      field: f.predicate,
      value,
      effectiveFromChapter: f.effectiveFromChapter,
      evidenceQuote: f.evidenceQuote,
      sourceRevisionId: f.sourceRevisionId,
      audience: f.audience,
    });
    if (OVERWRITE_FIELDS.has(f.predicate)) {
      state[f.predicate] = value;
    } else if (f.predicate === "inventory") {
      inventory.push(value);
      state.inventory = inventory;
    } else if (f.predicate === "relation") {
      relations.push(value);
      state.relations = relations;
    } else if (f.predicate === "knows_fact") {
      knows.push(value);
      state.knows = knows;
    } else {
      state[f.predicate] = value;
    }
  }

  const card = db
    .prepare(
      `SELECT id, name, summary, details FROM bible_cards WHERE id = ? AND book_id = ? AND kind = 'character'`,
    )
    .get(characterId, bookId) as
    | { id: string; name: string; summary: string; details: string }
    | undefined;

  return {
    characterId,
    asOfChapter,
    knowledgeMode,
    static: card
      ? { id: card.id, name: card.name, summary: card.summary, details: card.details }
      : null,
    dynamic: state,
    history,
    excluded,
  };
}

export function listStoryCharacters(bookId: string, asOfChapter: number | null = null) {
  mustBook(bookId);
  const cards = db
    .prepare(
      `SELECT id, name, summary FROM bible_cards WHERE book_id = ? AND kind = 'character' ORDER BY sort_order, name`,
    )
    .all(bookId) as Array<{ id: string; name: string; summary: string }>;

  // Also include subjects from character_state facts not yet in bible
  const subjects = db
    .prepare(
      `SELECT DISTINCT subject FROM story_facts
       WHERE book_id = ? AND status = 'active'
         AND (kind = 'character_state' OR predicate IN ('location','injury','goal','inventory','relation','knows_fact'))`,
    )
    .all(bookId) as Array<{ subject: string }>;

  const byId = new Map(cards.map((c) => [c.id, { ...c, fromBible: true as const }]));
  for (const s of subjects) {
    if (!s.subject || byId.has(s.subject)) continue;
    byId.set(s.subject, {
      id: s.subject,
      name: s.subject,
      summary: "",
      fromBible: true,
    });
  }

  return [...byId.values()].map((c) => {
    const projected = projectCharacterState(bookId, c.id, asOfChapter, "author");
    return {
      id: c.id,
      name: c.name,
      summary: c.summary,
      asOfChapter,
      dynamic: projected.dynamic,
    };
  });
}

export type HookLedgerItem = {
  hookStableId: string;
  description: string;
  status: "planned" | "planted" | "developed" | "paid_off" | "abandoned";
  plannedPayoffChapter: number | null;
  plantedChapter: number | null;
  paidOffChapter: number | null;
  events: Array<{
    id: string;
    eventKind: string;
    effectiveChapter: number;
    evidenceQuote: string;
    sourceRevisionId: string | null;
    publicationId: string | null;
  }>;
};

/** Project foreshadowing as-of chapter (narration order). planned_payoff never auto paid_off. */
export function listForeshadowing(bookId: string, asOfChapter: number | null = null): HookLedgerItem[] {
  mustBook(bookId);
  const rows = db
    .prepare(
      `SELECT id, hook_stable_id AS hookStableId, event_kind AS eventKind, description,
              planned_payoff_chapter AS plannedPayoffChapter,
              source_revision_id AS sourceRevisionId, publication_id AS publicationId,
              evidence_quote AS evidenceQuote, effective_chapter AS effectiveChapter
       FROM hook_events
       WHERE book_id = ? AND status = 'active'
       ORDER BY effective_chapter ASC, created_at ASC`,
    )
    .all(bookId) as Array<{
    id: string;
    hookStableId: string;
    eventKind: string;
    description: string;
    plannedPayoffChapter: number | null;
    sourceRevisionId: string | null;
    publicationId: string | null;
    evidenceQuote: string;
    effectiveChapter: number;
  }>;

  const filtered =
    asOfChapter == null ? rows : rows.filter((r) => r.effectiveChapter < asOfChapter);

  const byHook = new Map<string, HookLedgerItem>();
  for (const r of filtered) {
    let item = byHook.get(r.hookStableId);
    if (!item) {
      item = {
        hookStableId: r.hookStableId,
        description: r.description,
        status: "planned",
        plannedPayoffChapter: r.plannedPayoffChapter,
        plantedChapter: null,
        paidOffChapter: null,
        events: [],
      };
      byHook.set(r.hookStableId, item);
    }
    if (r.description) item.description = r.description;
    if (r.plannedPayoffChapter != null) item.plannedPayoffChapter = r.plannedPayoffChapter;
    item.events.push({
      id: r.id,
      eventKind: r.eventKind,
      effectiveChapter: r.effectiveChapter,
      evidenceQuote: r.evidenceQuote,
      sourceRevisionId: r.sourceRevisionId,
      publicationId: r.publicationId,
    });
    // Apply event — never auto-promote planned_payoff into paid_off
    if (r.eventKind === "planned") item.status = "planned";
    else if (r.eventKind === "planted") {
      item.status = "planted";
      item.plantedChapter = r.effectiveChapter;
    } else if (r.eventKind === "developed") item.status = "developed";
    else if (r.eventKind === "paid_off") {
      item.status = "paid_off";
      item.paidOffChapter = r.effectiveChapter;
    } else if (r.eventKind === "abandoned") item.status = "abandoned";
  }

  // T15: if only planned with future payoff, status stays planned (not paid_off)
  return [...byHook.values()].sort((a, b) =>
    (a.plantedChapter ?? a.plannedPayoffChapter ?? 0) - (b.plantedChapter ?? b.plannedPayoffChapter ?? 0),
  );
}

export function formatCharacterStatesForContext(
  bookId: string,
  asOfChapter: number | null,
  knowledgeMode: KnowledgeMode = "author",
  viewpointCharacterId?: string | null,
): { text: string; included: Array<Record<string, unknown>>; excluded: Array<Record<string, unknown>> } {
  const chars = listStoryCharacters(bookId, asOfChapter);
  const included: Array<Record<string, unknown>> = [];
  const excluded: Array<Record<string, unknown>> = [];
  const lines: string[] = [];

  for (const c of chars) {
    const projected = projectCharacterState(bookId, c.id, asOfChapter, knowledgeMode);
    // Re-filter with viewpoint for character mode
    if (knowledgeMode === "character" && viewpointCharacterId && c.id !== viewpointCharacterId) {
      // Other characters: only show non-secret overwrite fields visible to viewpoint via knowledge events
      const facts = listActiveFacts(bookId, asOfChapter).filter(
        (f) => f.subject === c.id && OVERWRITE_FIELDS.has(f.predicate) && f.audience !== "author",
      );
      const { allowed, excluded: ex } = filterFactsByKnowledge(
        bookId,
        facts,
        "character",
        asOfChapter,
        viewpointCharacterId,
      );
      excluded.push(...ex);
      if (!allowed.length) continue;
      const dyn: Record<string, unknown> = {};
      for (const f of allowed) {
        try {
          dyn[f.predicate] = JSON.parse(f.valueJson);
        } catch {
          dyn[f.predicate] = f.valueJson;
        }
      }
      const parts = Object.entries(dyn).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      lines.push(`${c.name || c.id}：${parts.join("；")}`);
      included.push({ kind: "character_state", sourceId: c.id, reason: "visible_to_viewpoint" });
      continue;
    }

    excluded.push(...projected.excluded.map((e) => ({ ...e, characterId: c.id })));
    const dyn = projected.dynamic;
    if (!dyn || !Object.keys(dyn).length) continue;
    const parts = Object.entries(dyn).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    lines.push(`${projected.static?.name || c.name || c.id}：${parts.join("；")}`);
    included.push({
      kind: "character_state",
      sourceId: c.id,
      reason: knowledgeMode === "author" ? "chapter_participant" : "knowledge_ok",
    });
  }

  return { text: lines.join("\n"), included, excluded };
}

export function formatForeshadowForContext(
  bookId: string,
  asOfChapter: number | null,
): { text: string; included: Array<Record<string, unknown>>; excluded: Array<Record<string, unknown>> } {
  const all = listForeshadowing(bookId, null);
  const included: Array<Record<string, unknown>> = [];
  const excluded: Array<Record<string, unknown>> = [];
  const lines: string[] = [];

  for (const h of all) {
    // Exclude future plant events — asOf filter already in listForeshadowing
    const asOf = listForeshadowing(bookId, asOfChapter).find((x) => x.hookStableId === h.hookStableId);
    if (!asOf) {
      // Exists only via future events or only planned with no plant yet before asOf
      if (h.status === "planned" && h.plannedPayoffChapter != null && asOfChapter != null) {
        // planned-only may appear as author note but T15: must NOT be paid_off
        excluded.push({
          sourceId: h.hookStableId,
          reason: "future_or_unplanted",
          plannedPayoffChapter: h.plannedPayoffChapter,
        });
      } else {
        excluded.push({ sourceId: h.hookStableId, reason: "future_chapter" });
      }
      continue;
    }
    if (asOf.status === "paid_off" || asOf.status === "abandoned") {
      excluded.push({ sourceId: asOf.hookStableId, reason: "already_resolved", status: asOf.status });
      continue;
    }
    if (asOf.status === "planned") {
      // planned does not enter happened-facts context
      excluded.push({ sourceId: asOf.hookStableId, reason: "planned_not_planted" });
      continue;
    }
    lines.push(
      `伏笔[${asOf.status}] ${asOf.description}` +
        (asOf.plannedPayoffChapter ? `（计划约第${asOf.plannedPayoffChapter}章回收，未等于已回收）` : ""),
    );
    included.push({
      kind: "foreshadow",
      sourceId: asOf.hookStableId,
      status: asOf.status,
      reason: "active_foreshadow",
      plantedChapter: asOf.plantedChapter,
      plannedPayoffChapter: asOf.plannedPayoffChapter,
    });
  }

  return { text: lines.join("\n"), included, excluded };
}

/** After inserting story_facts rows for accepted ops, enrich with kind/audience + side tables. */
export function enrichAcceptedOperations(opts: {
  bookId: string;
  factSetId: string;
  chapterNumber: number;
  sourceRevisionId: string;
  publicationId: string | null;
  acceptedOps: Array<Record<string, unknown>>;
  factIdsByOp: Map<string, string>;
}) {
  const now = nowIso();
  for (const op of opts.acceptedOps) {
    const opId = String(op.operationId ?? "");
    const factId = opts.factIdsByOp.get(opId);
    if (!factId) continue;
    const kind = String(op.kind ?? "");
    const field = String(op.field ?? "");
    const subject = String(op.subjectId ?? "");
    const audience = String(op.audience ?? (kind === "character_state_change" && field === "knows_fact" ? "author" : "author"));
    const characterId =
      typeof op.characterId === "string"
        ? op.characterId
        : kind === "character_state_change"
          ? subject
          : null;

    let factKind = "generic";
    if (kind === "character_state_change" || CHARACTER_STATE_FIELDS.has(field)) factKind = "character_state";
    if (kind.startsWith("foreshadow_")) factKind = "foreshadow";
    if (kind === "summary_update") factKind = "summary";

    db.prepare(
      `UPDATE story_facts SET kind = ?, audience = ?, character_id = ?, predicate = COALESCE(NULLIF(predicate,''), ?)
       WHERE id = ?`,
    ).run(factKind, audience, characterId, field || kind, factId);

    // Knowledge events
    const audiences: Array<{ audience: KnowledgeMode; characterId: string | null }> = [];
    if (audience === "reader") audiences.push({ audience: "reader", characterId: null });
    else if (audience === "character") audiences.push({ audience: "character", characterId: characterId });
    else audiences.push({ audience: "author", characterId: null });
    // Explicit reveal lists
    if (Array.isArray(op.revealTo)) {
      for (const r of op.revealTo as Array<Record<string, unknown>>) {
        const a = String(r.audience ?? "") as KnowledgeMode;
        if (a === "reader" || a === "character" || a === "author") {
          audiences.push({
            audience: a,
            characterId: typeof r.characterId === "string" ? r.characterId : null,
          });
        }
      }
    }
    for (const a of audiences) {
      db.prepare(
        `INSERT INTO story_knowledge_events
          (id, book_id, fact_id, audience, character_id, revealed_at_chapter,
           source_revision_id, publication_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        randomUUID(),
        opts.bookId,
        factId,
        a.audience,
        a.characterId,
        opts.chapterNumber,
        opts.sourceRevisionId,
        opts.publicationId,
        now,
      );
    }

    // Hook events with provenance
    if (kind.startsWith("foreshadow_") || kind === "foreshadow_planted" || kind === "foreshadow_paid_off") {
      const eventKind = kind.replace("foreshadow_", "") as string;
      const normalized =
        eventKind === "planted" ||
        eventKind === "developed" ||
        eventKind === "paid_off" ||
        eventKind === "abandoned" ||
        eventKind === "planned"
          ? eventKind
          : "planted";
      const proposed = (op.proposedValue as Record<string, unknown> | undefined) ?? {};
      const description = String(proposed.description ?? (op.evidence as { quote?: string } | undefined)?.quote ?? subject);
      const plannedPayoff =
        typeof proposed.plannedPayoffChapter === "number"
          ? proposed.plannedPayoffChapter
          : typeof op.plannedPayoffChapter === "number"
            ? op.plannedPayoffChapter
            : null;
      const hookStableId = subject || `hook:${opts.chapterNumber}:${description.slice(0, 40)}`;
      db.prepare(
        `INSERT INTO hook_events
          (id, book_id, hook_stable_id, event_kind, description, planned_payoff_chapter,
           source_revision_id, publication_id, evidence_quote, effective_chapter, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        randomUUID(),
        opts.bookId,
        hookStableId,
        normalized,
        description,
        plannedPayoff,
        opts.sourceRevisionId,
        opts.publicationId,
        String((op.evidence as { quote?: string } | undefined)?.quote ?? ""),
        opts.chapterNumber,
        now,
      );
      // Project to hook_marks for legacy UI (paid_off → recycled; never from planned alone)
      if (normalized === "paid_off") {
        const hookKey = hookStableId.includes(":") ? hookStableId : `${opts.chapterNumber}:${description.slice(0, 120)}`;
        const existing = db
          .prepare(`SELECT id FROM hook_marks WHERE book_id = ? AND hook_key = ?`)
          .get(opts.bookId, hookKey) as { id: string } | undefined;
        if (existing) {
          db.prepare(
            `UPDATE hook_marks SET status = 'recycled', recycled_chapter = ?, note = ?, updated_at = ? WHERE id = ?`,
          ).run(opts.chapterNumber, `from hook_events ${normalized}`, now, existing.id);
        } else {
          db.prepare(
            `INSERT INTO hook_marks (id, book_id, hook_key, status, recycled_chapter, note, updated_at)
             VALUES (?, ?, ?, 'recycled', ?, ?, ?)`,
          ).run(randomUUID(), opts.bookId, hookKey, opts.chapterNumber, `from hook_events ${normalized}`, now);
        }
      }
    }
  }
}

export function invalidateKnowledgeAndHooksForPublication(publicationId: string) {
  const now = nowIso();
  db.prepare(
    `UPDATE story_knowledge_events SET status = 'invalidated' WHERE publication_id = ? AND status = 'active'`,
  ).run(publicationId);
  db.prepare(
    `UPDATE hook_events SET status = 'invalidated' WHERE publication_id = ? AND status = 'active'`,
  ).run(publicationId);
  void now;
}

export function storyImpact(bookId: string, chapterId: string) {
  mustBook(bookId);
  const chapter = db
    .prepare(`SELECT id, number FROM chapters WHERE id = ? AND book_id = ?`)
    .get(chapterId, bookId) as { id: string; number: number } | undefined;
  if (!chapter) throw new HttpError(404, "章节不存在");

  const pub = db
    .prepare(
      `SELECT id, body_revision_id AS bodyRevisionId, publication_version AS publicationVersion, memory_state AS memoryState
       FROM chapter_publications WHERE book_id = ? AND chapter_id = ? AND status = 'active'`,
    )
    .get(bookId, chapterId) as
    | { id: string; bodyRevisionId: string; publicationVersion: number; memoryState: string }
    | undefined;

  const factsWouldInvalidate = pub
    ? (db
        .prepare(
          `SELECT id, subject, predicate, effective_from_chapter AS effectiveFromChapter, kind
           FROM story_facts WHERE publication_id = ? AND status = 'active'`,
        )
        .all(pub.id) as Array<Record<string, unknown>>)
    : [];

  const hookEventsWouldInvalidate = pub
    ? (db
        .prepare(
          `SELECT id, hook_stable_id AS hookStableId, event_kind AS eventKind, effective_chapter AS effectiveChapter
           FROM hook_events WHERE publication_id = ? AND status = 'active'`,
        )
        .all(pub.id) as Array<Record<string, unknown>>)
    : [];

  const subsequentPublications = db
    .prepare(
      `SELECT p.id AS publicationId, c.number AS chapterNumber, p.memory_state AS memoryState
       FROM chapter_publications p
       JOIN chapters c ON c.id = p.chapter_id
       WHERE p.book_id = ? AND p.status = 'active' AND c.number > ?
       ORDER BY c.number`,
    )
    .all(bookId, chapter.number) as Array<{
    publicationId: string;
    chapterNumber: number;
    memoryState: string;
  }>;

  const pendingProposals = db
    .prepare(
      `SELECT id, status, source_revision_id AS sourceRevisionId
       FROM memory_proposals
       WHERE book_id = ? AND chapter_id = ? AND status IN ('proposed', 'queued', 'extracting')`,
    )
    .all(bookId, chapterId) as Array<Record<string, unknown>>;

  const currentBody = db
    .prepare(
      `SELECT a.current_revision_id AS id FROM artifacts a
       WHERE a.book_id = ? AND a.chapter_id = ? AND a.kind = 'chapter_body'`,
    )
    .get(bookId, chapterId) as { id: string | null } | undefined;

  return {
    bookId,
    chapterId,
    chapterNumber: chapter.number,
    activePublication: pub
      ? {
          id: pub.id,
          bodyRevisionId: pub.bodyRevisionId,
          publicationVersion: pub.publicationVersion,
          memoryState: pub.memoryState,
        }
      : null,
    currentBodyRevisionId: currentBody?.id ?? null,
    draftDiverges: Boolean(pub && currentBody?.id && currentBody.id !== pub.bodyRevisionId),
    wouldInvalidate: {
      facts: factsWouldInvalidate,
      hookEvents: hookEventsWouldInvalidate,
      knowledgeEvents: pub
        ? (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM story_knowledge_events WHERE publication_id = ? AND status = 'active'`,
              )
              .get(pub.id) as { n: number }
          ).n
        : 0,
    },
    subsequentChaptersPossiblyStale: subsequentPublications,
    pendingProposals,
    note: "替换定稿会立即失效本章旧来源事实/钩子事件；不会自动改写后章正文。后章仅标记可能需复核。",
    autoRewriteSubsequentBodies: false,
  };
}

export function snapshotBibleCard(card: {
  id: string;
  bookId: string;
  kind: string;
  name: string;
  summary: string;
  details: string;
}) {
  const content = `${card.kind}\n${card.name}\n${card.summary}\n${card.details}`;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  db.prepare(
    `INSERT INTO bible_card_revisions
      (id, card_id, book_id, content_hash, kind, name, summary, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    card.id,
    card.bookId,
    hash,
    card.kind,
    card.name,
    card.summary,
    card.details,
    nowIso(),
  );
  return hash;
}
