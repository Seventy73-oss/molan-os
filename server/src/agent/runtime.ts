import type { AgentRuntimeAdapter } from "./adapter";
import { LocalDraftAdapter } from "./localDraft";
import { OpenAICompatibleAdapter } from "./openai";
import {
  PiAgentAdapter,
  PiAgentUnavailableAdapter,
  isPiPackageInstalled,
  probePiCapability,
  type AgentCapability,
} from "./piAdapter";
import type { RouteRow } from "../db";
import { getDbInfo } from "../db";
import { resolveProvider } from "../provider";

class NotedLocalAdapter implements AgentRuntimeAdapter {
  constructor(private readonly reason: string) {}

  async runScene(input: Parameters<AgentRuntimeAdapter["runScene"]>[0]) {
    const local = await new LocalDraftAdapter().runScene(input);
    return { text: local.text, modelUsed: `local-draft (${this.reason})` };
  }
}

let piAdapterCache: PiAgentAdapter | null | undefined;

async function getPiAdapterCached(): Promise<PiAgentAdapter | null> {
  if (piAdapterCache !== undefined) return piAdapterCache;
  piAdapterCache = await PiAgentAdapter.tryCreate();
  return piAdapterCache;
}

export function getAdapter(route: RouteRow): AgentRuntimeAdapter {
  const envRuntime = (process.env.MOLAN_AGENT_RUNTIME || process.env.CHANGJUAN_AGENT_RUNTIME || "").trim().toLowerCase();
  const provider =
    envRuntime === "pi" || envRuntime === "openai" || envRuntime === "local" ? envRuntime : route.provider;

  if (provider === "pi") {
    if (!isPiPackageInstalled()) return new PiAgentUnavailableAdapter();
    return {
      async runScene(input) {
        const adapter = await getPiAdapterCached();
        if (!adapter) return new PiAgentUnavailableAdapter().runScene(input);
        return adapter.runScene(input);
      },
    };
  }

  if (provider !== "openai") return new LocalDraftAdapter();

  try {
    const { apiKey, baseUrl, model } = resolveProvider(route);
    if (!apiKey || !baseUrl || !model) {
      return new NotedLocalAdapter("还没有可用的 API Key、接口地址或模型 ID，已回退本地草稿");
    }
    return new OpenAICompatibleAdapter({ baseUrl, apiKey, model });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "接口地址不安全";
    return new NotedLocalAdapter(reason);
  }
}

export function listAgentCapabilities(): {
  capabilities: AgentCapability[];
  envRuntime: string | null;
  db: { driver: string; detail: string; ready: boolean };
  note: string;
} {
  const envRuntime = (process.env.MOLAN_AGENT_RUNTIME || process.env.CHANGJUAN_AGENT_RUNTIME || "").trim() || null;
  const db = getDbInfo();
  const capabilities: AgentCapability[] = [
    {
      id: "local-draft",
      label: "本地草稿",
      available: true,
      reason: "内置结构化中文草稿，无需密钥",
    },
    {
      id: "openai-compatible",
      label: "OpenAI 兼容",
      available: true,
      reason: "在「模型」页配置 Base URL / API Key 后按场景路由调用",
    },
    probePiCapability(),
  ];
  return {
    capabilities,
    envRuntime,
    db,
    note:
      `存储：${db.ready ? db.driver : "初始化中"}（DATABASE_URL / MOLAN_DB 或 CHANGJUAN_DB=postgres|pglite，默认 sqlite；库文件仍为 data/changjuan.sqlite）。` +
      " pi-agent 已接入 @earendil-works/pi-agent-core；provider/env 选 pi 时走 Agent 运行时。",
  };
}
