import { useSyncExternalStore } from "react";
import { enUS } from "../locales/en-US";
import { zhCN } from "../locales/zh-CN";

export type Locale = "zh-CN" | "en-US";
export type LocaleChoice = Locale | "system";
const KEY = "molan.locale";
const listeners = new Set<() => void>();

function readChoice(): LocaleChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "system" || saved === "en-US" || saved === "zh-CN") return saved;
  } catch { /* Browser storage may be unavailable. */ }
  // Preserve the imported product's Chinese default until explicitly changed.
  return "zh-CN";
}
let choice = readChoice();
function resolve(value: LocaleChoice): Locale {
  if (value !== "system") return value;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}
export function getLocale(): Locale { return resolve(choice); }
function notify() {
  document.documentElement.lang = getLocale();
  for (const listener of listeners) listener();
}
export function setLocale(value: LocaleChoice) {
  choice = value;
  try { localStorage.setItem(KEY, value); } catch { /* Keep the in-memory choice. */ }
  notify();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useLocale() {
  useSyncExternalStore(subscribe, () => `${choice}:${getLocale()}`, () => "zh-CN:zh-CN");
  return { locale: getLocale(), choice, setLocale };
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = Object.keys(zhCN)
  .filter((key) => /\{p\d+\}/.test(key))
  .sort((a, b) => b.replace(/\{p\d+\}/g, "").length - a.replace(/\{p\d+\}/g, "").length)
  .map((key) => {
    const names = [...key.matchAll(/\{(p\d+)\}/g)].map((match) => match[1]);
    const parts = key.split(/\{p\d+\}/g);
    return { key, names, re: new RegExp("^" + parts.map(escapeRegex).join("([\\s\\S]*?)") + "$") };
  });

/** Translate application-owned copy only; manuscript and API business data stay untouched. */
export function t(source: string, values?: Record<string, unknown>): string {
  const locale = getLocale();
  let template = locale === "en-US" ? enUS[source] : zhCN[source];
  if (!template) {
    const trimmed = source.trim();
    const known = locale === "en-US" ? enUS[trimmed] : zhCN[trimmed];
    if (known) return source.replace(trimmed, known);
    if (locale === "en-US" && /[\u4e00-\u9fff]/.test(source)) {
      for (const pattern of patterns) {
        const match = pattern.re.exec(source);
        if (match) {
          const params = Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 1]]));
          return t(pattern.key, params);
        }
      }
    }
    template = source;
  }
  if (!values) return template;
  return template.replace(/\{(p\d+)\}/g, (original, key: string) => String(values[key] ?? original));
}

document.documentElement.lang = getLocale();
window.addEventListener("languagechange", () => { if (choice === "system") notify(); });
window.addEventListener("storage", (event) => {
  if (event.key === KEY || event.key === null) { choice = readChoice(); notify(); }
});
