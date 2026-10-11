import { useEffect, useState } from "react";
import {
  FONTS, SIZES, THEMES, getFont, getSize, getTheme, setFont, setSize, setTheme,
  type FontId, type SizeId, type ThemeId,
} from "../lib/theme";

const FONT_VAR: Record<FontId, string> = {
  default: "var(--serif)",
  song: '"Songti SC","STSong","SimSun","Noto Serif SC",serif',
  hei: '"PingFang SC","Source Han Sans SC","Noto Sans SC","Microsoft YaHei",sans-serif',
  kai: "var(--kai-stack)",
  fangsong: '"STFangsong","FangSong","FangSong_GB2312","Songti SC","SimSun",serif',
  wenkai: '"LXGW WenKai Screen",var(--kai-stack)',
  system: 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
};

export function Settings() {
  const [theme, setT] = useState<ThemeId>(getTheme());
  const [font, setF] = useState<FontId>(getFont());
  const [size, setS] = useState<SizeId>(getSize());
  useEffect(() => {
    document.title = "设置 · 墨兰写作";
  }, []);
  return (
    <div className="page page-enter settings-page">
      <p className="eyebrow">设置</p>
      <h1>设置</h1>
      <section className="card" aria-labelledby="theme-h">
        <h2 id="theme-h">外观</h2>
        <p className="sub">配色、字体、字号。立即生效，保存在本机浏览器。</p>

        <div className="appearance-block">
          <h3>配色</h3>
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
        </div>

        <div className="appearance-block">
          <h3>正文字体</h3>
          <p className="sub">只影响编辑区正文；设备上没有的字体会自动退回相近字体。</p>
          <div className="font-grid" role="radiogroup" aria-label="字体选择">
            {FONTS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={font === f.id}
                className="font-opt"
                data-font-id={f.id}
                onClick={() => {
                  setFont(f.id);
                  setF(f.id);
                }}
              >
                <span className="font-sample" style={{ fontFamily: FONT_VAR[f.id] }}>雾港 · 永字八法</span>
                <span className="theme-name">{f.name}</span>
                <span className="theme-desc">{f.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-block">
          <h3>正文字号</h3>
          <div className="size-row" role="radiogroup" aria-label="字号选择">
            {SIZES.map((z) => (
              <button
                key={z.id}
                type="button"
                role="radio"
                aria-checked={size === z.id}
                className="size-opt"
                data-size-id={z.id}
                onClick={() => {
                  setSize(z.id);
                  setS(z.id);
                }}
              >
                <span>{z.name}</span>
                <small>{z.px}px</small>
              </button>
            ))}
          </div>
          <div className="appearance-preview" aria-label="预览">
            <div className="manuscript prose" data-testid="appearance-preview">
              <p>铜表停在三点十七分。我把它贴在耳边，听不到一点声音，只有雾里的汽笛一下一下地响。</p>
              <p>“你还戴着它？”她问。我没回答，只摩挲了一下袖口。</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
