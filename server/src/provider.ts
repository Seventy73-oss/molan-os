import { db } from "./db";
import { MODEL_FETCH_RETRIES, MODEL_FETCH_RETRY_BACKOFF_MS, secureFetch } from "./outbound";
import {
  assertSafeBaseUrl,
  assertSafeBaseUrlResolved,
  decryptSecret,
  encryptSecret,
  envApiKey,
  redactSecrets,
} from "./security";

const KEYS = {
  baseUrl: "openai_base_url",
  apiKey: "openai_api_key",
  defaultModel: "default_model",
  chatModel: "chat_model",
  modelsCache: "models_cache",
  customModels: "custom_models",
} as const;

export type ProviderView = {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  defaultModel: string;
  chatModel: string;
  configured: boolean;
  keySource: "none" | "env" | "stored";
};

export type ModelInfo = { id: string; ownedBy?: string };

export type ModelsList = {
  models: ModelInfo[];
  fetchedAt: string | null;
  error?: string;
};

/**
 * A model list only means something for the Base URL it came from. Storing the
 * URL inside the cache is what makes switching providers invalidate the list
 * instead of silently showing the previous provider's models.
 */
type CachePayload = { baseUrl: string; models: ModelInfo[]; fetchedAt: string; error?: string };

/** Compare Base URLs the way a human would: ignore case and trailing slashes. */
export function sameBaseUrl(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

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

function readStoredApiKey(): string {
  const raw = read(KEYS.apiKey);
  if (!raw) return "";
  try {
    return decryptSecret(raw);
  } catch {
    return "";
  }
}

function writeStoredApiKey(plain: string) {
  if (!plain) {
    write(KEYS.apiKey, "");
    return;
  }
  write(KEYS.apiKey, encryptSecret(plain));
}

/** Migrate plaintext DB keys to encrypted form on first successful read path. */
function maybeReencryptPlaintext() {
  const raw = read(KEYS.apiKey);
  if (!raw || raw.startsWith("enc:v1:")) return;
  try {
    write(KEYS.apiKey, encryptSecret(raw));
  } catch {
    // leave as-is if encryption fails
  }
}

function readCache(): CachePayload | null {
  const raw = read(KEYS.modelsCache);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as CachePayload;
    if (!Array.isArray(data.models) || typeof data.fetchedAt !== "string") return null;
    // Caches written before the URL was recorded are treated as belonging to no
    // provider, so they can never leak across a switch.
    if (typeof data.baseUrl !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

/** The cache, but only when it was fetched from the Base URL in use right now. */
function readCacheFor(baseUrl: string): CachePayload | null {
  const cache = readCache();
  if (!cache) return null;
  if (!baseUrl) return cache;
  return sameBaseUrl(cache.baseUrl, baseUrl) ? cache : null;
}

function readCustomModels(): string[] {
  const raw = read(KEYS.customModels);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  } catch {
    return [];
  }
}

function writeCustomModels(list: string[]) {
  const unique = [...new Set(list.map((item) => item.trim()).filter(Boolean))];
  write(KEYS.customModels, unique.length ? JSON.stringify(unique) : "");
}

/** Merge fetched models with models the author added by hand (deduped, manual wins). */
function mergeCustom(models: ModelInfo[]): ModelInfo[] {
  const custom = readCustomModels();
  if (!custom.length) return models;
  const seen = new Set(models.map((model) => model.id.toLowerCase()));
  const extra = custom
    .filter((id) => !seen.has(id.toLowerCase()))
    .map((id) => ({ id, ownedBy: "manual" }));
  return [...models, ...extra];
}

function writeCache(payload: CachePayload) {
  write(KEYS.modelsCache, JSON.stringify(payload));
}

/**
 * Resolve credentials for outbound calls.
 * Env MOLAN_API_KEY / OPENAI_API_KEY wins over DB. Never expose the key via providerView.
 */
export function resolveProvider(route?: { base_url?: string | null; model_id?: string | null }) {
  maybeReencryptPlaintext();
  const storedKey = readStoredApiKey();
  const envKey = envApiKey();
  const storedBase = read(KEYS.baseUrl);
  const storedDefault = read(KEYS.defaultModel);
  const storedChat = read(KEYS.chatModel);
  const apiKey = envKey || storedKey;
  const hasStoredKey = Boolean(storedKey);
  const usingStoredKey = Boolean(storedKey) && !envKey;

  let baseUrl = (route?.base_url || storedBase || process.env.OPENAI_BASE_URL || process.env.MOLAN_BASE_URL || "https://api.openai.com/v1").trim();
  if (baseUrl) {
    // Validate before callers attach the key. Env or stored key both require allowlisted host.
    baseUrl = assertSafeBaseUrl(baseUrl, { withApiKey: Boolean(apiKey) });
  }

  const routeModel = route?.model_id?.trim() ?? "";
  const model =
    (routeModel && routeModel !== "local-draft" ? routeModel : "") ||
    storedChat ||
    storedDefault ||
    process.env.OPENAI_MODEL?.trim() ||
    process.env.MOLAN_MODEL?.trim() ||
    "";
  return {
    apiKey,
    baseUrl,
    model,
    hasStoredKey,
    usingStoredKey,
    keySource: (envKey ? "env" : storedKey ? "stored" : "none") as "env" | "stored" | "none",
  };
}

export function providerView(): ProviderView {
  maybeReencryptPlaintext();
  const storedKey = readStoredApiKey();
  const envKey = envApiKey();
  const shown = envKey || storedKey;
  const keySource: ProviderView["keySource"] = envKey ? "env" : storedKey ? "stored" : "none";
  return {
    baseUrl: read(KEYS.baseUrl),
    hasApiKey: Boolean(shown),
    apiKeyHint: keyHint(shown),
    defaultModel: read(KEYS.defaultModel),
    chatModel: read(KEYS.chatModel),
    configured: Boolean(shown),
    keySource,
  };
}

function cleanBase(value: string, withStoredKey: boolean): string {
  return assertSafeBaseUrl(value, { withStoredKey });
}

export function saveProvider(input: {
  baseUrl?: unknown;
  apiKey?: unknown;
  defaultModel?: unknown;
  chatModel?: unknown;
  clearApiKey?: unknown;
}): ProviderView {
  if (typeof input.baseUrl === "string") {
    const nextBase = input.baseUrl.trim() ? cleanBase(input.baseUrl, false) : "";
    const willHaveStoredKey =
      input.clearApiKey !== true &&
      ((typeof input.apiKey === "string" && Boolean(input.apiKey.trim())) || Boolean(readStoredApiKey()));
    // Env MOLAN_API_KEY also requires allowlist — key would travel with this Base URL at runtime.
    if (nextBase && (willHaveStoredKey || Boolean(envApiKey()))) {
      cleanBase(nextBase, true);
    }
    const previousBase = read(KEYS.baseUrl);
    write(KEYS.baseUrl, nextBase);
    // Switching providers must not leave the previous provider's models on screen.
    if (!sameBaseUrl(previousBase, nextBase)) write(KEYS.modelsCache, "");
  }
  if (input.clearApiKey === true) writeStoredApiKey("");
  else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    const plain = input.apiKey.trim();
    if (plain.startsWith("enc:v1:")) throw new Error("无效的 API Key");
    writeStoredApiKey(plain);
  }
  if (typeof input.defaultModel === "string") write(KEYS.defaultModel, input.defaultModel.trim());
  if (typeof input.chatModel === "string") write(KEYS.chatModel, input.chatModel.trim());
  return providerView();
}

export function redact(text: string): string {
  return redactSecrets(text);
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
  const baseUrl = providerView().baseUrl;
  const cache = readCacheFor(baseUrl);
  if (!providerView().configured && !envApiKey()) {
    return toModelsList(cache, "还没有配置 API Key，无法拉取模型列表");
  }
  const list = toModelsList(cache);
  return { ...list, models: mergeCustom(list.models) };
}

/** Add a model id by hand — works even when the provider has no /models endpoint. */
export function addCustomModel(id: unknown): ModelsList {
  const value = typeof id === "string" ? id.trim() : "";
  if (!value) throw new Error("模型 ID 不能为空");
  if (value.length > 120) throw new Error("模型 ID 太长");
  writeCustomModels([...readCustomModels(), value]);
  return getModelsList();
}

export function removeCustomModel(id: unknown): ModelsList {
  const value = typeof id === "string" ? id.trim() : "";
  if (!value) throw new Error("模型 ID 不能为空");
  writeCustomModels(readCustomModels().filter((item) => item.toLowerCase() !== value.toLowerCase()));
  return getModelsList();
}

/** Fetch GET {baseUrl}/models and cache the result. Never logs the key. */
export async function refreshModels(force = true): Promise<ModelsList> {
  let resolved: ReturnType<typeof resolveProvider>;
  try {
    resolved = resolveProvider();
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : "配置无效");
    return { ...getModelsList(), error: reason };
  }
  const { apiKey, baseUrl } = resolved;
  if (!apiKey) return { ...getModelsList(), error: "还没有 API Key" };
  if (!baseUrl) return { ...getModelsList(), error: "还没有 Base URL" };

  const existing = readCacheFor(baseUrl);
  if (!force && existing && !existing.error && Date.now() - Date.parse(existing.fetchedAt) < 5 * 60_000) {
    return { ...toModelsList(existing), models: mergeCustom(existing.models) };
  }

  let safeUrl: string;
  try {
    safeUrl = await assertSafeBaseUrlResolved(baseUrl, { withApiKey: Boolean(apiKey) });
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : "地址不安全");
    return { models: mergeCustom(existing?.models ?? []), fetchedAt: existing?.fetchedAt ?? null, error: reason };
  }

  const url = `${safeUrl.replace(/\/$/, "")}/models`;
  try {
    const response = await secureFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      withApiKey: Boolean(apiKey),
      timeoutMs: 15_000,
      retries: MODEL_FETCH_RETRIES,
      retryBackoffMs: MODEL_FETCH_RETRY_BACKOFF_MS,
    });
    if (!response.ok) {
      const detail = redact(await response.text());
      const error = `HTTP ${response.status}${detail ? ` ${detail}` : ""}`;
      const payload: CachePayload = {
        baseUrl,
        // A failed fetch keeps whatever this same provider already returned,
        // never another provider's list.
        models: existing?.models ?? [],
        fetchedAt: new Date().toISOString(),
        error,
      };
      writeCache(payload);
      return { ...toModelsList(payload), models: mergeCustom(payload.models) };
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
    const payload: CachePayload = { baseUrl, models, fetchedAt: new Date().toISOString() };
    writeCache(payload);
    return { ...toModelsList(payload), models: mergeCustom(models) };
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : "拉取失败");
    const payload: CachePayload = {
      baseUrl,
      models: existing?.models ?? [],
      fetchedAt: new Date().toISOString(),
      error: reason,
    };
    writeCache(payload);
    return { ...toModelsList(payload), models: mergeCustom(payload.models) };
  }
}

