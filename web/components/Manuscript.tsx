import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";

export type AssistAction = "rewrite" | "continue" | "polish" | "shorten" | "dialogue" | "custom";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Optional text bypasses React state lag after DOM replace. */
  onCommit: (text?: string) => void;
  placeholder: string;
  /** prose: indented paragraphs (chapter body). plain: unindented blocks with a blank-line gap (outlines, profile, review). */
  mode: "prose" | "plain";
  autoFocus?: boolean;
  /** Called when a bubble action needs AI rewrite of the selection. Return the replacement (or continuation-only for continue). */
  onAssist?: (payload: { action: AssistAction; selection: string; instruction: string }) => Promise<string>;
  /** Prefill companion composer with the quoted selection. */
  onAskAssistant?: (selection: string) => void;
  assistBusy?: boolean;
  /** Find this text in the doc, select it, and scroll into view. Token bumps re-trigger. */
  seek?: { text: string; token: number } | null;
  onSeekDone?: (found: boolean) => void;
};

const ACTIONS: { id: AssistAction; label: string; instruction: string }[] = [
  { id: "rewrite", label: "改写", instruction: "请改写下列选中文字，保持人称、事实与语气，只输出改写后的文字。" },
  { id: "continue", label: "续写", instruction: "请从下列选中文字末尾自然续写一小段（约80到150字）。只输出续写部分，不要重复原文。" },
  { id: "polish", label: "润色", instruction: "请润色下列选中文字，去掉套话和翻译腔，只输出润色后的文字。" },
  { id: "shorten", label: "缩短", instruction: "请压缩下列选中文字，保留关键信息与语气，只输出缩短后的文字。" },
  { id: "dialogue", label: "加强对白", instruction: "请改写下列选中文字，加强人物对白与潜台词，只输出改写后的文字。" },
];

type Bubble = {
  top: number;
  left: number;
  text: string;
  from: number;
  to: number;
  below: boolean;
};

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain "\\n\\n" manuscript → TipTap HTML (paragraphs + <br>). */
export function textToHtml(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized === "") return "<p></p>";
  return normalized
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n").map(escapeHtml);
      return `<p>${lines.join("<br>") || "<br>"}</p>`;
    })
    .join("");
}

/** TipTap doc → plain text with blank-line-separated blocks (md-sync compatible). */
export function serializeEditor(editor: Editor): string {
  const parts: string[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name !== "paragraph") return;
    let text = "";
    node.forEach((child) => {
      if (child.isText) text += child.text ?? "";
      else if (child.type.name === "hardBreak") text += "\n";
    });
    parts.push(text.replace(/\u00a0/g, " ").replace(/\u200b/g, ""));
  });
  if (parts.length === 1 && parts[0] === "") return "";
  return parts.join("\n\n");
}

function inlineContentFromBlock(block: string): JSONContent[] {
  const lines = block.split("\n");
  const content: JSONContent[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    if (line) content.push({ type: "text", text: line });
  });
  return content;
}

/** Assist result → TipTap content nodes (keeps plain-text fidelity). */
function textToInsertContent(text: string, mode: Props["mode"]): JSONContent[] | string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  if (!clean) return "";
  const blocks =
    mode === "prose"
      ? clean.split(/\n+/).map((line) => line.replace(/^[ \t\u3000]+/, "")).filter((line) => line.trim() !== "")
      : clean.split(/\n[ \t]*\n+/);
  if (blocks.length <= 1) {
    const block = blocks[0] ?? clean;
    const inline = inlineContentFromBlock(block);
    return inline.length ? inline : "";
  }
  return blocks.map((block) => ({
    type: "paragraph",
    content: inlineContentFromBlock(block),
  }));
}


function findTextRange(editor: Editor, needle: string): { from: number; to: number } | null {
  const want = needle.replace(/\s+/g, "");
  if (!want) return null;
  // Prefer exact contiguous text node match first.
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) {
      found = { from: pos + idx, to: pos + idx + needle.length };
      return false;
    }
  });
  if (found) return found;
  // Fallback: scan flattened text with whitespace ignored, map back approximately via textBetween windows.
  const docSize = editor.state.doc.content.size;
  const full = editor.state.doc.textBetween(0, docSize, "\n\n", "\n");
  const flatFull = full.replace(/\s+/g, "");
  const flatIdx = flatFull.indexOf(want);
  if (flatIdx < 0) return null;
  // Walk char by char mapping flat index to doc position — coarse: search sliding window of needle length in textBetween.
  const approx = needle.slice(0, Math.min(needle.length, 24));
  let pos = 0;
  while (pos < docSize) {
    const slice = editor.state.doc.textBetween(pos, Math.min(docSize, pos + needle.length + 40), "\n", "\n");
    const at = slice.indexOf(approx);
    if (at >= 0) {
      const from = pos + at;
      const to = Math.min(docSize, from + needle.length);
      return { from, to };
    }
    pos += 20;
  }
  return null;
}

