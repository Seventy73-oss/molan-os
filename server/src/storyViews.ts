/**
 * G5: derived views from the same authority tables (not a second store).
 * Relations / timeline / hooks are projections of story_facts, hook_events,
 * chapter_publications, and bible_cards.
 */
import { db } from "./db";
import { HttpError } from "./httpError";
import { listForeshadowing, listStoryCharacters, projectCharacterState } from "./storyState";

function mustBook(bookId: string) {
  const row = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId) as { id: string } | undefined;
  if (!row) throw new HttpError(404, "书不存在");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { raw };
  }
}

function relationEndpoint(value: unknown): { targetId: string; label: string; raw: unknown } | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t ? { targetId: t, label: "related", raw: value } : null;
  }
  if (typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const targetId = String(o.targetId ?? o.target ?? o.to ?? o.with ?? o.other ?? o.name ?? "").trim();
  if (!targetId) return null;
  const label = String(o.type ?? o.relation ?? o.kind ?? o.label ?? "related");
  return { targetId, label, raw: value };
}

/** Relation graph: nodes + edges from character bible + relation facts. */
export function storyRelationView(bookId: string, asOfChapter: number | null = null) {
  mustBook(bookId);
  const characters = listStoryCharacters(bookId, asOfChapter);
  const nodeMap = new Map<string, { id: string; label: string; kind: string; fromBible: boolean }>();
  for (const c of characters) {
    nodeMap.set(c.id, {
      id: c.id,
      label: c.name || c.id,
      kind: "character",
      fromBible: true,
    });
  }

  const edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    factId: string;
    effectiveFromChapter: number | null;
    evidenceQuote: string;
    sourceRevisionId: string;
  }> = [];

  for (const c of characters) {
    const projected = projectCharacterState(bookId, c.id, asOfChapter, "author");
    const relations = Array.isArray(projected.dynamic?.relations)
      ? (projected.dynamic.relations as unknown[])
      : [];
    // Also walk history for relation facts with provenance
    for (const h of projected.history) {
      if (h.field !== "relation") continue;
      const ep = relationEndpoint(h.value);
      if (!ep) continue;
      if (!nodeMap.has(ep.targetId)) {
        nodeMap.set(ep.targetId, {
          id: ep.targetId,
          label: ep.targetId,
          kind: "character_or_entity",
          fromBible: false,
        });
      }
      edges.push({
        id: String(h.factId),
        source: c.id,
        target: ep.targetId,
        label: ep.label,
        factId: String(h.factId),
        effectiveFromChapter: (h.effectiveFromChapter as number | null) ?? null,
        evidenceQuote: String(h.evidenceQuote ?? ""),
        sourceRevisionId: String(h.sourceRevisionId ?? ""),
      });
    }
    // Ensure dynamic-only relations without history id still appear (fallback)
    for (const rel of relations) {
      const ep = relationEndpoint(rel);
      if (!ep) continue;
      if (!nodeMap.has(ep.targetId)) {
        nodeMap.set(ep.targetId, {
          id: ep.targetId,
          label: ep.targetId,
          kind: "character_or_entity",
          fromBible: false,
        });
      }
      const already = edges.some((e) => e.source === c.id && e.target === ep.targetId && e.label === ep.label);
      if (!already) {
        edges.push({
          id: `dyn:${c.id}:${ep.targetId}:${ep.label}`,
          source: c.id,
          target: ep.targetId,
          label: ep.label,
          factId: "",
          effectiveFromChapter: asOfChapter,
          evidenceQuote: "",
          sourceRevisionId: "",
        });
      }
    }
  }

  return {
    authority: ["bible_cards", "story_facts"] as const,
    derived: true as const,
    asOfChapter,
    nodes: [...nodeMap.values()],
    edges,
    note: "关系图为派生视图；权威在 bible_cards / story_facts，不另建图库。",
  };
}

