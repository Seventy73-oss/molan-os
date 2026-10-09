import { db } from "./db";
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
    return data;
  } catch {
    return null;
  }
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
    // Validate before callers attach the key. Stored-key mode requires allowlisted host.
    baseUrl = assertSafeBaseUrl(baseUrl, { withStoredKey: usingStoredKey && Boolean(apiKey) });
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
    if (nextBase && willHaveStoredKey && !envApiKey()) {
      cleanBase(nextBase, true);
    }
    write(KEYS.baseUrl, nextBase);
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
  const cache = readCache();
  if (!providerView().configured && !envApiKey()) {
    return toModelsList(cache, "还没有配置 API Key，无法拉取模型列表");
  }
  return toModelsList(cache);
}

/** Fetch GET {baseUrl}/models and cache the result. Never logs the key. */
export async function refreshModels(force = true): Promise<ModelsList> {
  let resolved: ReturnType<typeof resolveProvider>;
  try {
    resolved = resolveProvider();
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : "配置无效");
    return { models: readCache()?.models ?? [], fetchedAt: readCache()?.fetchedAt ?? null, error: reason };
  }
  const { apiKey, baseUrl, usingStoredKey } = resolved;
  if (!apiKey) return { models: readCache()?.models ?? [], fetchedAt: readCache()?.fetchedAt ?? null, error: "还没有 API Key" };
  if (!baseUrl) return { models: readCache()?.models ?? [], fetchedAt: readCache()?.fetchedAt ?? null, error: "还没有 Base URL" };

  const existing = readCache();
  if (!force && existing && !existing.error && Date.now() - Date.parse(existing.fetchedAt) < 5 * 60_000) {
    return toModelsList(existing);
  }

  let safeUrl: string;
  try {
    safeUrl = await assertSafeBaseUrlResolved(baseUrl, { withStoredKey: usingStoredKey });
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : "地址不安全");
    return { models: existing?.models ?? [], fetchedAt: existing?.fetchedAt ?? null, error: reason };
  }

  const url = `${safeUrl.replace(/\/$/, "")}/models`;
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
  const usingStoredKey = !typedKey && Boolean(saved.hasStoredKey) && !envApiKey();

  let baseUrl = saved.baseUrl;
  if (typeof input.baseUrl === "string" && input.baseUrl.trim()) {
    baseUrl = assertSafeBaseUrl(input.baseUrl, { withStoredKey: usingStoredKey });
  } else if (baseUrl) {
    baseUrl = assertSafeBaseUrl(baseUrl, { withStoredKey: usingStoredKey });
  }

  const model =
    (typeof input.model === "string" && input.model.trim() && input.model.trim() !== "local-draft"
      ? input.model.trim()
      : "") ||
    saved.model ||
    "gpt-4o-mini";
  if (!apiKey) return { ok: false as const, model, error: "还没有 API Key" };
  if (!baseUrl) return { ok: false as const, model, error: "还没有 Base URL" };

  const safeUrl = await assertSafeBaseUrlResolved(baseUrl, { withStoredKey: usingStoredKey });
  const url = `${safeUrl.replace(/\/$/, "")}/chat/completions`;
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
