import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SCENES, migratePostgres, migrateSqlite, postgresSchema, sqliteSchema } from "./db/schema";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "../..");
export const dataDir = path.join(root, "data");
export const skillsDir = path.join(root, "skills");

fs.mkdirSync(dataDir, { recursive: true });

export type DbDriver = "sqlite" | "postgres" | "pglite";

export type BookRow = {
  id: string;
  title: string;
  genre: string;
  logline: string;
  style: string;
  target_chapters: number;
  words_per_chapter: number;
  created_at: string;
};

export type ChapterRow = {
  id: string;
  book_id: string;
  number: number;
  title: string;
  status: string;
};

export type RouteRow = {
  scene: string;
  provider: string;
  model_id: string;
  base_url: string | null;
};

export type SqlValue = string | number | null | boolean | bigint;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;
type RunResult = { changes: number };

export interface DbClient {
  readonly driver: DbDriver;
  readonly detail: string;
  exec(sql: string): void;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[];
  run(sql: string, params?: SqlParams): RunResult;
  transaction<T>(fn: () => T): () => T;
  prepare(sql: string): {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => RunResult;
  };
  /** Wait until durable postgres/pglite flush completes. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

type PgBackend = {
  exec(sql: string): Promise<void>;
  query(sql: string, params?: SqlValue[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
};

const TABLES = [
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
] as const;

function resolveDriverChoice(): {
  driver: DbDriver;
  connectionString: string | null;
  pgliteDir: string;
} {
  const raw = (process.env.CHANGJUAN_DB || "").trim().toLowerCase();
  const url = (process.env.DATABASE_URL || "").trim();
  const pgliteDir = path.join(dataDir, "changjuan-pglite");
  if (url) return { driver: "postgres", connectionString: url, pgliteDir };
  if (raw === "postgres" || raw === "postgresql" || raw === "pg" || raw === "pglite") {
    return { driver: "pglite", connectionString: null, pgliteDir };
  }
  return { driver: "sqlite", connectionString: null, pgliteDir };
}

function seedRoutes(run: (sql: string, params?: SqlValue[]) => void) {
  for (const scene of SCENES) {
    run(
      `INSERT INTO scene_routes (scene, provider, model_id, base_url)
       VALUES (?, 'local', 'local-draft', NULL)
       ON CONFLICT(scene) DO NOTHING`,
      [scene],
    );
  }
}

function createSqlite(): DbClient {
  const file = path.join(dataDir, "changjuan.sqlite");
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.exec(sqliteSchema());
  migrateSqlite(
    (sql) => raw.exec(sql),
    (sql) => {
      try {
        raw.prepare(sql).run();
      } catch {
        /* column may already exist */
      }
    },
  );
  seedRoutes((sql, params) => {
    const stmt = raw.prepare(sql);
    if (!params) stmt.run();
    else if (Array.isArray(params)) stmt.run(...params);
    else stmt.run(params);
  });

  return {
    driver: "sqlite",
    detail: file,
    exec(sql) {
      raw.exec(sql);
    },
    get(sql, params) {
      const stmt = raw.prepare(sql);
      if (!params) return stmt.get() as never;
      if (Array.isArray(params)) return stmt.get(...params) as never;
      return stmt.get(params) as never;
    },
    all(sql, params) {
      const stmt = raw.prepare(sql);
      if (!params) return stmt.all() as never;
      if (Array.isArray(params)) return stmt.all(...params) as never;
      return stmt.all(params) as never;
    },
    run(sql, params) {
      const stmt = raw.prepare(sql);
      const info = !params
        ? stmt.run()
        : Array.isArray(params)
          ? stmt.run(...params)
          : stmt.run(params);
      return { changes: info.changes };
    },
    transaction(fn) {
      return raw.transaction(fn);
    },
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        get: (...args: unknown[]) =>
          args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
            ? stmt.get(args[0] as Record<string, SqlValue>)
            : stmt.get(...(args as SqlValue[])),
        all: (...args: unknown[]) =>
          (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
            ? stmt.all(args[0] as Record<string, SqlValue>)
            : stmt.all(...(args as SqlValue[]))) as unknown[],
        run: (...args: unknown[]) => {
          const info =
            args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
              ? stmt.run(args[0] as Record<string, SqlValue>)
              : stmt.run(...(args as SqlValue[]));
          return { changes: info.changes };
        },
      };
    },
    async flush() {},
    async close() {
      raw.close();
    },
  };
}

