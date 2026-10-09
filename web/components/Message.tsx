import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const SCENE_HEAD = /^(场景\s*[一二三四五六七八九十百\d]+)\s*[·・:：\-—]?\s*(.*)$/;
const CHAPTER_HEAD = /^(第\s*[一二三四五六七八九十百\d]+\s*章)\s*(.*)$/;
const FIELD = /^([\u4e00-\u9fa5A-Za-z]{1,6})[：:]\s*(.+)$/;

function Line({ text }: { text: string }) {
  if (!text.trim()) return <div className="m-gap" />;
  const scene = SCENE_HEAD.exec(text);
  if (scene) {
    return (
      <div className="m-head">
        <span className="m-head-tag">{scene[1]}</span>
        {scene[2]}
      </div>
    );
  }
  const chapter = CHAPTER_HEAD.exec(text);
  if (chapter && text.length <= 40) {
    return (
      <div className="m-head">
        <span className="m-head-tag">{chapter[1]}</span>
        {chapter[2]}
      </div>
    );
  }
  const field = FIELD.exec(text);
  if (field) {
    return (
      <div className="m-field">
        <span className="m-label">{field[1]}</span>
        <span>{field[2]}</span>
      </div>
    );
  }
  return <p className="m-line">{text}</p>;
}

/**
 * Assistant reply: optional one-line summary, then the reply body with structure (场景 / 目标 / 冲突 …)
 * shown line by line. Long replies collapse to about six lines with a 展开 toggle.
 */
export function AssistantMessage({ content, hasSummary, action }: { content: string; hasSummary: boolean; action?: ReactNode }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const summary = hasSummary && lines.length > 1 ? lines[0] : null;
  const body = (summary !== null ? lines.slice(1) : lines).join("\n").replace(/^\n+|\n+$/g, "").split(/\n/);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || open) return;
    setOverflow(el.scrollHeight > el.clientHeight + 2);
  }, [content, open]);

  return (
    <div className="m-content">
      {summary ? <p className="m-summary">{summary}</p> : null}
      <div ref={bodyRef} className={open ? "m-body" : overflow ? "m-body clamp fade" : "m-body clamp"}>
        {body.map((line, index) => (
          <Line key={index} text={line} />
        ))}
      </div>
      {overflow || action ? (
        <div className="m-actions">
          {overflow ? (
            <button type="button" className="m-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
              {open ? "收起" : "展开"}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={open ? "flip" : ""}>
                <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
