import { createContext, useContext, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
} from "react-router-dom";
import { Library } from "./pages/Library";
import { Models } from "./pages/Models";
import { Skills } from "./pages/Skills";
import { Studio } from "./pages/Studio";

export type SaveState = "" | "saved" | "dirty" | "saving";

type ShellContext = {
  title: string;
  setTitle: (title: string) => void;
  saveState: SaveState;
  setSaveState: (state: SaveState) => void;
};

const TitleContext = createContext<ShellContext>({
  title: "",
  setTitle: () => undefined,
  saveState: "",
  setSaveState: () => undefined,
});

export function useBookTitle() {
  return useContext(TitleContext);
}

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      长
    </span>
  );
}

const SAVE_LABEL: Record<Exclude<SaveState, "">, string> = {
  saved: "已保存",
  dirty: "未保存",
  saving: "保存中…",
};

function Shell() {
  const location = useLocation();
  const studio = location.pathname.startsWith("/books/");
  const { title, saveState } = useBookTitle();
  return (
    <div className={studio ? "app is-studio" : "app"}>
      <header className="topbar">
        <Link to="/" className="brand">
          <LogoMark />
          <span className="wordmark">长卷</span>
        </Link>
        {studio ? (
          <nav className="crumbs" aria-label="位置">
            <Link to="/">书库</Link>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="crumb-current">{title || "…"}</span>
          </nav>
        ) : null}
        <span className="spacer" />
        {studio && saveState ? (
          <span className={`save-state ${saveState} ${saveState === "saving" ? "pulse" : saveState === "saved" ? "pop" : ""}`}>
            <i />
            {SAVE_LABEL[saveState]}
          </span>
        ) : null}
        <nav className="tabs" aria-label="主导航">
          <NavLink to="/" end>
            书库
          </NavLink>
          <NavLink to="/skills">技能</NavLink>
          <NavLink to="/models">模型</NavLink>
        </nav>
      </header>
      <div className="stage">
        {studio ? (
          <Outlet />
        ) : (
          <main className="main page-enter" key={location.pathname}>
            <Outlet />
          </main>
        )}
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="page page-enter not-found">
      <p className="eyebrow">长卷</p>
      <h1>没有这一页</h1>
      <p className="sub">链接可能写错了，或者书已经删掉。</p>
      <Link className="btn primary" to="/">
        回书库
      </Link>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Library /> },
      { path: "/books/:id", element: <Studio /> },
      { path: "/skills", element: <Skills /> },
      { path: "/models", element: <Models /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("");
  return (
    <TitleContext.Provider value={{ title, setTitle, saveState, setSaveState }}>
      <RouterProvider router={router} />
    </TitleContext.Provider>
  );
}
