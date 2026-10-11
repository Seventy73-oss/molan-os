import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SceneId } from "./agent/adapter";
import { emitChunked, OpenAICompatibleAdapter } from "./agent/openai";
import { getAdapter } from "./agent/runtime";
import {
  beginGeneration,
  buildContext,
  chat,
  completeGeneration,
  currentRevisionIdFor,
  demoteCancelledResultRevision,
  generationWriteShouldBeCandidate,
  HttpError,
  linkGenerationResultRevision,
  rewriteSelection,
  saveRevision,
} from "./engine";
import { formatOpenHooksForReview } from "./hooks";
import { db, type RouteRow } from "./db";
import { selectionSkillScene, skillPromptMeta, skillsForScene, toSkillTexts } from "./skills";
import { sceneKind } from "./agent/adapter";
import { normalizeThinking } from "./thinking";
import { isAbortError, throwIfAborted } from "./abortUtil";
import { estimateTokensFromText, recordUsage } from "./usage";

export const EMPTY_STREAM_RETRIES = 2;

type Emit = (event: Record<string, unknown>) => Promise<void>;

function routeFor(scene: string): RouteRow {
  const route = db.prepare("SELECT * FROM scene_routes WHERE scene = ?").get(scene) as RouteRow | undefined;
  return route ?? { scene, provider: "local", model_id: "local-draft", base_url: null, thinking_intensity: "medium" };
}

async function streamAdapterRun(
  route: RouteRow,
  input: Parameters<ReturnType<typeof getAdapter>["runScene"]>[0],
  emit: Emit,
) {
  throwIfAborted(input.signal);
  const adapter = getAdapter(route);
  if (adapter instanceof OpenAICompatibleAdapter) {
    await emit({ type: "status", message: "正在连接模型…" });
    // 中转偶发返回空流（无任何 token）：未输出任何内容时自动重试，最多再试 EMPTY_STREAM_RETRIES 次
    for (let attempt = 0; ; attempt++) {
      let emitted = 0;
      try {
        return await adapter.runSceneStream(input, async (delta) => {
          throwIfAborted(input.signal);
          emitted += delta.length;
          await emit({ type: "token", text: delta });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "";
        if (emitted === 0 && attempt < EMPTY_STREAM_RETRIES && /空流式响应/.test(msg) && !input.signal?.aborted) {
          await emit({ type: "status", message: `模型返回空流，自动重试（${attempt + 1}/${EMPTY_STREAM_RETRIES}）…` });
          continue;
        }
        throw error;
      }
    }
  }
  await emit({ type: "status", message: "本地草稿生成中…" });
  const result = await adapter.runScene(input);
  throwIfAborted(input.signal);
  await emitChunked(
    result.text,
    async (delta) => {
      await emit({ type: "token", text: delta });
    },
    24,
    input.signal,
  );
  return result;
}

export function sseJson(c: Context, run: (emit: Emit, signal: AbortSignal) => Promise<void>) {
  const signal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    let seq = 0;
    const emit: Emit = async (event) => {
      throwIfAborted(signal);
      await stream.writeSSE({ data: JSON.stringify(event), id: String(++seq) });
    };
    try {
      await run(emit, signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        try {
          await emit({ type: "error", message: "已取消" });
        } catch {
          /* client already gone */
        }
        return;
      }
      const message = error instanceof HttpError ? error.message : error instanceof Error ? error.message : "流式失败";
      try {
        await emit({ type: "error", message });
      } catch {
        /* ignore */
      }
    }
  });
}

