import { t as tr, useLocale, getLocale } from "../lib/i18n";
import { useEffect, useRef, useState, type FormEvent, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Book } from "../api";
import { useBookTitle } from "../App";
import { Icon } from "../components/Icon";
import { PaperSculpture } from "../components/PaperSculpture";
import { useAtelierMotion } from "../lib/useAtelierMotion";
import { getLastOpenedBookId } from "../lib/lastOpenedBook";

export function Library() {
  const { locale } = useLocale();
  const motionRoot = useAtelierMotion();
  const navigate = useNavigate();
  const { setTitle } = useBookTitle();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [lastOpenedBookId] = useState(getLastOpenedBookId);
  const [error, setError] = useState("");
  const [brief, setBrief] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", genre: "", logline: "" });
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [importConflict, setImportConflict] = useState<"new_book" | "overwrite" | "skip">("new_book");
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const confirmTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const collectionHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!confirmId) return;
    const trigger = confirmTriggerRef.current;
    cancelDeleteRef.current?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Capture also receives Escape from the isolated controls inside the card.
      if (!cancelDeleteRef.current?.disabled) setConfirmId("");
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [confirmId]);
  useEffect(() => {
    setTitle("");
    api.books().then((res) => setBooks(res.books)).catch((err: Error) => setError(err.message));
  }, [setTitle]);
  useEffect(() => {
    if (creating) {
      formRef.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
      formRef.current?.querySelector("input")?.focus({ preventScroll: true });
    }
  }, [creating]);

  async function autoSetup(event: FormEvent) {
    event.preventDefault();
    if (!brief.trim() || busy) return;
    setBusy(true); setError("");
    try { const book = await api.autoSetup(brief.trim()); navigate(`/books/${book.book.id}`); }
    catch (err) { setError(err instanceof Error ? err.message : "建书失败"); setBusy(false); }
  }
  async function manual(event: FormEvent) {
    event.preventDefault();
    if (!form.title.trim() || busy) return;
    setBusy(true); setError("");
    try { const book = await api.createBook(form); navigate(`/books/${book.book.id}`); }
    catch (err) { setError(err instanceof Error ? err.message : "建书失败"); setBusy(false); }
  }
  function download(url: string) {
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  }
  const totalWords = books?.reduce((sum, book) => sum + (book.words || 0), 0) || 0;
  const chapters = books?.reduce((sum, book) => sum + book.draftedCount, 0) || 0;
  const resumeBook = books?.find((book) => book.id === lastOpenedBookId)
    ?? books?.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const filtered = (books || []).filter((book) => `${book.title} ${book.genre} ${book.logline}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => sort === "title" ? a.title.localeCompare(b.title, getLocale()) : sort === "words" ? (b.words || 0) - (a.words || 0) : b.createdAt.localeCompare(a.createdAt));

  return <div ref={motionRoot} className="page library-page atelier-library">
    <div className="atelier-scroll-line" aria-hidden="true" />
    <header className="page-head library-hero">
      <div className="hero-copy"><p className="eyebrow"><span className="eyebrow-line" />{tr("属于你的故事空间")}</p><span className="library-volume">MOLAN — A LITERARY ATELIER</span></div>
      <div className="actions library-actions">
        <details className="import-tools"><summary className="btn ghost" aria-label={tr("导入 zip")}><Icon name="upload" size={17} /><span>{tr("导入 zip")}</span><Icon name="down" size={13} /></summary><div className="import-options"><label>{tr("导入冲突策略")}<select className="import-conflict" value={importConflict} aria-label={tr("导入冲突策略")} onChange={(event) => setImportConflict(event.target.value as typeof importConflict)}><option value="new_book">{tr("冲突则新建")}</option><option value="overwrite">{tr("冲突则覆盖")}</option><option value="skip">{tr("冲突则跳过")}</option></select></label><button type="button" className="btn" disabled={importing} onClick={() => importRef.current?.click()}>{importing ? tr("导入中…") : tr("选择 ZIP 文件")}</button><p>{tr("导入导出的全书 markdown zip")}</p></div></details>
        <button type="button" className="btn primary" aria-expanded={creating} onClick={() => setCreating((open) => !open)}><Icon name="plus" size={18} />{tr("新书")}</button>
        <input ref={importRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
          setImporting(true); setError("");
          void api.importBook(file, importConflict).then((res) => {
            if (res.skipped) { setError(`已跳过：书架上已有《${res.title}》`); setImporting(false); return; }
            navigate(`/books/${res.bookId}`);
          }).catch((err: Error) => { setError(err.message); setImporting(false); });
        }} />
      </div>
    </header>

    <section className="atelier-hero" data-kinetic="paper" aria-labelledby="atelier-title">
      <div className="atelier-title-block">
        <span className="edition-marker">EST. IN YOUR IMAGINATION / 01</span>
        <h1 id="atelier-title" className={locale === "zh-CN" ? "atelier-title" : "atelier-title is-english"} aria-label={tr("书稿")}>
          <span className="title-line"><span>{tr("笔下，")}</span></span>
          <span className="title-line second"><span>{tr("有世界。")}</span><i className="title-period" aria-hidden="true" /></span>
        </h1>
        <div className="atelier-intro"><span className="intro-index" aria-hidden="true">[01]</span><p>{tr("故事还未发生，世界已在笔下。")}</p></div>
        <div className="atelier-entry">
          <button type="button" className="atelier-primary" disabled={books === null} onClick={() => resumeBook ? navigate(`/books/${resumeBook.id}`) : setCreating(true)}><span>{tr(resumeBook ? "继续创作" : "开始你的故事")}</span><span className="entry-icon"><Icon name="northeast" size={23} /></span></button>
          {resumeBook ? <span className="entry-book" title={resumeBook.title}>{resumeBook.title}</span> : <span className="entry-book">{tr("第一句话，就从这里开始。")}</span>}
        </div>
      </div>
      <PaperSculpture />
      <div className="hero-annotation"><span>THE SPACE BETWEEN WORDS</span><button type="button" onClick={() => document.querySelector(".library-collection-head")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })}><span>{tr("向下，打开书架")}</span><Icon name="south" size={17} /></button></div>
    </section>

    <div className="library-overview reveal" aria-label={tr("创作概览")}>
      <div><Icon name="book" size={19} /><strong>{books ? books.length.toLocaleString(getLocale()) : "—"}</strong><span>{tr("本书稿")}</span></div>
      <div><Icon name="feather" size={19} /><strong>{books ? totalWords.toLocaleString(getLocale()) : "—"}</strong><span>{tr("字已写下")}</span></div>
      <div><Icon name="check" size={19} /><strong>{books ? chapters.toLocaleString(getLocale()) : "—"}</strong><span>{tr("章已起稿")}</span></div>
      <span className="overview-note">{tr("慢慢写，好故事值得等待。")}</span>
    </div>

    <section className="idea-panel reveal" aria-labelledby="idea-title">
      <div className="idea-intro"><span className="idea-mark"><Icon name="sparkles" size={22} /></span><div><h2 id="idea-title">{tr("从一个念头开始")}</h2><p>{tr("一句话建书，让灵感有迹可循。")}</p></div><span className="idea-index" aria-hidden="true">A SINGLE LINE.<br />AN ENTIRE WORLD.</span></div>
      <form className={busy ? "brief busy" : "brief"} onSubmit={autoSetup}><input id="brief" value={brief} readOnly={busy} aria-busy={busy} aria-label={tr("一句话建书")} placeholder={tr("都市悬疑，主角是旧物修复师，十二章。书名是某某")} onChange={(event) => setBrief(event.target.value)} /><button type="submit" className="btn primary" disabled={busy || !brief.trim()}>{busy ? <Icon name="loader" size={16} className="lucide-spin" /> : null}<span>{busy ? tr("正在建书…") : tr("建书")}</span><Icon name="arrow" size={17} /></button></form>
      <p className="brief-hint">{tr("这是一段简介，不是书名。墨兰写作会从里面拆题材和主角，再起书名。想自己定名，写上「书名是……」。")}</p>
    </section>

    {creating ? <form ref={formRef} className="card-form" onSubmit={manual}><header><div><p className="eyebrow">{tr("新的开始")}</p><h2>{tr("新书")}</h2></div><button type="button" className="icon-button" aria-label={tr("取消")} onClick={() => setCreating(false)}><Icon name="close" size={18} /></button></header><div className="new-book-fields"><label>{tr("书名")}<input required maxLength={200} value={form.title} placeholder={tr("为你的故事取个名字")} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label>{tr("题材")}<input value={form.genre} placeholder={tr("悬疑、幻想、都市…")} onChange={(event) => setForm({ ...form, genre: event.target.value })} /></label></div><label>{tr("简介")}<textarea className="field" rows={3} value={form.logline} placeholder={tr("关于谁，又发生了什么？")} onChange={(event) => setForm({ ...form, logline: event.target.value })} /></label><div className="actions end"><button type="button" className="btn ghost" onClick={() => setCreating(false)}>{tr("取消")}</button><button type="submit" className="btn primary" disabled={busy || !form.title.trim()}>{busy ? tr("正在建书…") : tr("创建")}<Icon name="arrow" size={17} /></button></div></form> : null}
    {error ? <p className="alert" role="alert">{tr(error)}</p> : null}

    <div className="library-collection-head reveal"><div className="collection-edition"><span>THE COLLECTION</span><span>VOL. {String(new Date().getFullYear()).slice(-2)}</span></div><div className="section-label"><h2 ref={collectionHeadingRef} tabIndex={-1}>{tr("全部书稿")}</h2>{books ? <span className="count">{books.length}</span> : null}</div><div className="collection-controls"><label className="book-search"><Icon name="search" size={16} /><input type="search" aria-label={tr("搜索书稿")} placeholder={tr("搜索书名、题材…")} value={query} onChange={(event) => setQuery(event.target.value)} /></label><select value={sort} aria-label={tr("书稿排序")} onChange={(event) => setSort(event.target.value)}><option value="newest">{tr("最新创建")}</option><option value="title">{tr("按书名")}</option><option value="words">{tr("按字数")}</option></select></div></div>
    {books === null && !error ? <p className="empty loading-line" role="status">{tr("正在打开书库…")}</p> : null}
    {books && !books.length ? <p className="library-empty-note">{tr("书架还空着。用一句话起头，或自己写一张档案。")}</p> : null}
    {Boolean(books?.length) && !filtered.length ? <div className="search-empty"><Icon name="search" size={26} /><p>{tr("没有找到匹配的书稿")}</p><button type="button" className="text-link" onClick={() => setQuery("")}>{tr("清除搜索")}</button></div> : null}
    <div className="book-grid">
      {filtered.map((book, index) => {
        const total = book.chapterCount || book.targetChapters || 1;
        const pct = Math.min(100, Math.round(book.draftedCount / total * 100));
        return <div key={book.id} className="book-card reveal" data-kinetic="book" style={{ "--book-tone": `${8 + index % 3 * 6}%`, "--book-order": index % 3, "--book-symbol-rotate": `${index * 17}deg` } as CSSProperties} role="link" tabIndex={0} aria-label={book.title} onClick={() => navigate(`/books/${book.id}`)} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") navigate(`/books/${book.id}`); }}>
          <div className="book-cover" aria-hidden="true"><div className="cover-topline"><span>MOLAN / EDITIONS</span><span>{String(index + 1).padStart(2, "0")}</span></div><div className="cover-art"><i /><i /><i /><i /><i /><i /></div><div className="cover-title">{book.title}</div><div className="cover-bottomline"><span>{book.genre || tr("未定题材")}</span><Icon name="feather" size={24} /></div><span className="cover-rule" /></div>
          <div className="book-details"><div className="book-heading"><span className="book-genre">{book.genre || tr("未定题材")}</span><Icon name="arrow" size={17} className="book-open-arrow" /></div><h3 className="book-title">{book.title}</h3><p className="book-logline">{book.logline || tr("还没有简介。")}</p><div className="book-foot"><span className="book-progress">{book.draftedCount} / {total} {tr("章")}<span>{(book.words || 0).toLocaleString(getLocale())} {tr("字")}</span></span><span className="progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span><div className="book-card-actions"><button type="button" className="book-export" title={tr("导出全书 markdown")} onClick={(event) => { event.stopPropagation(); download(api.exportBookUrl(book.id)); }}><Icon name="download" size={14} />{tr("导出")}</button><button type="button" className="book-export" title={tr("导出自包含故事包（定稿+事实+来源）")} onClick={(event) => { event.stopPropagation(); download(api.exportStoryPackUrl(book.id, true)); }}><Icon name="stack" size={14} />{tr("故事包")}</button><span className="spacer" /><button type="button" className="book-trash" disabled={deleting} aria-expanded={confirmId === book.id} aria-controls={confirmId === book.id ? `delete-confirm-${book.id}` : undefined} aria-label={tr("删除{p0}", { p0: book.title })} title={tr("删除")} onClick={(event) => { event.stopPropagation(); confirmTriggerRef.current = event.currentTarget; setConfirmId(book.id); }}><Icon name="trash" size={15} /></button></div></div></div>
          {confirmId === book.id ? <div className="book-confirm" id={`delete-confirm-${book.id}`} role="group" aria-labelledby={`delete-message-${book.id}`} aria-busy={deleting} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><span id={`delete-message-${book.id}`}>{tr("删除《")}{book.title}{tr("》？不能恢复。")}</span><div className="actions"><button ref={cancelDeleteRef} type="button" className="btn small ghost" disabled={deleting} onClick={() => setConfirmId("")}>{tr("取消")}</button><button type="button" className="btn small danger" disabled={deleting} onClick={() => { setDeleting(true); void api.deleteBook(book.id).then(() => { setBooks((list) => list?.filter((item) => item.id !== book.id) ?? null); setConfirmId(""); requestAnimationFrame(() => collectionHeadingRef.current?.focus({ preventScroll: true })); }).catch((err: Error) => setError(err.message)).finally(() => setDeleting(false)); }}>{tr("删除")}</button></div></div> : null}
        </div>;
      })}
      {books && !query.trim() ? <button type="button" className="book-card new reveal" onClick={() => setCreating(true)}><span className="new-plus" aria-hidden="true"><Icon name="plus" size={27} /></span><span className="new-text"><span className="new-title">{tr("下一本，等你落笔")}</span><span className="new-sub">{tr("写下书名和简介，或在上面用一句话起头。")}</span></span><span className="new-action">{tr("新书")}<Icon name="arrow" size={16} /></span></button> : null}
    </div>
    <footer className="library-colophon reveal"><div className="colophon-large" aria-hidden="true">molan<span>01</span></div><div className="colophon-bottom"><span>A PLACE FOR THE UNWRITTEN.</span><span>{tr("故事在这里，慢慢生长。")}</span><Icon name="feather" size={18} /></div></footer>
  </div>;
}
