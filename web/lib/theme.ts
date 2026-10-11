export type ThemeId = "system" | "light" | "dark" | "paper" | "green" | "molan";
export const THEME_KEY = "molan.theme";
export const THEMES: { id: ThemeId; name: string; desc: string; swatch: string[] }[] = [
  { id: "system", name: "跟随系统", desc: "按系统浅色/深色自动切换", swatch: [] },
  { id: "light", name: "浅色", desc: "默认暖白", swatch: ["#faf6ef", "#efe9df", "#1a1714", "#9b4324"] },
  { id: "dark", name: "深色", desc: "夜间低亮度", swatch: ["#1b1916", "#2a2622", "#ece5da", "#e08460"] },
  { id: "paper", name: "纸张", desc: "米黄书页", swatch: ["#f4ead2", "#ebdfc3", "#2a2116", "#9b4324"] },
  { id: "green", name: "护眼绿", desc: "柔和豆沙绿", swatch: ["#e6f0e1", "#dbe7d4", "#1d2a20", "#2f6b4a"] },
  { id: "molan", name: "墨兰", desc: "品牌靛蓝", swatch: ["#f5f5fa", "#ececf4", "#1c1f33", "#4b4fa8"] },
];
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
  const color = getComputedStyle(root).getPropertyValue("--theme-color").trim() || "#f6f1ea";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", r === "dark" ? "dark" : "light");
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
