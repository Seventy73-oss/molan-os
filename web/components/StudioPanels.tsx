import { Link } from "react-router-dom";
import { Icon, type IconName } from "./Icon";
import { t as tr, useLocale, getLocale } from "../lib/i18n";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  type BibleCard,
  type Book,
  type BookProgress,
  type HookItem,
  type RevisionMeta,
  type ReviewIssue,
  type SearchHit,
} from "../api";

const KIND_LABEL: Record<string, string> = {
  character: "人物",
  prop: "物件",
  place: "地点",
};

type SearchProps = {
  bookId: string;
  onJump: (hit: SearchHit) => void;
};

export function BookSearch({ bookId, onJump }: SearchProps) {
  useLocale();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      setBusy(true);
      setError("");
      void api
        .search(bookId, q.trim())
        .then((res) => setHits(res.hits))
        .catch((err: Error) => setError(err.message))
        .finally(() => setBusy(false));
    }, 220);
    return () => window.clearTimeout(handle);
  }, [bookId, q]);

  return (
    <div className="panel-block search-panel">
      <label className="panel-field">
        <span className="panel-label">{tr("全书搜索")}</span>
        <input
          value={q}
          placeholder={tr("搜章名、正文、细纲…")}
          onChange={(e) => setQ(e.target.value)}
          aria-label={tr("全书搜索")}
        />
      </label>
      {busy ? <p className="panel-muted">{tr("搜索中…")}</p> : null}
      {error ? <p className="panel-error">{tr(error)}</p> : null}
      {!busy && q.trim() && hits.length === 0 ? <p className="panel-muted">{tr("没有结果")}</p> : null}
      <ul className="hit-list">
        {hits.map((hit, index) => (
          <li key={`${hit.kind}-${hit.chapterNumber}-${hit.index}-${index}`}>
            <button type="button" className="hit-item" onClick={() => onJump(hit)}>
              <span className="hit-title">{hit.title}</span>
              <span className="hit-snip">{hit.snippet}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type HistoryProps = {
  bookId: string;
  kind: string;
  chapterNumber: number | null;
  onRestored: (body: string) => void;
};

export function VersionHistory({ bookId, kind, chapterNumber, onRestored }: HistoryProps) {
  useLocale();
  const [revisions, setRevisions] = useState<RevisionMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<{
    leftRevision: number | null;
    rightRevision: number;
    hunks: { type: "same" | "add" | "del"; text: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    setBusy(true);
    setError("");
    try {
      const res = await api.revisions(bookId, kind, chapterNumber);
      setRevisions(res.revisions);
      if (!selected && res.revisions[0]) setSelected(res.revisions[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取修订失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, kind, chapterNumber]);

  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    void api
      .revisionDiff(bookId, selected)
      .then((res) =>
        setDiff({
          leftRevision: res.leftRevision,
          rightRevision: res.rightRevision,
          hunks: res.hunks.slice(0, 120),
        }),
      )
      .catch(() => setDiff(null));
  }, [bookId, selected]);

  async function restore(id: string) {
    if (!window.confirm(tr("还原为这一版？会生成新修订，不会删掉现有历史。"))) return;
    setBusy(true);
    try {
      const res = await api.restoreRevision(bookId, id);
      onRestored(res.body.body);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "还原失败");
    } finally {
      setBusy(false);
    }
  }

  const current = revisions.find((r) => r.isCurrent);
  const previousOfCurrent = current
    ? revisions.find((r) => !r.isCurrent && r.revision === current.revision - 1) ||
      revisions.filter((r) => !r.isCurrent && r.revision < current.revision).sort((a, b) => b.revision - a.revision)[0]
    : undefined;

  return (
    <div className="panel-block history-panel">
      <div className="panel-row">
        <span className="panel-label">{tr("版本历史")}</span>
        <button type="button" className="text-link" disabled={busy} onClick={() => void reload()}>{tr("刷新")}</button>
      </div>
      {previousOfCurrent ? (
        <div className="panel-row history-restore-prev">
          <span className="panel-muted">{tr("当前稿可退回上一版（生成新修订，不删历史）")}</span>
          <button
            type="button"
            className="text-link"
            disabled={busy}
            data-testid="restore-previous"
            onClick={() => void restore(previousOfCurrent.id)}
          >{tr("还原上一版")}</button>
        </div>
      ) : null}
      {error ? <p className="panel-error">{tr(error)}</p> : null}
      {!revisions.length ? <p className="panel-muted">{tr("还没有修订记录")}</p> : null}
      <ul className="rev-list">
        {revisions.map((rev) => (
          <li key={rev.id} className={selected === rev.id ? "on" : ""}>
            <button type="button" className="rev-item" onClick={() => setSelected(rev.id)}>
              <span className="rev-num">{tr("修订")}{rev.revision}
                {rev.isCurrent ? <em>{tr("当前")}</em> : null}
              </span>
              <span className="rev-meta">
                {rev.source === "agent_cancelled" ? tr("已取消写入") : rev.source}
                {rev.source === "agent_cancelled" ? tr(" · 可还原") : ""} · {rev.chars}{tr(" 字 ·")}{" "}
                {new Date(rev.createdAt).toLocaleString(getLocale(), { hour12: false })}
              </span>
            </button>
            {!rev.isCurrent ? (
              <button type="button" className="text-link" disabled={busy} onClick={() => void restore(rev.id)}>{tr("还原")}</button>
            ) : null}
          </li>
        ))}
      </ul>
      {diff ? (
        <div className="diff-box" aria-label={tr("相邻修订对比")}>
          <div className="diff-head">
            {diff.leftRevision != null ? `r${diff.leftRevision}` : tr("（无上一版）")} → r{diff.rightRevision}
          </div>
          <pre className="diff-body">
            {diff.hunks.map((hunk, i) => (
              <span key={i} className={`diff-${hunk.type}`}>
                {hunk.type === "add" ? "+" : hunk.type === "del" ? "-" : " "}
                {hunk.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

type ProgressProps = {
  progress?: BookProgress | null;
  chapterNumber: number | null;
};

export function ProgressPanel({ progress, chapterNumber }: ProgressProps) {
  useLocale();
  if (!progress) return null;
  const pct = progress.targetWords ? Math.min(100, Math.round((progress.words / progress.targetWords) * 100)) : 0;
  const current = chapterNumber ? progress.chapters.find((c) => c.number === chapterNumber) : null;
  return (
    <div className="panel-block progress-panel">
      <div className="panel-row">
        <span className="panel-label">{tr("进度")}</span>
        <span className="panel-muted">
          {progress.words} / {progress.targetWords}{tr(" 字 · ")}{progress.draftedCount}/{progress.targetChapters}{tr("章")}</span>
      </div>
      <div className="progress fat" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      {current ? (
        <p className="panel-muted">{tr("本章")}{current.words} / {current.target}{tr("字")}{current.target ? `（${Math.min(100, Math.round((current.words / current.target) * 100))}%）` : ""}
        </p>
      ) : null}
      <ul className="chapter-progress-list">
        {progress.chapters.map((ch) => {
          const w = ch.target ? Math.min(100, Math.round((ch.words / ch.target) * 100)) : 0;
          return (
            <li key={ch.number} className={chapterNumber === ch.number ? "on" : ""}>
              <span className="cp-num">{String(ch.number).padStart(2, "0")}</span>
              <span className="cp-bar">
                <span style={{ width: `${w}%` }} />
              </span>
              <span className="cp-words">{ch.words}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type ReviewProps = {
  bookId: string;
  chapterNumber: number;
  body: string;
  onLocate: (issue: ReviewIssue) => void;
  onFix: (issue: ReviewIssue) => void;
  busy?: boolean;
};

export function ReviewFixPanel({ bookId, chapterNumber, body, onLocate, onFix, busy }: ReviewProps) {
  useLocale();
  const [issues, setIssues] = useState<ReviewIssue[]>([]);

  useEffect(() => {
    if (!body.trim()) {
      setIssues([]);
      return;
    }
    void api
      .reviewIssues(bookId, chapterNumber)
      .then((res) => setIssues(res.issues))
      .catch(() => setIssues([]));
  }, [bookId, chapterNumber, body]);

  if (!issues.length) {
    return (
      <div className="panel-block review-fix-panel">
        <span className="panel-label">{tr("审核改稿")}</span>
        <p className="panel-muted">{tr("生成审核后，这里会列出可定位、可一键改的问题。")}</p>
      </div>
    );
  }

  return (
    <div className="panel-block review-fix-panel">
      <span className="panel-label">{tr("审核改稿 · ")}{issues.length}{tr(" 条")}</span>
      <ul className="issue-list">
        {issues.map((issue) => (
          <li key={issue.index}>
            <div className="issue-head">
              <strong>
                {issue.index}. [{issue.type}]
              </strong>
              {issue.cite ? <code className="issue-cite">「{issue.cite}」</code> : null}
            </div>
            <p className="issue-text">{issue.text}</p>
            <div className="issue-actions">
              <button type="button" className="btn small ghost" disabled={busy || !issue.cite} onClick={() => onLocate(issue)}>{tr("定位正文")}</button>
              <button type="button" className="btn small primary" disabled={busy || !issue.cite} onClick={() => onFix(issue)}>{tr("一键改")}</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type BibleProps = {
  bookId: string;
};

export function BibleCardsPanel({ bookId }: BibleProps) {
  useLocale();
  const [cards, setCards] = useState<BibleCard[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState({ kind: "character", name: "", summary: "", details: "" });
  const [busy, setBusy] = useState(false);

  async function reload() {
    const res = await api.bible(bookId);
    setCards(res.cards);
  }

  useEffect(() => {
    void reload().catch((err: Error) => setError(err.message));
  }, [bookId]);

  const grouped = useMemo(() => {
    const map: Record<string, BibleCard[]> = {};
    for (const card of cards) {
      (map[card.kind] ??= []).push(card);
    }
    return map;
  }, [cards]);

  async function save() {
    if (!form.name.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (editing === "new") {
        await api.createBible(bookId, form);
      } else if (editing) {
        await api.updateBible(bookId, editing, form);
      }
      setEditing(null);
      setForm({ kind: "character", name: "", summary: "", details: "" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(tr("删除这张设定卡？"))) return;
    await api.deleteBible(bookId, id);
    await reload();
  }

  return (
    <div className="panel-block bible-panel">
      <div className="panel-row">
        <span className="panel-label">{tr("设定卡")}</span>
        <button
          type="button"
          className="text-link"
          onClick={() => {
            setEditing("new");
            setForm({ kind: "character", name: "", summary: "", details: "" });
          }}
        >{tr("新建")}</button>
      </div>
      {error ? <p className="panel-error">{tr(error)}</p> : null}
      {editing ? (
        <div className="bible-form">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="character">{tr("人物")}</option>
            <option value="prop">{tr("物件")}</option>
            <option value="place">{tr("地点")}</option>
          </select>
          <input
            placeholder={tr("名称")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            placeholder={tr("一句话摘要")}
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
          />
          <textarea
            rows={3}
            placeholder={tr("细节（外貌、动机、状态…）")}
            value={form.details}
            onChange={(e) => setForm({ ...form, details: e.target.value })}
          />
          <div className="actions end">
            <button type="button" className="btn small ghost" onClick={() => setEditing(null)}>{tr("取消")}</button>
            <button type="button" className="btn small primary" disabled={busy || !form.name.trim()} onClick={() => void save()}>{tr("保存")}</button>
          </div>
        </div>
      ) : null}
      {!cards.length && !editing ? <p className="panel-muted">{tr("还没有设定卡。人物、物件写在这里，生成时会带进上下文。")}</p> : null}
      {Object.entries(grouped).map(([kind, list]) => (
        <div key={kind} className="bible-group">
          <div className="bible-kind">{KIND_LABEL[kind] ?? kind}</div>
          {list.map((card) => (
            <article key={card.id} className="bible-card">
              <header>
                <strong>{card.name}</strong>
                <span className="bible-actions">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      setEditing(card.id);
                      setForm({
                        kind: card.kind,
                        name: card.name,
                        summary: card.summary,
                        details: card.details,
                      });
                    }}
                  >{tr("编辑")}</button>
                  <button type="button" className="text-link danger" onClick={() => void remove(card.id)}>{tr("删")}</button>
                </span>
              </header>
              {card.summary ? <p className="bible-summary">{card.summary}</p> : null}
              {card.details ? <p className="bible-details">{card.details}</p> : null}
            </article>
          ))}
        </div>
      ))}
    </div>
  );
}

type DrawerProps = {
  open: boolean;
  tab: "tools" | "bible" | "history" | "review" | "meta" | "hooks" | "story" | "foreshadow" | "context" | "graph";
  onTab: (tab: DrawerProps["tab"]) => void;
  onClose: () => void;
  children: ReactNode;
};

export function ToolsDrawer({ open, tab, onTab, onClose, children }: DrawerProps) {
  useLocale();
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);
  if (!open) return null;
  const tabs: { id: DrawerProps["tab"]; label: string; icon: IconName }[] = [
    { id: "tools", label: "进度", icon: "sliders" },
    { id: "meta", label: "信息", icon: "file" },
    { id: "hooks", label: "钩子", icon: "link" },
    { id: "foreshadow", label: "伏笔", icon: "flag" },
    { id: "story", label: "人物态", icon: "user" },
    { id: "context", label: "上下文", icon: "stack" },
    { id: "graph", label: "图谱", icon: "graph" },
    { id: "bible", label: "设定卡", icon: "book" },
    { id: "history", label: "版本", icon: "history" },
    { id: "review", label: "审核", icon: "check" },
  ];
  return <div className="tools-drawer" role="dialog" aria-label={tr("写作工具")}>
    <div className="tools-drawer-title"><div><Icon name="tools" size={19} /><h2>{tr("写作工具")}</h2></div><button type="button" className="drawer-close icon-button" onClick={onClose} aria-label={tr("关闭工具面板")}><Icon name="close" size={20} /></button></div>
    <div className="tools-drawer-head"><div className="tools-tabs">{tabs.map((item) => <button key={item.id} type="button" className={tab === item.id ? "on" : ""} aria-pressed={tab === item.id} onClick={() => onTab(item.id)}><Icon name={item.icon} size={16} /><span>{tr(item.label)}</span></button>)}</div></div>
    <div className="tools-drawer-body">{children}</div>
  </div>;
}

type MetaProps = {
  book: Book;
  onSaved: (payload: Awaited<ReturnType<typeof api.updateBook>>) => void;
};

export function BookMetaPanel({ book, onSaved }: MetaProps) {
  useLocale();
  const [form, setForm] = useState({
    title: book.title,
    genre: book.genre,
    logline: book.logline,
    style: book.style,
    targetChapters: book.targetChapters,
    wordsPerChapter: book.wordsPerChapter,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setForm({
      title: book.title,
      genre: book.genre,
      logline: book.logline,
      style: book.style,
      targetChapters: book.targetChapters,
      wordsPerChapter: book.wordsPerChapter,
    });
  }, [book.id, book.title, book.genre, book.logline, book.style, book.targetChapters, book.wordsPerChapter]);

  async function save() {
    if (!form.title.trim()) {
      setError("要有书名");
      return;
    }
    const shrinking = form.targetChapters < book.chapterCount;
    let confirmTrim = false;
    if (shrinking) {
      const ok = window.confirm(
        tr("目标章数从 {p0} 改为 {p1}，将删除后面的章节（有内容时需确认）。继续？", { p0: book.chapterCount, p1: form.targetChapters }),
      );
      if (!ok) return;
      confirmTrim = true;
    } else if (form.targetChapters > book.chapterCount) {
      const ok = window.confirm(tr("将新增第 {p0}–{p1} 章空章，确定？", { p0: book.chapterCount + 1, p1: form.targetChapters }));
      if (!ok) return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = await api.updateBook(book.id, { ...form, confirmTrim });
      onSaved(payload);
      setNotice("书信息已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-block meta-panel">
      <span className="panel-label">{tr("书信息")}</span>
      <label className="panel-field">
        <span className="panel-muted">{tr("书名")}</span>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </label>
      <label className="panel-field">
        <span className="panel-muted">{tr("题材")}</span>
        <input value={form.genre} onChange={(e) => setForm({ ...form, genre: e.target.value })} />
      </label>
      <label className="panel-field">
        <span className="panel-muted">{tr("简介")}</span>
        <textarea rows={3} value={form.logline} onChange={(e) => setForm({ ...form, logline: e.target.value })} />
      </label>
      <label className="panel-field">
        <span className="panel-muted">{tr("文风")}</span>
        <textarea rows={2} value={form.style} onChange={(e) => setForm({ ...form, style: e.target.value })} />
      </label>
      <div className="meta-nums">
        <label className="panel-field">
          <span className="panel-muted">{tr("目标章数")}</span>
          <input
            type="number"
            min={1}
            max={48}
            value={form.targetChapters}
            onChange={(e) => setForm({ ...form, targetChapters: Number(e.target.value) || 1 })}
          />
        </label>
        <label className="panel-field">
          <span className="panel-muted">{tr("每章字数")}</span>
          <input
            type="number"
            min={200}
            max={20000}
            step={100}
            value={form.wordsPerChapter}
            onChange={(e) => setForm({ ...form, wordsPerChapter: Number(e.target.value) || 2000 })}
          />
        </label>
      </div>
      {error ? <p className="panel-error">{tr(error)}</p> : null}
      {notice ? <p className="panel-muted">{tr(notice)}</p> : null}
      <div className="actions end">
        <button type="button" className="btn small primary" disabled={busy} onClick={() => void save()}>
          {busy ? tr("保存中…") : tr("保存书信息")}
        </button>
      </div>
    </div>
  );
}

type HooksProps = {
  bookId: string;
  onJumpChapter?: (number: number) => void;
};

export function HooksPanel({ bookId, onJumpChapter }: HooksProps) {
  useLocale();
  const [hooks, setHooks] = useState<HookItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    setBusy(true);
    setError("");
    try {
      const res = await api.hooks(bookId);
      setHooks(res.hooks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取钩子失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [bookId]);

  const openCount = hooks.filter((h) => h.warning || h.status === "open").length;

  async function mark(key: string, status: string) {
    setBusy(true);
    try {
      const res = await api.markHook(bookId, { key, status });
      setHooks(res.hooks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "标记失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-block hooks-panel">
      <div className="panel-row">
        <span className="panel-label">{tr("跨章钩子")}</span>
        <button type="button" className="text-link" disabled={busy} onClick={() => void reload()}>{tr("刷新")}</button>
      </div>
      <p className="panel-muted">
        {openCount ? <span className="hook-warn-badge">{openCount}{tr(" 条未回收")}</span> : tr("暂无未回收钩子")}
        {tr(" · 来自记忆/细纲，写入审核与后章上下文")}
      </p>
      {error ? <p className="panel-error">{tr(error)}</p> : null}
      {!hooks.length ? <p className="panel-muted">{tr("写完正文并抽出记忆后，这里会出现章末钩子。")}</p> : null}
      <ul className="hook-list">
        {hooks.map((hook) => (
          <li key={hook.key} className={hook.warning ? "hook-open" : "hook-ok"}>
            <div className="hook-head">
              <button
                type="button"
                className="text-link"
                onClick={() => onJumpChapter?.(hook.fromChapter)}
              >{tr("第")}{hook.fromChapter}{tr("章")}</button>
              <span className="hook-src">{hook.source === "memory" ? tr("记忆") : tr("细纲")}</span>
              {hook.warning ? <span className="hook-flag">{tr("未回收")}</span> : <span className="hook-flag ok">{tr("已回收")}{hook.recycledIn ? tr(" · 第{p0}章", { p0: hook.recycledIn }) : ""}</span>}
            </div>
            <p className="hook-text">{hook.text}</p>
            <div className="issue-actions">
              {hook.warning ? (
                <button type="button" className="btn small ghost" disabled={busy} onClick={() => void mark(hook.key, "marked")}>{tr("标为已处理")}</button>
              ) : (
                <button type="button" className="btn small ghost" disabled={busy} onClick={() => void mark(hook.key, "open")}>{tr("重开")}</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}


type StoryStateProps = { bookId: string; chapterNumber?: number | null };

/** G3 minimal: character dynamic state as-of chapter. */
export function StoryStatePanel({ bookId, chapterNumber }: StoryStateProps) {
  useLocale();
  const [chars, setChars] = useState<Array<{ id: string; name: string; summary: string; dynamic: Record<string, unknown> }>>([]);
  const [impact, setImpact] = useState<string>("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const asOf = chapterNumber && chapterNumber > 0 ? chapterNumber : null;

  async function reload() {
    setBusy(true);
    setError("");
    try {
      const res = await api.storyCharacters(bookId, asOf);
      setChars(res.characters);
      if (asOf) {
        const imp = await api.storyImpact(bookId, { chapterNumber: asOf });
        setImpact(
          `第${imp.chapterNumber}章影响：将失效事实 ${imp.wouldInvalidate.facts.length}、钩子事件 ${imp.wouldInvalidate.hookEvents.length}；后章可能需复核 ${imp.subsequentChaptersPossiblyStale.length}；不自动改正文。`,
        );
      } else setImpact("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [bookId, chapterNumber]);

  return (
    <div className="panel-block story-state-panel">
      <div className="panel-row">
        <span className="panel-label">{tr("人物动态")}{asOf ? tr(" · 截至第{p0}章前", { p0: asOf }) : ""}</span>
        <button type="button" className="text-link" disabled={busy} onClick={() => void reload()}>{tr("刷新")}</button>
      </div>
      <p className="panel-muted">{tr("地点/伤势/目标等按章合并；作者秘密默认不进读者视角。")}</p>
      {impact ? <p className="panel-muted">{impact}</p> : null}
      {error ? <p className="panel-error">{tr(error)}</p> : null}
      {!chars.length ? <p className="panel-muted">{tr("暂无人物动态。定稿并批准含 character_state 的提案后出现。")}</p> : null}
      <ul className="hook-list">
        {chars.map((c) => (
          <li key={c.id}>
            <div className="hook-head">
              <strong>{c.name || c.id}</strong>
            </div>
            {c.summary ? <p className="bible-summary">{c.summary}</p> : null}
            <p className="hook-text">
              {Object.keys(c.dynamic || {}).length
                ? Object.entries(c.dynamic)
                    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                    .join("；")
                : tr("尚无动态字段")}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ForeshadowProps = { bookId: string; chapterNumber?: number | null };

/** G3 minimal: foreshadow ledger with provenance. */
export function ForeshadowPanel({ bookId, chapterNumber }: ForeshadowProps) {
  useLocale();
  const [hooks, setHooks] = useState<
    Array<{
      hookStableId: string;
      description: string;
      status: string;
      plannedPayoffChapter: number | null;
      plantedChapter: number | null;
      paidOffChapter: number | null;
      events: Array<Record<string, unknown>>;
    }>
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const asOf = chapterNumber && chapterNumber > 0 ? chapterNumber : null;

  async function reload() {
    setBusy(true);
    setError("");
    try {
      const res = await api.storyForeshadowing(bookId, asOf);
      setHooks(res.hooks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [bookId, chapterNumber]);

  return (
    <div className="panel-block foreshadow-panel">
      <div className="panel-row">
        <span className="panel-label">{tr("有来源伏笔")}{asOf ? tr(" · 截至第{p0}章前", { p0: asOf }) : ""}</span>
        <button type="button" className="text-link" disabled={busy} onClick={() => void reload()}>{tr("刷新")}</button>
      </div>
      <p className="panel-muted">{tr("计划回收章不等于已回收；仅 paid_off 事件才算收回。")}</p>
      {error ? <p className="panel-error">{tr(error)}</p> : null}
      {!hooks.length ? <p className="panel-muted">{tr("暂无伏笔账本事件。")}</p> : null}
      <ul className="hook-list">
        {hooks.map((h) => (
          <li key={h.hookStableId} className={h.status === "paid_off" || h.status === "abandoned" ? "hook-ok" : "hook-open"}>
            <div className="hook-head">
              <span className="hook-flag">{h.status}</span>
              {h.plantedChapter ? <span className="hook-src">{tr("埋于第")}{h.plantedChapter}{tr("章")}</span> : null}
              {h.plannedPayoffChapter ? <span className="hook-src">{tr("计划第")}{h.plannedPayoffChapter}{tr("章")}</span> : null}
              {h.paidOffChapter ? <span className="hook-src">{tr("回收第")}{h.paidOffChapter}{tr("章")}</span> : null}
            </div>
            <p className="hook-text">{h.description}</p>
            <p className="panel-muted">{h.events.length}{tr(" 条事件 · 有出处")}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ContextPanelProps = { bookId: string; chapterNumber?: number | null };

/** G4: context inventory + budget estimate + publish checks. */
export function ContextPanel({ bookId, chapterNumber }: ContextPanelProps) {
  useLocale();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.contextPreview>> | null>(null);
  const [pub, setPub] = useState<Awaited<ReturnType<typeof api.publishCheck>> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const asOf = chapterNumber && chapterNumber > 0 ? chapterNumber : null;

  async function reload() {
    setBusy(true);
    setError("");
    try {
      const p = await api.contextPreview(bookId, asOf);
      setPreview(p);
      if (asOf) setPub(await api.publishCheck(bookId, asOf));
      else setPub(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [bookId, chapterNumber]);

  const budget = preview?.budgetEstimate;
  const included = preview?.manifest?.included ?? [];
  const excluded = preview?.manifest?.excluded ?? [];

  return (
    <div className="panel-block context-panel">
      <Link className="btn" to={`/references?book=${encodeURIComponent(bookId)}`}><Icon name="stack" size={16} />{tr("管理本书参考资料")}</Link>
      <p className="panel-muted">{tr("参考卡仅提供写作方法，不是设定或正式记忆。")}</p>
      <div className="panel-row">
        <span className="panel-label">{tr("上下文清单")}{asOf ? tr(" · 第{p0}章", { p0: asOf }) : ""}</span>
        <button type="button" className="text-link" disabled={busy} onClick={() => void reload()}>{tr("刷新")}</button>
      </div>
      <p className="panel-muted">{tr("模式 ")}{preview?.mode || "—"}{tr(" · 入选 ")}{included.length}{tr(" · 排除 ")}{excluded.length}</p>
      {budget ? (
        <p className="panel-muted">{tr("预算估算 ≈")}{budget.approxTokens} tokens（{budget.charCount}{tr(" 字，tokenizer=")}{budget.tokenizer}）
        </p>
      ) : null}
      {preview?.missing?.length ? (
        <ul className="hook-list">
          {preview.missing.map((m) => (
            <li key={m} className="hook-open">
              <p className="hook-text">{m}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-muted">{tr("资料齐全")}</p>
      )}
      {included.length ? (
        <>
          <p className="panel-label">{tr("已入选")}</p>
          <ul className="hook-list">
            {included.slice(0, 24).map((item, i) => (
              <li key={`${item.sourceId || i}`}>
                <div className="hook-head">
                  <strong>{String(item.kind || "item")}</strong>
                  <span className="panel-muted">{String(item.name || item.sourceId || "")}</span>
                </div>
                <p className="hook-text">{String(item.reason || "")}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {excluded.length ? (
        <>
          <p className="panel-label">{tr("未入选")}</p>
          <ul className="hook-list">
            {excluded.slice(0, 12).map((item, i) => (
              <li key={`${item.sourceId || i}`}>
                <p className="hook-text">
                  {String(item.sourceId || "")} · {String(item.reason || "")}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {pub ? (
        <>
          <p className="panel-label">{tr("发布检查 ")}{pub.ok ? <Icon name="check" size={16} /> : tr("有阻断")}</p>
          <ul className="hook-list">
            {pub.checks.map((c) => (
              <li key={c.id} className={c.level === "blocker" && !c.pass ? "hook-open" : "hook-ok"}>
                <p className="hook-text">[{c.level}] {c.message}</p>
              </li>
            ))}
          </ul>
          <p className="panel-muted">{pub.note}</p>
        </>
      ) : (
        <p className="panel-muted">{tr("打开章节后可看发布检查。")}</p>
      )}
      {error ? <p className="panel-error">{tr(error)}</p> : null}
    </div>
  );
}


type GraphProps = { bookId: string; chapterNumber?: number | null };

/** G5: relation / timeline / hooks views from same authority data + batch gates. */
export function StoryGraphPanel({ bookId, chapterNumber }: GraphProps) {
  useLocale();
  const [sub, setSub] = useState<"relations" | "timeline" | "hooks" | "batch">("relations");
  const [rel, setRel] = useState<Awaited<ReturnType<typeof api.storyRelationView>> | null>(null);
  const [timeline, setTimeline] = useState<Awaited<ReturnType<typeof api.storyTimelineView>> | null>(null);
  const [hooks, setHooks] = useState<Awaited<ReturnType<typeof api.storyHookView>> | null>(null);
  const [batch, setBatch] = useState<{
    id: string;
    status: string;
    progress: { items: Array<Record<string, unknown>>; gate: string | null; modelCalls?: number };
  } | null>(null);
  const [review, setReview] = useState<string>("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const asOf = chapterNumber && chapterNumber > 0 ? chapterNumber : null;

  async function reload() {
    setBusy(true);
    setError("");
    try {
      if (sub === "relations") setRel(await api.storyRelationView(bookId, asOf));
      if (sub === "timeline") setTimeline(await api.storyTimelineView(bookId, asOf));
      if (sub === "hooks") setHooks(await api.storyHookView(bookId, asOf));
      if (sub === "batch" && asOf) {
        const r = await api.readonlyStoryReview(bookId, asOf);
        setReview(r.findings.map((f) => `[${f.level}] ${f.message}`).join("\n"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [bookId, chapterNumber, sub]);

  async function runBatch() {
    if (!asOf) {
      setError("需要当前章节号才能跑批量记忆");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let b = await api.createMemoryReadyBatch(bookId, {
        fromChapter: asOf,
        toChapter: asOf,
        autoExtract: true,
        strictMemoryReady: true,
        maxModelCalls: 5,
      });
      b = await api.tickMemoryReadyBatch(bookId, b.id);
      setBatch(b);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批量失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-block story-graph-panel">
      <div className="panel-row">
        <span className="panel-label">{tr("同源派生视图")}{asOf ? tr(" · 截至第{p0}章", { p0: asOf }) : ""}</span>
        <button type="button" className="text-link" disabled={busy} onClick={() => void reload()}>{tr("刷新")}</button>
      </div>
      <div className="tools-tabs" style={{ marginBottom: 8 }}>
        {(
          [
            ["relations", tr("关系")],
            ["timeline", tr("时间线")],
            ["hooks", tr("伏笔视图")],
            ["batch", tr("批量记忆")],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={sub === id ? "on" : ""} onClick={() => setSub(id)}>
            {tr(label)}
          </button>
        ))}
      </div>
      <p className="panel-muted">{tr("视图只读派生；权威在定稿 / 事实 / hook_events。批量不绕过作者审批，无多 Agent 编排。")}</p>
      {error ? <p className="panel-error">{tr(error)}</p> : null}
      {sub === "relations" ? (
        <>
          <p className="panel-muted">{rel?.note}</p>
          <p className="panel-muted">{tr("节点")}{rel?.nodes?.length ?? 0}{tr(" · 边 ")}{rel?.edges?.length ?? 0}
          </p>
          <ul className="hook-list">
            {(rel?.edges ?? []).slice(0, 40).map((e) => (
              <li key={e.id}>
                <p className="hook-text">
                  {e.source} —[{e.label}]→ {e.target}
                </p>
              </li>
            ))}
          </ul>
          {!rel?.edges?.length ? <p className="panel-muted">{tr("暂无关系边。批准含 relation 的提案后出现。")}</p> : null}
        </>
      ) : null}
      {sub === "timeline" ? (
        <>
          <p className="panel-muted">{timeline?.note}</p>
          <ul className="hook-list">
            {(timeline?.events ?? []).slice(0, 60).map((ev) => (
              <li key={ev.id}>
                <div className="hook-head">
                  <strong>{tr("第")}{ev.chapter}{tr("章")}</strong>
                  <span className="hook-flag">{ev.kind}</span>
                  <span className="panel-muted">{ev.authorityTable}</span>
                </div>
                <p className="hook-text">{ev.title}</p>
                <p className="panel-muted">{ev.detail}</p>
              </li>
            ))}
          </ul>
          {!timeline?.events?.length ? <p className="panel-muted">{tr("暂无时间线事件。")}</p> : null}
        </>
      ) : null}
      {sub === "hooks" ? (
        <>
          <p className="panel-muted">{hooks?.note}</p>
          <ul className="hook-list">
            {(hooks?.hooks ?? []).map((h) => (
              <li key={String(h.hookStableId)}>
                <div className="hook-head">
                  <span className="hook-flag">{String(h.status)}</span>
                </div>
                <p className="hook-text">{String(h.description || h.hookStableId)}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {sub === "batch" ? (
        <>
          <button type="button" className="primary" disabled={busy || !asOf} onClick={() => void runBatch()}>{tr("对本开批记忆（extract→提案，不停写正式事实）")}</button>
          {batch ? (
            <p className="panel-muted">{tr("批次")}{batch.id.slice(0, 8)}… · {batch.status} · gate={String(batch.progress?.gate)} · items=
              {batch.progress?.items?.length ?? 0}
            </p>
          ) : null}
          {review ? <pre className="panel-muted" style={{ whiteSpace: "pre-wrap" }}>{review}</pre> : null}
        </>
      ) : null}
    </div>
  );
}