/** Timeline: narration-order events from publications, hook_events, facts, knowledge. */
export function storyTimelineView(bookId: string, asOfChapter: number | null = null) {
  mustBook(bookId);
  type Ev = {
    id: string;
    chapter: number;
    kind: string;
    title: string;
    detail: string;
    authorityTable: string;
    refs: Record<string, unknown>;
  };
  const events: Ev[] = [];

  const pubs = db
    .prepare(
      `SELECT p.id, p.body_revision_id AS bodyRevisionId, p.publication_version AS publicationVersion,
              p.memory_state AS memoryState, p.accepted_at AS createdAt, c.number AS chapterNumber
       FROM chapter_publications p
       JOIN chapters c ON c.id = p.chapter_id
       WHERE p.book_id = ? AND p.status = 'active'
       ORDER BY c.number ASC`,
    )
    .all(bookId) as Array<{
    id: string;
    bodyRevisionId: string;
    publicationVersion: number;
    memoryState: string;
    createdAt: string;
    chapterNumber: number;
  }>;
  for (const p of pubs) {
    if (asOfChapter != null && p.chapterNumber > asOfChapter) continue;
    events.push({
      id: `pub:${p.id}`,
      chapter: p.chapterNumber,
      kind: "publication",
      title: `第${p.chapterNumber}章定稿 v${p.publicationVersion}`,
      detail: `memory=${p.memoryState}`,
      authorityTable: "chapter_publications",
      refs: { publicationId: p.id, bodyRevisionId: p.bodyRevisionId, memoryState: p.memoryState },
    });
  }

  const hooks = db
    .prepare(
      `SELECT id, hook_stable_id AS hookStableId, event_kind AS eventKind, description,
              planned_payoff_chapter AS plannedPayoffChapter, effective_chapter AS effectiveChapter,
              evidence_quote AS evidenceQuote, source_revision_id AS sourceRevisionId, publication_id AS publicationId
       FROM hook_events WHERE book_id = ? AND status = 'active'
       ORDER BY effective_chapter ASC, created_at ASC`,
    )
    .all(bookId) as Array<{
    id: string;
    hookStableId: string;
    eventKind: string;
    description: string;
    plannedPayoffChapter: number | null;
    effectiveChapter: number;
    evidenceQuote: string;
    sourceRevisionId: string | null;
    publicationId: string | null;
  }>;
  for (const h of hooks) {
    if (asOfChapter != null && h.effectiveChapter > asOfChapter) continue;
    events.push({
      id: `hook:${h.id}`,
      chapter: h.effectiveChapter,
      kind: `foreshadow_${h.eventKind}`,
      title: h.description || h.hookStableId,
      detail:
        h.eventKind === "paid_off"
          ? "已回收"
          : h.plannedPayoffChapter
            ? `计划约第${h.plannedPayoffChapter}章回收（≠已回收）`
            : h.eventKind,
      authorityTable: "hook_events",
      refs: {
        hookStableId: h.hookStableId,
        eventKind: h.eventKind,
        publicationId: h.publicationId,
        sourceRevisionId: h.sourceRevisionId,
        evidenceQuote: h.evidenceQuote,
      },
    });
  }

  const facts = db
    .prepare(
      `SELECT id, subject, predicate, value_json AS valueJson, evidence_quote AS evidenceQuote,
              effective_from_chapter AS effectiveFromChapter, kind, source_revision_id AS sourceRevisionId,
              publication_id AS publicationId
       FROM story_facts WHERE book_id = ? AND status = 'active'
       ORDER BY COALESCE(effective_from_chapter, 0) ASC, created_at ASC`,
    )
    .all(bookId) as Array<{
    id: string;
    subject: string;
    predicate: string;
    valueJson: string;
    evidenceQuote: string;
    effectiveFromChapter: number | null;
    kind: string;
    sourceRevisionId: string;
    publicationId: string | null;
  }>;
  for (const f of facts) {
    const ch = f.effectiveFromChapter ?? 0;
    if (asOfChapter != null && ch > asOfChapter) continue;
    if (f.kind !== "character_state" && f.predicate !== "relation" && f.predicate !== "location") continue;
    events.push({
      id: `fact:${f.id}`,
      chapter: ch,
      kind: `fact_${f.predicate || f.kind}`,
      title: `${f.subject} · ${f.predicate}`,
      detail: JSON.stringify(parseJson(f.valueJson)).slice(0, 200),
      authorityTable: "story_facts",
      refs: {
        factId: f.id,
        publicationId: f.publicationId,
        sourceRevisionId: f.sourceRevisionId,
        evidenceQuote: f.evidenceQuote,
      },
    });
  }

  const knowledge = db
    .prepare(
      `SELECT id, fact_id AS factId, audience, character_id AS characterId, revealed_at_chapter AS revealedAt,
              publication_id AS publicationId
       FROM story_knowledge_events WHERE book_id = ? AND status = 'active'
       ORDER BY revealed_at_chapter ASC, created_at ASC`,
    )
    .all(bookId) as Array<{
    id: string;
    factId: string;
    audience: string;
    characterId: string | null;
    revealedAt: number;
    publicationId: string | null;
  }>;
  for (const k of knowledge) {
    if (asOfChapter != null && k.revealedAt > asOfChapter) continue;
    events.push({
      id: `know:${k.id}`,
      chapter: k.revealedAt,
      kind: "knowledge_reveal",
      title: `揭示给 ${k.audience}${k.characterId ? `/${k.characterId}` : ""}`,
      detail: `fact=${k.factId}`,
      authorityTable: "story_knowledge_events",
      refs: { factId: k.factId, audience: k.audience, characterId: k.characterId, publicationId: k.publicationId },
    });
  }

  events.sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id));

  return {
    authority: ["chapter_publications", "hook_events", "story_facts", "story_knowledge_events"] as const,
    derived: true as const,
    asOfChapter,
    events,
    note: "时间线按章节叙述顺序派生；复杂故事时间未建模。",
  };
}

/** Hook view — same ledger as foreshadowing, labeled as derived view. */
export function storyHookView(bookId: string, asOfChapter: number | null = null) {
  mustBook(bookId);
  const hooks = listForeshadowing(bookId, asOfChapter);
  return {
    authority: ["hook_events"] as const,
    derived: true as const,
    asOfChapter,
    hooks,
    note: "伏笔视图与 /story/foreshadowing 同源；计划回收 ≠ 已回收。",
  };
}
