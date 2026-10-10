/**
 * SQLite → native Postgres data migration (opt-in tooling).
 * Default product path remains SQLite; this does not change boot driver.
 *
 * CLI: npm run migrate:sqlite-to-pg -- [--dry-run] [--force] [--sqlite path]
 * Requires DATABASE_URL. Target schema is applied via createNativePostgresClient.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { createNativePostgresClient, type NativePgDbClient } from "./pgNativeClient";

/** Copy order: parents before children; artifacts.current_revision_id patched after revisions. */
export const MIGRATE_TABLE_ORDER = [
  "books",
  "chapters",
  "artifacts",
  "artifact_revisions",
  "skills",
  "scene_routes",
  "messages",
  "writing_jobs",
  "idempotency_keys",
  "settings",
  "bible_cards",
  "api_usage",
  "hook_marks",
  "generations",
] as const;

export type MigrateSqliteToPgOptions = {
  sqlitePath: string;
  databaseUrl: string;
  /** When true, only count / plan — no writes to Postgres. */
  dryRun?: boolean;
  /**
   * When target already has book rows (or non-empty primary tables), refuse unless force.
   * With force: ON CONFLICT DO UPDATE for primary key.
   */
  force?: boolean;
  /** Injected PG client (tests); caller still owns close unless we opened it. */
  pgClient?: NativePgDbClient;
};

export type MigrateSqliteToPgResult = {
  dryRun: boolean;
  forced: boolean;
  sqlitePath: string;
  tables: Record<string, { source: number; written: number }>;
  refused?: string;
  openedPg: boolean;
};

function sqliteTableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function pgTableColumns(pg: NativePgDbClient, table: string): string[] {
  const rows = pg.all<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ?
     ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

function pkColumn(table: string): string {
  if (table === "idempotency_keys" || table === "settings") return "key";
  if (table === "scene_routes") return "scene";
  return "id";
}

function countPg(pg: NativePgDbClient, table: string): number {
  const row = pg.get<{ n: number | string }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return Number(row?.n ?? 0);
}

/**
 * Copy all known tables from a SQLite file into native Postgres.
 * Does not flip MOLAN_NATIVE_PG / boot driver — operator must enable native afterwards.
 */
export async function migrateSqliteToPg(opts: MigrateSqliteToPgOptions): Promise<MigrateSqliteToPgResult> {
  const dryRun = !!opts.dryRun;
  const forced = !!opts.force;
  if (!fs.existsSync(opts.sqlitePath)) {
    throw new Error(`SQLite 源不存在: ${opts.sqlitePath}`);
  }

  const sqlite = new Database(opts.sqlitePath, { readonly: true, fileMustExist: true });
  let pg = opts.pgClient;
  let openedPg = false;
  const tables: MigrateSqliteToPgResult["tables"] = {};

  try {
    if (!pg) {
      pg = createNativePostgresClient(opts.databaseUrl);
      openedPg = true;
    }

    const bookCount = countPg(pg, "books");
    if (bookCount > 0 && !forced && !dryRun) {
      return {
        dryRun,
        forced,
        sqlitePath: opts.sqlitePath,
        tables: {},
        refused: `目标 Postgres 已有 ${bookCount} 本书；请加 --force 覆盖同主键，或换空库`,
        openedPg,
      };
    }

    for (const table of MIGRATE_TABLE_ORDER) {
      const srcCols = sqliteTableColumns(sqlite, table);
      if (!srcCols.length) {
        tables[table] = { source: 0, written: 0 };
        continue;
      }
      const destCols = new Set(pgTableColumns(pg, table));
      const cols = srcCols.filter((c) => destCols.has(c));
      if (!cols.length) {
        tables[table] = { source: 0, written: 0 };
        continue;
      }

      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      tables[table] = { source: rows.length, written: 0 };
      if (dryRun || !rows.length) continue;

      const pk = pkColumn(table);
      const useNullCurrent =
        table === "artifacts" && cols.includes("current_revision_id");

      const insertCols = useNullCurrent
        ? cols
        : cols;
      const placeholders = insertCols.map(() => "?").join(", ");
      const colList = insertCols.join(", ");
      const updates = insertCols
        .filter((c) => c !== pk)
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(", ");
      const sql = forced
        ? `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
           ON CONFLICT (${pk}) DO UPDATE SET ${updates || `${pk} = EXCLUDED.${pk}`}`
        : `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
           ON CONFLICT (${pk}) DO NOTHING`;

      const runInsert = pg.transaction(() => {
        let n = 0;
        for (const row of rows) {
          const values = insertCols.map((c) => {
            if (useNullCurrent && c === "current_revision_id") return null;
            const v = row[c];
            if (typeof v === "boolean") return v ? 1 : 0;
            if (typeof v === "bigint") return Number(v);
            return (v ?? null) as string | number | null;
          });
          const r = pg!.run(sql, values);
          n += r.changes > 0 ? 1 : 0;
        }
        return n;
      });
      tables[table].written = runInsert();
    }

    // Patch artifacts.current_revision_id after revisions exist
    if (!dryRun) {
      const artCols = sqliteTableColumns(sqlite, "artifacts");
      if (artCols.includes("current_revision_id")) {
        const arts = sqlite
          .prepare(
            `SELECT id, current_revision_id FROM artifacts WHERE current_revision_id IS NOT NULL`,
          )
          .all() as { id: string; current_revision_id: string }[];
        const patch = pg.transaction(() => {
          let n = 0;
          for (const a of arts) {
            const r = pg!.run(`UPDATE artifacts SET current_revision_id = ? WHERE id = ?`, [
              a.current_revision_id,
              a.id,
            ]);
            n += r.changes;
          }
          return n;
        });
        patch();
      }
    }

    return { dryRun, forced, sqlitePath: opts.sqlitePath, tables, openedPg };
  } finally {
    sqlite.close();
    if (openedPg && pg) {
      await pg.close();
    }
  }
}

/** Summarize counts for CLI / tests without opening Postgres. */
export function countSqliteMigrateTables(sqlitePath: string): Record<string, number> {
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const out: Record<string, number> = {};
    for (const table of MIGRATE_TABLE_ORDER) {
      try {
        const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        out[table] = Number(row?.n ?? 0);
      } catch {
        out[table] = 0;
      }
    }
    return out;
  } finally {
    sqlite.close();
  }
}