async function openPgBackend(choice: ReturnType<typeof resolveDriverChoice>): Promise<{
  backend: PgBackend;
  driver: DbDriver;
  detail: string;
}> {
  if (choice.driver === "postgres" && choice.connectionString) {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: choice.connectionString, max: 8 });
    await pool.query("select 1 as ok");
    return {
      driver: "postgres",
      detail: choice.connectionString.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@"),
      backend: {
        exec: async (sql) => {
          await pool.query(sql);
        },
        query: async (sql, params = []) => {
          const r = await pool.query(sql, params);
          return { rows: r.rows as Record<string, unknown>[] };
        },
        close: async () => {
          await pool.end();
        },
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  fs.mkdirSync(choice.pgliteDir, { recursive: true });
  const lite = new PGlite(choice.pgliteDir);
  await lite.waitReady;
  return {
    driver: "pglite",
    detail: choice.pgliteDir,
    backend: {
      exec: async (sql) => {
        await lite.exec(sql);
      },
      query: async (sql, params = []) => {
        const r = await lite.query(sql, params);
        return { rows: (r.rows as Record<string, unknown>[]) ?? [] };
      },
      close: async () => {
        await lite.close();
      },
    },
  };
}

async function hydrateMirror(backend: PgBackend, mirror: InstanceType<typeof Database>) {
  for (const table of TABLES) {
    const { rows } = await backend.query(`SELECT * FROM ${table}`);
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]!);
    const insert = mirror.prepare(
      `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    );
    const tx = mirror.transaction((batch: Record<string, unknown>[]) => {
      for (const row of batch) insert.run(...cols.map((c) => row[c] as SqlValue));
    });
    tx(rows);
  }
}

async function snapshotToBackend(mirror: InstanceType<typeof Database>, backend: PgBackend) {
  for (const table of TABLES) {
    await backend.query(`DELETE FROM ${table}`);
    const rows = mirror.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]!);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    for (const row of rows) {
      await backend.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
        cols.map((c) => row[c] as SqlValue),
      );
    }
  }
}

async function createPostgresClient(choice: ReturnType<typeof resolveDriverChoice>): Promise<DbClient> {
  const opened = await openPgBackend(choice);
  const { backend, driver, detail } = opened;
  await backend.exec(postgresSchema());
  await migratePostgres((sql) => backend.exec(sql));
  for (const scene of SCENES) {
    await backend.query(
      `INSERT INTO scene_routes (scene, provider, model_id, base_url)
       VALUES ($1, 'local', 'local-draft', NULL)
       ON CONFLICT (scene) DO NOTHING`,
      [scene],
    );
  }

  const mirror = new Database(":memory:");
  mirror.exec(sqliteSchema());
  migrateSqlite(
    (sql) => mirror.exec(sql),
    (sql) => {
      try {
        mirror.prepare(sql).run();
      } catch {
        /* ignore */
      }
    },
  );
  await hydrateMirror(backend, mirror);
  // Ensure default routes exist in mirror too
  seedRoutes((sql, params) => {
    const stmt = mirror.prepare(sql);
    if (!params) stmt.run();
    else if (Array.isArray(params)) stmt.run(...params);
    else stmt.run(params);
  });

  let chain: Promise<void> = Promise.resolve();
  let dirty = false;

  function scheduleFlush() {
    dirty = true;
    chain = chain.then(async () => {
      if (!dirty) return;
      dirty = false;
      await snapshotToBackend(mirror, backend);
    });
  }

  return {
    driver,
    detail,
    exec(sql) {
      mirror.exec(sql);
      scheduleFlush();
    },
    get(sql, params) {
      const stmt = mirror.prepare(sql);
      if (!params) return stmt.get() as never;
      if (Array.isArray(params)) return stmt.get(...params) as never;
      return stmt.get(params) as never;
    },
    all(sql, params) {
      const stmt = mirror.prepare(sql);
      if (!params) return stmt.all() as never;
      if (Array.isArray(params)) return stmt.all(...params) as never;
      return stmt.all(params) as never;
    },
    run(sql, params) {
      const stmt = mirror.prepare(sql);
      const info = !params
        ? stmt.run()
        : Array.isArray(params)
          ? stmt.run(...params)
          : stmt.run(params);
      scheduleFlush();
      return { changes: info.changes };
    },
    transaction(fn) {
      const run = mirror.transaction(fn);
      return () => {
        const result = run();
        scheduleFlush();
        return result;
      };
    },
    prepare(sql) {
      const stmt = mirror.prepare(sql);
      return {
        get: (...args: unknown[]) =>
          args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
            ? stmt.get(args[0] as Record<string, SqlValue>)
            : stmt.get(...(args as SqlValue[])),
        all: (...args: unknown[]) =>
          (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
            ? stmt.all(args[0] as Record<string, SqlValue>)
            : stmt.all(...(args as SqlValue[]))) as unknown[],
        run: (...args: unknown[]) => {
          const info =
            args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
              ? stmt.run(args[0] as Record<string, SqlValue>)
              : stmt.run(...(args as SqlValue[]));
          scheduleFlush();
          return { changes: info.changes };
        },
      };
    },
    async flush() {
      scheduleFlush();
      await chain;
    },
    async close() {
      scheduleFlush();
      await chain;
      mirror.close();
      await backend.close();
    },
  };
}

let _db: DbClient | null = null;
let _init: Promise<DbClient> | null = null;

export function getDbInfo(): { driver: DbDriver; detail: string; ready: boolean } {
  if (!_db) {
    const choice = resolveDriverChoice();
    return { driver: choice.driver, detail: "", ready: false };
  }
  return { driver: _db.driver, detail: _db.detail, ready: true };
}

export async function initDb(): Promise<DbClient> {
  if (_db) return _db;
  if (_init) return _init;
  _init = (async () => {
    const choice = resolveDriverChoice();
    _db = choice.driver === "sqlite" ? createSqlite() : await createPostgresClient(choice);
    console.log(`[db] driver=${_db.driver} detail=${_db.detail}`);
    return _db;
  })();
  return _init;
}

const bootChoice = resolveDriverChoice();
if (bootChoice.driver === "sqlite") {
  _db = createSqlite();
}

export const db: DbClient = new Proxy({} as DbClient, {
  get(_target, prop) {
    if (!_db) {
      throw new Error("数据库尚未初始化：Postgres/PGlite 模式请先 await initDb()");
    }
    const value = (_db as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as Function).bind(_db) : value;
  },
});
