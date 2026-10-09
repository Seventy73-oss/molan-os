/** Child helper for pg-lease-audit: try acquire once and print JSON. */
import pg from "pg";
import { acquireJobLeasePg } from "../src/jobs/pgNativeLease";

const url = (process.env.MOLAN_LEASE_DATABASE_URL || "").trim();
const jobId = (process.env.MOLAN_LEASE_JOB_ID || "").trim();
const owner = (process.env.MOLAN_LEASE_OWNER || "child").trim();
if (!url || !jobId) {
  console.error("missing MOLAN_LEASE_DATABASE_URL or MOLAN_LEASE_JOB_ID");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
const ok = await acquireJobLeasePg(pool, jobId, owner, 60_000);
console.log(JSON.stringify({ owner, ok }));
await pool.end();
process.exit(ok ? 0 : 1);
