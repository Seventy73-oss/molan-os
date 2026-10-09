/**
 * SQLite-style SQL → Postgres-compatible SQL helpers for the native driver.
 * App code keeps `?` placeholders; native client rewrites before send.
 */

/** Convert `?` placeholders to `$1..$n`, skipping `?` inside single-quoted strings. */
export function qmarksToDollar(sql: string): { text: string; count: number } {
  let out = "";
  let n = 0;
  let i = 0;
  let inStr = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (inStr) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        inStr = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "?") {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { text: out, count: n };
}

/** Rewrite a few SQLite-only idioms that appear in bootstrap paths. */
export function rewriteSqliteIdioms(sql: string): string {
  return sql
    .replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, "INSERT INTO")
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO");
}
