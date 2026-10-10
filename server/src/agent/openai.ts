import type { AgentRuntimeAdapter, RunInput, RunOutput, SceneId } from "./adapter";
import { normalizeDialogueQuotes } from "./localDraft";
import {
  maxTokensHint,
  modelLikelySupportsReasoning,
  normalizeThinking,
  reasoningEffortForModel,
  temperatureOf,
  thinkingSystemHint,
  type ThinkingIntensity,
} from "../thinking";
import { redactSecrets } from "../security";
import { MODEL_FETCH_RETRIES, MODEL_FETCH_RETRY_BACKOFF_MS, secureFetch } from "../outbound";
import { isAbortError, throwIfAborted } from "../abortUtil";

const CONTRACT: Record<SceneId, string> = {
  topic: "交付题材方案：读者、冲突、不写什么、书名和两句简介。",
  book_setup: "先逐行写出书名、题材、简介、文风、目标章数、每章字数和章目，再写档案散文。",
  outline: "按章交付全书大纲。每章一行「数字. 章名」，下一段写这一章不能退回的因果。",
  chapter_outline: "交付本章细纲：章名、三到四个场景（目标、冲突、细节）和章末钩子。",
  chapter_body: "只交付本章正文。不要标题，不要创作说明。用叙事散文写完这一章。对白必须用弯引号“”（U+201C/U+201D），禁止用「」、（）或()包说话。",
  review: "只交付问题清单。每条包含类型、稿中原句和改法。不要重写全文。",
  humanize: "只交付润色后的正文。不改人名、时间和物件事实，不加说明。对白改用弯引号“”，去掉「」、（）或()包的说话。",
  memory_extract: "用短行写下本章事实、章末留下的物件、下一章必须接住的信息。",
  chat: "用简体中文简短回答用户关于本书写作的问题。不要擅自生成整章正文或大纲，除非对方明确要求。",
};

function stripFence(text: string): string {
  const match = text.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return (match?.[1] ?? text).trim();
}

function finalizeModelText(scene: SceneId, text: string): string {
  const cleaned = stripFence(text);
  if (scene === "chapter_body" || scene === "humanize") {
    return normalizeDialogueQuotes(cleaned);
  }
  return cleaned;
}


function intensityOf(input: RunInput): ThinkingIntensity {
  return normalizeThinking(input.thinkingIntensity);
}

function buildMessages(input: RunInput) {
  const level = intensityOf(input);
  const system = [
    "你是墨兰写作的写作引擎。用简体中文交付当前场景的稿件，不要解释写作过程。正文对白只用弯引号“…”（U+201C/U+201D），禁止用「」、（）或()包说话。",
    CONTRACT[input.scene],
    thinkingSystemHint(level),
    ...input.skillTexts.map((skill) => `# ${skill.name}\n${skill.text}`),
  ].join("\n\n");
  const user = [input.context, input.instruction ? `【本次指令】\n${input.instruction}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
}

/** Build chat/completions body with thinking intensity mapped to provider fields. */
export function buildCompletionBody(input: RunInput, model: string, stream: boolean) {
  const level = intensityOf(input);
  const body: Record<string, unknown> = {
    model,
    messages: buildMessages(input),
    temperature: temperatureOf(level),
  };
  if (stream) body.stream = true;

  const effort = reasoningEffortForModel(model, level);
  if (effort && modelLikelySupportsReasoning(model)) {
    body.reasoning_effort = effort;
    body.thinking = { type: "enabled", budget_tokens: level === "high" ? 8000 : level === "medium" ? 4000 : 1024 };
  } else if (effort) {
    body.reasoning_effort = effort;
  }

  const maxTok = maxTokensHint(level);
  if (maxTok) body.max_tokens = maxTok;

  return body;
}

export class OpenAICompatibleAdapter implements AgentRuntimeAdapter {
  constructor(
    private readonly options: { baseUrl: string; apiKey: string; model: string },
  ) {}

  async runScene(input: RunInput): Promise<RunOutput> {
    const model =
      input.model && input.model.trim() && input.model.trim() !== "local-draft"
        ? input.model.trim()
        : this.options.model;
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    try {
      throwIfAborted(input.signal);
      const response = await secureFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(buildCompletionBody(input, model, false)),
        withApiKey: Boolean(this.options.apiKey),
        timeoutMs: 120_000,
        signal: input.signal,
        retries: MODEL_FETCH_RETRIES,
        retryBackoffMs: MODEL_FETCH_RETRY_BACKOFF_MS,
      });
      throwIfAborted(input.signal);
      if (!response.ok) {
        const detail = redactSecrets(await response.text());
        throw new Error(`HTTP ${response.status} ${detail}`);
      }
      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const text = finalizeModelText(input.scene, data.choices?.[0]?.message?.content ?? "");
      if (!text) throw new Error("空响应");
      return {
        text,
        modelUsed: model,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      if (isAbortError(error)) {
        const err = new Error("已取消");
        err.name = "AbortError";
        throw err;
      }
      const reason = redactSecrets(error instanceof Error ? error.message : "未知错误");
      throw new Error(`模型调用失败：${reason}`);
    }
  }

  /** Stream tokens when the provider supports SSE chat completions. Errors surface — no silent local fallback. */
  async runSceneStream(input: RunInput, onToken: (delta: string) => void | Promise<void>): Promise<RunOutput> {
    const model =
      input.model && input.model.trim() && input.model.trim() !== "local-draft"
        ? input.model.trim()
        : this.options.model;
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    try {
      throwIfAborted(input.signal);
      const response = await secureFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(buildCompletionBody(input, model, true)),
        withApiKey: Boolean(this.options.apiKey),
        timeoutMs: 120_000,
        signal: input.signal,
        retries: MODEL_FETCH_RETRIES,
        retryBackoffMs: MODEL_FETCH_RETRY_BACKOFF_MS,
      });
      if (!response.ok) {
        const detail = redactSecrets(await response.text());
        throw new Error(`HTTP ${response.status} ${detail}`);
      }
      if (!response.body) throw new Error("无流式响应体");
      const reader = response.body.getReader();
      const onAbort = () => {
        try {
          void reader.cancel();
        } catch {
          /* ignore */
        }
      };
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";
      try {
      while (true) {
        throwIfAborted(input.signal);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
            };
            const delta = json.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              assembled += delta;
              await onToken(delta);
            }
          } catch {
            // ignore bad chunk
          }
        }
      }
      const text = finalizeModelText(input.scene, assembled);
      if (!text) throw new Error("空流式响应");
      return { text, modelUsed: model };
      } finally {
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      if (isAbortError(error)) {
        const err = new Error("已取消");
        err.name = "AbortError";
        throw err;
      }
      const reason = redactSecrets(error instanceof Error ? error.message : "未知错误");
      throw new Error(`模型流式调用失败：${reason}`);
    }
  }
}

export async function emitChunked(
  text: string,
  onToken: (delta: string) => void | Promise<void>,
  chunkSize = 24,
  signal?: AbortSignal,
) {
  for (let i = 0; i < text.length; i += chunkSize) {
    throwIfAborted(signal);
    await onToken(text.slice(i, i + chunkSize));
  }
}
