import { randomUUID } from "node:crypto";
import { db, getDbInfo } from "../db";
import { releaseJobLease, tickJob, tryAcquireJobLease } from "../engine";

const DEFAULT_INTERVAL_MS = 2500;
const WORKER_OWNER = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Mirror Postgres/PGlite (memory SQLite + full-table flush): cross-process leases are NOT safe.
 * Native Postgres (`postgres-native` / MOLAN_NATIVE_PG=1): real SQL + FOR UPDATE SKIP LOCKED — worker allowed.
 * Mirror opt-in: MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER=1 (single-process only).
 */
export function experimentalPgWorkerAllowed(): boolean {
  return (process.env.MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER || "").trim() === "1";
}

/**
 * Pure policy for tests / boot.
 * sqlite + postgres-native → allow; mirror postgres/pglite → refuse unless experimental flag.
 */
export function jobWorkerAllowedForDriver(
  driver: string,
  experimentalFlag = experimentalPgWorkerAllowed(),
): { allowed: boolean; reason: string } {
  if (driver === "sqlite") {
    return { allowed: true, reason: "sqlite" };
  }
  if (driver === "postgres-native") {
    return { allowed: true, reason: "postgres-native (FOR UPDATE SKIP LOCKED lease)" };
  }
  if (experimentalFlag) {
    return {
      allowed: true,
      reason: `${driver}: MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER=1 (single-process only)`,
    };
  }
  return {
    allowed: false,
    reason:
      `${driver} 为实验性镜像刷盘，多进程租约未验证；默认拒绝启动任务 worker。` +
      `原生驱动请设 MOLAN_NATIVE_PG=1；镜像单进程可设 MOLAN_ALLOW_EXPERIMENTAL_PG_WORKER=1。详见 docs/STORAGE_LEASE.md`,
  };
}

export function assertJobWorkerStoragePolicy(): { allowed: boolean; reason: string } {
  return jobWorkerAllowedForDriver(getDbInfo().driver);
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
/** In-process guard still useful; DB lease is the durable guard. */
const locked = new Set<string>();

export type WorkerStatus = {
  running: boolean;
  intervalMs: number;
  busy: boolean;
  lastTickAt: string | null;
  lastJobId: string | null;
  lastAdvanced: boolean | null;
  lastError: string | null;
  ticks: number;
  leaseOwner: string;
};

const status: WorkerStatus = {
  running: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  busy: false,
  lastTickAt: null,
  lastJobId: null,
  lastAdvanced: null,
  lastError: null,
  ticks: 0,
  leaseOwner: WORKER_OWNER,
};

export function getWorkerStatus(): WorkerStatus {
  return { ...status, busy };
}

/**
 * Prevent double-tick of the same job from HTTP + worker.
 * Uses in-process Set + SQLite lease so two entry points on the same DB file cannot both advance.
 */
export async function withJobLock<T>(jobId: string, fn: () => Promise<T>, owner = WORKER_OWNER): Promise<T | null> {
  if (locked.has(jobId)) return null;
  if (!tryAcquireJobLease(jobId, owner)) return null;
  locked.add(jobId);
  try {
    return await fn();
  } finally {
    locked.delete(jobId);
    try {
      releaseJobLease(jobId, owner);
    } catch {
      /* ignore */
    }
  }
}

async function tickOnce() {
  if (busy) return;
  busy = true;
  status.busy = true;
  try {
    const rows = db
      .prepare(
        `SELECT id FROM writing_jobs
         WHERE status = 'running'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .all() as { id: string }[];
    const jobId = rows[0]?.id;
    if (!jobId) return;
    const result = await withJobLock(jobId, () => tickJob(jobId));
    status.lastTickAt = new Date().toISOString();
    status.lastJobId = jobId;
    status.ticks += 1;
    if (result) {
      status.lastAdvanced = result.advanced;
      status.lastError = result.job.error ?? null;
      if (result.advanced) {
        console.log(
          `[jobs] tick ${jobId} → ${result.job.status} stage=${result.job.currentStage} ch=${result.job.currentChapter}`,
        );
      }
    }
  } catch (error) {
    status.lastError = error instanceof Error ? error.message : String(error);
    status.lastTickAt = new Date().toISOString();
    console.error("[jobs] worker tick failed:", status.lastError);
  } finally {
    busy = false;
    status.busy = false;
  }
}

export function startJobWorker(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return status;
  const policy = assertJobWorkerStoragePolicy();
  if (!policy.allowed) {
    status.running = false;
    status.lastError = policy.reason;
    console.warn(`[jobs] worker NOT started: ${policy.reason}`);
    return status;
  }
  if (policy.reason !== "sqlite" && !policy.reason.startsWith("postgres-native")) {
    console.warn(`[jobs] experimental PG worker enabled — ${policy.reason}`);
  } else if (policy.reason.startsWith("postgres-native")) {
    console.log(`[jobs] native Postgres worker — ${policy.reason}`);
  }
  status.intervalMs = intervalMs;
  status.running = true;
  timer = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  console.log(`[jobs] server worker started (every ${intervalMs}ms) owner=${WORKER_OWNER}`);
  void tickOnce();
  return status;
}

export function stopJobWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  status.running = false;
}
