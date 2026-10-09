import { db } from "./db";

export type UsageRow = {
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
  meta: Record<string, unknown> | null;
  createdAt: string;
};

/** Rough USD per 1M tokens — enough for a dashboard, not billing-grade. */
const RATES: { match: RegExp; inPerM: number; outPerM: number }[] = [
  { match: /gpt-4o-mini/i, inPerM: 0.15, outPerM: 0.6 },
  { match: /gpt-4o/i, inPerM: 2.5, outPerM: 10 },
  { match: /deepseek/i, inPerM: 0.27, outPerM: 1.1 },
  { match: /moonshot|kimi/i, inPerM: 1.0, outPerM: 1.0 },
  { match: /claude-3-5|claude-sonnet/i, inPerM: 3.0, outPerM: 15 },
  { match: /local/i, inPerM: 0, outPerM: 0 },
];

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const rate = RATES.find((r) => r.match.test(model)) ?? { inPerM: 0.5, outPerM: 1.5 };
  return (promptTokens / 1_000_000) * rate.inPerM + (completionTokens / 1_000_000) * rate.outPerM;
}

export function recordUsage(input: {
  bookId?: string | null;
  scene?: string;
  model: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  local?: boolean;
  meta?: Record<string, unknown> | null;
}) {
  const prompt = Math.max(0, Math.floor(input.promptTokens ?? 0));
  const completion = Math.max(0, Math.floor(input.completionTokens ?? 0));
  const total = Math.max(0, Math.floor(input.totalTokens ?? prompt + completion));
  const local = Boolean(input.local || /local/i.test(input.model));
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const cost = local ? 0 : estimateCost(input.model, prompt, completion);
  db.prepare(
    `INSERT INTO api_usage
      (id, book_id, scene, model, provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost, local, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.bookId ?? null,
    input.scene ?? "",
    input.model,
    input.provider ?? (local ? "local" : "openai"),
    prompt,
    completion,
    total,
    cost,
    local ? 1 : 0,
    input.meta ? JSON.stringify(input.meta) : null,
    createdAt,
  );
  return {
    id,
    bookId: input.bookId ?? null,
    scene: input.scene ?? "",
    model: input.model,
    provider: input.provider ?? (local ? "local" : "openai"),
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    estimatedCost: cost,
    local,
    meta: input.meta ?? null,
    createdAt,
  } satisfies UsageRow;
}

function mapRow(row: {
  id: string;
  book_id: string | null;
  scene: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  local: number;
  meta_json: string | null;
  created_at: string;
}): UsageRow {
  return {
    id: row.id,
    bookId: row.book_id,
    scene: row.scene,
    model: row.model,
    provider: row.provider,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    estimatedCost: row.estimated_cost,
    local: row.local === 1,
    meta: row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}

export function listUsage(opts?: { bookId?: string | null; limit?: number }): UsageRow[] {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  if (opts?.bookId) {
    return (
      db
        .prepare("SELECT * FROM api_usage WHERE book_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(opts.bookId, limit) as Parameters<typeof mapRow>[0][]
    ).map(mapRow);
  }
  return (
    db.prepare("SELECT * FROM api_usage ORDER BY created_at DESC LIMIT ?").all(limit) as Parameters<typeof mapRow>[0][]
  ).map(mapRow);
}

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

export function usageSummary(bookId?: string | null): UsageSummary {
  const rows = listUsage({ bookId: bookId ?? undefined, limit: 500 });
  const byModel = new Map<string, { model: string; calls: number; totalTokens: number; estimatedCost: number }>();
  const byBook = new Map<string, { bookId: string | null; title: string; calls: number; totalTokens: number; estimatedCost: number }>();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  let localCalls = 0;
  for (const row of rows) {
    promptTokens += row.promptTokens;
    completionTokens += row.completionTokens;
    totalTokens += row.totalTokens;
    estimatedCost += row.estimatedCost;
    if (row.local) localCalls += 1;
    const m = byModel.get(row.model) ?? { model: row.model, calls: 0, totalTokens: 0, estimatedCost: 0 };
    m.calls += 1;
    m.totalTokens += row.totalTokens;
    m.estimatedCost += row.estimatedCost;
    byModel.set(row.model, m);
    const key = row.bookId ?? "";
    const title =
      row.bookId
        ? ((db.prepare("SELECT title FROM books WHERE id = ?").get(row.bookId) as { title: string } | undefined)?.title ??
          "（已删）")
        : "（未归属）";
    const b = byBook.get(key) ?? { bookId: row.bookId, title, calls: 0, totalTokens: 0, estimatedCost: 0 };
    b.calls += 1;
    b.totalTokens += row.totalTokens;
    b.estimatedCost += row.estimatedCost;
    byBook.set(key, b);
  }
  return {
    calls: rows.length,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCost,
    localCalls,
    byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    byBook: [...byBook.values()].sort((a, b) => b.estimatedCost - a.estimatedCost),
  };
}

/** Rough token estimate when provider omits usage. */
export function estimateTokensFromText(text: string): number {
  const s = text || "";
  // CJK-heavy: ~1.5 chars/token; Latin ~4 chars/token. Blend.
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = Math.max(0, s.length - cjk);
  return Math.max(1, Math.round(cjk / 1.5 + rest / 4));
}
