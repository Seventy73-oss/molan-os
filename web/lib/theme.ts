export type ThemeId =
  | "system" | "light" | "dark" | "paper" | "green" | "molan"
  | "ash" | "mist" | "sakura" | "night" | "contrast" | "ancient";
export const THEME_KEY = "molan.theme";
export const THEMES: { id: ThemeId; name: string; desc: string; swatch: string[] }[] = [
  { id: "system", name: "跟随系统", desc: "按系统浅色/深色自动切换", swatch: [] },
  { id: "light", name: "浅色", desc: "默认暖白", swatch: ["#faf6ef", "#efe9df", "#1a1714", "#9b4324"] },
  { id: "dark", name: "深色", desc: "夜间低亮度", swatch: ["#1b1916", "#2a2622", "#ece5da", "#e08460"] },
  { id: "paper", name: "纸张", desc: "米黄书页", swatch: ["#f4ead2", "#ebdfc3", "#2a2116", "#9b4324"] },
  { id: "green", name: "护眼绿", desc: "柔和豆沙绿", swatch: ["#e6f0e1", "#dbe7d4", "#1d2a20", "#2f6b4a"] },
  { id: "molan", name: "墨兰", desc: "品牌靛蓝", swatch: ["#f5f5fa", "#ececf4", "#1c1f33", "#4b4fa8"] },
  { id: "ash", name: "烟灰", desc: "中性冷灰，不偏色", swatch: ["#f2f2f1", "#e8e8e6", "#1f2123", "#4a5a6a"] },
  { id: "mist", name: "雾青", desc: "淡青灰，清爽", swatch: ["#e9f1f1", "#dde8e8", "#18292b", "#2c6a70"] },
  { id: "sakura", name: "樱粉", desc: "极浅樱色，柔和", swatch: ["#faf1f2", "#f2e4e6", "#2e1c22", "#a0405a"] },
  { id: "night", name: "暗夜蓝", desc: "深蓝夜读", swatch: ["#141b26", "#171f2b", "#dfe6f0", "#7fa8e0"] },
  { id: "ancient", name: "古籍", desc: "暖棕深色，灯下旧书", swatch: ["#2a2119", "#2e241b", "#eadcc4", "#d99a5b"] },
  { id: "contrast", name: "墨黑高对比", desc: "纯黑底白字，最高对比", swatch: ["#000000", "#161616", "#ffffff", "#ffd166"] },
];
export const DARK_THEMES: ThemeId[] = ["dark", "night", "contrast", "ancient"];
const IDS = THEMES.map((t) => t.id);
export function getTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY) as ThemeId | null;
    return v && IDS.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}
export function resolveTheme(id: ThemeId): Exclude<ThemeId, "system"> {
  if (id !== "system") return id;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
export function applyTheme(id: ThemeId = getTheme()) {
  const r = resolveTheme(id);
  const root = document.documentElement;
  root.dataset.theme = r;
  root.dataset.themeChoice = id;
  root.style.colorScheme = DARK_THEMES.includes(r) ? "dark" : "light";
  const color = getComputedStyle(root).getPropertyValue("--theme-color").trim() || "#f6f1ea";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", DARK_THEMES.includes(r) ? "dark" : "light");
}
export function setTheme(id: ThemeId) {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* ignore */
  }
  applyTheme(id);
}
let watching = false;
export function watchSystemTheme() {
  if (watching || !window.matchMedia) return;
  watching = true;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getTheme() === "system") applyTheme("system");
  });
}

/* ---- 字体 ---- */
export type FontId = "default" | "song" | "hei" | "kai" | "fangsong" | "wenkai" | "system";
export const FONT_KEY = "molan.font";
export const FONTS: { id: FontId; name: string; desc: string }[] = [
  { id: "default", name: "默认（思源宋体）", desc: "原样，网页字体" },
  { id: "song", name: "宋体", desc: "系统宋体：苹方宋/华文宋体/中易宋体" },
  { id: "hei", name: "黑体", desc: "苹方/思源黑体/微软雅黑" },
  { id: "kai", name: "楷体", desc: "系统楷体；安卓无楷体时用霞鹜文楷" },
  { id: "fangsong", name: "仿宋", desc: "系统仿宋；无则退回宋体" },
  { id: "wenkai", name: "霞鹜文楷", desc: "开源字体（OFL），本地按需加载" },
  { id: "system", name: "系统默认", desc: "跟随设备界面字体" },
];
const FONT_IDS = FONTS.map((f) => f.id);
export function getFont(): FontId {
  try {
    const v = localStorage.getItem(FONT_KEY) as FontId | null;
    return v && FONT_IDS.includes(v) ? v : "default";
  } catch {
    return "default";
  }
}
let wenkaiLoaded = false;
export function ensureWenkai() {
  if (wenkaiLoaded) return;
  wenkaiLoaded = true;
  void import("lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css");
}
export function applyFont(id: FontId = getFont()) {
  document.documentElement.dataset.font = id;
  if (id === "wenkai" || id === "kai") ensureWenkai();
}
export function setFont(id: FontId) {
  try {
    localStorage.setItem(FONT_KEY, id);
  } catch {
    /* ignore */
  }
  applyFont(id);
}

/* ---- 字号（正文编辑区） ---- */
export type SizeId = "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
export const SIZE_KEY = "molan.fontSize";
export const SIZES: { id: SizeId; name: string; px: number }[] = [
  { id: "xs", name: "小", px: 15 },
  { id: "sm", name: "较小", px: 16.5 },
  { id: "md", name: "标准", px: 18 },
  { id: "lg", name: "大", px: 20 },
  { id: "xl", name: "较大", px: 22 },
  { id: "xxl", name: "特大", px: 24 },
];
const SIZE_IDS = SIZES.map((x) => x.id);
export function getSize(): SizeId {
  try {
    const v = localStorage.getItem(SIZE_KEY) as SizeId | null;
    return v && SIZE_IDS.includes(v) ? v : "md";
  } catch {
    return "md";
  }
}
export function applySize(id: SizeId = getSize()) {
  document.documentElement.dataset.fs = id;
}
export function setSize(id: SizeId) {
  try {
    localStorage.setItem(SIZE_KEY, id);
  } catch {
    /* ignore */
  }
  applySize(id);
}
export function applyAppearance() {
  applyTheme();
  applyFont();
  applySize();
}
