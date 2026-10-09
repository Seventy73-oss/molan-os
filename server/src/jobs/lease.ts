/**
 * Job lease helpers — SQLite-proven semantics shared with Postgres-native SQL.
 *
 * Product default remains SQLite (`tryAcquireJobLease` via DbClient).
 * Postgres-native acquire/release (FOR UPDATE + lease columns) lives in pgNativeLease.ts
 * and is proven by server/scripts/pg-lease-audit.mts against real Postgres when available.
 */

export const DEFAULT_LEASE_TTL_MS = 120_000;

/** ISO now helper (injectable for tests). */
export type Clock = () => string;

export function defaultClock(): string {
  return new Date().toISOString();
}

/**
 * SQLite / DbClient-shaped UPDATE: same predicate the product uses.
 * Bind order: owner, until, id, nowIso, owner
 */
export const SQLITE_ACQUIRE_SQL = `UPDATE writing_jobs SET lease_owner = ?, lease_until = ?
       WHERE id = ?
         AND status = 'running'
         AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)`;

/** Bind order: id, owner */
export const SQLITE_RELEASE_SQL = `UPDATE writing_jobs SET lease_owner = NULL, lease_until = NULL
     WHERE id = ? AND lease_owner = ?`;

/**
 * Postgres-native acquire (parameter style $1..$5).
 * Bind: owner, until, id, nowIso, owner
 * Uses the same predicate as SQLite. Pair with SELECT … FOR UPDATE SKIP LOCKED
 * in a transaction when contending across sessions (see pgNativeLease).
 */
export const PG_ACQUIRE_SQL = `UPDATE writing_jobs SET lease_owner = $1, lease_until = $2
       WHERE id = $3
         AND status = 'running'
         AND (lease_until IS NULL OR lease_until < $4 OR lease_owner = $5)
       RETURNING id`;

/** Bind: id, owner */
export const PG_RELEASE_SQL = `UPDATE writing_jobs SET lease_owner = NULL, lease_until = NULL
     WHERE id = $1 AND lease_owner = $2
     RETURNING id`;

/**
 * Lock the job row for the duration of the lease decision.
 * SKIP LOCKED: another session already locking this row → treat as not acquired.
 */
export const PG_LOCK_ROW_SQL = `SELECT id, status, lease_owner, lease_until
     FROM writing_jobs
     WHERE id = $1
     FOR UPDATE SKIP LOCKED`;

export type LeaseAcquireParams = {
  id: string;
  owner: string;
  ttlMs?: number;
  nowIso?: string;
};

export function leaseUntilIso(ttlMs: number, nowMs = Date.now()): string {
  return new Date(nowMs + ttlMs).toISOString();
}

/** Pure predicate: would this owner win given current row state? */
export function wouldAcquireLease(row: {
  status: string;
  lease_owner: string | null;
  lease_until: string | null;
}, owner: string, nowIso: string): boolean {
  if (row.status !== "running") return false;
  if (row.lease_until == null || row.lease_until < nowIso) return true;
  if (row.lease_owner === owner) return true;
  return false;
}
