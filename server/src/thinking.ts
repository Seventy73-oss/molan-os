/** Per-scene thinking / reasoning intensity for model calls. */

export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingIntensity = (typeof THINKING_LEVELS)[number];

export const THINKING_LABELS: Record<ThinkingIntensity, string> = {
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
};

export function normalizeThinking(raw: unknown): ThinkingIntensity {
  if (typeof raw !== "string") return "medium";
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "none" || v === "关闭") return "off";
  if (v === "low" || v === "低") return "low";
  if (v === "high" || v === "高") return "high";
  if (v === "medium" || v === "中" || v === "med") return "medium";
  return "medium";
}

/** OpenAI-style reasoning_effort when provider supports it. */
export function reasoningEffortOf(level: ThinkingIntensity): "low" | "medium" | "high" | null {
  if (level === "off") return null;
  return level;
}

export function temperatureOf(level: ThinkingIntensity): number {
  switch (level) {
    case "off":
      return 0.9;
    case "low":
      return 0.75;
    case "medium":
      return 0.65;
    case "high":
      return 0.45;
  }
}

export function maxTokensHint(level: ThinkingIntensity): number | undefined {
  switch (level) {
    case "off":
      return undefined;
    case "low":
      return 4096;
    case "medium":
      return 8192;
    case "high":
      return 16384;
  }
}

/** Extra system guidance when the provider has no native reasoning_effort. */
export function thinkingSystemHint(level: ThinkingIntensity): string {
  switch (level) {
    case "off":
      return "【思考强度：关闭】直接交付结果，不要长篇推敲或列出思考过程。";
    case "low":
      return "【思考强度：低】稍作核对关键事实与节奏后交付，保持简洁。";
    case "medium":
      return "【思考强度：中】仔细推敲结构、因果与细节后再交付；不要写出思考过程。";
    case "high":
      return "【思考强度：高】深度推敲人物动机、前后矛盾、钩子与节奏，再交付定稿；不要写出思考过程。";
  }
}

/** Detect models that typically accept reasoning_effort (o-series / gpt-5 / reasoner). */
export function modelLikelySupportsReasoning(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /^o[1-9]/.test(m) ||
    m.includes("o1-") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("gpt-5") ||
    m.includes("reasoner") ||
    m.includes("thinking") ||
    m.includes("r1")
  );
}
