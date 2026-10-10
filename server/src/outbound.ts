/**
 * Unified secure outbound HTTP for provider test / model list / formal generation.
 * All credentialed calls must go through secureFetch — not raw fetch.
 *
 * Optional limited retries (network / HTTP 4xx+5xx). Never retries
 * user abort / cancel. Never silent-local-downgrades — callers still see hard failure.
 */
import { lookup } from "node:dns/promises";
import { assertSafeBaseUrl, assertSafeBaseUrlResolved, isPrivateOrReservedHost, redactSecrets } from "./security";
import { combineSignals, isAbortError, sleepAbortable, throwIfAborted } from "./abortUtil";

export type SecureFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** When true, Base URL / request URL must pass allowlist + HTTPS rules. */
  withApiKey?: boolean;
  /** Max redirects to follow (default 0 — reject redirects). */
  maxRedirects?: number;
  timeoutMs?: number;
  /**
   * Extra attempts after the first failure (default 0).
   * Model callers typically pass 2 (3 attempts total).
   */
  retries?: number;
  /**
   * Base backoff in ms before retry #1 (default 300). Delay = base * 2^(attempt-1).
   * Tests may set 0 for instant retry.
   */
  retryBackoffMs?: number;
};

/** Default retries for outbound model / provider credentialed calls. */
export const MODEL_FETCH_RETRIES = 2;
export const MODEL_FETCH_RETRY_BACKOFF_MS = 300;

function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(
    ([k, v]) => /^(authorization|x-api-key)$/i.test(k) && Boolean(v?.trim()),
  );
}

async function assertResolvedTarget(url: URL, withApiKey: boolean): Promise<void> {
  // Re-validate after any URL changes; check every DNS answer.
  await assertSafeBaseUrlResolved(`${url.protocol}//${url.host}`, { withApiKey });
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return;
  try {
    const results = await lookup(host, { all: true, verbatim: true });
    for (const row of results) {
      if (isPrivateOrReservedHost(row.address)) {
        throw new Error(`出站目标 ${host} 解析到内网地址 ${row.address}，已拒绝`);
      }
    }
  } catch (error) {
    if (error instanceof Error && /内网|SSRF|拒绝/.test(error.message)) throw error;
  }
}

/** HTTP 4xx and 5xx (incl. 400/401/403/429). Abort/cancel is never retried. */
export function isRetryableHttpStatus(status: number): boolean {
  return Number.isFinite(status) && status >= 400 && status <= 599;
}

/**
 * Network / transport failures are retryable. Abort, SSRF policy, and explicit
 * client errors are not.
 */
export function isRetryableNetworkError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (!(error instanceof Error)) return true;
  const msg = error.message || "";
  if (/出站目标|SSRF|内网|已拒绝|重定向|不安全|allowlist|白名单/i.test(msg)) return false;
  if (/HTTP\s+4\d\d/i.test(msg)) return false;
  // Node fetch: TypeError "fetch failed"; undici cause codes
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? (error as Error & { code?: string }).code ?? "";
  if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|EHOSTUNREACH|ENETUNREACH/i.test(
      String(code),
    )
  ) {
    return true;
  }
  if (/fetch failed|network|socket|timed?\s*out|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(msg)) {
    return true;
  }
  // Generic TypeError from fetch without SSRF markers
  if (error.name === "TypeError" && /fetch/i.test(msg)) return true;
  return false;
}

function backoffDelayMs(baseMs: number, attemptIndex: number): number {
  // attemptIndex is 1-based retry number
  if (baseMs <= 0) return 0;
  return baseMs * 2 ** (attemptIndex - 1);
}

async function drainResponse(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    /* ignore */
  }
}

/**
 * Perform an outbound request with SSRF checks. Redirects are rejected by default
 * (or re-validated per hop if maxRedirects > 0).
 *
 * When `retries` > 0, retries on network failures and HTTP 4xx/5xx.
 * Does not retry abort/cancel or SSRF policy errors. No silent local fallback.
 */
export async function secureFetch(rawUrl: string, options: SecureFetchOptions = {}): Promise<Response> {
  const withApiKey = Boolean(options.withApiKey ?? hasAuthHeader(options.headers));
  const cleaned = assertSafeBaseUrl(rawUrl, { withApiKey });
  let current = new URL(cleaned);
  await assertResolvedTarget(current, withApiKey);

  const maxRedirects = options.maxRedirects ?? 0;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const method = options.method ?? "GET";
  const headers = { ...(options.headers ?? {}) };
  let body = options.body;
  const maxRetries = Math.max(0, Math.min(5, Math.floor(options.retries ?? 0)));
  const backoffMs = options.retryBackoffMs ?? MODEL_FETCH_RETRY_BACKOFF_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    if (attempt > 0) {
      await sleepAbortable(backoffDelayMs(backoffMs, attempt), options.signal);
    }

    let redirects = 0;
    let hopUrl = current;
    let hopBody = body;

    try {
      while (true) {
        const combined = combineSignals(options.signal, timeoutMs);
        try {
          const response = await fetch(hopUrl.toString(), {
            method,
            headers,
            body: method === "GET" || method === "HEAD" ? undefined : hopBody,
            signal: combined.signal,
            redirect: "manual",
          });

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) throw new Error(`出站重定向缺少 Location（HTTP ${response.status}）`);
            if (redirects >= maxRedirects) {
              throw new Error(`出站请求被重定向到 ${location}，已拒绝（防 SSRF）`);
            }
            const next = new URL(location, hopUrl);
            assertSafeBaseUrl(next.toString(), { withApiKey });
            await assertResolvedTarget(next, withApiKey);
            hopUrl = next;
            redirects += 1;
            if (response.status === 303) {
              hopBody = undefined;
            }
            combined.dispose();
            continue;
          }

          combined.dispose();

          if (isRetryableHttpStatus(response.status) && attempt < maxRetries) {
            await drainResponse(response);
            lastError = new Error(`HTTP ${response.status}`);
            break; // retry outer loop
          }

          return response;
        } catch (error) {
          combined.dispose();
          throw error;
        }
      }
      // fell through from 4xx/5xx retry path
      continue;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!isRetryableNetworkError(error) || attempt >= maxRetries) throw error;
      lastError = error;
      continue;
    }
  }

  if (lastError) throw lastError;
  throw new Error("出站请求失败");
}

export function safeErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