/**
 * Tiny completion against credentials.
 * Critical: if the request uses the *stored* key, a newly typed baseUrl must pass allowlist —
 * never send the saved key to an arbitrary URL.
 */
export async function testProvider(input: { baseUrl?: unknown; apiKey?: unknown; model?: unknown }) {
  let saved: ReturnType<typeof resolveProvider>;
  try {
    saved = resolveProvider();
  } catch {
    const stored = readStoredApiKey();
    saved = {
      apiKey: envApiKey() || stored,
      baseUrl: read(KEYS.baseUrl),
      model: "",
      hasStoredKey: Boolean(stored),
      usingStoredKey: !envApiKey() && Boolean(stored),
      keySource: "none",
    };
  }

  const typedKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : "";
  const apiKey = typedKey || saved.apiKey;
  // Any key that will be attached (typed, env, or stored) requires Base URL allowlist.
  const withApiKey = Boolean(apiKey);

  let baseUrl = saved.baseUrl;
  if (typeof input.baseUrl === "string" && input.baseUrl.trim()) {
    baseUrl = assertSafeBaseUrl(input.baseUrl, { withApiKey });
  } else if (baseUrl) {
    baseUrl = assertSafeBaseUrl(baseUrl, { withApiKey });
  }

  const model =
    (typeof input.model === "string" && input.model.trim() && input.model.trim() !== "local-draft"
      ? input.model.trim()
      : "") ||
    saved.model ||
    "gpt-4o-mini";
  if (!apiKey) return { ok: false as const, model, error: "还没有 API Key" };
  if (!baseUrl) return { ok: false as const, model, error: "还没有 Base URL" };

  const safeUrl = await assertSafeBaseUrlResolved(baseUrl, { withApiKey });
  const url = `${safeUrl.replace(/\/$/, "")}/chat/completions`;
  try {
    const response = await secureFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: "user", content: "ping" }],
      }),
      withApiKey: Boolean(apiKey),
      timeoutMs: 12_000,
      retries: MODEL_FETCH_RETRIES,
      retryBackoffMs: MODEL_FETCH_RETRY_BACKOFF_MS,
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
