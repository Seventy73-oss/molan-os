import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router-dom";
import { api, streamApi, type Artifact, type BookPayload, type ChatMessage, type ModelInfo, type ProviderSettings, type Route, type Skill, type WritingJob, THINKING_OPTIONS, thinkingLabel, type ThinkingIntensity } from "../api";
import { prefersReducedMotion, revealText } from "../lib/reveal";
import { ModelPicker } from "../components/ModelPicker";
import { useBookTitle } from "../App";
import { Manuscript, mirror, type AssistAction } from "../components/Manuscript";
import { AssistantMessage } from "../components/Message";
import {
  BibleCardsPanel,
  BookMetaPanel,
  BookSearch,
  HooksPanel,
  ProgressPanel,
  ReviewFixPanel,
  ToolsDrawer,
  VersionHistory,
} from "../components/StudioPanels";
import type { ReviewIssue, SearchHit } from "../api";

type Kind = "book_profile" | "book_outline" | "chapter_outline" | "chapter_body" | "review_report" | "chapter_memory";
type Scene = "book_setup" | "outline" | "chapter_outline" | "chapter_body" | "review" | "humanize" | "memory_extract";

type Doc = {
  kind: Kind;
  chapterNumber: number | null;
  label: string;
};

const STATUS: Record<string, string> = {
  empty: "未写",
  outlined: "已有细纲",
  drafted: "已有正文",
  reviewed: "已审核",
};

const CHILDREN: { kind: Kind; label: string }[] = [
  { kind: "chapter_outline", label: "细纲" },
  { kind: "chapter_body", label: "正文" },
  { kind: "review_report", label: "审核" },
  { kind: "chapter_memory", label: "记忆" },
];

const KIND_NAME: Record<string, string> = {
  book_profile: "档案",
  book_outline: "全书大纲",
  chapter_outline: "细纲",
  chapter_body: "正文",
  review_report: "审核报告",
  chapter_memory: "记忆",
};

