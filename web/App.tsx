import { t as tr, useLocale } from "./lib/i18n";
import { createContext, useContext, useEffect, useState } from "react";
import { Link, NavLink, Outlet, RouterProvider, createBrowserRouter, useLocation } from "react-router-dom";
import { References } from "./pages/References";
import { Library } from "./pages/Library";
import { Models } from "./pages/Models";
import { Settings } from "./pages/Settings";
import { Skills } from "./pages/Skills";
import { Studio } from "./pages/Studio";
import { Icon, type IconName } from "./components/Icon";

export type SaveState = "" | "saved" | "dirty" | "saving";
type ShellContext = { title: string; setTitle: (title: string) => void; saveState: SaveState; setSaveState: (state: SaveState) => void };
const TitleContext = createContext<ShellContext>({ title: "", setTitle: () => undefined, saveState: "", setSaveState: () => undefined });
export function useBookTitle() { return useContext(TitleContext); }

const NAV: { path: string; label: string; icon: IconName; caption: string }[] = [
  { path: "/", label: "书库", icon: "book", caption: "故事的起点" },
  { path: "/references", label: "参考库", icon: "stack", caption: "阅读成为方法" },
  { path: "/skills", label: "技能", icon: "sparkles", caption: "你的写作方法" },
  { path: "/models", label: "模型", icon: "model", caption: "为灵感接上引擎" },
  { path: "/settings", label: "设置", icon: "sliders", caption: "舒服的写作环境" },
];
const SAVE_LABEL: Record<Exclude<SaveState, "">, string> = { saved: "已保存", dirty: "未保存", saving: "保存中…" };

function Brand({ className = "" }: { className?: string }) {
  return <Link to="/" className={`brand ${className}`} aria-label={tr("墨兰写作")}><span className="brand-emblem" aria-hidden="true"><Icon name="feather" size={24} /></span><span className="brand-copy"><span className="wordmark">molan<span className="wordmark-dot">.</span></span><span className="brand-sub">{tr("墨兰 · 写作工坊")}</span></span></Link>;
}
function Navigation() {
  return <nav className="tabs" aria-label={tr("主导航")}>{NAV.map((item, index) => <NavLink to={item.path} end={item.path === "/"} key={item.path} aria-label={tr(item.label)} title={tr(item.label)}><Icon name={item.icon} size={20} /><span>{tr(item.label)}</span><span className="nav-number" aria-hidden="true">0{index + 1}</span><Icon name="arrow" size={14} className="nav-arrow" /></NavLink>)}</nav>;
}
function Shell() {
  const { locale, choice, setLocale } = useLocale();
  const location = useLocation();
  const studio = location.pathname.startsWith("/books/");
  const { title, saveState } = useBookTitle();
  const activePage = NAV.find((item) => item.path === location.pathname);
  useEffect(() => {
    const page = studio ? title : activePage?.label || "没有这一页";
    document.title = `${studio ? page : tr(page)} · ${tr("墨兰写作")}`;
  }, [locale, location.pathname, studio, title, activePage?.label]);
  return (
    <div className={studio ? "app is-studio" : "app workspace-shell"}>
      {!studio ? <aside className="shell-rail">
        <Brand className="shell-brand" />
        <div className="rail-section-label"><span>{tr("创作空间")}</span><span>01</span></div>
        <Navigation />
        <div className="rail-bottom">
          <div className="rail-quote"><span className="rail-seal" aria-hidden="true">文</span><p>{tr("未完，待续。")}</p><span>{tr("为尚未写出的世界。")}</span></div>
          <div className="rail-signature"><span>WRITING ATELIER</span><Icon name="northeast" size={13} /></div>
        </div>
      </aside> : null}
      <header className="topbar">
        <Brand className="topbar-brand" />
        {studio ? <nav className="crumbs" aria-label={tr("位置")}><Link to="/" title={tr("回书库")} aria-label={tr("回书库")}><Icon name="back" size={16} /><span>{tr("书库")}</span></Link><span className="crumb-sep" aria-hidden="true">/</span><span className="crumb-current">{title || "…"}</span></nav> : <div className="workspace-breadcrumb"><span>{tr("我的工作台")}</span><span className="crumb-sep">/</span><strong>{tr(activePage?.label || "没有这一页")}</strong></div>}
        <span className="spacer" />
        {studio && saveState ? <span role="status" className={`save-state ${saveState} ${saveState === "saving" ? "pulse" : ""}`}><i />{tr(SAVE_LABEL[saveState])}</span> : null}
        {studio ? <Navigation /> : <span className="workspace-date">{new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</span>}
        <div className="language-control"><Icon name="globe" size={16} /><select className="locale-select" aria-label={locale === "zh-CN" ? "界面语言" : "Interface language"} value={choice} onChange={(event) => setLocale(event.target.value as "system" | "en-US" | "zh-CN")}><option value="system">{tr("跟随系统")}</option><option value="zh-CN">中文</option><option value="en-US">English</option></select></div>
      </header>
      <div className="stage">{studio ? <Outlet /> : <main className="main" key={location.pathname}><Outlet /></main>}</div>
    </div>
  );
}
function NotFound() {
  useLocale();
  return <div className="page page-enter not-found"><p className="eyebrow">{tr("墨兰写作")}</p><h1>{tr("没有这一页")}</h1><p className="sub">{tr("链接可能写错了，或者书已经删掉。")}</p><Link className="btn primary" to="/">{tr("回书库")}</Link></div>;
}
const router = createBrowserRouter([{ element: <Shell />, children: [{ path: "/", element: <Library /> }, { path: "/books/:id", element: <Studio /> }, { path: "/references", element: <References /> }, { path: "/skills", element: <Skills /> }, { path: "/models", element: <Models /> }, { path: "/settings", element: <Settings /> }, { path: "*", element: <NotFound /> }] }]);
export function App() {
  useLocale();
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("");
  return <TitleContext.Provider value={{ title, setTitle, saveState, setSaveState }}><RouterProvider router={router} /></TitleContext.Provider>;
}
