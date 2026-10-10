/**
 * Quarantine leftover whole-DB `.sqlite.phys` files under data/import-recovery/.
 * Prefer convert → per-book dump when the book is readable; otherwise move to legacy-quarantine/.
 *
 *   npm run quarantine:legacy-phys
 *   npm run quarantine:legacy-phys -- --dir /path/to/import-recovery
 *
 * Does NOT call replaceSqliteFromPhysicalBackup (whole-DB restore is deprecated).
 */
import path from "node:path";
import { quarantineOrphanLegacyWholeDbPhys } from "../src/importBook";

const args = process.argv.slice(2);
const dirIdx = args.findIndex((a) => a === "--dir" || a === "-d");
const dir =
  dirIdx >= 0 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]!) : undefined;

function main() {
  const result = quarantineOrphanLegacyWholeDbPhys(dir);
  console.log("[quarantine-legacy-phys] scanned=", result.scanned);
  console.log("[quarantine-legacy-phys] converted=", result.converted);
  console.log("[quarantine-legacy-phys] quarantined=", result.quarantined);
  console.log("[quarantine-legacy-phys] skipped=", result.skipped);
  if (result.converted.length || result.quarantined.length) {
    console.log(
      "[quarantine-legacy-phys] done — whole-DB auto restore stays disabled; use per-book .book.phys.sqlite only",
    );
  } else {
    console.log("[quarantine-legacy-phys] nothing to do");
  }
}

main();
