/**
 * Unified secure outbound HTTP for provider test / model list / formal generation.
 * All credentialed calls must go through secureFetch — not raw fetch.
 */
import { lookup } from "node:dns/promises";
import { assertSafeBaseUrl, assertSafeBaseUrlResolved, isPrivateOrReservedHost, redactSecrets } from "./security";

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
};

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

/**
 * Perform an outbound request with SSRF checks. Redirects are rejected by default
 * (or re-validated per hop if maxRedirects > 0).
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
  let redirects = 0;

  while (true) {
    const signal =
      options.signal ??
      AbortSignal.timeout(timeoutMs);
    const response = await fetch(current.toString(), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      signal,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`出站重定向缺少 Location（HTTP ${response.status}）`);
      if (redirects >= maxRedirects) {
        throw new Error(`出站请求被重定向到 ${location}，已拒绝（防 SSRF）`);
      }
      const next = new URL(location, current);
      assertSafeBaseUrl(next.toString(), { withApiKey });
      await assertResolvedTarget(next, withApiKey);
      current = next;
      redirects += 1;
      // Drop body on redirect to GET-like targets
      if (response.status === 303) {
        body = undefined;
      }
      continue;
    }

    return response;
  }
}

export function safeErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
