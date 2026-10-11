import { ReferenceError } from "./errors";

type Message = { role: "system" | "user"; content: string };
export type TextCompletion = { text: string; tokens: number; modelLabel: string };

function settings() {
  // Fixed server-owned text route. This does not touch scene_routes/provider.ts.
  return {
    base: process.env.EAZO_APP_AI_API_BASE?.replace(/\/+$/, ""),
    appId: process.env.EAZO_APP_ID,
    key: process.env.EAZO_PRIVATE_KEY,
    model: process.env.EAZO_AI_TEXT_MODEL_KEY,
    mode: process.env.EAZO_AI_PROVIDER_MODE,
  };
}
export function distillationReadiness() {
  const c = settings();
  return {
    configured: Boolean(c.base && c.appId && c.key && c.model && c.mode !== "byok"),
    modelLabel: c.model === "qwen.qwen3.8-flash" ? "Qwen3.8 Flash" : "Eazo text AI",
  };
}

export async function distillChat(input: { messages: Message[]; viewerUserId: string; signal: AbortSignal }): Promise<TextCompletion> {
  const c = settings();
  if (!distillationReadiness().configured) throw new ReferenceError(503, "ai_not_configured", "蒸馏模型尚未配置，请在 Eazo 中配置文本模型");
  if (!input.viewerUserId) throw new ReferenceError(401, "authentication_required", "请先登录");
  let response: Response;
  try {
    response = await fetch(`${c.base}/api/app-ai/chat`, {
      method: "POST", redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json", "x-eazo-app-id": c.appId!, Authorization: `Bearer ${c.key!}` },
      body: JSON.stringify({
        app_id: c.appId, model_key: c.model, viewer_user_id: input.viewerUserId,
        messages: input.messages, stream: false,
        params: { temperature: 0.25, max_tokens: 4500 },
      }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(150_000)]),
    });
  } catch {
    if (input.signal.aborted) throw new ReferenceError(409, "cancelled", "已取消蒸馏");
    throw new ReferenceError(502, "ai_connection_failed", "蒸馏模型连接失败或超时，请稍后重试");
  }
  if (!response.ok) {
    // Do not forward upstream error bodies: they can contain server credentials or private URLs.
    await response.body?.cancel();
    if (response.status === 402) throw new ReferenceError(402, "app_ai_unavailable", "Eazo AI 额度不足或暂不可用，请检查 App AI 额度后重试");
    throw new ReferenceError(502, "ai_request_failed", `蒸馏模型请求失败（${response.status}），未生成参考卡`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ReferenceError(502, "empty_completion", "蒸馏模型返回空内容");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 512_000) { await reader.cancel(); throw new ReferenceError(502, "ai_response_too_large", "蒸馏响应超出安全上限"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  let result: { choices?: { finish_reason?: string; message?: { content?: unknown } }[]; usage?: { total_tokens?: number } };
  try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ReferenceError(502, "invalid_completion", "蒸馏模型返回了无法解析的响应"); }
  const choice = result.choices?.[0];
  if (choice?.finish_reason === "length") throw new ReferenceError(502, "truncated_completion", "蒸馏输出被截断，请减少选章后重试");
  if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) throw new ReferenceError(502, "empty_completion", "蒸馏模型未返回可用内容");
  return { text: choice.message.content, tokens: Math.max(0, Number(result.usage?.total_tokens) || 0), modelLabel: distillationReadiness().modelLabel };
}