export async function streamSceneRun(
  emit: Emit,
  input: {
    bookId: string;
    scene: SceneId;
    chapterNumber: number | null;
    instruction?: string;
    skillIds?: string[];
    signal?: AbortSignal;
    generationId?: string | null;
    expectedRevisionId?: string | null;
    onConflict?: "throw" | "candidate";
  },
) {
  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(input.bookId) as { id: string } | undefined;
  if (!book) throw new HttpError(404, "没有这本书");

  const needsChapter =
    input.scene === "chapter_outline" ||
    input.scene === "chapter_body" ||
    input.scene === "review" ||
    input.scene === "humanize" ||
    input.scene === "memory_extract";
  const chapterNumber = needsChapter ? input.chapterNumber ?? 1 : null;
  if (chapterNumber) {
    const chapter = db
      .prepare("SELECT id FROM chapters WHERE book_id = ? AND number = ?")
      .get(input.bookId, chapterNumber) as { id: string } | undefined;
    if (!chapter) throw new HttpError(400, `没有第 ${chapterNumber} 章`);
  }

  const kind = sceneKind(input.scene);
  const writeChapterNumber =
    kind === "book_profile" || kind === "book_outline" || !kind ? null : chapterNumber;
  const baselineRevisionId =
    input.expectedRevisionId !== undefined
      ? input.expectedRevisionId
      : kind
        ? currentRevisionIdFor(input.bookId, kind, writeChapterNumber)
        : undefined;
  const writeOnConflict = input.onConflict ?? "candidate";

  if (input.generationId) {
    const began = beginGeneration({
      id: input.generationId,
      bookId: input.bookId,
      scene: input.scene,
      chapterNumber,
      baseRevisionId: baselineRevisionId ?? null,
    });
    if (began.reused) {
      if (began.status === "completed" && began.result) {
        await emit({ type: "done", payload: began.result });
        return;
      }
      if (began.status === "running") {
        throw new HttpError(409, "同一 generationId 仍在执行，请查询状态而非重试");
      }
      if (began.status === "failed") {
        throw new HttpError(502, began.error || "上次生成失败");
      }
      if (began.status === "cancelled") {
        throw new HttpError(409, "该生成已取消");
      }
    }
  }

  try {
    const skills = skillsForScene(input.scene, input.skillIds);
    const skillTexts = toSkillTexts(skills);
    let instruction = input.instruction?.trim() ?? "";
    if (input.scene === "review" && chapterNumber) {
      const hookBlock = formatOpenHooksForReview(input.bookId, chapterNumber);
      if (hookBlock) instruction = [instruction, hookBlock].filter(Boolean).join("\n\n");
    }
    const context = buildContext(input.bookId, chapterNumber, instruction, {
      scene: input.scene,
      generationId: input.generationId,
      persist: true,
    });
    const route = routeFor(input.scene);
    const result = await streamAdapterRun(
      route,
      {
        scene: input.scene,
        model: route.model_id,
        thinkingIntensity: normalizeThinking(route.thinking_intensity),
        skillTexts,
        context,
        instruction,
        signal: input.signal,
      },
      emit,
    );

    throwIfAborted(input.signal);
    try {
      // C8：流式路径也记用量（优先 provider usage，否则估算）
      const promptTokens = result.usage?.promptTokens ?? estimateTokensFromText(context + instruction);
      const completionTokens = result.usage?.completionTokens ?? estimateTokensFromText(result.text);
      recordUsage({
        bookId: input.bookId,
        scene: input.scene,
        model: result.modelUsed,
        provider: route.provider,
        promptTokens,
        completionTokens,
        totalTokens: result.usage?.totalTokens ?? promptTokens + completionTokens,
        local: /local/i.test(result.modelUsed),
        meta: { stream: true, chars: Array.from(result.text).length },
      });
    } catch (error) {
      console.error("[usage] stream record failed", error);
    }

    const asCandidateNow = generationWriteShouldBeCandidate(input.generationId, input.signal);
    const saved = kind
      ? saveRevision({
          bookId: input.bookId,
          kind,
          chapterNumber: kind === "book_profile" || kind === "book_outline" ? null : chapterNumber,
          body: result.text,
          source: asCandidateNow ? "agent_cancelled" : "agent",
          model: result.modelUsed,
          skillIds: skills.map((skill) => skill.id),
          scene: input.scene,
          expectedRevisionId: baselineRevisionId,
          asCandidate: asCandidateNow,
          onConflict: writeOnConflict,
        })
      : null;

    if (input.generationId && saved?.revisionId) {
      linkGenerationResultRevision(input.generationId, saved.revisionId);
    }

    if (
      saved?.revisionId &&
      saved.current &&
      generationWriteShouldBeCandidate(input.generationId, input.signal)
    ) {
      demoteCancelledResultRevision(saved.revisionId);
      if (input.generationId) {
        completeGeneration(input.generationId, {
          status: "cancelled",
          resultRevisionId: saved.revisionId,
          error: "已取消（已退回上一版修订）",
          result: {
            cancelRevert: true,
            note: "取消前已写入的修订已退回上一版；该次结果保留在版本历史（来源 agent_cancelled）。",
            saved: { ...saved, current: false },
          },
        });
      }
      const err = new Error("已取消");
      err.name = "AbortError";
      throw err;
    }

    const payload = {
      text: result.text,
      modelUsed: result.modelUsed,
      skills: skills.map((skill) => ({ id: skill.id, name: skill.name, role: skill.role })),
      skillPromptMeta: skillPromptMeta(skillTexts),
      saved,
    };
    if (input.generationId) {
      if (generationWriteShouldBeCandidate(input.generationId, input.signal)) {
        completeGeneration(input.generationId, {
          status: "cancelled",
          resultRevisionId: saved?.revisionId ?? null,
          error: "已取消",
          result: { ...payload, current: false },
        });
        const err = new Error("已取消");
        err.name = "AbortError";
        throw err;
      }
      completeGeneration(input.generationId, {
        status: "completed",
        resultRevisionId: saved && "revisionId" in saved ? saved.revisionId : null,
        result: payload,
      });
    }
    await emit({ type: "done", payload });
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) {
      if (input.generationId) {
        const { cancelGeneration } = await import("./engine");
        cancelGeneration(input.generationId);
      }
      throw error;
    }
    if (input.generationId) {
      completeGeneration(input.generationId, {
        status: "failed",
        error: error instanceof Error ? error.message : "流式失败",
      });
    }
    throw error;
  }
}

