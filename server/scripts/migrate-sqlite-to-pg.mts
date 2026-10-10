/**
 * CLI: migrate local SQLite → native Postgres.
 *
 *   DATABASE_URL=postgres://... npm run migrate:sqlite-to-pg -- --dry-run
 *   DATABASE_URL=postgres://... npm run migrate:sqlite-to-pg -- --force
 *   DATABASE_URL=postgres://... npm run migrate:sqlite-to-pg -- --sqlite /path/to.sqlite
 *
 * Does not enable MOLAN_NATIVE_PG; after success, start with MOLAN_NATIVE_PG=1.
 * Markdown under data/books/ is unchanged (shared layout).
 */
import path from "node:path";
import { resolveSqliteFilePath } from "../src/db";
import { countSqliteMigrateTables, migrateSqliteToPg } from "../src/db/migrateSqliteToPg";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-n");
const force = args.includes("--force") || args.includes("-f");
const sqliteIdx = args.findIndex((a) => a === "--sqlite" || a === "-s");
const sqlitePath =
  sqliteIdx >= 0 && args[sqliteIdx + 1]
    ? path.resolve(args[sqliteIdx + 1]!)
    : resolveSqliteFilePath();
const databaseUrl = (process.env.DATABASE_URL || process.env.MOLAN_MIGRATE_DATABASE_URL || "").trim();

async function main() {
  if (!databaseUrl) {
    console.error("需要 DATABASE_URL（或 MOLAN_MIGRATE_DATABASE_URL）指向目标 Postgres");
    process.exit(2);
  }
  console.log(`[migrate] source sqlite=${sqlitePath}`);
  console.log(`[migrate] target=${databaseUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@")}`);
  console.log(`[migrate] dryRun=${dryRun} force=${force}`);

  const counts = countSqliteMigrateTables(sqlitePath);
  console.log("[migrate] source row counts:", counts);

  const result = await migrateSqliteToPg({
    sqlitePath,
    databaseUrl,
    dryRun,
    force,
  });

  if (result.refused) {
    console.error(`[migrate] REFUSED: ${result.refused}`);
    process.exit(3);
  }

  console.log("[migrate] table results:");
  for (const [table, info] of Object.entries(result.tables)) {
    console.log(`  ${table}: source=${info.source} written=${info.written}`);
  }
  if (dryRun) {
    console.log("[migrate] dry-run complete — no Postgres writes");
  } else {
    console.log(
      "[migrate] done. 启用原生驱动：MOLAN_NATIVE_PG=1 DATABASE_URL=... npm run dev:server",
    );
  }
}

main().catch((error) => {
  console.error("[migrate] failed", error);
  process.exit(1);
});
