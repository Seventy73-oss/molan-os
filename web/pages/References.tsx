import { auth } from "@eazo/sdk";
import { useEazo } from "@eazo/sdk/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useBookTitle } from "../App";
import { api, type Book } from "../api";
import { Icon } from "../components/Icon";
import { ReferenceImport, ReferenceSearch } from "../components/references/ReferenceIngest";
import { ReferenceReader } from "../components/references/ReferenceReader";
import { referencesApi, type ReferenceDetail, type ReferenceIndex } from "../lib/api/references";
import { t as tr, useLocale } from "../lib/i18n";
import { referenceErrorText } from "../lib/referenceErrors";

export function References() {
  const ownerId = useEazo(s => s.auth.user?.id);
  // Auth changes remount only this private workspace, never the writing editor.
  // A late response from the old account cannot become the new account's state.
  return <ReferenceWorkspace key={ownerId || "signed-out"} />;
}

function ReferenceWorkspace() {
  useLocale();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const user = useEazo(s => s.auth.user), loading = useEazo(s => s.auth.loading);
  const [params] = useSearchParams(); const { setTitle } = useBookTitle();
  const [data, setData] = useState<ReferenceIndex | null>(null), [detail, setDetail] = useState<ReferenceDetail | null>(null);
  const [selected, setSelected] = useState(""); const selectedRef = useRef(selected); selectedRef.current = selected;
  const [mode, setMode] = useState<"library" | "search" | "import">("library");
  const [books, setBooks] = useState<Book[]>([]), [bookId, setBookId] = useState(params.get("book") || "");
  const [error, setError] = useState(""), [busy, setBusy] = useState("");
  const ownerRef = useRef(user?.id); ownerRef.current = user?.id;
  const update = useCallback(async (sourceId?: string) => {
    const owner = ownerRef.current; if (!owner || !mounted.current) return;
    const next = await referencesApi.list(); if (!mounted.current || ownerRef.current !== owner) return;
    setData(next);
    const wanted = sourceId || selectedRef.current || next.sources[0]?.id || "";
    if (next.sources.some(s => s.id === wanted)) {
      const nextDetail = await referencesApi.detail(wanted); if (!mounted.current || ownerRef.current !== owner) return;
      if (!sourceId && selectedRef.current && selectedRef.current !== wanted) return;
      setSelected(wanted); setDetail(nextDetail);
    } else { setSelected(""); setDetail(null); }
  }, []);
  useEffect(() => { setTitle(""); }, [setTitle]);
  useEffect(() => {
    let alive = true; selectedRef.current = ""; setData(null); setDetail(null); setSelected(""); setBooks([]); setBusy(""); setMode("library"); setError("");
    if (!user) return;
    void update().catch(e => { if (alive) setError(e.message); });
    void api.books().then(res => { if (alive) setBooks(res.books); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [user?.id, update]);
  const running = data?.jobs.some(j => ["queued", "running"].includes(j.status)) || false;
  useEffect(() => {
    if (!user || !running) return;
    const owner = ownerRef.current;
    const timer = window.setInterval(() => { if (!document.hidden) void update().catch(e => { if (mounted.current && ownerRef.current === owner) setError(e.message); }); }, 2500);
    return () => window.clearInterval(timer);
  }, [user?.id, running, update]);
  async function act(name: string, operation: () => Promise<void>) {
    const owner = ownerRef.current;
    setBusy(name); setError("");
    try { await operation(); }
    catch (e) {
      const message = e instanceof Error ? e.message : "操作失败";
      const cancelledLogin = name === "login" && /user (?:closed|cancelled)|cancelled login/i.test(message);
      if (!cancelledLogin && mounted.current && ownerRef.current === owner) setError(name === "login" ? "登录未完成，请重试或在 Eazo 内打开。" : message);
    } finally { if (mounted.current && (ownerRef.current === owner || name === "login" || name === "logout")) setBusy(""); }
  }
  async function openSource(id: string) {
    const owner = ownerRef.current;
    selectedRef.current = id; setSelected(id); setDetail(null); setMode("library");
    await act("open", async () => { const next = await referencesApi.detail(id); if (mounted.current && ownerRef.current === owner && selectedRef.current === id) setDetail(next); });
  }
  async function imported(sourceId: string) { setMode("library"); await update(sourceId); }
  const activeJob = data?.jobs.find(j => j.sourceId === selected && ["queued", "running"].includes(j.status));
  return <div className={`page page-enter references-page${!user ? " is-signed-out" : ""}`}>
    <header className="page-head">
      <div><p className="eyebrow"><span className="eyebrow-line" />{tr("让阅读，成为写作的方法")}</p><h1>{tr("参考库")}<span className="heading-dot">.</span></h1><span className="page-english-title">READ. DISTILL. CREATE.</span><p className="sub">{tr("从小说片段中提炼方法，让 Agent 借鉴机制，而不是复刻故事。")}</p></div>
      <div className="ref-account">{user ? <><span><Icon name="user" size={15} />{user.name || tr("已登录")}</span><button className="text-link" onClick={() => void act("logout", () => auth.logout())} disabled={busy === "logout"}>{tr("退出登录")}</button></> : <span className="ref-private"><Icon name="lock" size={15} />{tr("私人原文 · 审阅后引用")}</span>}</div>
    </header>
    <ol className="ref-flow" aria-label={tr("参考流程")}><li><span>01</span>{tr("搜索 / 导入")}</li><li><span>02</span>{tr("选章蒸馏")}</li><li><span>03</span>{tr("审阅方法卡")}</li><li><span>04</span>{tr("绑定书稿")}</li></ol>
    {error ? <div className="alert" role="alert">{tr(error)} <button className="text-link" onClick={() => void act("retry", () => update())} disabled={!user || !!busy}>{tr("重试")}</button></div> : null}
    {loading ? <p role="status" className="ref-loading">{tr("正在确认登录状态…")}</p> : !user ? <section className="ref-welcome">
      <div className="ref-welcome-mark" aria-hidden="true"><Icon name="stack" size={54} /><span>METHOD<br />NOT MEMORY</span></div>
      <div><p className="eyebrow">{tr("读过的，不只是故事")}</p><h2>{tr("把阅读积累，留给下一次创作。")}</h2><p>{tr("导入有权使用的文本，用 Qwen3.8 Flash 提炼开局、结构、节奏与文风。原文仅自己可见，参考卡由你决定是否交给 Agent。")}</p><button className="btn primary" onClick={() => void act("login", async () => { await auth.login(); })} disabled={busy === "login"}><Icon name="lock" size={16} />{busy === "login" ? tr("等待登录…") : tr("登录 Eazo，打开参考库")}</button><small>{tr("不改原书稿，不覆盖已有技能，不自动写入设定或记忆。")}</small></div>
    </section> : <>
      <div className="ref-toolbar"><div className="ref-tabs" role="group" aria-label={tr("参考库视图")}>
        {([["library", "我的参考", "stack"], ["search", "搜索小说", "search"], ["import", "导入文本", "upload"]] as const).map(([value, label, icon]) => <button key={value} className={mode === value ? "on" : ""} aria-pressed={mode === value} onClick={() => setMode(value)}><Icon name={icon} size={16} />{tr(label)}{value === "library" && data ? <small>{data.sources.length}</small> : null}</button>)}
      </div><span className="ref-model"><i className={data?.ai.configured ? "ready" : ""} />{data?.ai.modelLabel || "Qwen3.8 Flash"}<small>{tr("仅用于蒸馏")}</small></span></div>
      {mode === "import" ? <ReferenceImport onImported={imported} /> : mode === "search" ? <ReferenceSearch onDownloaded={imported} running={running} /> : !data ? <p role="status" className="ref-loading">{tr("正在载入参考资料…")}</p> : <div className="ref-library-layout">
        <aside className="ref-source-list"><div className="ref-section-head"><h2>{tr("阅读来源")}</h2><button className="text-link" onClick={() => setMode("import")} aria-label={tr("添加来源")}><Icon name="plus" size={18} /></button></div>
          {data.sources.length ? data.sources.map((s, i) => <button className={`ref-source ${s.id === selected ? "on" : ""}`} key={s.id} onClick={() => void openSource(s.id)} aria-pressed={s.id === selected}><span className="ref-source-index">{String(data.sources.length - i).padStart(2, "0")}</span><span><strong>{s.title}</strong><small>{s.author || tr("未注明作者")} · {s.chapterCount} {tr("章")}</small><span className="ref-source-foot">{s.cardCount} {tr("张方法卡")}<Icon name="arrow" size={14} /></span></span></button>) : <p className="ref-muted">{tr("还没有阅读来源。先导入一段文本，或搜索小说选取章节。")}</p>}
        </aside>
        <section className="ref-reading-area" aria-busy={busy === "open"}>
          {detail ? <ReferenceReader key={detail.source.id} detail={detail} books={books} bookId={bookId} onBookChange={setBookId} configured={data.ai.configured} modelLabel={data.ai.modelLabel} job={activeJob} onChanged={() => update()} onDeleted={() => { setSelected(""); selectedRef.current = ""; setDetail(null); return update(); }} /> : selected ? <p role="status" className="ref-loading">{tr("正在载入来源…")}</p> : <div className="ref-empty"><Icon name="file" size={40} /><h2>{tr("先从一段好文字开始。")}</h2><p>{tr("每一张方法卡，都有可回看的来源。")}</p><button className="btn primary" onClick={() => setMode("import")}><Icon name="upload" size={16} />{tr("导入第一份文本")}</button></div>}
        </section>
      </div>}
      {data?.jobs.length ? <section className="ref-jobs"><div className="ref-section-head"><h2>{tr("处理记录")}</h2><span>{tr("已完成部分会保留，刷新不会重复扣费")}</span></div>{data.jobs.slice(0, 5).map(j => <div className="ref-job" key={j.id}><div><button className="text-link" onClick={() => void openSource(j.sourceId)}>{data.sources.find(s => s.id === j.sourceId)?.title || tr("来源")}</button><small>{tr(j.kind === "distill" ? "蒸馏" : "下载")} · {tr(({ queued: "排队中", running: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" } as Record<string, string>)[j.status] || j.status)} · {j.progress}/{j.total} {tr(j.kind === "distill" ? "分块" : "章")}{j.tokens > 0 ? ` · ${j.tokens.toLocaleString()} tokens` : ""}</small>{j.error ? <p role="status">{referenceErrorText(j.error)}</p> : null}</div><progress value={j.progress} max={j.total} aria-label={tr("任务进度")} />{["queued", "running"].includes(j.status) ? <button className="btn" disabled={busy === j.id} onClick={() => void act(j.id, async () => { await referencesApi.cancel(j.id); await update(); })}>{tr("取消")}</button> : <Icon name={j.status === "completed" ? "check" : "clock"} size={18} />}</div>)}</section> : null}
    </>}
    <footer className="ref-colophon"><span>READING ROOM / MOLAN</span><p>{tr("方法是参考，故事仍属于你。")}</p></footer>
  </div>;
}
