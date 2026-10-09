import { readFileSync } from "node:fs";
import type { AgentRuntimeAdapter, RunInput, RunOutput, SkillText } from "./adapter";
import { normalizeThinking } from "../thinking";

type PresetChapter = {
  title: string;
  beat: string;
  scenes: string[][];
  hook: string;
  body: string;
};

type PresetFile = {
  title: string;
  genre: string;
  logline: string;
  style: string;
  role: string;
  protagonist: string;
  client: string;
  antagonist: string;
  father: string;
  city: string;
  place: string;
  object: string;
  chapters: PresetChapter[];
};

type SceneBlock = { name: string; goal: string; conflict: string; detail: string };

type ChapterPlan = {
  title: string;
  beat: string;
  scenes: SceneBlock[];
  hook: string;
  body: string;
};

type World = {
  title: string;
  genre: string;
  logline: string;
  style: string;
  role: string;
  protagonist: string;
  client: string;
  antagonist: string;
  city: string;
  place: string;
  object: string;
  secret: string;
  profile: string;
  chapters: ChapterPlan[];
  preset: boolean;
};

const preset = JSON.parse(
  readFileSync(new URL("./preset.json", import.meta.url), "utf8"),
) as PresetFile;

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function cnNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  if (token === "十") return 10;
  if (token.startsWith("十")) return 10 + (CN_DIGIT[token.slice(1)] ?? 0);
  const idx = token.indexOf("十");
  if (idx > 0) {
    const hi = CN_DIGIT[token.slice(0, idx)] ?? 1;
    const lo = token.slice(idx + 1);
    return hi * 10 + (lo ? (CN_DIGIT[lo] ?? 0) : 0);
  }
  return CN_DIGIT[token] ?? null;
}

function hash(input: string): number {
  let h = 2166136261;
  for (const ch of input) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
}

function pick<T>(seed: string, items: T[]): T {
  return items[hash(seed) % items.length]!;
}

function len(text: string): number {
  return Array.from(text).length;
}

function section(text: string, name: string): string {
  const match = text.match(new RegExp(`【${name}】\\n([\\s\\S]*?)(?=\\n【|$)`));
  return (match?.[1] ?? "").trim();
}

