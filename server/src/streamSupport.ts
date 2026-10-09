import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SceneId } from "./agent/adapter";
import { emitChunked, OpenAICompatibleAdapter } from "./agent/openai";
import { getAdapter } from "./agent/runtime";
import {
  buildContext,
  chat,
  HttpError,
  rewriteSelection,
  saveRevision,
} from "./engine";
import { db, type RouteRow } from "./db";
import { skillPromptMeta, skillsForScene, toSkillTexts } from "./skills";
import { sceneKind } from "./agent/adapter";
import { normalizeThinking } from "./thinking";

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
  const adapter = getAdapter(route);
  if (adapter instanceof OpenAICompatibleAdapter) {
    await emit({ type: "status", message: "正在连接模型…" });
    const result = await adapter.runSceneStream(input, async (delta) => {
      await emit({ type: "token", text: delta });
    });
    return result;
  }
  await emit({ type: "status", message: "本地草稿生成中…" });
  const result = await adapter.runScene(input);
  await emitChunked(result.text, async (delta) => {
    await emit({ type: "token", text: delta });
  });
  return result;
}

export function sseJson(c: Context, run: (emit: Emit) => Promise<void>) {
  return streamSSE(c, async (stream) => {
    let seq = 0;
    const emit: Emit = async (event) => {
      await stream.writeSSE({ data: JSON.stringify(event), id: String(++seq) });
    };
    try {
      await run(emit);
    } catch (error) {
      const message = error instanceof HttpError ? error.message : error instanceof Error ? error.message : "流式失败";
      await emit({ type: "error", message });
    }
  });
}

export async function streamSceneRun(
  emit: Emit,
  input: { bookId: string; scene: SceneId; chapterNumber: number | null; instruction?: string; skillIds?: string[] },
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

  const skills = skillsForScene(input.scene, input.skillIds);
  const skillTexts = toSkillTexts(skills);
  const instruction = input.instruction?.trim() ?? "";
  const context = buildContext(input.bookId, chapterNumber, instruction);
  const route = routeFor(input.scene);
  const result = await streamAdapterRun(route, {
    scene: input.scene,
    model: route.model_id,
    thinkingIntensity: normalizeThinking(route.thinking_intensity),
    skillTexts,
    context,
    instruction,
  }, emit);

  const kind = sceneKind(input.scene);
  const saved = kind
    ? saveRevision({
        bookId: input.bookId,
        kind,
        chapterNumber: kind === "book_profile" || kind === "book_outline" ? null : chapterNumber,
        body: result.text,
        source: "agent",
        model: result.modelUsed,
        skillIds: skills.map((skill) => skill.id),
        scene: input.scene,
      })
    : null;

  const payload = {
    text: result.text,
    modelUsed: result.modelUsed,
    skills: skills.map((skill) => ({ id: skill.id, name: skill.name, role: skill.role })),
    skillPromptMeta: skillPromptMeta(skillTexts),
    saved,
  };
  await emit({ type: "done", payload });
}

export async function streamSelectionRewrite(
  emit: Emit,
  input: { bookId: string; selection: string; instruction: string; scene?: SceneId },
) {
  // Prefer real OpenAI stream when available; otherwise chunk the sync result.
  const route = routeFor(input.scene && ["chapter_body", "humanize", "chapter_outline", "outline", "review", "book_setup"].includes(input.scene) ? input.scene : "humanize");
  if (route.provider === "openai") {
    const adapter = getAdapter(route);
    if (adapter instanceof OpenAICompatibleAdapter) {
      await emit({ type: "status", message: "正在改写选区…" });
      try {
        const skillRows = skillsForScene("humanize");
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
              /续写/.test(input.instruction) ? "若指令是续写：只输出接在选区后面的新文字，不要重复原文。" : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
          async (delta) => {
            await emit({ type: "token", text: delta });
          },
        );
        let text = result.text.replace(/\r\n?/g, "\n").trim();
        const selection = input.selection.replace(/\r\n?/g, "\n").trim();
        let local = false;
        if (text.length > Math.max(selection.length * 4, 1200) && !/续写/.test(input.instruction)) {
          const { rewriteSelectionLocal } = await import("./agent/localDraft");
          text = rewriteSelectionLocal(selection, input.instruction);
          local = true;
        }
        if (!text) {
          const { rewriteSelectionLocal } = await import("./agent/localDraft");
          text = rewriteSelectionLocal(selection, input.instruction);
          local = true;
        }
        await emit({ type: "done", payload: { text, modelUsed: local ? `local-draft (${result.modelUsed})` : result.modelUsed, local, skills: skillRows.map((s) => ({ id: s.id, name: s.name, role: s.role })), skillPromptMeta: skillPromptMeta(skillTexts) } });
        return;
      } catch {
        // fall through to sync rewrite
      }
    }
  }

  const result = await rewriteSelection(input);
  await emit({ type: "status", message: result.local ? "本地草稿改写中…" : "改写完成，正在呈现…" });
  await emitChunked(result.text, async (delta) => {
    await emit({ type: "token", text: delta });
  });
  await emit({ type: "done", payload: result });
}

export async function streamChat(emit: Emit, bookId: string, message: string, preferredChapter?: number | null) {
  // Chat persistence + routing is complex; stream status then run sync chat, then chunk the assistant body.
  await emit({ type: "status", message: "助手正在写…" });
  const result = await chat(bookId, message, preferredChapter);
  const body = result.message.content;
  // Prefer streaming the manuscript body after the first line if saved.
  const newline = body.indexOf("\n");
  const head = newline >= 0 ? body.slice(0, newline + 1) : body;
  const tail = newline >= 0 ? body.slice(newline + 1) : "";
  if (head) await emit({ type: "token", text: head });
  if (tail) {
    await emitChunked(tail, async (delta) => {
      await emit({ type: "token", text: delta });
    }, 36);
  }
  await emit({ type: "done", payload: result });
}

