export type Book = {
  id: string;
  title: string;
  genre: string;
  logline: string;
  style: string;
  targetChapters: number;
  wordsPerChapter: number;
  createdAt: string;
  chapterCount: number;
  draftedCount: number;
  words?: number;
  targetWords?: number;
};

export type Chapter = { id: string; number: number; title: string; status: string; words?: number };

export type Artifact = {
  id: string;
  kind: string;
  chapterId: string | null;
  chapterNumber: number | null;
  revision: number;
  revisionId?: string | null;
  body: string;
  source: string | null;
  model: string | null;
  skillIds: string[];
  scene: string | null;
  createdAt: string | null;
};

export type BookProgress = {
  chapterCount: number;
  draftedCount: number;
  words: number;
  targetWords: number;
  targetChapters: number;
  wordsPerChapter: number;
  chapters: { number: number; title: string; status: string; words: number; target: number }[];
};

export type BookPayload = { book: Book; chapters: Chapter[]; artifacts: Artifact[]; progress?: BookProgress };

export type RevisionMeta = {
  id: string;
  revision: number;
  source: string;
  model: string | null;
  scene: string | null;
  createdAt: string;
  chars: number;
  isCurrent: boolean;
};

export type SearchHit = {
  kind: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  title: string;
  snippet: string;
  index: number;
};

