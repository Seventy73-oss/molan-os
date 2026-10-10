import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Book } from "../api";
import { useBookTitle } from "../App";

export function Library() {
  const navigate = useNavigate();
  const { setTitle } = useBookTitle();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState("");
  const [brief, setBrief] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", genre: "", logline: "" });
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState("");
  const [importConflict, setImportConflict] = useState<"new_book" | "overwrite" | "skip">("new_book");
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!confirmId) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setConfirmId("");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmId]);

  useEffect(() => {
    setTitle("");
    api.books().then((res) => setBooks(res.books)).catch((err: Error) => setError(err.message));
  }, [setTitle]);

  async function autoSetup(event: FormEvent) {
    event.preventDefault();
    if (!brief.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const book = await api.autoSetup(brief.trim());
      navigate(`/books/${book.book.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "建书失败");
      setBusy(false);
    }
  }

  async function manual(event: FormEvent) {
    event.preventDefault();
    if (!form.title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const book = await api.createBook(form);
      navigate(`/books/${book.book.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "建书失败");
      setBusy(false);
    }
  }

  return (
    <div className="page library-page page-enter">
      <header className="page-head library-hero">
        <div className="hero-copy">
          <p className="eyebrow">墨兰写作 · 书库</p>
          <h1>书稿</h1>
          <p className="sub">一句话起头，或自己写下书名。大纲、细纲和正文都留在同一本书里。</p>
        </div>
        <div className="actions library-actions">
          <button type="button" className="btn ghost" onClick={() => document.getElementById("brief")?.focus()}>
            一句话建书
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={importing}
            title="导入导出的全书 markdown zip"
            onClick={() => importRef.current?.click()}
          >
            {importing ? "导入中…" : "导入 zip"}
          </button>
          <select
            className="import-conflict"
            value={importConflict}
            aria-label="导入冲突策略"
            title="书名冲突时"
            onChange={(e) => setImportConflict(e.target.value as typeof importConflict)}
          >
            <option value="new_book">冲突则新建</option>
            <option value="overwrite">冲突则覆盖</option>
            <option value="skip">冲突则跳过</option>
          </select>
          <input
            ref={importRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setImporting(true);
              setError("");
              void api
                .importBook(file, importConflict)
                .then((res) => {
                  if (res.skipped) {
                    setError(`已跳过：书架上已有《${res.title}》`);
                    setImporting(false);
                    return;
                  }
                  navigate(`/books/${res.bookId}`);
                })
                .catch((err: Error) => {
                  setError(err.message);
                  setImporting(false);
                });
            }}
          />
          <button type="button" className="btn primary" onClick={() => setCreating((open) => !open)}>
            <span className="plus">+</span>
            新书
          </button>
        </div>
      </header>

      <form className={busy ? "brief busy" : "brief"} onSubmit={autoSetup}>
        <svg className="brief-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M4.2 11.8l1.4-1.4M10.4 5.6l1.4-1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <input
          id="brief"
          value={brief}
          readOnly={busy}
          aria-busy={busy}
          placeholder="都市悬疑，主角是旧物修复师，十二章。书名是某某"
          onChange={(e) => setBrief(e.target.value)}
        />
        {brief.trim() && !busy ? <kbd className="enter-hint">↵ 回车</kbd> : null}
        <button type="submit" className="btn primary small" disabled={busy || !brief.trim()}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "正在建书…" : "建书"}
        </button>
      </form>
      <p className="brief-hint">这是一段简介，不是书名。墨兰写作会从里面拆题材和主角，再起书名。想自己定名，写上「书名是……」。</p>

      {creating ? (
        <form className="card-form" onSubmit={manual}>
          <h2>新书</h2>
          <label>
            书名
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label>
            题材
            <input value={form.genre} onChange={(e) => setForm({ ...form, genre: e.target.value })} />
          </label>
          <label>
            简介
            <textarea className="field" rows={3} value={form.logline} onChange={(e) => setForm({ ...form, logline: e.target.value })} />
          </label>
          <div className="actions end">
            <button type="button" className="btn ghost" onClick={() => setCreating(false)}>
              取消
            </button>
            <button type="submit" className="btn primary" disabled={busy || !form.title.trim()}>
              创建
            </button>
          </div>
        </form>
      ) : null}

      {error ? <p className="alert">{error}</p> : null}

      <div className="section-label">
        <span>全部书稿</span>
        {books ? <span className="count">{books.length}</span> : null}
      </div>

      {books === null && !error ? <p className="empty loading-line">正在打开书库…</p> : null}
      {books && books.length === 0 ? <p className="empty">书架还空着。用一句话起头，或自己写一张档案。</p> : null}

      <div className="book-grid" style={{ gridTemplateColumns: `repeat(${books && books.length < 2 ? 2 : 3}, minmax(0, 1fr))` }}>
        {books?.map((book) => {
          const total = book.chapterCount || book.targetChapters || 1;
          const pct = Math.round((book.draftedCount / total) * 100);
          return (
            <div
              key={book.id}
              className="book-card"
              role="link"
              tabIndex={0}
              onClick={() => navigate(`/books/${book.id}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter") navigate(`/books/${book.id}`);
              }}
            >
              <div className="book-spine" aria-hidden="true" />
              <span className="book-genre">{book.genre || "未定题材"}</span>
              <span className="book-title">{book.title}</span>
              <span className="book-logline">{book.logline || "还没有简介。"}</span>
              <span className="book-foot">
                <span className="progress" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="book-progress">
                  {book.draftedCount} / {total} 章
                  {book.words != null ? ` · ${book.words} 字` : ""}
                </span>
                <button
                  type="button"
                  className="book-export"
                  title="导出全书 markdown"
                  onClick={(event) => {
                    event.stopPropagation();
                    const anchor = document.createElement("a");
                    anchor.href = api.exportBookUrl(book.id);
                    anchor.download = "";
                    document.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                  }}
                >
                  导出
                </button>
                <button
                  type="button"
                  className="book-export"
                  title="导出自包含故事包（定稿+事实+来源）"
                  onClick={(event) => {
                    event.stopPropagation();
                    const anchor = document.createElement("a");
                    anchor.href = api.exportStoryPackUrl(book.id, true);
                    anchor.download = "";
                    document.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                  }}
                >
                  故事包
                </button>
              </span>
              {confirmId === book.id ? (
                <span className="book-confirm" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <span>删除《{book.title}》？不能恢复。</span>
                  <span className="actions">
                    <button type="button" className="btn small ghost" onClick={() => setConfirmId("")}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn small danger"
                      onClick={() => {
                        void api.deleteBook(book.id).then(() => {
                          setBooks((list) => list?.filter((item) => item.id !== book.id) ?? null);
                          setConfirmId("");
                        }).catch((err: Error) => setError(err.message));
                      }}
                    >
                      删除
                    </button>
                  </span>
                </span>
              ) : (
                <button
                  type="button"
                  className="book-trash"
                  aria-label={`删除${book.title}`}
                  title="删除"
                  onClick={(event) => {
                    event.stopPropagation();
                    setConfirmId(book.id);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M3 4h8M5.5 4V3h3v1M4.5 4l.4 7h4.2l.4-7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
        {books ? (
          <button
            type="button"
            className={`book-card new ${books.length < 2 ? "wide" : `span-${3 - (books.length % 3)}`}`}
            onClick={() => {
              setCreating(true);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            <span className="new-plus" aria-hidden="true">+</span>
            <span className="new-text">
              <span className="new-title">新书</span>
              <span className="new-sub">写下书名和简介，或在上面用一句话起头。</span>
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
