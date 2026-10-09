/** Abort helpers shared by streaming, adapters, and outbound fetch. */

export function throwIfAborted(signal?: AbortSignal | null, message = "已取消"): void {
  if (!signal) return;
  if (signal.aborted) {
    const err = new Error(message);
    err.name = "AbortError";
    throw err;
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; message?: string };
  return e.name === "AbortError" || /aborted|已取消|The operation was aborted/i.test(e.message ?? "");
}

/** Merge user signal with a timeout; abort of either aborts the combined controller. */
export function combineSignals(
  user: AbortSignal | undefined | null,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(onAbort, timeoutMs);
  if (user) {
    if (user.aborted) onAbort();
    else user.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (user) user.removeEventListener("abort", onAbort);
    },
  };
}