export async function streamSelectionRewrite(
  emit: Emit,
  input: { bookId: string; selection: string; instruction: string; scene?: SceneId; signal?: AbortSignal },
) {
  const route = routeFor(
    input.scene &&
      ["chapter_body", "humanize", "chapter_outline", "outline", "review", "book_setup"].includes(input.scene)
      ? input.scene
      : "humanize",
  );
  if (route.provider === "openai") {
    const adapter = getAdapter(route);
    if (adapter instanceof OpenAICompatibleAdapter) {
      await emit({ type: "status", message: "正在改写选区…" });
      try {
        const skillRows = skillsForScene(selectionSkillScene(input.scene));
        const skillTexts = toSkillTexts(skillRows, 36000);
        const result = await adapter.runSceneStream(
          {
            scene: "humanize",
            model: route.model_id,
            thinkingIntensity: normalizeThinking(route.thinking_intensity),
            skillTexts,
            context: `【待改片段】\n${input.selection}\n`,
            instruction: [
              input.instruction,
              "只改写上面的「待改片段」。",
              "只输出改写后的文字本身，不要标题、引号包裹、创作说明或前后缀。",
              "对白只用弯引号“”，不要用「」、（）或()包说话。",
              /续写/.test(input.instruction) ? "若指令是续写：只输出接在选区后面的新文字，不要重复原文。" : "",
            ]
              .filter(Boolean)
              .join("\n"),
            signal: input.signal,
          },
          async (delta) => {
            throwIfAborted(input.signal);
            await emit({ type: "token", text: delta });
          },
        );
        throwIfAborted(input.signal);
        const { normalizeDialogueQuotes } = await import("./agent/localDraft");
        let text = normalizeDialogueQuotes(result.text.replace(/\r\n?/g, "\n").trim());
        const selection = input.selection.replace(/\r\n?/g, "\n").trim();
        if (text.length > Math.max(selection.length * 4, 1200) && !/续写/.test(input.instruction)) {
          throw new HttpError(502, "模型返回过长，已拒绝替换选区（请缩短指令或重试）");
        }
        if (!text) {
          throw new HttpError(502, "模型返回为空");
        }
        await emit({
          type: "done",
          payload: {
            text,
            modelUsed: result.modelUsed,
            local: false,
            skills: skillRows.map((s) => ({ id: s.id, name: s.name, role: s.role })),
            skillPromptMeta: skillPromptMeta(skillTexts),
          },
        });
        return;
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof HttpError) throw error;
        const reason = error instanceof Error ? error.message : "流式改写失败";
        throw new HttpError(502, reason);
      }
    }
  }

  throwIfAborted(input.signal);
  const result = await rewriteSelection(input);
  throwIfAborted(input.signal);
  await emit({ type: "status", message: result.local ? "本地草稿改写中…" : "改写完成，正在呈现…" });
  await emitChunked(
    result.text,
    async (delta) => {
      await emit({ type: "token", text: delta });
    },
    24,
    input.signal,
  );
  await emit({ type: "done", payload: result });
}

export async function streamChat(
  emit: Emit,
  bookId: string,
  message: string,
  preferredChapter?: number | null,
  generationId?: string | null,
  signal?: AbortSignal,
) {
  await emit({ type: "status", message: "助手正在写…" });
  try {
    throwIfAborted(signal);
    const result = await chat(bookId, message, preferredChapter, generationId, signal);
    throwIfAborted(signal);
    const body = result.message.content;
    const newline = body.indexOf("\n");
    const head = newline >= 0 ? body.slice(0, newline + 1) : body;
    const tail = newline >= 0 ? body.slice(newline + 1) : "";
    if (head) await emit({ type: "token", text: head });
    if (tail) {
      await emitChunked(
        tail,
        async (delta) => {
          await emit({ type: "token", text: delta });
        },
        36,
        signal,
      );
    }
    if (generationId) {
      completeGeneration(generationId, { status: "completed", result });
    }
    await emit({ type: "done", payload: result });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      if (generationId) {
        const { cancelGeneration } = await import("./engine");
        try {
          cancelGeneration(generationId);
        } catch {
          completeGeneration(generationId, { status: "cancelled", error: "已取消" });
        }
      }
      throw error;
    }
    if (generationId) {
      completeGeneration(generationId, {
        status: "failed",
        error: error instanceof Error ? error.message : "生成失败",
      });
    }
    throw error;
  }
}
