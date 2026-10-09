export type SceneId =
  | "topic"
  | "book_setup"
  | "outline"
  | "chapter_outline"
  | "chapter_body"
  | "review"
  | "humanize"
  | "memory_extract"
  | "chat";

export type SkillText = {
  id: string;
  name: string;
  role: string;
  text: string;
};

export type RunInput = {
  scene: SceneId;
  model?: string;
  skillTexts: SkillText[];
  context: string;
  instruction?: string;
  /** off | low | medium | high */
  thinkingIntensity?: string;
};

export type RunOutput = {
  text: string;
  modelUsed: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

export interface AgentRuntimeAdapter {
  runScene(input: RunInput): Promise<RunOutput>;
}

export function sceneKind(scene: SceneId): string | null {
  switch (scene) {
    case "topic":
    case "book_setup":
      return "book_profile";
    case "outline":
      return "book_outline";
    case "chapter_outline":
      return "chapter_outline";
    case "chapter_body":
    case "humanize":
      return "chapter_body";
    case "review":
      return "review_report";
    case "memory_extract":
      return "chapter_memory";
    case "chat":
      return null;
    default:
      return null;
  }
}
