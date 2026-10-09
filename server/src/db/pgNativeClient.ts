/**
 * Native Postgres DbClient — real SQL against node-pg (no SQLite mirror flush).
 * Sync API via worker_threads Atomics bridge (app engine stays sync).
 *
 * Enable: DATABASE_URL=postgres://... MOLAN_NATIVE_PG=1
 * Default product path remains SQLite.
 */
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postgresSchema, SCENES } from "./schema";
import { qmarksToDollar, rewriteSqliteIdioms } from "./sqlCompat";

export type SqlValue = string | number | null | boolean | bigint;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;
type RunResult = { changes: number };

export type NativePgDbClient = {
  readonly driver: "postgres-native";
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
  flush(): Promise<void>;
  close(): Promise<void>;
};

type BridgeResponse =
  | { ok: true; result: { ok?: boolean; rows?: Record<string, unknown>[]; rowCount?: number } }
  | { ok: false; error: string };

type CallMsg =
  | { op: "open"; connectionString: string; max?: number }
  | { op: "exec"; sql: string }
  | { op: "query"; sql: string; params?: SqlValue[] }
  | { op: "begin" }
  | { op: "commit" }
  | { op: "rollback" }
  | { op: "close" };

const MIGRATE_SQL = `
CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY,
  book_id TEXT,
  scene TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  local INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_usage_book ON api_usage(book_id, created_at);
CREATE INDEX IF NOT EXISTS api_usage_created ON api_usage(created_at);
CREATE TABLE IF NOT EXISTS hook_marks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  hook_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  recycled_chapter INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, hook_key)
);
DO $$ BEGIN
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS auto_review INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS log_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS lease_until TEXT;
  ALTER TABLE scene_routes ADD COLUMN IF NOT EXISTS thinking_intensity TEXT NOT NULL DEFAULT 'medium';
  ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS source_revision_id TEXT;
EXCEPTION WHEN others THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  scene TEXT NOT NULL,
  chapter_id TEXT,
  chapter_number INTEGER,
  status TEXT NOT NULL,
  base_revision_id TEXT,
  result_revision_id TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function normalizeParams(params?: SqlParams): SqlValue[] {
  if (!params) return [];
  if (Array.isArray(params)) return params;
  throw new Error("postgres-native 驱动不支持命名参数，请使用 ? 位置参数");
}

function toPgSql(sql: string): string {
  return qmarksToDollar(rewriteSqliteIdioms(sql)).text;
}

export function isNativePgEnabled(): boolean {
  return (process.env.MOLAN_NATIVE_PG || "").trim() === "1";
}

export function createNativePostgresClient(connectionString: string): NativePgDbClient {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, "pgNativeWorker.mjs");
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const readySignal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(readySignal, 0, 0);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(workerPath);

  worker.on("error", (err) => {
    console.error("[db] postgres-native worker error", err);
  });

  worker.postMessage({ signal, port: port2, readySignal }, [port2]);
  const readyWait = Atomics.wait(readySignal, 0, 0, 20_000);
  if (readyWait === "timed-out" && Atomics.load(readySignal, 0) === 0) {
    void worker.terminate();
    throw new Error("postgres-native worker 启动超时");
  }

  function call(msg: CallMsg): BridgeResponse {
    Atomics.store(signal, 0, 0);
    port1.postMessage(msg);
    const waitResult = Atomics.wait(signal, 0, 0, 120_000);
    if (waitResult === "timed-out" && Atomics.load(signal, 0) === 0) {
      throw new Error(`postgres-native 查询超时: ${msg.op}`);
    }
    const received = receiveMessageOnPort(port1);
    if (!received) {
      throw new Error(`postgres-native 无响应: ${msg.op}`);
    }
    return received.message as BridgeResponse;
  }

  function must(msg: CallMsg) {
    const res = call(msg);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }

  must({ op: "open", connectionString, max: 8 });
  must({ op: "exec", sql: postgresSchema() });
  must({ op: "exec", sql: MIGRATE_SQL });

  for (const scene of SCENES) {
    must({
      op: "query",
      sql: toPgSql(
        `INSERT INTO scene_routes (scene, provider, model_id, base_url)
         VALUES (?, 'local', 'local-draft', NULL)
         ON CONFLICT (scene) DO NOTHING`,
      ),
      params: [scene],
    });
  }

  const detail = connectionString.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");

  function runQuery(sql: string, params?: SqlParams) {
    return must({ op: "query", sql: toPgSql(sql), params: normalizeParams(params) });
  }

  const client: NativePgDbClient = {
    driver: "postgres-native",
    detail,
    exec(sql: string) {
      must({ op: "exec", sql: toPgSql(sql) });
    },
    get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
      const r = runQuery(sql, params);
      return (r.rows?.[0] as T) ?? undefined;
    },
    all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
      const r = runQuery(sql, params);
      return (r.rows as T[]) ?? [];
    },
    run(sql: string, params?: SqlParams) {
      const r = runQuery(sql, params);
      return { changes: r.rowCount ?? 0 };
    },
    transaction<T>(fn: () => T): () => T {
      return () => {
        must({ op: "begin" });
        try {
          const result = fn();
          must({ op: "commit" });
          return result;
        } catch (error) {
          try {
            must({ op: "rollback" });
          } catch {
            /* ignore */
          }
          throw error;
        }
      };
    },
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => client.get(sql, flattenPrepareArgs(args)),
        all: (...args: unknown[]) => client.all(sql, flattenPrepareArgs(args)) as unknown[],
        run: (...args: unknown[]) => client.run(sql, flattenPrepareArgs(args)),
      };
    },
    async flush() {},
    async close() {
      try {
        must({ op: "close" });
      } finally {
        port1.close();
        await worker.terminate();
      }
    },
  };

  return client;
}

function flattenPrepareArgs(args: unknown[]): SqlValue[] | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
    throw new Error("postgres-native prepare() 不支持命名参数对象");
  }
  return args as SqlValue[];
}
