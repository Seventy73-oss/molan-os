import { t } from "./i18n";

/** Only application-owned errors are translated, never source text or method cards. */
export function referenceErrorText(message: string): string {
  const prefix = /^([a-z][a-z0-9_]*):\s*([\s\S]*)$/.exec(message);
  return prefix ? `${prefix[1]}: ${t(prefix[2]!)}` : t(message);
}
