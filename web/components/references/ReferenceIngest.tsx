import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "../Icon";
import { referencesApi, type NovelCatalog, type SearchNovel } from "../../lib/api/references";
import { t as tr, useLocale } from "../../lib/i18n";

function Rights({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return <label className="ref-check ref-rights"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span>{tr("我有权使用并分析这些内容；只提炼写作方法，不复制原作。")}</span></label>;
}
export function ReferenceImport({ onImported }: { onImported: (sourceId: string) => Promise<void> }) {
  useLocale();
  const [title, setTitle] = useState(""), [author, setAuthor] = useState(""), [text, setText] = useState("");
  const [rights, setRights] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  async function readFile(file?: File) {
    if (!file) return;
    setError("");
    if (!/\.(txt|md|markdown)$/i.test(file.name) || file.size > 8_000_000) { setError("请选择不超过 8 MB 的 TXT 或 Markdown 文件"); return; }
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      let value: string;
      try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { value = new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
      if (value.length > 2_000_000) throw new Error("单份文本不能超过 200 万字，请分卷导入");
      setText(value); if (!title) setTitle(file.name.replace(/\.(txt|md|markdown)$/i, ""));
    } catch (e) { setError(e instanceof Error ? e.message : "文件读取失败"); } finally { setBusy(false); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { const res = await referencesApi.import({ title, author, text, rightsConfirmed: rights }); await onImported(res.source.id); }
    catch (e) { setError(e instanceof Error ? e.message : "导入失败"); } finally { setBusy(false); }
  }
  return <form className="ref-ingest" onSubmit={e => void submit(e)}>
    <div className="ref-ingest-intro"><span className="ref-large-number">01</span><h2>{tr("留下一份阅读来源。")}</h2><p>{tr("TXT / Markdown，支持 UTF-8 与 GB18030。自动识别章节；无章名的长文本按片段整理。")}</p><p className="ref-muted">{tr("导入不会调用模型，也不会创建或修改书稿。")}</p></div>
    <div className="ref-ingest-form"><button type="button" className="ref-upload-zone" onClick={() => fileRef.current?.click()} disabled={busy}><Icon name="upload" size={28} /><strong>{tr("选择文本文件")}</strong><span>TXT / MD · 8 MB · {tr("最多 200 万字")}</span></button><input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden onChange={e => { void readFile(e.target.files?.[0]); e.target.value = ""; }} />
      <div className="ref-fields"><label>{tr("资料标题")}<input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required placeholder={tr("这份资料叫什么？")} /></label><label>{tr("作者 / 来源署名")}<input value={author} onChange={e => setAuthor(e.target.value)} maxLength={120} placeholder={tr("可选，保留来源线索")} /></label></div>
      <label className="ref-field">{tr("或粘贴原文")}<textarea value={text} onChange={e => setText(e.target.value)} rows={9} maxLength={2_000_000} placeholder={tr("粘贴至少 100 字的小说片段，保留章名更方便追溯。") } /></label><div className="ref-count">{text.length.toLocaleString()} / 2,000,000 {tr("字")}</div>
      <Rights checked={rights} onChange={setRights} />{error ? <p className="alert" role="alert">{tr(error)}</p> : null}
      <button className="btn primary" type="submit" disabled={busy || !rights || !title.trim() || text.trim().length < 100}><Icon name={busy ? "loader" : "arrow"} size={17} className={busy ? "lucide-spin" : ""} />{busy ? tr("正在导入…") : tr("导入并选择章节")}</button>
    </div>
  </form>;
}

export function ReferenceSearch({ onDownloaded, running }: { onDownloaded: (sourceId: string) => Promise<void>; running: boolean }) {
  useLocale();
  const [query, setQuery] = useState(""), [results, setResults] = useState<SearchNovel[] | null>(null), [catalog, setCatalog] = useState<NovelCatalog | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set()), [filter, setFilter] = useState("");
  const [rights, setRights] = useState(false), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  async function search(e: FormEvent) {
    e.preventDefault(); requestRef.current?.abort(); const controller = new AbortController(); requestRef.current = controller;
    setBusy("search"); setError(""); setCatalog(null); setResults(null); setChecked(new Set());
    try { const res = await referencesApi.search(query, controller.signal); if (!controller.signal.aborted) setResults(res.books); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "搜索失败"); }
    finally { if (!controller.signal.aborted) setBusy(""); }
  }
  async function open(book: SearchNovel) {
    requestRef.current?.abort(); const controller = new AbortController(); requestRef.current = controller;
    setBusy("catalog"); setError(""); setCatalog(null); setChecked(new Set()); setFilter(""); setRights(false);
    try { const res = await referencesApi.catalog(book.url, controller.signal); if (!controller.signal.aborted) setCatalog(res); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "目录读取失败"); }
    finally { if (!controller.signal.aborted) setBusy(""); }
  }
  async function download() {
    if (!catalog) return; setBusy("download"); setError("");
    try { const job = await referencesApi.download({ url: catalog.url, chapterUrls: [...checked], rightsConfirmed: rights }); await onDownloaded(job.sourceId); }
    catch (e) { setError(e instanceof Error ? e.message : "下载失败"); } finally { setBusy(""); }
  }
  const visible = catalog?.chapters.filter(c => c.title.toLowerCase().includes(filter.toLowerCase())) || [];
  return <section className="ref-search-area">
    <div className="ref-source-notice"><Icon name="shield" size={18} /><p>{tr("沿用附件书源 shukuge.com，仅通过 HTTP 获取公开章节，不绕过登录、付费或反爬限制。第三方内容可能变动，请自行核对授权与原文。")}</p></div>
    <form className="ref-search-form" onSubmit={e => void search(e)}><Icon name="search" size={20} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr("搜索书名或作者…")} aria-label={tr("搜索书名或作者")} maxLength={80} required /><button className="btn primary" disabled={!query.trim() || busy === "search"}>{busy === "search" ? tr("搜索中…") : tr("搜索")}</button></form>
    {error ? <p className="alert" role="alert">{tr(error)}</p> : null}
    <div className="ref-search-layout"><div className="ref-search-results">
      <h2>{tr("搜索结果")}{results ? <small>{results.length}</small> : null}</h2>
      {results?.map(book => <button key={book.url} onClick={() => void open(book)} className={`ref-search-result ${catalog?.url === book.url ? "on" : ""}`}><span><strong>{book.title}</strong><small>{book.author || tr("未注明作者")}</small></span><Icon name="arrow" size={16} /></button>)}
      {results?.length === 0 ? <p className="ref-muted">{tr("未找到结果，请换一个关键词。")}</p> : results === null ? <p className="ref-muted">{tr("输入关键词，选择作品后查看目录。")}</p> : null}
    </div><div className="ref-catalog">
      {busy === "catalog" ? <p role="status">{tr("正在读取目录…")}</p> : catalog ? <><div className="ref-section-head"><div><p className="eyebrow">{tr("章节目录")}</p><h2>{catalog.title}</h2></div><span>{catalog.chapters.length} {tr("章")}</span></div>
        <input className="ref-filter" aria-label={tr("筛选章节")} placeholder={tr("筛选章节…")} value={filter} onChange={e => setFilter(e.target.value)} />
        <div className="ref-selection-actions"><button onClick={() => setChecked(new Set(visible.map(c => c.url)))}>{tr("全选筛选结果")}</button><button onClick={() => setChecked(prev => new Set(visible.filter(c => !prev.has(c.url)).map(c => c.url)))}>{tr("反选")}</button><button onClick={() => setChecked(new Set(catalog.chapters.slice(0, 50).map(c => c.url)))}>{tr("前 50 章")}</button><button onClick={() => setChecked(new Set(catalog.chapters.slice(0, 200).map(c => c.url)))}>{tr("前 200 章")}</button><button onClick={() => setChecked(new Set())}>{tr("清空")}</button></div>
        <div className="ref-chapter-list">{visible.slice(0, 500).map(c => <label key={c.url} className="ref-check"><input type="checkbox" checked={checked.has(c.url)} onChange={e => setChecked(prev => { const next = new Set(prev); if (e.target.checked) next.add(c.url); else next.delete(c.url); return next; })} /><span><small>{String(c.ordinal).padStart(2, "0")}</small>{c.title}</span></label>)}</div>
        {visible.length > 500 ? <p className="ref-muted">{tr("仅展示前 500 项，请筛选章名以定位更多章节。")}</p> : null}
        <p className="ref-muted">{tr("已选 {p0} 章，每次最多下载 200 章。", { p0: checked.size })}</p><Rights checked={rights} onChange={setRights} />
        <button className="btn primary" disabled={!!busy || running || !rights || checked.size < 1 || checked.size > 200} onClick={() => void download()}><Icon name="download" size={16} />{busy === "download" ? tr("创建下载任务…") : tr("下载到私人参考库")}</button>
      </> : busy !== "catalog" ? <div className="ref-empty"><Icon name="list" size={32} /><p>{tr("选一部作品，再决定读哪些章节。")}</p></div> : null}
    </div></div>
  </section>;
}