const SCENE_NAME: Record<Scene, string> = {
  book_setup: "建书",
  outline: "全书大纲",
  chapter_outline: "细纲",
  chapter_body: "正文",
  review: "审核",
  humanize: "去 AI 味",
  memory_extract: "记忆",
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function countChars(text: string) {
  return text.replace(/\s/g, "").length;
}

function TreeIcon({ d }: { d: string }) {
  return (
    <svg className="tree-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function findArtifact(data: BookPayload, doc: Doc): Artifact | undefined {
  return data.artifacts.find(
    (artifact) => artifact.kind === doc.kind && (artifact.chapterNumber ?? null) === (doc.chapterNumber ?? null),
  );
}

function defaultDoc(data: BookPayload): Doc {
  const body = data.artifacts.find((artifact) => artifact.kind === "chapter_body" && artifact.body);
  if (body) return { kind: "chapter_body", chapterNumber: body.chapterNumber, label: "正文" };
  if (data.artifacts.some((artifact) => artifact.kind === "book_outline" && artifact.body)) {
    return { kind: "book_outline", chapterNumber: null, label: "全书大纲" };
  }
  return { kind: "book_profile", chapterNumber: null, label: "档案" };
}

function sceneFor(doc: Doc): Scene {
  if (doc.kind === "book_profile") return "book_setup";
  if (doc.kind === "book_outline") return "outline";
  if (doc.kind === "chapter_outline") return "chapter_outline";
  if (doc.kind === "review_report") return "review";
  if (doc.kind === "chapter_memory") return "memory_extract";
  return "chapter_body";
}

function segments(doc: Doc): { id: Scene; label: string }[] {
  if (doc.kind === "chapter_body") return [
    { id: "chapter_body", label: "正文" },
    { id: "humanize", label: "去 AI 味" },
  ];
  if (doc.kind === "book_profile") return [{ id: "book_setup", label: "建书" }];
  if (doc.kind === "book_outline") return [{ id: "outline", label: "全书大纲" }];
  if (doc.kind === "chapter_outline") return [{ id: "chapter_outline", label: "细纲" }];
  if (doc.kind === "chapter_memory") return [{ id: "memory_extract", label: "记忆" }];
  return [{ id: "review", label: "审核" }];
}

/** Chat suggestions phrased so the server's chat router picks the right scene and chapter. */
function suggestionsFor(doc: Doc, hasText: boolean, total: number): string[] {
  const n = doc.chapterNumber ?? 1;
  const next = Math.min(n + 1, Math.max(total, n + 1));
  switch (doc.kind) {
    case "chapter_body":
      return hasText
        ? [`审核第 ${n} 章`, `把第 ${n} 章正文去 AI 味`, `写第 ${next} 章细纲`]
        : [`写第 ${n} 章细纲`, `按细纲写第 ${n} 章正文`, `审核第 ${n} 章`];
    case "chapter_outline":
      return hasText
        ? [`按细纲写第 ${n} 章正文`, `重写第 ${n} 章细纲`, `写第 ${next} 章细纲`]
        : [`写第 ${n} 章细纲`, `按细纲写第 ${n} 章正文`, `写全书大纲`];
    case "review_report":
      return [`审核第 ${n} 章`, `把第 ${n} 章正文去 AI 味`, `写第 ${next} 章细纲`];
    case "chapter_memory":
      return [`审核第 ${n} 章`, `写第 ${next} 章细纲`, `按细纲写第 ${n} 章正文`];
    case "book_outline":
      return [`写全书大纲`, `写第 1 章细纲`, `写第 1 章正文`];
    default:
      return [`写全书大纲`, `写第 1 章细纲`, `写第 1 章正文`];
  }
}

export function Studio() {
  const { id = "" } = useParams();
  const { setTitle, setSaveState } = useBookTitle();
  const [data, setData] = useState<BookPayload | null>(null);
  const [doc, setDoc] = useState<Doc>({ kind: "book_profile", chapterNumber: null, label: "档案" });
  const [draft, setDraft] = useState("");
  const [savedText, setSavedText] = useState("");
  const [revision, setRevision] = useState(0);
  const [scene, setScene] = useState<Scene>("book_setup");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
  const [pickingModel, setPickingModel] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [chatText, setChatText] = useState("");
  const [busy, setBusy] = useState<"" | "generate" | "chat" | "assist">("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  const [pendingUser, setPendingUser] = useState("");
  const [confirmDeleteChapter, setConfirmDeleteChapter] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [assistLocal, setAssistLocal] = useState(false);
  const [jobs, setJobs] = useState<WritingJob[]>([]);
  const [jobOpen, setJobOpen] = useState(false);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobAuto, setJobAuto] = useState(false);
  const [streamPreview, setStreamPreview] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const jobAutoRef = useRef(false);
  const revealAbort = useRef<AbortController | null>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const [jobFrom, setJobFrom] = useState(1);
  const [jobAutoReview, setJobAutoReview] = useState(false);
  const [jobMaxRetries, setJobMaxRetries] = useState(1);
  const [jobTo, setJobTo] = useState(2);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsTab, setToolsTab] = useState<"tools" | "bible" | "history" | "review" | "meta" | "hooks">("tools");
  const [seek, setSeek] = useState<{ text: string; token: number } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerComposing = useRef(false);
  const composerSwallowEnter = useRef(false);
  const dataRef = useRef<BookPayload | null>(null);
  const busyRef = useRef(false);
  const dirty = draft !== savedText;
  const leaveBlocker = useBlocker(Boolean(data) && dirty && !saving && !busy);
  function isAbort(err: unknown) {
    return err instanceof Error && (err.name === "AbortError" || err.message === "已取消");
  }
  function cancelStream() {
    streamAbort.current?.abort();
    revealAbort.current?.abort();
  }


  function show(payload: BookPayload, next: Doc) {
    const artifact = findArtifact(payload, next);
    setDoc(next);
    setDraft(artifact?.body ?? "");
    setSavedText(artifact?.body ?? "");
    setRevision(artifact?.revision ?? 0);
    setScene(sceneFor(next));
    setWriting(false);
    if (next.chapterNumber) setExpanded(next.chapterNumber);
    centerRef.current?.scrollTo(0, 0);
  }

  useEffect(() => {
    let cancel = false;
    Promise.all([api.book(id), api.messages(id), api.routes(), api.skills(), api.provider(), api.providerModels(), api.jobs(id).catch(() => ({ jobs: [] as WritingJob[] }))])
      .then(([payload, msgs, routeRes, skillRes, providerRes, modelRes, jobRes]) => {
        if (cancel) return;
        dataRef.current = payload;
        setData(payload);
        setTitle(payload.book.title);
        setMessages(msgs.messages);
        setRoutes(routeRes.routes);
        setSkills(skillRes.skills);
        setProvider(providerRes);
        setModelCatalog(modelRes.models);
        setJobs(jobRes.jobs);
        show(payload, defaultDoc(payload));
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      cancel = true;
    };
  }, [id, setTitle]);

  useEffect(() => {
    const list = skills.filter((skill) => skill.scene === scene && skill.enabled);
    setChecked(list.map((skill) => skill.id));
  }, [scene, skills]);

  useEffect(() => {
    setSaveState(!data ? "" : saving ? "saving" : dirty ? "dirty" : "saved");
  }, [data, saving, dirty, setSaveState]);

  useEffect(() => () => setSaveState(""), [setSaveState]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, pendingUser]);

  useEffect(() => {
    if (!fileMenuOpen) return;
    function onPointer(event: MouseEvent) {
      if (!fileMenuRef.current?.contains(event.target as Node)) setFileMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setFileMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [fileMenuOpen]);

  const saveRef = useRef(save);
  saveRef.current = save;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
      if (event.key === "Escape") {
        setPickingModel(false);
        setConfirmDeleteChapter(null);
        setFileMenuOpen(false);
      }
    }
    function onLeave(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!data) return;
    const from = doc.chapterNumber ?? 1;
    const max = Math.max(1, data.book.targetChapters || data.chapters.length || 1);
    setJobFrom(from);
    setJobTo(Math.min(from + 1, max));
  }, [data?.book.id, doc.chapterNumber, data?.book.targetChapters, data?.chapters.length]);

  useEffect(() => {
    if (leaveBlocker.state !== "blocked") return;
    const handle = window.setTimeout(() => {
      const ok = window.confirm("当前稿件还未保存，确定离开？未保存的改动会丢掉。");
      if (ok) leaveBlocker.proceed();
      else leaveBlocker.reset();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [leaveBlocker]);

  const sceneSkills = skills.filter((skill) => skill.scene === scene && skill.enabled);
  const primaries = sceneSkills.filter((skill) => skill.role === "primary");
  const locked = primaries.length === 1 ? primaries[0]!.id : null;
  const route = routes.find((item) => item.scene === scene);
  const effectiveModel =
    route?.provider === "openai"
      ? route.modelId && route.modelId !== "local-draft"
        ? route.modelId
        : provider?.chatModel || provider?.defaultModel || "未选模型"
      : "本地草稿引擎";
  const modelLine = !route || route.provider === "local" ? "本地草稿引擎" : effectiveModel;
  const needsKey = route?.provider === "openai" && provider !== null && !provider.configured;
  const canPickModel = provider !== null; // show per-scene picker once settings loaded (even without API Key)

  async function applySceneModel(modelId: string, makeDefault = false) {
    if (!route) return;
    const next = routes.map((item) =>
      item.scene === scene
        ? { ...item, provider: "openai", modelId: modelId || "local-draft" }
        : item,
    );
    setRoutes(next);
    try {
      const saved = await api.saveRoutes(next);
      setRoutes(saved.routes);
      if (makeDefault && modelId) {
        const settings = await api.saveProvider({ defaultModel: modelId, chatModel: modelId });
        setProvider(settings);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "模型没有保存");
    }
  }

  async function applySceneProvider(providerKind: "local" | "openai") {
    if (!route) return;
    const modelId =
      providerKind === "local"
        ? "local-draft"
        : route.modelId && route.modelId !== "local-draft"
          ? route.modelId
          : provider?.defaultModel || provider?.chatModel || "local-draft";
    const next = routes.map((item) =>
      item.scene === scene ? { ...item, provider: providerKind, modelId, baseUrl: providerKind === "local" ? null : item.baseUrl } : item,
    );
    setRoutes(next);
    try {
      const saved = await api.saveRoutes(next);
      setRoutes(saved.routes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "路由没有保存");
    }
  }

  async function applySceneThinking(level: ThinkingIntensity) {
    if (!route) return;
    const next = routes.map((item) =>
      item.scene === scene ? { ...item, thinkingIntensity: level } : item,
    );
    setRoutes(next);
    try {
      const saved = await api.saveRoutes(next);
      setRoutes(saved.routes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "思考强度没有保存");
    }
  }

  const chapterTitle = data?.chapters.find((chapter) => chapter.number === doc.chapterNumber)?.title;

  function claim(kind: "generate" | "chat" | "assist") {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(kind);
    return true;
  }

  function release() {
    busyRef.current = false;
    setBusy("");
  }

  async function persist(text = draft) {
    if (!data || text === savedText) return;
    setSaving(true);
    try {
      const saved = await api.saveArtifact(id, {
        kind: doc.kind,
        chapterNumber: doc.chapterNumber,
        body: text,
        source: "human",
        scene,
        skillIds: checked,
        model: modelLine,
      });
      setDraft(text);
      setSavedText(text);
      setRevision(saved.revision);
      const payload = await api.book(id);
      dataRef.current = payload;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      throw err;
    } finally {
      setSaving(false);
    }
  }

  function save(text?: string) {
    void persist(text ?? draft).catch((err: Error) => setError(err.message));
  }

  async function reloadFromFile() {
    if (dirty && !window.confirm("当前有未保存改动。用磁盘 md 覆盖编辑区？")) return;
    try {
      const file = await api.readArtifactFile(id, doc.kind, doc.chapterNumber);
      setDraft(file.body);
      setWriting(true);
      setNotice("已从 md 载入编辑区（尚未写回数据库，保存后才会覆盖）");
    } catch (err) {
      setError(err instanceof Error ? err.message : "读文件失败");
    }
  }

  function download(url: string) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function open(next: Doc) {
    if (busyRef.current) return false;
    try {
      await persist();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      return false;
    }
    const payload = dataRef.current;
    if (payload) show(payload, next);
    return true;
  }

  /** Runs the current scene for the current document, or for `target` right after switching to it. */
  async function generate(target?: Doc) {
    if (!claim("generate")) return;
    setError("");
    setStreamPreview("");
    setStreamStatus("正在生成…");
    const runDoc = target ?? doc;
    const runScene = target ? sceneFor(target) : scene;
    const runSkills = target ? skills.filter((skill) => skill.scene === runScene && skill.enabled).map((skill) => skill.id) : checked;
    revealAbort.current?.abort();
    streamAbort.current?.abort();
    const abort = new AbortController();
    revealAbort.current = abort;
    streamAbort.current = abort;
    try {
      if (!target) await persist();
      setWriting(true);
      let assembled = "";
      let result;
      try {
        result = await streamApi.sceneRun(
          id,
          { scene: runScene, chapterNumber: runDoc.chapterNumber, instruction: "", skillIds: runSkills },
          (event) => {
            if (event.type === "status" && event.message) setStreamStatus(event.message);
            if (event.type === "token" && event.text) {
              assembled += event.text;
              setStreamPreview(assembled);
              setDraft(assembled);
            }
          },
          abort.signal,
        );
      } catch (err) {
        if (isAbort(err)) throw err;
        // Fallback to classic JSON if SSE unavailable.
        result = await api.sceneRun(id, {
          scene: runScene,
          chapterNumber: runDoc.chapterNumber,
          instruction: "",
          skillIds: runSkills,
        });
        assembled = result.text;
        await revealText(assembled, (partial) => {
          setDraft(partial);
          setStreamPreview(partial);
        }, { signal: abort.signal });
      }
      const payload = await api.book(id);
      dataRef.current = payload;
      setData(payload);
      const artifact = findArtifact(payload, runDoc);
      const nextText = artifact?.body || result.text || assembled;
      setDraft(nextText);
      setSavedText(nextText);
      setRevision(artifact?.revision ?? result.saved?.revision ?? 0);
      setNotice(`已生成${KIND_NAME[runDoc.kind] ?? "稿件"}`);
    } catch (err) {
      if (isAbort(err)) {
        setNotice("已停止生成。当前内容留在编辑区，可继续改或保存。");
      } else {
        setError(err instanceof Error ? err.message : "生成失败");
      }
    } finally {
      setStreamPreview("");
      setStreamStatus("");
      if (streamAbort.current === abort) streamAbort.current = null;
      release();
    }
  }

  async function generateInto(next: Doc) {
    if (busyRef.current) return;
    const sameDoc = next.kind === doc.kind && next.chapterNumber === doc.chapterNumber;
    if (sameDoc) return generate();
    const switched = await open(next);
    if (switched) await generate(next);
  }

  async function send(text = chatText) {
    const message = text.trim();
    if (!message || !claim("chat")) return;
    setError("");
    setChatText("");
    setPendingUser(message);
    setStreamPreview("");
    setStreamStatus("助手正在写…");
    streamAbort.current?.abort();
    const abort = new AbortController();
    streamAbort.current = abort;
    try {
      // Persist current edits first so chat generation cannot clobber an unsaved draft.
      await persist();
      let result;
      let live = "";
      try {
        result = await streamApi.chat(id, message, (event) => {
          if (event.type === "status" && event.message) setStreamStatus(event.message);
          if (event.type === "token" && event.text) {
            live += event.text;
            setStreamPreview(live);
          }
        }, abort.signal);
      } catch (err) {
        if (isAbort(err)) throw err;
        result = await api.chat(id, message);
      }
      const msgs = await api.messages(id);
      setMessages(msgs.messages);
      if (result.saved) {
        const payload = await api.book(id);
        dataRef.current = payload;
        setData(payload);
        setTitle(payload.book.title);
        const label =
          CHILDREN.find((child) => child.kind === result.saved!.kind)?.label ??
          (result.saved.kind === "book_outline" ? "大纲" : result.saved.kind === "book_profile" ? "档案" : "稿件");
        const nextDoc: Doc = {
          kind: result.saved.kind as Kind,
          chapterNumber: result.saved.chapterNumber ?? null,
          label,
        };
        show(payload, nextDoc);
        setNotice(`已写入${savedLabel(result.saved.kind, result.saved.chapterNumber)}，并打开该稿`);
      }
    } catch (err) {
      if (isAbort(err)) {
        setNotice("已停止本次对话");
        setChatText(message);
      } else {
        setError(err instanceof Error ? err.message : "发送失败");
        setChatText(message);
      }
    } finally {
      setPendingUser("");
      setStreamPreview("");
      setStreamStatus("");
      if (streamAbort.current === abort) streamAbort.current = null;
      release();
    }
  }


  async function assistSelection(payload: { action: AssistAction; selection: string; instruction: string }) {
    if (!claim("assist")) throw new Error("正在忙");
    setError("");
    setStreamStatus("正在改写选区…");
    streamAbort.current?.abort();
    const abort = new AbortController();
    streamAbort.current = abort;
    try {
      let result;
      try {
        result = await streamApi.rewriteSelection(
          id,
          { selection: payload.selection, instruction: payload.instruction, scene },
          (event) => {
            if (event.type === "status" && event.message) setStreamStatus(event.message);
          },
          abort.signal,
        );
      } catch (err) {
        if (isAbort(err)) throw err;
        result = await api.rewriteSelection(id, {
          selection: payload.selection,
          instruction: payload.instruction,
          scene,
        });
      }
      setAssistLocal(Boolean(result.local));
      if (result.local) {
        setNotice("选区改写走的是本地草稿，质量一般。在「模型」页填 API Key 后效果会好很多。");
      }
      return result.text;
    } catch (err) {
      if (isAbort(err)) {
        setNotice("已停止选区改写");
        throw err;
      }
      const message = err instanceof Error ? err.message : "选区改写失败";
      setError(message);
      throw err;
    } finally {
      setStreamStatus("");
      if (streamAbort.current === abort) streamAbort.current = null;
      release();
    }
  }

  function askAssistantAboutSelection(selection: string) {
    const quote = selection.trim();
    if (!quote) return;
    const clipped = quote.length > 480 ? `${quote.slice(0, 480)}…` : quote;
    setChatText(`关于这段选中文字：\n「${clipped}」\n\n`);
    setSettingsOpen(true);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }

  function jumpSearchHit(hit: SearchHit) {
    const kindMap: Record<string, Kind> = {
      book_profile: "book_profile",
      book_outline: "book_outline",
      chapter_outline: "chapter_outline",
      chapter_body: "chapter_body",
      review_report: "review_report",
      chapter_memory: "chapter_memory",
    };
    if (hit.kind === "chapter_title") {
      void open({ kind: "chapter_body", chapterNumber: hit.chapterNumber, label: "正文" });
      return;
    }
    const kind = kindMap[hit.kind];
    if (!kind) return;
    void open({ kind, chapterNumber: hit.chapterNumber, label: KIND_NAME[kind] || kind }).then((ok) => {
      if (!ok) return;
      const needle = hit.snippet.replace(/^…|…$/g, "").trim().slice(0, 48);
      if (needle) setSeek({ text: needle, token: Date.now() });
    });
  }

  async function locateReviewIssue(issue: ReviewIssue) {
    const chapterNumber = doc.chapterNumber;
    if (!issue.cite || !chapterNumber) return;
    const ok = await open({ kind: "chapter_body", chapterNumber, label: "正文" });
    if (!ok) return;
    setSeek({ text: issue.cite, token: Date.now() });
    setNotice("已在正文中定位引用");
  }

  async function fixReviewIssue(issue: ReviewIssue) {
    const chapterNumber = doc.chapterNumber;
    if (!issue.cite || !chapterNumber) return;
    const ok = await open({ kind: "chapter_body", chapterNumber, label: "正文" });
    if (!ok) return;
    setSeek({ text: issue.cite, token: Date.now() });
    if (!claim("assist")) return;
    setError("");
    setAssistLocal(false);
    try {
      const instruction = `请按下列审核意见修改选中文字，只输出改写后的文字。\n审核：${issue.text}`;
      const result = await api.rewriteSelection(id, {
        selection: issue.cite,
        instruction,
        scene: "humanize",
      });
      if (result.local) setAssistLocal(true);
      const payload = dataRef.current;
      const art = payload?.artifacts.find((a) => a.kind === "chapter_body" && a.chapterNumber === chapterNumber);
      const current = art?.body ?? draft;
      if (!current.includes(issue.cite)) {
        setNotice("正文里找不到原文引用，已定位相近位置，请手动改");
        return;
      }
      const next = current.replace(issue.cite, result.text);
      setDraft(next);
      setWriting(true);
      await persist(next);
      setNotice(result.local ? "已按审核意见改写（本地草稿）并保存" : "已按审核意见改写并保存");
      setSeek({ text: result.text.slice(0, 40), token: Date.now() });
    } catch (err) {
      if (!isAbort(err)) setError(err instanceof Error ? err.message : "改稿失败");
    } finally {
      release();
    }
  }



  const STAGE_LABEL: Record<string, string> = {
    outline: "全书大纲",
    chapter_outline: "章节细纲",
    chapter_body: "章节正文",
    memory: "抽取记忆",
    review: "自动审核",
    done: "完成",
  };

  async function refreshJobs() {
    try {
      const res = await api.jobs(id);
      setJobs(res.jobs);
      return res.jobs;
    } catch {
      return jobs;
    }
  }

  async function startJob() {
    if (jobBusy || busyRef.current) return;
    setJobBusy(true);
    setError("");
    try {
      await persist();
      const max = Math.max(1, data?.book.targetChapters || data?.chapters.length || 1);
      const from = Math.max(1, Math.min(jobFrom, max));
      const to = Math.max(from, Math.min(jobTo, max));
      setJobFrom(from);
      setJobTo(to);
      const job = await api.createJob(id, {
        fromChapter: from,
        toChapter: to,
        autoReview: jobAutoReview,
        maxRetries: jobMaxRetries,
      });
      setJobs((list) => [job, ...list.filter((item) => item.id !== job.id)]);
      setJobOpen(true);
      setNotice(`已创建批量任务：第 ${from}–${to} 章`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建任务失败");
    } finally {
      setJobBusy(false);
    }
  }

  async function tickActiveJob(jobId: string) {
    if (jobBusy) return;
    setJobBusy(true);
    setError("");
    try {
      const result = await api.tickJob(jobId);
      setJobs((list) => list.map((item) => (item.id === jobId ? result.job : item)));
      if (result.advanced) {
        const payload = await api.book(id);
        dataRef.current = payload;
        setData(payload);
        setNotice(
          result.job.status === "done"
            ? "批量任务已完成"
            : `任务推进：${STAGE_LABEL[result.job.currentStage] ?? result.job.currentStage} · 第 ${result.job.currentChapter} 章`,
        );
      }
      return result.job;
    } catch (err) {
      setError(err instanceof Error ? err.message : "任务推进失败");
      return null;
    } finally {
      setJobBusy(false);
    }
  }

  async function toggleJob(jobId: string, status: "paused" | "running") {
    try {
      const job = await api.patchJob(jobId, status);
      setJobs((list) => list.map((item) => (item.id === jobId ? job : item)));
      if (status === "paused") {
        jobAutoRef.current = false;
        setJobAuto(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新任务失败");
    }
  }

  async function runJobAuto(jobId: string) {
    if (jobAutoRef.current) {
      jobAutoRef.current = false;
      setJobAuto(false);
      return;
    }
    jobAutoRef.current = true;
    setJobAuto(true);
    setJobOpen(true);
    while (jobAutoRef.current) {
      const job = await tickActiveJob(jobId);
      if (!job || job.status === "done" || job.status === "error" || job.status === "paused") break;
      await new Promise((r) => window.setTimeout(r, prefersReducedMotion() ? 40 : 280));
    }
    jobAutoRef.current = false;
    setJobAuto(false);
    await refreshJobs();
  }

  async function addChapter() {
    if (busyRef.current) return;
    try {
      await persist();
      const next = await api.addChapter(id);
      dataRef.current = next;
      setData(next);
      const last = next.chapters[next.chapters.length - 1];
      if (last) {
        setExpanded(last.number);
        setNotice(`已添加第 ${last.number} 章`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加章失败");
    }
  }

  async function renameCurrentChapter(number: number) {
    const current = data?.chapters.find((chapter) => chapter.number === number);
    if (!current) return;
    const nextTitle = window.prompt("章节标题", current.title);
    if (nextTitle == null) return;
    try {
      await persist();
      const next = await api.renameChapter(id, number, nextTitle);
      dataRef.current = next;
      setData(next);
      if (doc.chapterNumber === number) {
        show(next, { ...doc, chapterNumber: number });
      }
      setNotice(`已改名第 ${number} 章`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "改名失败");
    }
  }

  async function removeChapter(number: number) {
    if (busyRef.current) return;
    try {
      await persist();
      const next = await api.deleteChapter(id, number);
      dataRef.current = next;
      setData(next);
      setConfirmDeleteChapter(null);
      if (doc.chapterNumber == null) {
        show(next, doc);
      } else if (doc.chapterNumber === number) {
        show(next, defaultDoc(next));
      } else if (doc.chapterNumber > number) {
        show(next, { ...doc, chapterNumber: doc.chapterNumber - 1 });
      } else {
        show(next, doc);
      }
      setNotice(`已删除原第 ${number} 章，后续章节已重排`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删章失败");
      setConfirmDeleteChapter(null);
    }
  }

  if (!data) {
    return (
      <div className="studio empty-studio">
        <p>{error || "正在打开书稿…"}</p>
        {error ? (
          <p className="empty-actions">
            <Link className="btn" to="/">回书库</Link>
          </p>
        ) : null}
      </div>
    );
  }

  const chapterNo = doc.chapterNumber;
  const words = countChars(draft);
  const revLine = revision ? `修订 ${revision}` : "尚未成稿";
  let docTitle = "档案";
  let metaParts: string[] = [];
  let crumb: string[] = [];
  if (doc.kind === "book_profile") {
    docTitle = "档案";
    metaParts = [data.book.title, data.book.genre || "未定题材"];
    crumb = ["档案"];
  } else if (doc.kind === "book_outline") {
    docTitle = "全书大纲";
    metaParts = [`${data.chapters.length} 章`];
    crumb = ["全书大纲"];
  } else if (doc.kind === "chapter_body") {
    docTitle = chapterTitle || `第 ${chapterNo} 章`;
    metaParts = [`第 ${chapterNo} 章`, "正文"];
    crumb = [`第 ${chapterNo} 章 ${chapterTitle ?? ""}`.trim(), "正文"];
  } else if (doc.kind === "chapter_outline") {
    docTitle = `第 ${chapterNo} 章 细纲`;
    metaParts = ["细纲", chapterTitle ?? ""];
    crumb = [`第 ${chapterNo} 章 ${chapterTitle ?? ""}`.trim(), "细纲"];
  } else if (doc.kind === "chapter_memory") {
    docTitle = `第 ${chapterNo} 章 记忆`;
    metaParts = ["记忆", chapterTitle ?? ""];
    crumb = [`第 ${chapterNo} 章 ${chapterTitle ?? ""}`.trim(), "记忆"];
  } else {
    docTitle = "审核报告";
    metaParts = [`第 ${chapterNo} 章`, chapterTitle ?? ""];
    crumb = [`第 ${chapterNo} 章 ${chapterTitle ?? ""}`.trim(), "审核"];
  }
  metaParts = [...metaParts.filter(Boolean), revLine];

  const isOn = (kind: Kind, chapterNumber: number | null) =>
    doc.kind === kind && (doc.chapterNumber ?? null) === chapterNumber;
  const hasBody = (kind: Kind, chapterNumber: number | null) =>
    Boolean(findArtifact(data, { kind, chapterNumber, label: "" })?.body);

  const isEmptyDoc = draft.trim() === "" && !dirty;
  const showEmpty = isEmptyDoc && !writing;
  const outlineDoc: Doc | null = chapterNo ? { kind: "chapter_outline", chapterNumber: chapterNo, label: "细纲" } : null;
  const needsOutline = doc.kind === "chapter_body" && outlineDoc !== null && !hasBody("chapter_outline", chapterNo);
  const generateLabel = `生成${KIND_NAME[doc.kind] ?? "此稿"}`;
  const suggestions = suggestionsFor(doc, !isEmptyDoc, data.chapters.length);
  const settingsExpanded = settingsOpen ?? messages.length === 0;
  const activeSkills = sceneSkills.filter((skill) => checked.includes(skill.id));

  return (
    <div className="studio page-enter">
      {notice ? (
        <div className="toast-notice" role="status">
          {notice}
          <button type="button" className="toast-dismiss" aria-label="关闭" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      ) : null}
      <aside className="sidebar rail">
        <div className="side-label">书籍</div>
        <button
          type="button"
          className={isOn("book_profile", null) ? "tree-item on" : "tree-item"}
          onClick={() => void open({ kind: "book_profile", chapterNumber: null, label: "档案" })}
        >
          <TreeIcon d="M4 2.5h5.5L12 5v8.5H4zM9.5 2.5V5H12M6 8h4M6 10.5h4" />
          <span className="tree-text">档案</span>
        </button>
        <button
          type="button"
          className={isOn("book_outline", null) ? "tree-item on" : "tree-item"}
          onClick={() => void open({ kind: "book_outline", chapterNumber: null, label: "全书大纲" })}
        >
          <TreeIcon d="M3 4h1M3 8h1M3 12h1M6.5 4H13M6.5 8H13M6.5 12H13" />
          <span className="tree-text">全书大纲</span>
        </button>

        <div className="side-label with-count">
          <span>章节</span>
          <span className="side-count" title={`已写正文 ${data.book.draftedCount} 章，共 ${data.chapters.length} 章`}>
            {data.book.draftedCount} / {data.chapters.length}
          </span>
        </div>
        {data.chapters.map((chapter) => {
          const openChapter = expanded === chapter.number;
          const containsDoc = doc.chapterNumber === chapter.number;
          const status = STATUS[chapter.status] ?? chapter.status;
          const confirming = confirmDeleteChapter === chapter.number;
          return (
            <div key={chapter.id} className={openChapter ? "chapter open" : "chapter"}>
              <button
                type="button"
                className={containsDoc ? "tree-item chapter-row current" : "tree-item chapter-row"}
                aria-expanded={openChapter}
                title={`第 ${chapter.number} 章 · ${chapter.title} · ${status}`}
                onClick={() => {
                  setConfirmDeleteChapter(null);
                  setExpanded(openChapter ? null : chapter.number);
                }}
              >
                <span className="num">{pad(chapter.number)}</span>
                <span className="tree-text">{chapter.title}</span>
                {chapter.words ? <span className="tree-words">{chapter.words}</span> : null}
                <span className={`status-dot is-${chapter.status}`} aria-label={status} />
              </button>
              {openChapter ? (
                <div className="tree-sub">
                  {CHILDREN.map((child) => {
                    const filled = hasBody(child.kind, chapter.number);
                    return (
                      <button
                        key={child.kind}
                        type="button"
                        title={filled ? `第 ${chapter.number} 章${child.label}` : `第 ${chapter.number} 章${child.label} · 未写`}
                        className={["tree-item", "child", isOn(child.kind, chapter.number) ? "on" : "", filled ? "" : "blank"].join(" ").trim()}
                        onClick={() => void open({ kind: child.kind, chapterNumber: chapter.number, label: child.label })}
                      >
                        <span className="tree-text">{child.label}</span>
                        {filled ? null : <span className="child-hint">未写</span>}
                      </button>
                    );
                  })}
                  {confirming ? (
                    <div className="chapter-confirm">
                      <p>删除第 {chapter.number} 章「{chapter.title}」？细纲、正文和审核都会去掉，后面章节会往前排。</p>
                      <div className="actions">
                        <button type="button" className="btn small ghost" onClick={() => setConfirmDeleteChapter(null)}>
                          取消
                        </button>
                        <button type="button" className="btn small danger" onClick={() => void removeChapter(chapter.number)}>
                          删除
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="chapter-tools">
                      <button type="button" className="text-link" onClick={() => void renameCurrentChapter(chapter.number)}>
                        改名
                      </button>
                      <button
                        type="button"
                        className="text-link danger"
                        disabled={data.chapters.length <= 1}
                        title={data.chapters.length <= 1 ? "至少保留一章" : "删除本章"}
                        onClick={() => setConfirmDeleteChapter(chapter.number)}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        <button type="button" className="tree-item add" onClick={() => void addChapter()}>
          <span className="num plus">+</span>
          <span className="tree-text">新章</span>
        </button>
      </aside>

      <section className="center paper" ref={centerRef} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 8)}>
        <div className={scrolled ? "doc-bar scrolled" : "doc-bar"}>
          <div className="doc-crumbs">
            {crumb.map((part, index) => (
              <span key={index} className={index === crumb.length - 1 ? "last" : ""}>
                {index > 0 ? <span className="sep">/</span> : null}
                {part}
              </span>
            ))}
          </div>
          <span className="doc-count" aria-live="polite">
            {words.toLocaleString("zh-CN")} 字
          </span>
          <span className="spacer" />
          <div className="doc-tools">
            <button
              type="button"
              className={toolsOpen ? "btn small primary" : "btn small ghost"}
              onClick={() => setToolsOpen((v) => !v)}
              title="搜索、书信息、钩子、设定卡、版本、审核改稿"
            >
              工具
            </button>
            <div className={fileMenuOpen ? "file-menu open" : "file-menu"} ref={fileMenuRef}>
              <button
                type="button"
                className="btn small ghost file-trigger"
                aria-haspopup="menu"
                aria-expanded={fileMenuOpen}
                title="文件与导出"
                onClick={() => setFileMenuOpen((open) => !open)}
              >
                文件
                <svg className="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {fileMenuOpen ? (
                <div className="file-pop" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="file-item"
                    title="用磁盘上的 md 覆盖当前编辑区（不自动保存）"
                    onClick={() => {
                      setFileMenuOpen(false);
                      void reloadFromFile();
                    }}
                  >
                    <span>从 md 载入</span>
                    <span className="file-hint">覆盖编辑区</span>
                  </button>
                  {doc.chapterNumber ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="file-item"
                      title="下载本章文件夹的 zip"
                      onClick={() => {
                        setFileMenuOpen(false);
                        download(api.exportChapterUrl(id, doc.chapterNumber!));
                      }}
                    >
                      <span>导出本章</span>
                      <span className="file-hint">本章 zip</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="file-item"
                    title="下载全书 markdown zip"
                    onClick={() => {
                      setFileMenuOpen(false);
                      download(api.exportBookUrl(id));
                    }}
                  >
                    <span>导出全书</span>
                    <span className="file-hint">全书 zip</span>
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={dirty || saving ? "btn small primary" : "btn small"}
              onClick={() => save()}
              disabled={!dirty || saving}
              title="保存（⌘S / Ctrl+S）"
            >
              {saving ? <Spinner /> : null}
              {saving ? "保存中" : "保存"}
              {!saving ? <kbd>⌘S</kbd> : null}
            </button>
          </div>
        </div>
        <article className="page-doc sheet">
          <p className="doc-meta">
            {metaParts.map((part, index) => (
              <span key={index}>
                {index > 0 ? <span className="sep">·</span> : null}
                {part}
              </span>
            ))}
            <span>
              <span className="sep">·</span>
              {words.toLocaleString("zh-CN")} 字
            </span>
            {dirty ? <span className="unsaved">未保存</span> : null}
          </p>
          <h1 className="doc-title">{docTitle}</h1>
          {showEmpty ? (
            <div className="doc-empty">
              <div className="doc-empty-mark" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M5 3.5h7l3 3v10H5z M12 3.5v3h3 M8 10h4 M8 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h2>{doc.kind === "chapter_body" ? "这一章还空着" : `${KIND_NAME[doc.kind]}还空着`}</h2>
              <p>
                {needsOutline
                  ? "建议先写细纲，定下场景和冲突，再按细纲生成正文。"
                  : doc.kind === "review_report"
                    ? "正文写好后，可以让墨兰写作按设定逐条核对，生成一份审核报告。"
                    : "让墨兰写作按档案和大纲先起一稿，再慢慢改。"}
              </p>
              <div className="doc-empty-actions">
                {needsOutline && outlineDoc ? (
                  <>
                    <button type="button" className={busy === "generate" ? "btn primary working" : "btn primary"} disabled={Boolean(busy)} onClick={() => void generateInto(outlineDoc)}>
                      {busy === "generate" ? <Spinner /> : null}
                      生成细纲
                    </button>
                    <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void generate()}>
                      直接生成正文
                    </button>
                  </>
                ) : (
                  <button type="button" className={busy === "generate" ? "btn primary working" : "btn primary"} disabled={Boolean(busy)} onClick={() => void generate()}>
                    {busy === "generate" ? <Spinner /> : null}
                    {busy === "generate" ? "正在生成…" : generateLabel}
                  </button>
                )}
                <button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={() => setWriting(true)}>
                  自己写
                </button>
              </div>
            </div>
          ) : (
            <div className={busy === "generate" ? "doc-body generating streaming" : "doc-body"}>
              {busy === "generate" && streamStatus ? (
                <div className="stream-status" role="status">
                  <span className="stream-pulse" aria-hidden="true" />
                  <span className="stream-status-text">{streamStatus}</span>
                  {streamPreview ? <span className="stream-count">{streamPreview.replace(/\s/g, "").length} 字</span> : null}
                  <button type="button" className="btn small ghost stream-stop" onClick={() => cancelStream()}>
                    停止
                  </button>
                </div>
              ) : null}
              <Manuscript
                key={`${doc.kind}-${doc.chapterNumber ?? "book"}`}
                mode={doc.kind === "chapter_body" ? "prose" : "plain"}
                value={draft}
                autoFocus={writing && isEmptyDoc}
                placeholder={doc.kind === "chapter_body" ? "从第一句开始写…" : "在这里写…"}
                onChange={setDraft}
                onCommit={save}
                assistBusy={busy === "assist"}
                onAssist={assistSelection}
                onAskAssistant={askAssistantAboutSelection}
                seek={seek}
              />
              <p className="editor-hint">TipTap 稿纸 · 选中文字可改写 · ⌘Z 撤销 · ⌘⇧Z 重做 · ⌘S 保存</p>
            </div>
          )}
        </article>
      </section>


      <ToolsDrawer
        open={toolsOpen}
        tab={toolsTab}
        onTab={setToolsTab}
        onClose={() => setToolsOpen(false)}
      >
        {toolsTab === "tools" ? (
          <>
            <BookSearch bookId={id} onJump={jumpSearchHit} />
            <ProgressPanel progress={data.progress} chapterNumber={doc.chapterNumber} />
          </>
        ) : null}
        {toolsTab === "meta" ? (
          <BookMetaPanel
            book={data.book}
            onSaved={(payload) => {
              dataRef.current = payload;
              setData(payload);
              setTitle(payload.book.title);
              setNotice("书信息已更新");
            }}
          />
        ) : null}
        {toolsTab === "hooks" ? (
          <HooksPanel
            bookId={id}
            onJumpChapter={(number) => {
              setDoc({ kind: "chapter_body", chapterNumber: number, label: "正文" });
              setToolsOpen(false);
            }}
          />
        ) : null}
        {toolsTab === "bible" ? <BibleCardsPanel bookId={id} /> : null}
        {toolsTab === "history" ? (
          <VersionHistory
            bookId={id}
            kind={doc.kind}
            chapterNumber={doc.chapterNumber}
            onRestored={(body) => {
              setDraft(body);
              setSavedText(body);
              setWriting(true);
              setNotice("已还原为该版本（已写入新修订）");
              void api.book(id).then((payload) => {
                dataRef.current = payload;
                setData(payload);
                setRevision(findArtifact(payload, doc)?.revision ?? 0);
              });
            }}
          />
        ) : null}
        {toolsTab === "review" ? (
          doc.kind === "review_report" && doc.chapterNumber ? (
            <ReviewFixPanel
              bookId={id}
              chapterNumber={doc.chapterNumber}
              body={draft}
              busy={busy === "assist"}
              onLocate={(issue) => void locateReviewIssue(issue)}
              onFix={(issue) => void fixReviewIssue(issue)}
            />
          ) : (
            <div className="panel-block">
              <p className="panel-muted">打开某一章的「审核」稿后，可在这里定位正文并一键改。</p>
            </div>
          )
        ) : null}
      </ToolsDrawer>

      <aside className="assistant rail companion">
        <header className="assistant-head">
          <h2>助手</h2>
          <span className="model-cluster">
            {canPickModel ? (
              <span className="studio-model">
                <button
                  type="button"
                  className={pickingModel ? "model-line open" : "model-line"}
                  title={`切换「${SCENE_NAME[scene]}」场景的模型（只改当前场景）`}
                  onClick={() => setPickingModel((v) => !v)}
                >
                  <span className="model-scene-tag">{SCENE_NAME[scene]}</span>
                  <span className="model-scene-sep">·</span>
                  <span>{modelLine}</span>
                </button>
                {pickingModel ? (
                  <div className="studio-model-menu">
                    <p className="studio-model-caption">
                      仅改「{SCENE_NAME[scene]}」场景路由
                      {needsKey ? "（还没填 API Key，会退回本地草稿）" : ""}
                    </p>
                    <div className="studio-model-source" role="group" aria-label="来源">
                      <button
                        type="button"
                        className={route?.provider === "local" ? "chip on" : "chip"}
                        onClick={() => {
                          void applySceneProvider("local").then(() => setPickingModel(false));
                        }}
                      >
                        本地草稿
                      </button>
                      <button
                        type="button"
                        className={route?.provider === "openai" ? "chip on" : "chip"}
                        onClick={() => {
                          void applySceneProvider("openai");
                        }}
                      >
                        OpenAI 兼容
                      </button>
                    </div>
                    {route?.provider === "openai" || needsKey ? (
                      <ModelPicker
                        compact
                        value={route?.provider === "openai" && route.modelId !== "local-draft" ? route.modelId : provider?.defaultModel || ""}
                        models={modelCatalog}
                        placeholder="搜索或输入模型"
                        allowEmpty
                        emptyLabel="使用默认模型"
                        onChange={(value) => {
                          void applySceneModel(value).then(() => setPickingModel(false));
                        }}
                      />
                    ) : null}
                    <div className="studio-thinking" role="group" aria-label="思考强度">
                      <span className="studio-thinking-label">思考强度</span>
                      {THINKING_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          className={(route?.thinkingIntensity ?? "medium") === opt.value ? "chip on" : "chip"}
                          onClick={() => {
                            void applySceneThinking(opt.value);
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="studio-model-actions">
                      <Link className="text-link" to="/models" onClick={() => setPickingModel(false)}>
                        全部场景…
                      </Link>
                      <button type="button" className="text-link" onClick={() => setPickingModel(false)}>
                        关闭
                      </button>
                    </div>
                  </div>
                ) : null}
              </span>
            ) : (
              <span className={needsKey ? "model-line warn" : "model-line"} title={`「${SCENE_NAME[scene]}」场景模型`}>
                <span className="model-scene-tag">{SCENE_NAME[scene]}</span>
                <span className="model-scene-sep">·</span>
                <span>{modelLine}</span>
              </span>
            )}
            {needsKey ? (
              <Link className="key-hint" to="/models">
                去填写 API
              </Link>
            ) : null}
            {!needsKey && (route?.provider !== "openai" || assistLocal) ? (
              <Link className="key-hint soft" to="/models" title="本地草稿只适合起稿，正式改写请接模型">
                本地草稿
              </Link>
            ) : null}
            <span className="thinking-pill" title={`「${SCENE_NAME[scene]}」思考强度`}>
              思考·{thinkingLabel(route?.thinkingIntensity)}
            </span>
          </span>
        </header>
        {settingsExpanded ? (
          <div className="assistant-context">
            <div className="context-top">
              <div className="segment" role="tablist" aria-label="场景">
                {segments(doc).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={scene === item.id}
                    className={scene === item.id ? "on" : ""}
                    onClick={() => setScene(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {messages.length ? (
                <button type="button" className="icon-btn" aria-label="收起设置" title="收起" onClick={() => setSettingsOpen(false)}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M3.5 8.75 7 5.25l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}
            </div>
            {sceneSkills.length ? (
              <ul className="skill-list">
                {sceneSkills.map((skill) => {
                  const on = checked.includes(skill.id);
                  const isLocked = locked === skill.id;
                  return (
                    <li key={skill.id}>
                      <span className="skill-name">{skill.name}</span>
                      <span className={skill.role === "primary" ? "role primary" : "role"}>
                        {skill.role === "primary" ? "主技能" : "辅助"}
                      </span>
                      {isLocked ? (
                        <span className="locked" title="这个场景唯一的主技能，生成时必选" aria-label={`${skill.name}：必选`}>
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <rect x="2.5" y="5.25" width="7" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
                            <path d="M4.25 5.25V4a1.75 1.75 0 0 1 3.5 0v1.25" stroke="currentColor" strokeWidth="1.2" />
                          </svg>
                          必选
                        </span>
                      ) : (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${skill.name}${on ? "已启用" : "未启用"}`}
                          className={on ? "toggle on" : "toggle"}
                          onClick={() =>
                            setChecked((list) => (list.includes(skill.id) ? list.filter((item) => item !== skill.id) : [...list, skill.id]))
                          }
                        >
                          <i />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="skill-empty">这个场景还没有启用的技能。</p>
            )}
          </div>
        ) : (
          <button type="button" className="context-summary" onClick={() => setSettingsOpen(true)} aria-expanded={false}>
            <span className="summary-scene">{SCENE_NAME[scene]}</span>
            <span className="summary-sep">·</span>
            <span className="summary-skills">
              {activeSkills.length ? activeSkills.map((skill) => skill.name).join("、") : "无技能"}
            </span>
            <span className="spacer" />
            <span className="summary-edit">设置</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div className="transcript" ref={transcriptRef}>
          {messages.length === 0 && !pendingUser && !busy ? (
            <div className="chat-empty">
              <div className="chat-empty-mark">长</div>
              <p className="chat-empty-title">想让墨兰写作做什么？</p>
              <p className="chat-empty-sub">选一条开头，或直接输入。</p>
              <div className="suggestions">
                {suggestions.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className="suggestion"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setChatText(item);
                      composerRef.current?.focus();
                    }}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="msg user">
                <p>{message.content}</p>
              </div>
            ) : (
              <div key={message.id} className="msg bot">
                <div className="who">
                  <span className="bot-mark">长</span>
                  墨兰
                </div>
                <AssistantMessage
                  content={message.content}
                  hasSummary={Boolean(message.meta?.saved)}
                  action={
                    message.meta?.saved ? (
                      <button
                        type="button"
                        className="saved-chip"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          const saved = message.meta!.saved!;
                          const label = CHILDREN.find((child) => child.kind === saved.kind)?.label ?? (saved.kind === "book_outline" ? "大纲" : "档案");
                          void open({ kind: saved.kind as Kind, chapterNumber: saved.chapterNumber ?? null, label });
                        }}
                      >
                        打开{savedLabel(message.meta.saved.kind, message.meta.saved.chapterNumber)}
                      </button>
                    ) : undefined
                  }
                />
              </div>
            ),
          )}
          {pendingUser ? (
            <div className="msg user pending-user">
              <p>{pendingUser}</p>
            </div>
          ) : null}
          {busy ? (
            <div className="msg bot pending" aria-live="polite">
              <div className="who">
                <span className="bot-mark">长</span>
                墨兰
              </div>
              <div className="pending-line">
                <span className="typing">
                  <i />
                  <i />
                  <i />
                </span>
                {streamStatus
                  || (busy === "generate"
                  ? `正在${generateLabel.replace("生成", "写")}…`
                  : busy === "assist"
                    ? "正在改选区…"
                    : "正在想…")}
                {(busy === "generate" || busy === "chat" || busy === "assist") ? (
                  <button type="button" className="text-link stream-stop-inline" onClick={() => cancelStream()}>
                    停止
                  </button>
                ) : null}
              {busy === "chat" && streamPreview ? (
                <pre className="stream-chat-preview">{streamPreview.slice(0, 480)}{streamPreview.length > 480 ? "…" : ""}</pre>
              ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <div className={jobOpen ? "jobs-panel open" : "jobs-panel"}>
          <button type="button" className="jobs-toggle" onClick={() => setJobOpen((v) => !v)} aria-expanded={jobOpen}>
            <span>批量写</span>
            <span className="jobs-meta">
              {jobs[0] ? `${jobs[0].status === "running" ? "进行中" : jobs[0].status === "done" ? "已完成" : jobs[0].status === "paused" ? "已暂停" : jobs[0].status} · 第 ${jobs[0].currentChapter} 章` : "大纲→细纲→正文"}
            </span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d={jobOpen ? "M3 7.5 6 4.5 9 7.5" : "M3 4.5 6 7.5 9 4.5"} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {jobOpen ? (
            <div className="jobs-body">
              <p className="jobs-help">质量闸门：大纲 → 细纲 → 正文 → 等待记忆抽取 →（可选）自动审核 → 下一章。失败可重试。</p>
              <label className="jobs-check">
                <input type="checkbox" checked={jobAutoReview} onChange={(e) => setJobAutoReview(e.target.checked)} />
                写完后自动审核
              </label>
              <label className="jobs-check">
                失败重试
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={jobMaxRetries}
                  onChange={(e) => setJobMaxRetries(Math.max(0, Number(e.target.value) || 0))}
                />
                次
              </label>
              <div className="jobs-range">
                <label>
                  从
                  <input
                    type="number"
                    min={1}
                    max={data.book.targetChapters || data.chapters.length}
                    value={jobFrom}
                    disabled={jobBusy || Boolean(busy)}
                    onChange={(e) => setJobFrom(Number(e.target.value) || 1)}
                  />
                </label>
                <label>
                  到
                  <input
                    type="number"
                    min={1}
                    max={data.book.targetChapters || data.chapters.length}
                    value={jobTo}
                    disabled={jobBusy || Boolean(busy)}
                    onChange={(e) => setJobTo(Number(e.target.value) || 1)}
                  />
                </label>
                <span className="jobs-range-hint">共 {data.chapters.length} 章</span>
              </div>
              <div className="jobs-actions">
                <button type="button" className="btn small" disabled={jobBusy || Boolean(busy)} onClick={() => void startJob()}>
                  {jobBusy ? "…" : "开新任务"}
                </button>
                {jobs[0] && jobs[0].status !== "done" ? (
                  <>
                    <button
                      type="button"
                      className="btn small primary"
                      disabled={jobBusy || Boolean(busy) || jobs[0].status === "paused"}
                      onClick={() => void tickActiveJob(jobs[0]!.id)}
                    >
                      推进一步
                    </button>
                    <button
                      type="button"
                      className={jobAuto ? "btn small working" : "btn small"}
                      disabled={jobBusy && !jobAuto}
                      onClick={() => void runJobAuto(jobs[0]!.id)}
                    >
                      {jobAuto ? "停止自动" : "自动连跑"}
                    </button>
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={jobBusy}
                      onClick={() => void toggleJob(jobs[0]!.id, jobs[0]!.status === "paused" ? "running" : "paused")}
                    >
                      {jobs[0].status === "paused" ? "继续" : "暂停"}
                    </button>
                  </>
                ) : null}
              </div>
              {jobs.length ? (
                <ul className="jobs-list">
                  {jobs.slice(0, 4).map((job) => (
                    <li key={job.id} className={`job-row is-${job.status}`}>
                      <span className="job-stage">{STAGE_LABEL[job.currentStage] ?? job.currentStage}</span>
                      <span className="job-range">
                        第 {job.fromChapter}–{job.toChapter} 章 · 当前 {job.currentChapter}
                        {job.autoReview ? " · 审核开" : ""}
                        {job.retryCount ? ` · 已重试 ${job.retryCount}` : ""}
                      </span>
                      <span className="job-status">{job.status}</span>
                      {job.error ? <span className="job-error">{job.error}</span> : null}
                      {job.status === "error" ? (
                        <button
                          type="button"
                          className="btn small ghost"
                          disabled={jobBusy}
                          onClick={() => {
                            void api.retryJob(job.id).then((next) => {
                              setJobs((list) => list.map((item) => (item.id === job.id ? next : item)));
                              setNotice("已重新排队失败任务");
                            });
                          }}
                        >
                          重试本章
                        </button>
                      ) : null}
                      {job.log?.length ? (
                        <ul className="job-log">
                          {job.log.slice(-4).map((entry, i) => (
                            <li key={`${job.id}-log-${i}`}>
                              {STAGE_LABEL[entry.stage] ?? entry.stage} · {entry.message}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="jobs-empty">还没有批量任务</p>
              )}
            </div>
          ) : null}
        </div>
        <footer className="composer">
          {error ? <p className="alert">{error}</p> : null}
          <div className={busy ? "composer-box busy" : "composer-box"}>
            <div className="grow" data-value={mirror(chatText)}>
              <textarea
                ref={composerRef}
                rows={1}
                value={chatText}
                placeholder="让墨兰写作改写、续写，或问点什么…"
                onChange={(event) => setChatText(event.target.value)}
                onCompositionStart={() => {
                  composerComposing.current = true;
                }}
                onCompositionEnd={() => {
                  composerComposing.current = false;
                  composerSwallowEnter.current = true;
                  setTimeout(() => {
                    composerSwallowEnter.current = false;
                  }, 0);
                }}
                onKeyDown={(event) => {
                  if (composerComposing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter" && composerSwallowEnter.current) {
                    composerSwallowEnter.current = false;
                    event.preventDefault();
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="send"
              aria-label="发送"
              title="发送（Enter）"
              onClick={() => void send()}
              disabled={Boolean(busy) || !chatText.trim()}
            >
              {busy === "chat" ? (
                <Spinner />
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          <div className="generate-row">
            <label className="thinking-inline" title="当前场景的思考强度，可在上方模型菜单或「模型」页修改">
              <span>思考</span>
              <select
                value={route?.thinkingIntensity ?? "medium"}
                aria-label="思考强度"
                disabled={Boolean(busy)}
                onChange={(e) => {
                  void applySceneThinking(e.target.value as ThinkingIntensity);
                }}
              >
                {THINKING_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={busy === "generate" ? "btn primary generate working" : "btn primary generate"}
              onClick={() => {
                if (busy === "generate") cancelStream();
                else void generate();
              }}
              disabled={Boolean(busy) && busy !== "generate"}
              aria-busy={busy === "generate"}
            >
              {busy === "generate" ? <Spinner /> : null}
              {busy === "generate" ? "停止生成" : "生成此稿"}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function savedLabel(kind: string, chapterNumber: number | null) {
  const name = KIND_NAME[kind] ?? kind;
  return chapterNumber ? ` 第 ${chapterNumber} 章 ${name}` : ` ${name}`;
}