function field(text: string, label: string): string {
  const match = text.match(new RegExp(`^${label}：(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

function chapterNumberFrom(text: string): number | null {
  const labeled = text.match(/章号：\s*(\d+)/);
  if (labeled) return Number(labeled[1]);
  const verbal = text.match(/第\s*(\d+|[一二三四五六七八九十两]+)\s*章/);
  if (!verbal) return null;
  return cnNumber(verbal[1] ?? "");
}

function countFrom(text: string): number | null {
  const labeled = text.match(/目标章数：\s*(\d+)/);
  if (labeled) return Number(labeled[1]);
  const verbal = text.match(/(\d+|[一二三四五六七八九十两]+)\s*章/);
  if (!verbal) return null;
  return cnNumber(verbal[1] ?? "");
}

function sceneBlocks(rows: string[][]): SceneBlock[] {
  return rows.map((row) => ({
    name: row[0] ?? "场景",
    goal: row[1] ?? "",
    conflict: row[2] ?? "",
    detail: row[3] ?? "",
  }));
}

function presetProfile(): string {
  return [
    `${preset.protagonist}，三十二岁，在${preset.city}${preset.place}做${preset.role}。铺子没有招牌，常客叫它慢修。他修表、修锁、修断过的伞骨，不替别人把话说圆。九年前他的父亲死在工作台上，记录写成台灯短路。他不再在子时开工。`,
    `${preset.client}是钟表匠${preset.father}的女儿。${preset.father}失踪前一夜见过古董商${preset.antagonist}。她拿来的怀表停在十一点五十七分，后盖新刻着“勿在子时打开”，机芯里还有一套不带动指针的齿轮。`,
    `${preset.antagonist}经营画廊，账上登记过十二只表。他认“慢针”是沈家工坊的印记，不觉得自己在藏人。他的条件始终是：表先回来。`,
    "这本书写城市里的手艺和隐瞒。线索只放在物件上：断口、镀层、刻字深浅、工具朝向。不写通灵，不写全知内心。每章收在一个具体动作上。",
  ].join("\n\n");
}

function presetWorld(): World {
  return {
    title: preset.title,
    genre: preset.genre,
    logline: preset.logline,
    style: preset.style,
    role: preset.role,
    protagonist: preset.protagonist,
    client: preset.client,
    antagonist: preset.antagonist,
    city: preset.city,
    place: preset.place,
    object: preset.object,
    secret: "被固定死的读数",
    profile: presetProfile(),
    preset: true,
    chapters: preset.chapters.map((chapter) => ({
      title: chapter.title,
      beat: chapter.beat,
      scenes: sceneBlocks(chapter.scenes),
      hook: chapter.hook,
      body: chapter.body.trim(),
    })),
  };
}

const STEMS = [
  "把东西收下",
  "看见不该有的痕迹",
  "守住一条规矩",
  "让对手先开口",
  "得到第二件证据",
  "走进旧地址",
  "发现记忆被修过",
  "当着别人的面对质",
  "失去原来的落脚点",
  "捡到多出来的部分",
  "把东西打开",
  "在别人面前做完选择",
];

function isPresetText(text: string): boolean {
  return /旧物修复|怀表|慢针|沈酌|青桐巷|林伯年|勿在子时打开/.test(text);
}

function genericWorld(blob: string): World {
  const roleMatch = blob.match(/主角是([^，,。\n]{1,16})/);
  const cleanRole = (roleMatch?.[1] ?? "调查者").replace(/[的之].*$/, "") || "调查者";
  const genreField = field(blob, "题材");
  const genre = genreField || blob.split(/[，,。\n]/)[0]?.trim() || "长篇";
  const seed = `${genre}|${cleanRole}|${blob.slice(0, 80)}`;
  const protagonist = pick(seed + "p", ["陈迟", "顾晚", "许昭", "沈宁", "周川"]);
  const client = pick(seed + "c", ["宋小满", "叶知", "江澄", "裴晓"]);
  const antagonist = pick(seed + "a", ["韩峙", "孟谦", "邱朗"]);
  const city = pick(seed + "city", ["江州", "南埠", "澄市"]);
  const place = pick(seed + "place", ["旧货楼的里间", "沿河的工作间", "档案馆侧门"]);
  const object = /言情|恋爱|爱情/.test(genre)
    ? "一封没有落款的信"
    : /科幻|未来/.test(genre)
      ? "一只走时错位的终端"
      : /武侠|江湖/.test(genre)
        ? "一截被换过穗的剑"
        : /历史|民国/.test(genre)
          ? "一页被涂改的户籍"
          : "一把缺了齿的旧钥匙";
  const secret = /科幻/.test(genre) ? "坐标" : /言情|恋爱/.test(genre) ? "约定" : "日期";
  const titled = blob.match(/《([^》]{1,16})》/)?.[1];
  const named = blob.match(/书名(?:是|为|：|:)\s*([^\s，,。]{1,16})/)?.[1];
  const fieldTitle = field(blob, "书名");
  const generated = pick(seed + "t", ["未寄出", "缺齿", "夜页", "旧址", "第三行", "回声"]);
  const title =
    (titled && titled) ||
    (named && !/自定|待定|未定/.test(named) ? named : "") ||
    (fieldTitle && !/自定|未命名|待定/.test(fieldTitle) ? fieldTitle : "") ||
    generated;
  const count = Math.min(24, Math.max(4, countFrom(blob) ?? 12));
  const style = field(blob, "文风") || "短句，少判断，对话只说人物此刻肯说的话。";
  const logline = `${city}${place}的${cleanRole}${protagonist}收下${object}。委托人${client}要它恢复原样，${antagonist}要的却是里面那个还没被说完的${secret}。`;
  const chapters: ChapterPlan[] = [];
  for (let i = 0; i < count; i += 1) {
    const stem = STEMS[i] ?? `把第 ${i + 1} 步做完`;
    const titleN = i < 12 ? stem : `第 ${i + 1} 步`;
    const beat = `${protagonist}在${place}${stem}。${object}的状态因此改变，${client}看见了，${antagonist}不能再假装这件事没有发生。`;
    chapters.push({
      title: titleN,
      beat,
      hook: `${object}上多出一个只有${protagonist}的职业才认得的痕迹。`,
      scenes: [
        {
          name: "接手",
          goal: `${protagonist}用职业动作确认${object}的现状。`,
          conflict: `${client}希望立刻得到结论，他拒绝先下结论。`,
          detail: `${object}被放在桌上，灯光只打在有问题的那一处。`,
        },
        {
          name: "压力",
          goal: `让${antagonist}或${client}说出一句不能收回的话。`,
          conflict: "对方用更顺的解释盖住缺口。",
          detail: "有一个细节和解释对不上，人物先不点破。",
        },
        {
          name: "留下",
          goal: "把这一章的变化落到物件上。",
          conflict: "说出来会把人推进危险，不说则下一章失去根据。",
          detail: "章末只留一个动作，不留感想。",
        },
      ],
      body: "",
    });
  }
  const profile = [
    `${protagonist}在${city}靠${cleanRole}谋生，做事的顺序固定：先看材料，再听人说话。`,
    `${client}把${object}送来。${client}要的是恢复，不是故事。`,
    `${antagonist}出现得比官方记录更早。他有自己的理由，理由里藏着那个${secret}。`,
    `叙述保持短句。不写通灵，不替人物总结主题。每章只推进一个不能退回的变化。`,
  ].join("\n\n");
  const world: World = {
    title,
    genre,
    logline,
    style,
    role: cleanRole,
    protagonist,
    client,
    antagonist,
    city,
    place,
    object,
    secret,
    profile,
    chapters,
    preset: false,
  };
  world.chapters = world.chapters.map((chapter, index) => ({
    ...chapter,
    body: genericBody(world, index),
  }));
  return world;
}

function genericBody(world: World, index: number): string {
  const chapter = world.chapters[index]!;
  const step = index + 1;
  const paragraphs = [
    `${world.city}的${world.place}这个时候不接待闲人。${world.protagonist}把${world.object}转到有光的一面，先看材料，再看${world.client}的脸。第 ${step} 章要做的事只有一件：${chapter.title}。`,
    `“你先告诉我它还能不能用。”${world.client}说。${world.protagonist}摇头。“能用之前，我得知道它哪里被人动过。”他指出一处不该新的边缘。${world.client}看见了，却没有承认自己也发现过。`,
    `${world.antagonist}的消息比人先到。有人在门外留下一句很顺的解释：东西是旧的，人是自己走的，${world.secret}并不存在。${world.protagonist}把这句解释写在纸上，又在旁边记下它盖不住的那个痕迹。`,
    `他没有把结论说满。他把${world.object}收进不马上归还的位置，对${world.client}只留一个时间。“下一回你来，不要一个人来。”${chapter.hook}`,
    `${world.protagonist}把今天的事实单独写成三行：物件的状态、${world.client}离开的时刻、${world.antagonist}那句过于顺的话。纸上没有形容词。没有形容词，后面的章节才改不了这些事实。`,
  ];
  let text = paragraphs.join("\n\n");
  if (len(text) < 620) {
    text += `\n\n${world.place}重新安静下来。${world.protagonist}知道安静不是结束，只是${world.object}暂时不再发出声音。`;
  }
  return text;
}

function resolveWorld(input: RunInput): World {
  const brief = section(input.context, "题材简述");
  const book = section(input.context, "书");
  const archive = section(input.context, "档案");
  const blob = [brief, book, archive, input.instruction ?? "", input.context].join("\n");
  if (isPresetText(blob)) return presetWorld();
  const world = genericWorld(blob);
  const catalog = section(input.context, "章目");
  const titles = catalog
    .split("\n")
    .map((line) => line.match(/^(\d+)\.\s+(.+)$/))
    .filter((item): item is RegExpMatchArray => Boolean(item));
  for (const item of titles) {
    const index = Number(item[1]) - 1;
    const title = item[2]?.trim();
    if (world.chapters[index] && title && !/^第\d+章$/.test(title)) {
      world.chapters[index]!.title = title;
    }
  }
  const titled = field(book, "书名");
  if (titled) world.title = titled;
  const genre = field(book, "题材");
  if (genre) world.genre = genre;
  const logline = field(book, "简介");
  if (logline) world.logline = logline;
  const style = field(book, "文风");
  if (style) world.style = style;
  return world;
}

function renderProfile(world: World): string {
  return [
    `书名：${world.title}`,
    `题材：${world.genre}`,
    `简介：${world.logline}`,
    `文风：${world.style}`,
    `目标章数：${world.chapters.length}`,
    "每章字数：800",
    "",
    "章目：",
    ...world.chapters.map((chapter, index) => `${index + 1}. ${chapter.title}`),
    "",
    "档案",
    "",
    world.profile,
  ].join("\n");
}

function renderTopic(world: World): string {
  return [
    `题材：${world.genre}`,
    `书名：${world.title}`,
    `读者：愿意跟着职业动作往下看、不爱听作者总结的人。`,
    `外在目标：${world.protagonist}要弄清${world.object}为什么变成现在这样。`,
    `反对的力量：${world.antagonist}有自己的理由，而且比主角更早行动。`,
    `类型承诺：线索来自物件，不来自突然揭晓的身世。`,
    "不写：通灵、金手指、全知解释、与主线无关的第二条大案子。",
    `卖点：${world.role}的手艺本身就是调查方法。`,
    "",
    world.logline,
    "",
    "开篇就要看见的三个细节：物件上新的痕迹、委托人没说完的半句话、对手比官方更早出现。",
    `后段才揭开的事实：${world.secret}一直在开篇那件东西上，只是当时还不能读懂。`,
  ].join("\n");
}

function renderOutline(world: World): string {
  return world.chapters
    .map((chapter, index) => `${index + 1}. ${chapter.title}\n${chapter.beat}`)
    .join("\n\n");
}

function cnLabel(n: number): string {
  return ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][n] ?? String(n);
}

function renderChapterOutline(world: World, number: number): string {
  const chapter = world.chapters[number - 1] ?? world.chapters[world.chapters.length - 1];
  if (!chapter) return `第${number}章\n\n这一章还没有可以展开的章目。`;
  const scenes = chapter.scenes
    .map(
      (scene, index) =>
        `场景${cnLabel(index + 1)} · ${scene.name}\n目标：${scene.goal}\n冲突：${scene.conflict}\n细节：${scene.detail}`,
    )
    .join("\n\n");
  return `第${number}章 ${chapter.title}\n\n${scenes}\n\n章末钩子：${chapter.hook}`;
}


/** Spoken dialogue must use “…” (U+201C/U+201D) only; never 「」, （）, or (). */
export function normalizeDialogueQuotes(text: string): string {
  let out = text;
  // After speech verbs: 说（…）→ 说“…”
  out = out.replace(
    /(说|道|问|喊|答|叫|骂|笑|回|应|斥|劝|吼|嘀咕|低语)([道了着过]?)\s*[（(]([^（）()]{1,160})[）)]/g,
    "$1$2“$3”",
  );
  // Standalone paren speech lines / clauses that look like talk
  out = out.replace(/(^|\n)\s*[（(]([^（）()\n]{1,160})[）)]\s*(?=\n|$)/g, "$1“$2”");
  // Inline speech-like paren containing sentence-final particles
  out = out.replace(
    /[（(]([^（）()]{0,100}[吗吧啊呢嘛哟呵唉][！？!?。…]?)[）)]/g,
    "“$1”",
  );
  // Convert corner brackets used as speech quotes → curly quotes
  out = out.replace(/「/g, "“").replace(/」/g, "”");
  return out;
}

function dialogueEnabled(skills: SkillText[]): boolean {
  if (skills.length === 0) return true;
  return skills.some((skill) => skill.id === "dialogue" || skill.name.includes("对白"));
}

function applyDialogue(text: string, enabled: boolean): string {
  const normalized = normalizeDialogueQuotes(text);
  if (enabled) return normalized;
  return normalized.replace(/“([^”]*)”/g, "$1");
}

function renderBody(world: World, number: number, skills: SkillText[]): string {
  const chapter = world.chapters[number - 1];
  const raw = chapter?.body || genericBody(world, Math.max(0, number - 1));
  return applyDialogue(raw, dialogueEnabled(skills));
}

function renderReview(context: string): string {
  const body = section(context, "本章正文");
  const outline = section(context, "本章细纲");
  const issues: string[] = [];
  if (!body) {
    return "审核\n\n1. [连续] 这一章还没有正文，细纲无从对照。\n\n优先改：先写正文，再审核。";
  }
  for (const tic of ["不禁", "宛如", "一抹", "与此同时", "心中涌起", "嘴角微微上扬"]) {
    if (body.includes(tic)) {
      issues.push(`[文风] 正文出现「${tic}」。这是套话，删掉，改成手上的动作。`);
    }
  }
  const quoted = [...outline.matchAll(/「([^」]{2,24})」/g)].map((item) => item[1] ?? "");
  for (const quote of quoted) {
    if (quote && !body.includes(quote)) {
      issues.push(`[连续] 细纲里的「${quote}」正文没有落地。补进动作，不要另起一段解释。`);
    }
  }
  const dialogues = body.match(/“/g)?.length ?? 0;
  if (/「/.test(body)) {
    issues.push("[文风] 对白用了「」。改成弯引号“”（U+201C/U+201D），不要用「」。");
  }
  if (/[（(][^）)]{1,80}[）)]/.test(body) && /(说|道|问|喊)[（(]|[（(][^）)]{0,40}[吗吧啊呢]/.test(body)) {
    issues.push("[文风] 对白用了括号（）或 ()。改成弯引号“”，括号不是对白。");
  }
  if (dialogues < 2) {
    issues.push("[文风] 对白少于两处，信息几乎都靠叙述。把一条信息改成人物在压力下说出口的话。");
  }
  const paragraphs = body.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  issues.push(`[物件] 章末停在「${Array.from(last).slice(0, 22).join("")}」。确认它是钩子，不是感想。`);
  const picked = issues.slice(0, 5);
  const lines = picked.map((issue, index) => `${index + 1}. ${issue}`).join("\n\n");
  const first = picked[0]?.replace(/^\[[^\]]+\]\s*/, "") ?? "对照章末再读一次。";
  return `审核\n\n${lines}\n\n优先改：${first}`;
}

function humanize(context: string): string {
  const body = section(context, "本章正文").trim();
  if (!body) return "这一章还没有正文，无法去 AI 味。";
  let text = body;
  const rules: [RegExp, string][] = [
    [/不禁/g, ""],
    [/宛如/g, "像"],
    [/仿佛/g, ""],
    [/一抹/g, ""],
    [/与此同时，?/g, ""],
    [/然而，?/g, "可"],
    [/深深地/g, ""],
    [/缓缓地?/g, ""],
    [/竟然/g, ""],
    [/不由得/g, ""],
    [/嘴角微微上扬/g, "笑了一下"],
    [/心中涌起(?:一股)?/g, ""],
    [/目光深邃/g, "他看着"],
    [/时间仿佛静止/g, ""],
    [/的的/g, "的"],
  ];
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
  text = text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const commas = paragraph.match(/，/g)?.length ?? 0;
      if (commas < 3) return paragraph;
      let seen = 0;
      return paragraph.replace(/，/g, (mark) => {
        seen += 1;
        return seen === 2 ? "。" : mark;
      });
    })
    .join("\n\n");
  text = text.replace(/。{2,}/g, "。").replace(/\s+\n/g, "\n").trim();
  return normalizeDialogueQuotes(text);
}

function renderMemory(context: string): string {
  const body = section(context, "本章正文");
  const first = body.split(/\n+/).map((item) => item.trim()).find(Boolean) ?? "这一章还没有正文。";
  const last = body.split(/\n+/).map((item) => item.trim()).filter(Boolean).at(-1) ?? "无";
  return [`本章事实：${Array.from(first).slice(0, 80).join("")}`, `章末留下：${Array.from(last).slice(0, 80).join("")}`, "未回收：章末物件需要在下一章开场有着落。"].join("\n");
}

function applyInstruction(text: string, instruction: string | undefined): string {
  if (!instruction) return text;
  if (/雨(更大|更密|不停|下大)/.test(instruction) && !text.includes("雨比")) {
    return `${text}\n\n雨比先前更密，檐沟里的水声盖过了说话声。`;
  }
  return text;
}

export class LocalDraftAdapter implements AgentRuntimeAdapter {
  async runScene(input: RunInput): Promise<RunOutput> {
    const world = resolveWorld(input);
    const number = chapterNumberFrom(input.context) ?? chapterNumberFrom(input.instruction ?? "") ?? 1;
    let text = "";
    switch (input.scene) {
      case "topic":
        text = renderTopic(world);
        break;
      case "book_setup":
        text = renderProfile(world);
        break;
      case "outline":
        text = renderOutline(world);
        break;
      case "chapter_outline":
        text = renderChapterOutline(world, number);
        break;
      case "chapter_body":
        text = applyInstruction(renderBody(world, number, input.skillTexts), input.instruction);
        break;
      case "review":
        text = renderReview(input.context);
        break;
      case "humanize":
        text = applyInstruction(humanize(input.context), input.instruction);
        break;
      case "memory_extract":
        text = renderMemory(input.context);
        break;
      case "chat":
        text = `关于《${world.title}》：我可以按场景帮你写全书大纲、细纲、正文或审核。直接说“写第 1 章正文”“审核第 2 章”之类即可。`;
        break;
      default:
        text = renderProfile(world);
    }
    const level = normalizeThinking(input.thinkingIntensity);
    if (level === "high" && (input.scene === "chapter_body" || input.scene === "humanize")) {
      text = `${text.trim()}\n\n（本地草稿·高思考：动机与钩子已按可推敲密度收束。）`;
    } else if (level === "off" && input.scene === "chat") {
      text = text.trim();
    }
    // Spoken dialogue everywhere: “…” only (never 「」 / （）).
    text = normalizeDialogueQuotes(text.trim());
    return { text, modelUsed: `local-draft/${level}` };
  }
}

/** Lightweight local rewrite for a selected span (does not touch full-chapter generation). */
export function rewriteSelectionLocal(selection: string, instruction: string): string {
  const text = selection.replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  const ask = instruction.trim();

  if (/续写/.test(ask)) {
    const tail = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).at(-1) ?? text;
    const hint = Array.from(tail).slice(-24).join("");
    return normalizeDialogueQuotes(`${hint}——话还没落完，对面已经把茶杯放下。窗外的声响近了一寸，像有人故意踩着旧板。`);
  }

  if (/缩短|精简|压缩/.test(ask)) {
    const parts = text.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean);
    if (parts.length <= 2) return normalizeDialogueQuotes(text);
    const keep = Math.max(2, Math.ceil(parts.length * 0.55));
    return normalizeDialogueQuotes(parts.slice(0, keep).join(""));
  }

  if (/对白|对话/.test(ask)) {
    const base = normalizeDialogueQuotes(text);
    const lead = base.split(/\n+/).map((line) => line.trim()).filter(Boolean)[0] ?? base;
    const clip = Array.from(lead).slice(0, 36).join("");
    return normalizeDialogueQuotes(
      `${base}\n\n“你就说一句实话。”\n“我说过了。”他停了一停，“你只是不想听。”\n她看着${clip ? "那一点痕迹" : "他"}，没有再追。`,
    );
  }

  // 润色 / 改写 / custom: strip common AI-ish fillers on the span itself.
  let out = text;
  const rules: [RegExp, string][] = [
    [/不禁/g, ""],
    [/宛如/g, "像"],
    [/仿佛/g, ""],
    [/一抹/g, ""],
    [/与此同时，?/g, ""],
    [/然而，?/g, "可"],
    [/深深地/g, ""],
    [/缓缓地?/g, ""],
    [/竟然/g, ""],
    [/不由得/g, ""],
    [/嘴角微微上扬/g, "笑了一下"],
    [/心中涌起(?:一股)?/g, ""],
    [/目光深邃/g, "他看着"],
    [/时间仿佛静止/g, ""],
    [/的的/g, "的"],
  ];
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  out = out.replace(/。{2,}/g, "。").replace(/，{2,}/g, "，").replace(/[ \t]+\n/g, "\n").trim();

  if (/改写/.test(ask)) {
    const sentences = out.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean);
    const complete = sentences.filter((part) => /[。！？!?]$/.test(part));
    // Only swap when we have two+ complete sentences; never reorder a clipped mid-sentence span.
    if (complete.length >= 2 && complete.length === sentences.length) {
      const [first, second, ...rest] = sentences;
      out = [second, first, ...rest].join("");
    } else {
      // Light rephrase so the selection visibly updates under local-draft.
      out = out
        .replace(/把/g, "将")
        .replace(/没有/g, "没")
        .replace(/一边/g, "一面")
        .replace(/看着/g, "望着");
      if (out === text) {
        if (!out.includes("——他停了一停")) {
          const bare = out.replace(/[。！？!?]+$/u, "");
          out = bare ? `${bare}——他停了一停。` : text;
        }
      }
    }
  }

  out = normalizeDialogueQuotes(out);
  return out || text;
}
