import { createHash, randomUUID } from "node:crypto";
import { db } from "./db";
import { formatBibleForContext, formatMemoriesForContextParts, listBibleCards } from "./features";
import { formatOpenHooksForContext, listHooks } from "./hooks";
import {
  formatCharacterStatesForContext,
  formatForeshadowForContext,
  type KnowledgeMode,
} from "./storyState";

const MODE = "legacy_current";

export type ContextManifest = {
  mode: string;
  chapterNumber: number | null;
  scene?: string | null;
  included: Array<Record<string, unknown>>;
  excluded: Array<Record<string, unknown>>;
  missing: string[];
  counts: { bibleCards: number; memories: number; openHooks: number };
  note: string;
};

export function missingContextHints(
  bibleCount: number,
  memoryCount: number,
  openHookCount: number,
  chapterNumber: number | null,
): string[] {
  const missing: string[] = [];
  if (bibleCount === 0) missing.push("设定卡为空：生成时缺少人物/物件/地点约束");
  if (chapterNumber && chapterNumber > 1 && memoryCount === 0) {
    missing.push("前文记忆缺失或源版本不匹配：续写可能丢连续性");
  }
  if (openHookCount > 0) missing.push(`有 ${openHookCount} 条未回收钩子待接住`);
  return missing;
}

export function buildContextManifest(
  bookId: string,
  chapterNumber: number | null,
  scene?: string | null,
): {
  bible: string;
  memories: string;
  openHooks: string;
  manifest: ContextManifest;
} {
  const knowledgeMode: KnowledgeMode = "author";
  const bible = formatBibleForContext(bookId);
  const memParts = formatMemoriesForContextParts(bookId, chapterNumber);
  const openHooks = formatOpenHooksForContext(bookId, chapterNumber);
  const charParts = formatCharacterStatesForContext(bookId, chapterNumber, knowledgeMode);
  const foreshadowParts = formatForeshadowForContext(bookId, chapterNumber);
  const cards = listBibleCards(bookId);
  const openHookItems = listHooks(bookId).filter((h) => {
    if (!(h.warning || h.status === "open")) return false;
    if (chapterNumber) return h.fromChapter < chapterNumber;
    return true;
  });
  const included: Array<Record<string, unknown>> = [
    ...cards.map((c) => ({
      kind: "bible_card",
      sourceId: c.id,
      cardKind: c.kind,
      name: c.name,
      reason: "book_bible",
    })),
    ...memParts.included,
    ...charParts.included,
    ...foreshadowParts.included,
    ...openHookItems.map((h) => ({
      kind: "open_hook",
      sourceId: h.key,
      fromChapter: h.fromChapter,
      reason: "active_hook",
      qualification: "legacy_unverified",
    })),
  ];
  const missing = missingContextHints(cards.length, memParts.included.length, openHookItems.length, chapterNumber);
  const manifest: ContextManifest = {
    mode: MODE,
    chapterNumber,
    scene: scene ?? null,
    included,
    excluded: [...memParts.excluded, ...charParts.excluded, ...foreshadowParts.excluded],
    missing,
    counts: {
      bibleCards: cards.length,
      memories: memParts.included.length,
      openHooks: openHookItems.length,
    },
    note: "G3：作者模式注入人物动态与有来源伏笔；知识门控排除未揭示秘密；计划回收≠已回收",
  };
  const openHooksMerged = [openHooks, foreshadowParts.text].filter(Boolean).join("\n");
  const bibleMerged = [bible, charParts.text ? `【人物动态】\n${charParts.text}` : ""].filter(Boolean).join("\n");
  return { bible: bibleMerged, memories: memParts.text, openHooks: openHooksMerged, manifest };
}

export function saveContextSnapshot(input: {
  bookId: string;
  scene?: string | null;
  chapterNumber: number | null;
  renderedText: string;
  manifest: ContextManifest;
  generationId?: string | null;
}): { id: string; hash: string } {
  const id = randomUUID();
  const hash = createHash("sha256").update(input.renderedText, "utf8").digest("hex");
  db.prepare(
    `INSERT INTO context_snapshots
     (id, book_id, scene, chapter_number, mode, rendered_text, rendered_hash, manifest_json, generation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.bookId,
    input.scene ?? "",
    input.chapterNumber,
    MODE,
    input.renderedText,
    hash,
    JSON.stringify(input.manifest),
    input.generationId ?? null,
    new Date().toISOString(),
  );
  return { id, hash };
}

export function previewContext(bookId: string, chapterNumber: number | null) {
  const { bible, memories, openHooks, manifest } = buildContextManifest(bookId, chapterNumber, "preview");
  return {
    mode: MODE,
    chapterNumber,
    missing: manifest.missing,
    manifest,
    sections: { bible, memories, openHooks },
  };
}
