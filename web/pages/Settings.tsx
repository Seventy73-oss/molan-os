import { useEffect, useState } from "react";
import { THEMES, getTheme, setTheme, type ThemeId } from "../lib/theme";

export function Settings() {
  const [theme, setT] = useState<ThemeId>(getTheme());
  useEffect(() => {
    document.title = "设置 · 墨兰写作";
  }, []);
  return (
    <div className="page page-enter settings-page">
      <p className="eyebrow">设置</p>
      <h1>设置</h1>
      <section className="card" aria-labelledby="theme-h">
        <h2 id="theme-h">配色</h2>
        <p className="sub">立即生效，保存在本机浏览器。</p>
        <div className="theme-grid" role="radiogroup" aria-label="配色选择">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={theme === t.id}
              className="theme-opt"
              data-theme-id={t.id}
              onClick={() => {
                setTheme(t.id);
                setT(t.id);
              }}
            >
              <span className={t.id === "system" ? "theme-swatch system" : "theme-swatch"} aria-hidden="true">
                {t.swatch.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
              <span className="theme-name">{t.name}</span>
              <span className="theme-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