function selectionBubble(editor: Editor): Bubble | null {
  const { from, to, empty } = editor.state.selection;
  if (empty || from === to) return null;
  const text = editor.state.doc.textBetween(from, to, "\n\n", "\n").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
  if (!text.trim()) return null;
  const start = editor.view.coordsAtPos(from);
  const end = editor.view.coordsAtPos(to);
  const topEdge = Math.min(start.top, end.top);
  const bottomEdge = Math.max(start.bottom, end.bottom);
  const midX = (start.left + end.right) / 2;
  const bubbleW = 420;
  const pad = 10;
  let left = midX;
  left = Math.max(pad + bubbleW / 2, Math.min(left, window.innerWidth - pad - bubbleW / 2));
  let top = topEdge - 10;
  let below = false;
  if (top < 56) {
    top = bottomEdge + 10;
    below = true;
  }
  return { top, left, text, from, to, below };
}

/**
 * TipTap manuscript editor.
 * Stores plain text with "\\n\\n" paragraph breaks so md sync stays compatible.
 * Bold/italic stay off so disk md matches what you see.
 */
export function Manuscript({
  value,
  onChange,
  onCommit,
  placeholder,
  mode,
  autoFocus,
  onAssist,
  onAskAssistant,
  assistBusy,
  seek,
  onSeekDone,
}: Props) {
  const emitted = useRef<string | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const savedSel = useRef<{ from: number; to: number; text: string } | null>(null);
  const busy = Boolean(assistBusy) || localBusy;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const promptOpenRef = useRef(false);
  promptOpenRef.current = promptOpen;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const editorRef = useRef<Editor | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        // Keep paragraph + hardBreak + undo/redo from the kit.
      }),
      Placeholder.configure({
        placeholder,
        emptyEditorClass: "is-empty",
        showOnlyWhenEditable: true,
        showOnlyCurrent: false,
      }),
    ],
    [placeholder],
  );

  const hideBubble = useCallback(() => {
    setBubble(null);
    setPromptOpen(false);
    setPromptText("");
    savedSel.current = null;
  }, []);

  const refreshBubble = useCallback(
    (editor: Editor | null) => {
      if (!editor || busyRef.current) return;
      const next = selectionBubble(editor);
      if (!next) {
        hideBubble();
        return;
      }
      savedSel.current = { from: next.from, to: next.to, text: next.text };
      setBubble(next);
    },
    [hideBubble],
  );

  const editor = useEditor({
    extensions,
    content: textToHtml(value),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: `manuscript ${mode}`,
        spellcheck: "false",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "稿件正文",
      },
      handlePaste(_view, event) {
        const plain = event.clipboardData?.getData("text/plain");
        if (plain == null) return false;
        event.preventDefault();
        const clean = plain.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/^\n+|\n+$/g, "");
        if (!clean) return true;
        const pasteMode = modeRef.current;
        const blocks =
          pasteMode === "prose"
            ? clean
                .split(/\n+/)
                .map((line) => line.replace(/^[ \t\u3000]+/, ""))
                .filter((line) => line.trim() !== "")
            : clean.split(/\n[ \t]*\n+/);
        const content: JSONContent[] = blocks.map((block) => ({
          type: "paragraph",
          content: inlineContentFromBlock(block),
        }));
        editorRef.current?.chain().focus().insertContent(content).run();
        return true;
      },
      handleDrop(_view, event) {
        if (event.dataTransfer?.types.includes("Files")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      handleKeyDown(_view, event) {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && ["b", "i", "u"].includes(event.key.toLowerCase())) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const next = serializeEditor(ed);
      emitted.current = next;
      if (next !== valueRef.current) onChangeRef.current(next);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      if (promptOpenRef.current || busyRef.current) return;
      requestAnimationFrame(() => refreshBubble(ed));
    },
  });

  editorRef.current = editor;

  // Seed / external value sync (chapter switch, stream fill, restore).
  useEffect(() => {
    if (!editor) return;
    if (emitted.current === value) return;
    const current = serializeEditor(editor);
    if (current === value) {
      emitted.current = value;
      return;
    }
    editor.commands.setContent(textToHtml(value), { emitUpdate: false });
    emitted.current = value;
  }, [value, editor]);

  useEffect(() => {
    if (!editor || !autoFocus) return;
    editor.commands.focus("end");
  }, [autoFocus, editor]);

  // External seek / highlight request (search hit, review cite).
  useEffect(() => {
    if (!editor || !seek?.text) return;
    const range = findTextRange(editor, seek.text);
    if (!range) {
      onSeekDone?.(false);
      return;
    }
    editor.chain().focus().setTextSelection(range).run();
    requestAnimationFrame(() => {
      try {
        const start = editor.view.coordsAtPos(range.from);
        const el = editor.view.dom;
        const parent = el.closest(".center.paper") as HTMLElement | null;
        if (parent) {
          const top = start.top - parent.getBoundingClientRect().top + parent.scrollTop - 120;
          parent.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        } else {
          editor.view.dispatch(editor.state.tr.scrollIntoView());
        }
      } catch {
        /* ignore */
      }
      onSeekDone?.(true);
    });
  }, [editor, seek?.token, seek?.text, onSeekDone]);

  // Commit on blur of the ProseMirror surface.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onBlur = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (bubbleRef.current && active && bubbleRef.current.contains(active)) return;
        if (dom.contains(active)) return;
        const nextText = serializeEditor(editor);
        emitted.current = nextText;
        onCommit(nextText);
      });
    };
    dom.addEventListener("blur", onBlur);
    return () => dom.removeEventListener("blur", onBlur);
  }, [editor, onCommit]);

  useEffect(() => {
    function onPointer(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (bubbleRef.current?.contains(target)) return;
      if (editor?.view.dom.contains(target)) return;
      hideBubble();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") hideBubble();
    }
    function onScroll() {
      if (!busyRef.current) hideBubble();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    const center = editor?.view.dom.closest(".center");
    center?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      center?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [editor, hideBubble]);

  async function runAssist(action: AssistAction, instruction: string) {
    if (!onAssist || !editor || busy) return;
    const sel = savedSel.current;
    if (!sel || !sel.text.trim()) return;
    const { from, to, text: selected } = sel;
    setLocalBusy(true);
    try {
      const result = await onAssist({ action, selection: selected, instruction });
      const next = (result ?? "").replace(/\r\n?/g, "\n").trim();
      if (!next) return;
      // Re-validate range against current doc size.
      const size = editor.state.doc.content.size;
      const safeFrom = Math.max(0, Math.min(from, size));
      const safeTo = Math.max(safeFrom, Math.min(to, size));
      if (action === "continue") {
        // Append a new paragraph after the selection so续写 stays md-sync friendly.
        const continued: JSONContent[] = [
          { type: "paragraph", content: inlineContentFromBlock(next) },
        ];
        editor.chain().focus().insertContentAt(safeTo, continued).run();
      } else {
        const insert = textToInsertContent(next, mode);
        editor.chain().focus().insertContentAt({ from: safeFrom, to: safeTo }, insert).run();
      }
      const nextText = serializeEditor(editor);
      emitted.current = nextText;
      if (nextText !== valueRef.current) onChange(nextText);
      hideBubble();
      onCommit(nextText);
    } finally {
      setLocalBusy(false);
    }
  }

  return (
    <>
      <EditorContent editor={editor} />
      {bubble
        ? createPortal(
            <div
              ref={bubbleRef}
              className={[busy ? "sel-bubble busy" : "sel-bubble", bubble.below ? "below" : ""].filter(Boolean).join(" ")}
              style={{ top: bubble.top, left: bubble.left }}
              role="toolbar"
              aria-label="选区助手"
              onMouseDown={(event) => {
                const target = event.target as HTMLElement | null;
                if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
                event.preventDefault();
              }}
            >
              <div className="sel-bubble-row">
                {ACTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="sel-chip"
                    disabled={busy || !onAssist}
                    title={item.instruction}
                    onClick={() => void runAssist(item.id, item.instruction)}
                  >
                    {item.label}
                  </button>
                ))}
                <span className="sel-sep" aria-hidden="true" />
                <button
                  type="button"
                  className={promptOpen ? "sel-chip soft on" : "sel-chip soft"}
                  disabled={busy}
                  onClick={() => setPromptOpen((open) => !open)}
                >
                  对助手说…
                </button>
              </div>
              {promptOpen ? (
                <div className="sel-prompt">
                  <textarea
                    value={promptText}
                    placeholder="例如：语气再冷一点，别解释动机…"
                    rows={2}
                    disabled={busy}
                    onChange={(event) => setPromptText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        const ask = promptText.trim();
                        if (!ask) return;
                        void runAssist("custom", ask);
                      }
                    }}
                  />
                  <div className="sel-prompt-actions">
                    {onAskAssistant ? (
                      <button
                        type="button"
                        className="sel-link"
                        disabled={busy}
                        onClick={() => {
                          onAskAssistant(bubble.text);
                          hideBubble();
                        }}
                      >
                        发到侧栏
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="sel-apply"
                      disabled={busy || !promptText.trim() || !onAssist}
                      onClick={() => {
                        const ask = promptText.trim();
                        if (!ask) return;
                        void runAssist("custom", ask);
                      }}
                    >
                      {busy ? "改写中…" : "应用到选区"}
                    </button>
                  </div>
                </div>
              ) : null}
              {busy ? <div className="sel-busy">正在改写选区…</div> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Text for a hidden auto-size mirror (used by the chat composer). Only pad when needed. */
export function mirror(text: string) {
  return text === "" || text.endsWith("\n") ? `${text} ` : text;
}
