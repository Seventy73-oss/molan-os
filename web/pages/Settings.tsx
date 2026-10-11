import { t as tr, useLocale } from "../lib/i18n";
import { useState } from "react";
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
  useLocale();
  const [theme, setT] = useState<ThemeId>(getTheme());
  const [font, setF] = useState<FontId>(getFont());
  const [size, setS] = useState<SizeId>(getSize());
  return (
    <div className="page page-enter settings-page">
      <header className="page-head"><div><p className="eyebrow"><span className="eyebrow-line" />{tr("让写作更合心意")}</p><h1>{tr("设置")}<span className="heading-dot" aria-hidden="true">.</span></h1><span className="page-english-title" aria-hidden="true">THE ATMOSPHERE</span><p className="sub">{tr("一张舒服的稿纸，是好故事的开始。")}</p></div></header>
      <section className="card" aria-labelledby="theme-h">
        <h2 id="theme-h">{tr("外观")}</h2>
        <p className="sub">{tr("配色、字体、字号。立即生效，保存在本机浏览器。")}</p>

        <div className="appearance-block">
          <h3>{tr("配色")}</h3>
          <div className="theme-grid" role="radiogroup" aria-label={tr("配色选择")}>
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
                <span className="theme-name">{tr(t.name)}</span>
                <span className="theme-desc">{tr(t.desc)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-block">
          <h3>{tr("正文字体")}</h3>
          <p className="sub">{tr("只影响编辑区正文；设备上没有的字体会自动退回相近字体。")}</p>
          <div className="font-grid" role="radiogroup" aria-label={tr("字体选择")}>
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
                <span className="font-sample" style={{ fontFamily: FONT_VAR[f.id] }}>{tr("雾港 · 永字八法")}</span>
                <span className="theme-name">{tr(f.name)}</span>
                <span className="theme-desc">{tr(f.desc)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-block">
          <h3>{tr("正文字号")}</h3>
          <div className="size-row" role="radiogroup" aria-label={tr("字号选择")}>
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
                <span>{tr(z.name)}</span>
                <small>{z.px}px</small>
              </button>
            ))}
          </div>
          <div className="appearance-preview" aria-label={tr("预览")}>
            <div className="manuscript prose" data-testid="appearance-preview">
              <p>{tr("铜表停在三点十七分。我把它贴在耳边，听不到一点声音，只有雾里的汽笛一下一下地响。")}</p>
              <p>{tr("“你还戴着它？”她问。我没回答，只摩挲了一下袖口。")}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
