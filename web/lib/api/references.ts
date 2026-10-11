import { auth } from "@eazo/sdk";
import { getLocale } from "../i18n";

export type ReferenceSource = { id: string; title: string; author: string; originKind: string; sourceUrl: string; note: string; charCount: number; chapterCount: number; cardCount: number; createdAt: string };
export type ReferenceChapter = { id: string; ordinal: number; title: string; charCount: number; sourceUrl: string };
export type ReferenceKind = "opening" | "structure" | "pacing" | "style";
export type ReferenceEvidence = { chapterId: string; chapterTitle: string; ordinal: number; from: number; to: number; hash: string; quote: string };
export type ReferenceCard = { id: string; sourceId: string; jobId: string; kind: ReferenceKind; title: string; principle: string; application: string; caution: string; evidence: ReferenceEvidence[]; stages: string[]; approved: boolean; bookIds: string[]; createdAt: string };
export type ReferenceJob = { id: string; sourceId: string; kind: "download" | "distill"; status: string; progress: number; total: number; error: string; modelLabel: string; tokens: number; createdAt: string; updatedAt: string };
export type ReferenceDetail = { source: ReferenceSource; chapters: ReferenceChapter[]; cards: ReferenceCard[] };
export type ReferenceIndex = { sources: ReferenceSource[]; jobs: ReferenceJob[]; ai: { configured: boolean; modelLabel: string }; sourceName: string; limits: { distillChars: number; chunkChars: number; dailyJobs: number } };
export type SearchNovel = { title: string; author: string; url: string };
export type NovelCatalog = SearchNovel & { chapters: { title: string; url: string; ordinal: number }[] };
export class ReferenceApiError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }

async function request(path: string, init: RequestInit = {}) {
  const owner = auth.user?.id;
  const session = await auth.getSessionHeader();
  if (!session || !owner) throw new ReferenceApiError("请登录 Eazo 后使用参考库", 401, "authentication_required");
  if (auth.user?.id !== owner) throw new ReferenceApiError("登录账户已变更，请重新操作", 409, "identity_changed");
  const headers = new Headers(init.headers);
  headers.set("x-eazo-session", session); headers.set("x-eazo-locale", getLocale());
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/references${path}`, { ...init, headers, cache: "no-store" });
  if (auth.user?.id !== owner) {
    await response.body?.cancel();
    throw new ReferenceApiError("登录账户已变更，请重新操作", 409, "identity_changed");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ReferenceApiError(data.error || "参考库请求失败", response.status, data.code || "request_failed");
  }
  return response;
}
async function json<T>(path: string, init?: RequestInit): Promise<T> { return (await request(path, init)).json() as Promise<T>; }
const id = encodeURIComponent;
export const referencesApi = {
  list: () => json<ReferenceIndex>(""),
  detail: (sourceId: string) => json<ReferenceDetail>(`/sources/${id(sourceId)}`),
  search: (query: string, signal?: AbortSignal) => json<{ books: SearchNovel[]; sourceName: string }>(`/search?q=${id(query)}`, { signal }),
  catalog: (url: string, signal?: AbortSignal) => json<NovelCatalog>(`/catalog?url=${id(url)}`, { signal }),
  import: (input: { title: string; author: string; text: string; note?: string; rightsConfirmed: boolean }) => json<ReferenceDetail>("/import", { method: "POST", body: JSON.stringify(input) }),
  download: (input: { url: string; chapterUrls: string[]; rightsConfirmed: boolean }) => json<ReferenceJob>("/download", { method: "POST", body: JSON.stringify(input) }),
  distill: (sourceId: string, chapterIds: string[], focus: ReferenceKind[]) => json<ReferenceJob>(`/sources/${id(sourceId)}/distill`, { method: "POST", body: JSON.stringify({ chapterIds, focus }) }),
  chapter: (sourceId: string, chapterId: string) => json<{ id: string; title: string; body: string; sourceUrl: string }>(`/sources/${id(sourceId)}/chapters/${id(chapterId)}`),
  cancel: (jobId: string) => json<ReferenceJob>(`/jobs/${id(jobId)}/cancel`, { method: "POST" }),
  approve: (cardId: string, approved: boolean) => json<ReferenceCard>(`/cards/${id(cardId)}`, { method: "PATCH", body: JSON.stringify({ approved }) }),
  bind: (cardId: string, bookId: string, enabled: boolean, shareConfirmed: boolean) => json<ReferenceCard>(`/cards/${id(cardId)}/books/${id(bookId)}`, { method: "PUT", body: JSON.stringify({ enabled, shareConfirmed }) }),
  remove: (sourceId: string) => json<{ ok: true }>(`/sources/${id(sourceId)}`, { method: "DELETE" }),
  exportText: async (sourceId: string) => (await request(`/sources/${id(sourceId)}/export`)).blob(),
};