export type BibleCard = {
  id: string;
  bookId: string;
  kind: string;
  name: string;
  summary: string;
  details: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ReviewIssue = { index: number; type: string; cite: string; text: string };

export type Skill = {
  id: string;
  name: string;
  scene: string;
  role: string;
  path: string;
  enabled: boolean;
  description: string;
  body: string;
  /** User distillation pack (stage-primary). */
  userPack?: boolean;
  /** Extra scenes this pack auto-attaches to (in addition to home `scene`). */
  attachScenes?: string[];
};

export type ThinkingIntensity = "off" | "low" | "medium" | "high";

export type Route = {
  scene: string;
  provider: string;
  modelId: string;
  baseUrl: string | null;
  thinkingIntensity?: ThinkingIntensity;
};

export const THINKING_OPTIONS: { value: ThinkingIntensity; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

export function thinkingLabel(level?: string | null): string {
  const hit = THINKING_OPTIONS.find((o) => o.value === level);
  return hit?.label ?? "中";
}

export type ProviderSettings = {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  defaultModel: string;
  chatModel: string;
  configured: boolean;
  keySource?: "none" | "env" | "stored";
};

export type ModelInfo = { id: string; ownedBy?: string };

export type ModelsList = {
  models: ModelInfo[];
  fetchedAt: string | null;
  error?: string;
};

export type AgentCapability = {
  id: string;
  label: string;
  available: boolean;
  reason: string;
  packageName?: string;
};

export type AgentRuntimeInfo = {
  capabilities: AgentCapability[];
  envRuntime: string | null;
  note: string;
  pi?: { mode: string; autonomous: boolean; toolsSupported: boolean; note: string };
};

export type ChatMessage = {
  id: string;
  role: string;
  content: string;
  meta: { scene?: string | null; modelUsed?: string; saved?: Saved | null } | null;
  createdAt: string;
};

export type Saved = {
  kind: string;
  revision: number;
  revisionId?: string;
  artifactId?: string;
  chapterId?: string | null;
  chapterNumber: number | null;
  current?: boolean;
};

export type WritingJob = {
  id: string;
  bookId: string;
  status: string;
  fromChapter: number;
  toChapter: number;
  currentChapter: number;
  currentStage: string;
  error: string | null;
  createdAt: string;
  autoReview?: boolean;
  maxRetries?: number;
  retryCount?: number;
  log?: { at: string; stage: string; chapter: number; message: string }[];
};

export type HookItem = {
  key: string;
  fromChapter: number;
  fromTitle: string;
  text: string;
  source: "memory" | "outline" | string;
  status: "open" | "recycled" | "marked" | string;
  recycledIn: number | null;
  warning: boolean;
};

export type UsageSummary = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  localCalls: number;
  byModel: { model: string; calls: number; totalTokens: number; estimatedCost: number }[];
  byBook: { bookId: string | null; title: string; calls: number; totalTokens: number; estimatedCost: number }[];
};

export type UsageEntry = {
  id: string;
  bookId: string | null;
  scene: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  local: boolean;
  createdAt: string;
};

export type SceneRunResult = {
  text: string;
  modelUsed: string;
  skills: { id: string; name: string; role: string }[];
  saved: Saved | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data as T;
}

export const api = {
  books: () => request<{ books: Book[] }>("/api/books"),
  deleteBook: (id: string) => request<{ ok: boolean }>(`/api/books/${id}`, { method: "DELETE" }),
  readArtifactFile: (id: string, kind: string, chapterNumber: number | null) =>
    request<{ kind: string; chapterNumber: number | null; body: string }>(
      `/api/books/${id}/artifacts/file?kind=${encodeURIComponent(kind)}&chapterNumber=${chapterNumber ?? ""}`,
    ),
  exportBookUrl: (id: string) => `/api/books/${id}/export.zip`,
  exportChapterUrl: (id: string, number: number) => `/api/books/${id}/chapters/${number}/export.zip`,
  book: (id: string) => request<BookPayload>(`/api/books/${id}`),
  createBook: (body: { title: string; genre: string; logline: string }) =>
    request<BookPayload>("/api/books", { method: "POST", body: JSON.stringify(body) }),
  autoSetup: (brief: string) =>
    request<BookPayload & { modelUsed: string }>("/api/books/auto-setup", {
      method: "POST",
      body: JSON.stringify({ brief }),
    }),
  saveArtifact: (
    id: string,
    body: {
      kind: string;
      chapterNumber: number | null;
      body: string;
      source: "human" | "agent";
      scene: string;
      skillIds: string[];
      model: string;
      expectedRevisionId?: string | null;
      chapterId?: string | null;
    },
  ) => request<Saved>(`/api/books/${id}/artifacts`, { method: "PUT", body: JSON.stringify(body) }),
  getGeneration: (generationId: string) =>
    request<{
      id: string;
      status: string;
      result: unknown;
      error: string | null;
      resultRevisionId?: string | null;
      revert?: {
        demoted: boolean;
        orphanRevisionId: string | null;
        restoredRevisionId: string | null;
        artifactId: string | null;
      } | null;
      alreadyTerminal?: boolean;
      accepted?: boolean;
      previousRevisionId?: string | null;
      note?: string | null;
    }>(`/api/generations/${generationId}`),
  cancelGeneration: (generationId: string) =>
    request<{
      id: string;
      status: string;
      result: unknown;
      error: string | null;
      resultRevisionId?: string | null;
      revert?: {
        demoted: boolean;
        orphanRevisionId: string | null;
        restoredRevisionId: string | null;
        artifactId: string | null;
      } | null;
      alreadyTerminal?: boolean;
      accepted?: boolean;
      previousRevisionId?: string | null;
      note?: string | null;
    }>(`/api/generations/${generationId}/cancel`, { method: "POST", body: "{}" }),
  sceneRun: (
    id: string,
    body: { scene: string; chapterNumber: number | null; instruction: string; skillIds?: string[] },
  ) =>
    request<{ text: string; modelUsed: string; skills: { id: string; name: string; role: string }[]; saved: Saved | null }>(
      `/api/books/${id}/scene-runs`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  chat: (id: string, message: string, chapterNumber?: number | null) =>
    request<{ message: ChatMessage; saved: Saved | null }>(`/api/books/${id}/chat`, {
      method: "POST",
      body: JSON.stringify({ message, chapterNumber: chapterNumber ?? null }),
    }),
  addChapter: (id: string, title?: string) =>
    request<BookPayload>(`/api/books/${id}/chapters`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  renameChapter: (id: string, number: number, title: string) =>
    request<BookPayload>(`/api/books/${id}/chapters/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteChapter: (id: string, number: number) =>
    request<BookPayload>(`/api/books/${id}/chapters/${number}`, { method: "DELETE" }),
  rewriteSelection: (
    id: string,
    body: { selection: string; instruction: string; scene?: string },
  ) =>
    request<{ text: string; modelUsed: string; local?: boolean }>(`/api/books/${id}/selection-rewrite`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  messages: (id: string) => request<{ messages: ChatMessage[] }>(`/api/books/${id}/messages`),
  skills: () => request<{ skills: Skill[] }>("/api/skills"),
  skillsForScene: (scene: string) =>
    request<{
      scene: string;
      autoAttachUserPacks: string[];
      skills: Array<Pick<Skill, "id" | "name" | "scene" | "role" | "enabled" | "userPack" | "attachScenes">>;
    }>(`/api/skills/for-scene?scene=${encodeURIComponent(scene)}`),
  patchSkill: (id: string, enabled: boolean) =>
    request<Skill>(`/api/skills/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  reloadSkills: () => request<{ skills: Skill[] }>("/api/skills/reload", { method: "POST" }),
  routes: () => request<{ routes: Route[] }>("/api/scene-routes"),
  saveRoutes: (routes: Route[]) =>
    request<{ routes: Route[] }>("/api/scene-routes", { method: "PUT", body: JSON.stringify({ routes }) }),
  provider: () => request<ProviderSettings>("/api/settings/provider"),
  saveProvider: (body: { baseUrl?: string; apiKey?: string; defaultModel?: string; chatModel?: string; clearApiKey?: boolean }) =>
    request<ProviderSettings>("/api/settings/provider", { method: "PUT", body: JSON.stringify(body) }),
  testProvider: (body: { baseUrl?: string; apiKey?: string; model?: string }) =>
    request<{ ok: boolean; model: string; error?: string }>("/api/settings/provider/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  providerModels: () => request<ModelsList>("/api/settings/provider/models"),
  refreshProviderModels: () =>
    request<ModelsList>("/api/settings/provider/models/refresh", { method: "POST", body: "{}" }),
  jobs: (id: string) => request<{ jobs: WritingJob[] }>(`/api/books/${id}/jobs`),
  createJob: (
    id: string,
    body?: { fromChapter?: number; toChapter?: number; autoReview?: boolean; maxRetries?: number },
  ) => request<WritingJob>(`/api/books/${id}/jobs`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  getJob: (jobId: string) => request<WritingJob>(`/api/jobs/${jobId}`),
  tickJob: (jobId: string) => request<{ job: WritingJob; advanced: boolean }>(`/api/jobs/${jobId}/tick`, { method: "POST", body: "{}" }),
  patchJob: (jobId: string, status: string) =>
    request<WritingJob>(`/api/jobs/${jobId}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  agentRuntime: () => request<AgentRuntimeInfo>("/api/agent/runtime"),
  progress: (id: string) => request<BookProgress>(`/api/books/${id}/progress`),
  search: (id: string, q: string) =>
    request<{ query: string; hits: SearchHit[] }>(`/api/books/${id}/search?q=${encodeURIComponent(q)}`),
  revisions: (id: string, kind: string, chapterNumber: number | null) =>
    request<{ revisions: RevisionMeta[] }>(
      `/api/books/${id}/artifacts/revisions?kind=${encodeURIComponent(kind)}&chapterNumber=${chapterNumber ?? ""}`,
    ),
  revisionDiff: (id: string, revId: string, against?: string | null) =>
    request<{
      kind: string;
      chapterNumber: number | null;
      leftRevision: number | null;
      rightRevision: number;
      leftChars: number;
      rightChars: number;
      hunks: { type: "same" | "add" | "del"; text: string }[];
      leftBody: string;
      rightBody: string;
    }>(
      `/api/books/${id}/artifacts/revisions/${revId}/diff${against ? `?against=${encodeURIComponent(against)}` : ""}`,
    ),
  restoreRevision: (id: string, revId: string) =>
    request<{ saved: Saved; body: { body: string; kind: string; chapterNumber: number | null } }>(
      `/api/books/${id}/artifacts/revisions/${revId}/restore`,
      { method: "POST", body: "{}" },
    ),
  reviewIssues: (id: string, chapterNumber: number) =>
    request<{ chapterNumber: number; issues: ReviewIssue[]; body: string }>(
      `/api/books/${id}/review-issues?chapterNumber=${chapterNumber}`,
    ),
  bible: (id: string) => request<{ cards: BibleCard[] }>(`/api/books/${id}/bible`),
  createBible: (id: string, body: { kind: string; name: string; summary?: string; details?: string }) =>
    request<BibleCard>(`/api/books/${id}/bible`, { method: "POST", body: JSON.stringify(body) }),
  updateBible: (
    id: string,
    cardId: string,
    body: { kind?: string; name?: string; summary?: string; details?: string; sortOrder?: number },
  ) => request<BibleCard>(`/api/books/${id}/bible/${cardId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteBible: (id: string, cardId: string) =>
    request<{ ok: boolean }>(`/api/books/${id}/bible/${cardId}`, { method: "DELETE" }),
  updateBook: (
    id: string,
    body: {
      title?: string;
      genre?: string;
      logline?: string;
      style?: string;
      targetChapters?: number;
      wordsPerChapter?: number;
      confirmTrim?: boolean;
    },
  ) => request<BookPayload>(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  importBook: async (file: File, conflict: "new_book" | "overwrite" | "skip" = "new_book", title?: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("conflict", conflict);
    if (title) form.append("title", title);
    const res = await fetch("/api/books/import", { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error || `导入失败 (${res.status})`);
    return data as {
      bookId: string;
      title: string;
      conflict: string;
      reused: boolean;
      skipped: boolean;
      imported: { kind: string; chapterNumber: number | null; path: string }[];
      chapters: number;
      book: BookPayload;
    };
  },
  hooks: (id: string) => request<{ hooks: HookItem[] }>(`/api/books/${id}/hooks`),
  storyHead: (id: string) => request<{ bookId: string; storyEpoch: number; factSetVersion: number }>(`/api/books/${id}/story/head`),
  storyStatus: (id: string, chapterNumber: number) =>
    request<{
      chapterId: string;
      chapterNumber: number;
      storyEpoch: number;
      currentRevisionId: string | null;
      publication: null | {
        id: string;
        bodyRevisionId: string;
        publicationVersion: number;
        memoryState: string;
      };
      draftDivergesFromPublication: boolean;
      openProposal: null | { id: string; status: string };
      mode: string;
    }>(`/api/books/${id}/story/status?chapterNumber=${chapterNumber}`),
  finalizeChapter: (
    id: string,
    chapterId: string,
    body: {
      bodyRevisionId: string;
      expectedPublicationId: string | null;
      expectedCurrentRevisionId?: string | null;
      expectedStoryEpoch?: number | null;
      idempotencyKey: string;
    },
  ) =>
    request<{
      publicationId: string;
      storyEpoch: number;
      memoryState: string;
      bodyRevisionId: string;
    }>(`/api/books/${id}/story/chapters/${chapterId}/finalize`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getMemoryProposal: (id: string, proposalId: string) =>
    request<{
      id: string;
      status: string;
      summary: string;
      sourceRevisionId: string;
      operations: Array<{ operationId: string; kind: string; proposedValue?: { text?: string } }>;
    }>(`/api/books/${id}/story/memory/proposals/${proposalId}`),
  applyMemoryProposal: (
    id: string,
    proposalId: string,
    body: {
      acceptedOperationIds: string[];
      expectedSourceRevisionId: string;
      expectedStoryEpoch?: number | null;
      idempotencyKey: string;
    },
  ) =>
    request<{ status: string; memoryState: string; storyEpoch: number }>(
      `/api/books/${id}/story/memory/proposals/${proposalId}/apply`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  rejectMemoryProposal: (id: string, proposalId: string, reason?: string) =>
    request<{ status: string }>(`/api/books/${id}/story/memory/proposals/${proposalId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  contextPreview: (id: string, chapterNumber?: number | null) =>
    request<{
      mode: string;
      chapterNumber: number | null;
      missing: string[];
      manifest: { counts: { bibleCards: number; memories: number; openHooks: number }; missing: string[] };
      sections: { bible: string; memories: string; openHooks: string };
    }>(
      `/api/books/${id}/context-preview${
        chapterNumber ? `?chapterNumber=${encodeURIComponent(String(chapterNumber))}` : ""
      }`,
    ),
  storyCharacters: (id: string, asOfChapter?: number | null) =>
    request<{ characters: Array<{ id: string; name: string; summary: string; dynamic: Record<string, unknown> }> }>(
      `/api/books/${id}/story/characters${asOfChapter ? `?asOfChapter=${asOfChapter}` : ""}`,
    ),
  storyCharacterState: (
    id: string,
    characterId: string,
    opts?: { asOfChapter?: number | null; knowledgeMode?: string },
  ) => {
    const q = new URLSearchParams();
    if (opts?.asOfChapter) q.set("asOfChapter", String(opts.asOfChapter));
    if (opts?.knowledgeMode) q.set("knowledgeMode", opts.knowledgeMode);
    const qs = q.toString();
    return request<{
      characterId: string;
      asOfChapter: number | null;
      knowledgeMode: string;
      static: { id: string; name: string; summary: string; details: string } | null;
      dynamic: Record<string, unknown>;
      history: Array<Record<string, unknown>>;
      excluded: Array<{ sourceId: string; reason: string }>;
    }>(`/api/books/${id}/story/characters/${encodeURIComponent(characterId)}/state${qs ? `?${qs}` : ""}`);
  },
  storyForeshadowing: (id: string, asOfChapter?: number | null) =>
    request<{
      hooks: Array<{
        hookStableId: string;
        description: string;
        status: string;
        plannedPayoffChapter: number | null;
        plantedChapter: number | null;
        paidOffChapter: number | null;
        events: Array<Record<string, unknown>>;
      }>;
    }>(`/api/books/${id}/story/foreshadowing${asOfChapter ? `?asOfChapter=${asOfChapter}` : ""}`),
  storyImpact: (id: string, opts: { chapterId?: string; chapterNumber?: number }) => {
    const q = new URLSearchParams();
    if (opts.chapterId) q.set("chapterId", opts.chapterId);
    if (opts.chapterNumber) q.set("chapterNumber", String(opts.chapterNumber));
    return request<{
      chapterNumber: number;
      draftDiverges: boolean;
      wouldInvalidate: { facts: unknown[]; hookEvents: unknown[]; knowledgeEvents: number };
      subsequentChaptersPossiblyStale: Array<{ chapterNumber: number; memoryState: string }>;
      note: string;
      autoRewriteSubsequentBodies: boolean;
    }>(`/api/books/${id}/story/impact?${q.toString()}`);
  },
  markHook: (
    id: string,
    body: { key: string; status: string; recycledChapter?: number | null; note?: string },
  ) => request<{ hook: HookItem | null; hooks: HookItem[] }>(`/api/books/${id}/hooks`, { method: "PATCH", body: JSON.stringify(body) }),
  usage: (bookId?: string) =>
    request<{ entries: UsageEntry[]; summary: UsageSummary }>(
      bookId ? `/api/books/${bookId}/usage` : "/api/usage",
    ),
  usageSummary: (bookId?: string) =>
    request<UsageSummary>(`/api/usage/summary${bookId ? `?bookId=${encodeURIComponent(bookId)}` : ""}`),
  retryJob: (jobId: string) => request<WritingJob>(`/api/jobs/${jobId}/retry`, { method: "POST", body: "{}" }),
};

async function postStream(
  path: string,
  body: unknown,
  onEvent: (event: { type: string; text?: string; message?: string; payload?: unknown }) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  const { readSse } = await import("./lib/reveal");
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  let donePayload: unknown = null;
  let errorMessage = "";
  await readSse(res, (event) => {
    if (event.type === "done") donePayload = event.payload;
    if (event.type === "error") errorMessage = event.message;
    onEvent(event as { type: string; text?: string; message?: string; payload?: unknown });
  }, signal);
  if (signal?.aborted) {
    const err = new Error("已取消");
    err.name = "AbortError";
    throw err;
  }
  if (errorMessage) throw new Error(errorMessage);
  return donePayload;
}

export const streamApi = {
  sceneRun: (
    id: string,
    body: { scene: string; chapterNumber: number | null; instruction: string; skillIds?: string[] },
    onEvent: (event: { type: string; text?: string; message?: string; payload?: unknown }) => void,
    signal?: AbortSignal,
  ) => postStream(`/api/books/${id}/scene-runs/stream`, body, onEvent, signal) as Promise<SceneRunResult>,
  rewriteSelection: (
    id: string,
    body: { selection: string; instruction: string; scene?: string },
    onEvent: (event: { type: string; text?: string; message?: string; payload?: unknown }) => void,
    signal?: AbortSignal,
  ) =>
    postStream(`/api/books/${id}/selection-rewrite/stream`, body, onEvent, signal) as Promise<{
      text: string;
      modelUsed: string;
      local?: boolean;
    }>,
  chat: (
    id: string,
    message: string,
    onEvent: (event: { type: string; text?: string; message?: string; payload?: unknown }) => void,
    signal?: AbortSignal,
    chapterNumber?: number | null,
    generationId?: string | null,
  ) =>
    postStream(
      `/api/books/${id}/chat/stream`,
      { message, chapterNumber: chapterNumber ?? null, generationId: generationId ?? null },
      onEvent,
      signal,
    ) as Promise<{
      message: ChatMessage;
      saved: Saved | null;
    }>,
};
