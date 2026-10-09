/**
 * Real adapter for `@earendil-works/pi-agent-core`.
 * Package is installed; Models page reports available when the module resolves.
 * runScene always exercises the Agent class:
 *  - With OpenAI-compatible credentials → generate via OpenAICompatibleAdapter, deliver through Agent+faux
 *  - Without credentials → LocalDraftAdapter text delivered through Agent+faux
 * This keeps the pi runtime on the critical path without inventing fake "success" when the package is missing.
 */
import { createRequire } from "node:module";
import type { AgentRuntimeAdapter, RunInput, RunOutput } from "./adapter";
import { LocalDraftAdapter } from "./localDraft";
import { OpenAICompatibleAdapter } from "./openai";
import { resolveProvider } from "../provider";

const PACKAGE_NAME = "@earendil-works/pi-agent-core";
const require = createRequire(import.meta.url);

export type AgentCapability = {
  id: "local-draft" | "openai-compatible" | "pi-agent";
  label: string;
  available: boolean;
  reason: string;
  packageName?: string;
};

export function isPiPackageInstalled(): boolean {
  try {
    // ESM-only package: require.resolve may fail on exports map; fall back to package.json path.
    require.resolve(PACKAGE_NAME);
    return true;
  } catch {
    try {
      require.resolve(`${PACKAGE_NAME}/package.json`);
      return true;
    } catch {
      return false;
    }
  }
}

export function probePiCapability(): AgentCapability {
  if (isPiPackageInstalled()) {
    return {
      id: "pi-agent",
      label: "pi-agent-core",
      available: true,
      reason: "已安装 @earendil-works/pi-agent-core；设 MOLAN_AGENT_RUNTIME=pi（兼容 CHANGJUAN_AGENT_RUNTIME）或路由 provider=pi 启用",
      packageName: PACKAGE_NAME,
    };
  }
  return {
    id: "pi-agent",
    label: "pi-agent-core",
    available: false,
    reason: `未安装 ${PACKAGE_NAME}`,
    packageName: PACKAGE_NAME,
  };
}

function extractAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text!)
        .join("");
      if (text.trim()) return text.trim();
    }
  }
  return "";
}

export class PiAgentAdapter implements AgentRuntimeAdapter {
  static async tryCreate(): Promise<PiAgentAdapter | null> {
    if (!isPiPackageInstalled()) return null;
    try {
      await import(PACKAGE_NAME);
      await import("@earendil-works/pi-ai");
      return new PiAgentAdapter();
    } catch (error) {
      console.warn("[pi-agent] import failed:", error instanceof Error ? error.message : error);
      return null;
    }
  }

  async runScene(input: RunInput): Promise<RunOutput> {
    const { Agent } = await import("@earendil-works/pi-agent-core");
    const { createModels, fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");

    const prompt = [
      `场景: ${input.scene}`,
      input.instruction ? `指令: ${input.instruction}` : "",
      input.skillTexts.map((s) => `# ${s.name}\n${s.text}`).join("\n\n"),
      input.context,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Produce draft text first (openai if configured, else local), then run it through Agent.
    let draft: RunOutput;
    try {
      const resolved = resolveProvider({
        base_url: null,
        model_id: input.model || null,
      });
      if (resolved.apiKey && resolved.baseUrl && resolved.model) {
        draft = await new OpenAICompatibleAdapter({
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          model: resolved.model,
        }).runScene(input);
      } else {
        draft = await new LocalDraftAdapter().runScene(input);
      }
    } catch {
      draft = await new LocalDraftAdapter().runScene(input);
    }

    const models = createModels();
    const faux = fauxProvider({
      models: [{ id: "molan-pi", name: "墨兰写作 pi" }],
    });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(draft.text)]);

    const model = faux.getModel();
    const agent = new Agent({
      initialState: {
        systemPrompt: "你是墨兰写作的写作运行时（pi-agent）。只交付场景要求的中文稿件，不要解释过程。对白只用弯引号“…”（U+201C/U+201D），禁止用「」、（）或()包说话。",
        model,
      },
      streamFn: models.streamSimple.bind(models),
    });

    await agent.prompt(prompt.slice(0, 12000));
    await agent.waitForIdle();
    const text = extractAssistantText(agent.state.messages as Array<{ role?: string; content?: unknown }>);
    if (!text) throw new Error("pi-agent 返回空文本");
    return {
      text,
      modelUsed: `pi-agent/${draft.modelUsed}`,
    };
  }
}

export class PiAgentUnavailableAdapter implements AgentRuntimeAdapter {
  async runScene(_input: RunInput): Promise<RunOutput> {
    throw new Error(probePiCapability().reason);
  }
}
