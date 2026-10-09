import { db } from "./db";

const KEYS = {
  baseUrl: "openai_base_url",
  apiKey: "openai_api_key",
  defaultModel: "default_model",
  chatModel: "chat_model",
  modelsCache: "models_cache",
} as const;

export type ProviderView = {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  defaultModel: string;
  chatModel: string;
  configured: boolean;
};

export type ModelInfo = { id: string; ownedBy?: string };

export type ModelsList = {
  models: ModelInfo[];
  fetchedAt: string | null;
  error?: string;
};

type CachePayload = { models: ModelInfo[]; fetchedAt: string; error?: string };

function read(key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value?.trim() ?? "";
}

function write(key: string, value: string) {
  if (!value) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function keyHint(secret: string): string | null {
  if (secret.length < 4) return null;
  const tail = secret.slice(-4);
  return secret.startsWith("sk-") ? `sk-…${tail}` : `…${tail}`;
}

function readCache(): CachePayload | null {
  const raw = read(KEYS.modelsCache);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as CachePayload;
    if (!Array.isArray(data.models) || typeof data.fetchedAt !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(payload: CachePayload) {
  write(KEYS.modelsCache, JSON.stringify(payload));
}

/** UI value wins over the environment. Per-scene route base URL wins over both. */
export function resolveProvider(route?: { base_url?: string | null; model_id?: string | null }) {
  const storedKey = read(KEYS.apiKey);
  const storedBase = read(KEYS.baseUrl);
  const storedDefault = read(KEYS.defaultModel);
  const storedChat = read(KEYS.chatModel);
  const apiKey = storedKey || process.env.OPENAI_API_KEY?.trim() || "";
  const baseUrl = (route?.base_url || storedBase || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
  const routeModel = route?.model_id?.trim() ?? "";
  const model =
    (routeModel && routeModel !== "local-draft" ? routeModel : "") ||
    storedChat ||
    storedDefault ||
    process.env.OPENAI_MODEL?.trim() ||
    "";
  return { apiKey, baseUrl, model, hasStoredKey: Boolean(storedKey) };
}

export function providerView(): ProviderView {
  const storedKey = read(KEYS.apiKey);
  const envKey = process.env.OPENAI_API_KEY?.trim() || "";
  const shown = storedKey || envKey;
  return {
    baseUrl: read(KEYS.baseUrl),
    hasApiKey: Boolean(shown),
    apiKeyHint: keyHint(shown),
    defaultModel: read(KEYS.defaultModel),
    chatModel: read(KEYS.chatModel),
    configured: Boolean(shown),
  };
}

function cleanBase(value: string): string {
  const text = value.trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Base URL 需要是 http 或 https 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL 只接受 http 或 https");
  if (url.username || url.password) throw new Error("不要把密钥写进地址");
  return text.replace(/\/+$/, "");
}

export function saveProvider(input: {
  baseUrl?: unknown;
  apiKey?: unknown;
  defaultModel?: unknown;
  chatModel?: unknown;
  clearApiKey?: unknown;
}): ProviderView {
  if (typeof input.baseUrl === "string") write(KEYS.baseUrl, cleanBase(input.baseUrl));
  if (input.clearApiKey === true) write(KEYS.apiKey, "");
  else if (typeof input.apiKey === "string" && input.apiKey.trim()) write(KEYS.apiKey, input.apiKey.trim());
  if (typeof input.defaultModel === "string") write(KEYS.defaultModel, input.defaultModel.trim());
  if (typeof input.chatModel === "string") write(KEYS.chatModel, input.chatModel.trim());
  return providerView();
}

export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .slice(0, 180);
}

function toModelsList(cache: CachePayload | null, error?: string): ModelsList {
  if (!cache) return { models: [], fetchedAt: null, error };
  return {
    models: cache.models,
    fetchedAt: cache.fetchedAt,
    error: error ?? cache.error,
  };
}

export function getModelsList(): ModelsList {
  const cache = readCache();
  if (!providerView().configured && !process.env.OPENAI_API_KEY?.trim()) {
    return toModelsList(cache, "还没有配置 API Key，无法拉取模型列表");
  }
  return toModelsList(cache);
}

/** Fetch GET {baseUrl}/models and cache the result. Never logs the key. */
export async function refreshModels(force = true): Promise<ModelsList> {
  const { apiKey, baseUrl } = resolveProvider();
  if (!apiKey) return { models: readCache()?.models ?? [], fetchedAt: readCache()?.fetchedAt ?? null, error: "还没有 API Key" };
  if (!baseUrl) return { models: readCache()?.models ?? [], fetchedAt: readCache()?.fetchedAt ?? null, error: "还没有 Base URL" };

  const existing = readCache();
  if (!force && existing && !existing.error && Date.now() - Date.parse(existing.fetchedAt) < 5 * 60_000) {
    return toModelsList(existing);
  }

  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = redact(await response.text());
      const error = `HTTP ${response.status}${detail ? ` ${detail}` : ""}`;
      const payload: CachePayload = {
        models: existing?.models ?? [],
        fetchedAt: new Date().toISOString(),
        error,
      };
      writeCache(payload);
      return toModelsList(payload);
    }
    const data = (await response.json()) as {
      data?: { id?: string; owned_by?: string }[];
    };
    const models = (data.data ?? [])
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        ownedBy: typeof item.owned_by === "string" ? item.owned_by : undefined,
      }))
      .filter((item) => item.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const payload: CachePayload = { models, fetchedAt: new Date().toISOString() };
    writeCache(payload);
    return toModelsList(payload);
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : "拉取失败");
    const payload: CachePayload = {
      models: existing?.models ?? [],
      fetchedAt: new Date().toISOString(),
      error: reason,
    };
    writeCache(payload);
    return toModelsList(payload);
  }
}

/** Tiny completion against the saved (or just-typed) credentials. The key is never logged or returned. */
export async function testProvider(input: { baseUrl?: unknown; apiKey?: unknown; model?: unknown }) {
  const saved = resolveProvider();
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : saved.apiKey;
  let baseUrl = saved.baseUrl;
  if (typeof input.baseUrl === "string" && input.baseUrl.trim()) baseUrl = cleanBase(input.baseUrl);
  const model =
    (typeof input.model === "string" && input.model.trim() && input.model.trim() !== "local-draft"
      ? input.model.trim()
      : "") ||
    saved.model ||
    "gpt-4o-mini";
  if (!apiKey) return { ok: false as const, model, error: "还没有 API Key" };
  if (!baseUrl) return { ok: false as const, model, error: "还没有 Base URL" };
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const detail = redact(await response.text());
      return { ok: false as const, model, error: `HTTP ${response.status}${detail ? ` ${detail}` : ""}` };
    }
    return { ok: true as const, model };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "连接失败";
    return { ok: false as const, model, error: redact(reason) };
  }
}
