/** Progressive text reveal for local-draft / post-response streaming feel. */

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Calls `onFrame` with growing prefixes of `text`. Respects reduced motion.
 * Returns the final text. Cancel by setting `signal.aborted`.
 */
export async function revealText(
  text: string,
  onFrame: (partial: string) => void,
  options?: { signal?: AbortSignal; msPerChunk?: number; chunks?: number },
): Promise<string> {
  const full = text ?? "";
  if (!full || prefersReducedMotion()) {
    onFrame(full);
    return full;
  }
  const chunks = Math.max(12, options?.chunks ?? Math.min(64, Math.ceil(full.length / 24)));
  const step = Math.max(1, Math.ceil(full.length / chunks));
  const delay = options?.msPerChunk ?? 18;
  for (let i = step; i < full.length; i += step) {
    if (options?.signal?.aborted) {
      onFrame(full);
      return full;
    }
    onFrame(full.slice(0, i));
    await sleep(delay);
  }
  onFrame(full);
  return full;
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "status"; message: string }
  | { type: "done"; payload: unknown }
  | { type: "error"; message: string };

/** Consume an SSE response body. Falls back to treating the body as JSON if not SSE. */
export async function readSse(
  res: Response,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/event-stream")) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    onEvent({ type: "done", payload: data });
    return;
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  const reader = res.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      const err = new Error("已取消");
      err.name = "AbortError";
      throw err;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const dataLine = part
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!dataLine || dataLine === "[DONE]") continue;
        try {
          const parsed = JSON.parse(dataLine) as StreamEvent;
          onEvent(parsed);
        } catch {
          // ignore malformed chunk
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) {
    const err = new Error("已取消");
    err.name = "AbortError";
    throw err;
  }
}
