import { db } from "../db";
import { tickJob } from "../engine";

const DEFAULT_INTERVAL_MS = 2500;

let timer: NodeJS.Timeout | null = null;
let busy = false;
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
};

export function getWorkerStatus(): WorkerStatus {
  return { ...status, busy };
}

/** Prevent double-tick of the same job from HTTP + worker. */
export async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T | null> {
  if (locked.has(jobId)) return null;
  locked.add(jobId);
  try {
    return await fn();
  } finally {
    locked.delete(jobId);
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
  status.intervalMs = intervalMs;
  status.running = true;
  timer = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  // Allow process to exit naturally in tests if needed; keep alive with server.
  if (typeof timer.unref === "function") {
    // keep referenced so server stays active with jobs — do NOT unref
  }
  console.log(`[jobs] server worker started (every ${intervalMs}ms)`);
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
