/**
 * Native Postgres / PGlite job lease (FOR UPDATE SKIP LOCKED + lease columns).
 * Independent of the app's experimental mirror driver — safe to use against a real
 * shared Postgres for multi-process mutual exclusion tests and future native drivers.
 */
import {
  DEFAULT_LEASE_TTL_MS,
  PG_ACQUIRE_SQL,
  PG_LOCK_ROW_SQL,
  PG_RELEASE_SQL,
  leaseUntilIso,
} from "./lease";

export type PgQueryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

export type PgLeaseClient = PgQueryable & {
  /** Optional: begin a transaction-scoped client (node-pg). */
  connect?: () => Promise<
    PgQueryable & {
      query: PgQueryable["query"];
      release?: () => void;
    }
  >;
};

async function withTx<T>(
  poolOrClient: PgLeaseClient,
  fn: (q: PgQueryable) => Promise<T>,
): Promise<T> {
  if (typeof poolOrClient.connect === "function") {
    const client = await poolOrClient.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    } finally {
      client.release?.();
    }
  }
  // Single-connection backends (PGlite): best-effort BEGIN/COMMIT on same handle.
  await poolOrClient.query("BEGIN");
  try {
    const result = await fn(poolOrClient);
    await poolOrClient.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await poolOrClient.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * Acquire lease with row lock. Returns true if this owner holds the lease.
 * Concurrent sessions: SKIP LOCKED → false for the waiter that did not lock the row.
 */
export async function acquireJobLeasePg(
  client: PgLeaseClient,
  id: string,
  owner: string,
  ttlMs = DEFAULT_LEASE_TTL_MS,
  nowIso = new Date().toISOString(),
): Promise<boolean> {
  const until = leaseUntilIso(ttlMs);
  return withTx(client, async (q) => {
    const locked = await q.query(PG_LOCK_ROW_SQL, [id]);
    if (!locked.rows.length) {
      // Row missing OR locked by another session (SKIP LOCKED).
      return false;
    }
    const updated = await q.query(PG_ACQUIRE_SQL, [owner, until, id, nowIso, owner]);
    return updated.rows.length > 0;
  });
}

export async function releaseJobLeasePg(
  client: PgLeaseClient,
  id: string,
  owner: string,
): Promise<boolean> {
  const result = await client.query(PG_RELEASE_SQL, [id, owner]);
  return (result.rows?.length ?? 0) > 0 || (result.rowCount ?? 0) > 0;
}

/** Minimal DDL for lease integration tests (not the full app schema). */
export const PG_LEASE_TEST_DDL = `
CREATE TABLE IF NOT EXISTS writing_jobs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  status TEXT NOT NULL,
  from_chapter INTEGER,
  to_chapter INTEGER,
  current_chapter INTEGER,
  current_stage TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  auto_review INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 0,
  log_json TEXT NOT NULL DEFAULT '[]',
  lease_owner TEXT,
  lease_until TEXT
);
`;
