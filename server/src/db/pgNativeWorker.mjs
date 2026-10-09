/**
 * Worker thread for native Postgres DbClient (sync bridge via Atomics + MessagePort).
 */
import { parentPort } from "node:worker_threads";
import pg from "pg";

const Pool = pg.Pool || pg.default?.Pool;

/** @type {import('pg').Pool | null} */
let pool = null;
/** @type {import('pg').PoolClient | null} */
let tx = null;

function q() {
  return tx || pool;
}

async function handle(msg) {
  switch (msg.op) {
    case "open": {
      if (pool) await handle({ op: "close" });
      pool = new Pool({ connectionString: msg.connectionString, max: msg.max ?? 8 });
      await pool.query("select 1 as ok");
      return { ok: true };
    }
    case "exec": {
      const client = q();
      if (!client) throw new Error("pg native pool not open");
      await client.query(msg.sql);
      return { ok: true };
    }
    case "query": {
      const client = q();
      if (!client) throw new Error("pg native pool not open");
      const r = await client.query(msg.sql, msg.params ?? []);
      return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
    }
    case "begin": {
      if (tx) throw new Error("nested transaction not supported");
      if (!pool) throw new Error("pg native pool not open");
      tx = await pool.connect();
      await tx.query("BEGIN");
      return { ok: true };
    }
    case "commit": {
      if (!tx) throw new Error("no transaction");
      try {
        await tx.query("COMMIT");
      } finally {
        tx.release();
        tx = null;
      }
      return { ok: true };
    }
    case "rollback": {
      if (!tx) return { ok: true };
      try {
        await tx.query("ROLLBACK");
      } finally {
        try {
          tx.release();
        } catch {
          /* ignore */
        }
        tx = null;
      }
      return { ok: true };
    }
    case "close": {
      if (tx) {
        try {
          await tx.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        try {
          tx.release();
        } catch {
          /* ignore */
        }
        tx = null;
      }
      if (pool) {
        await pool.end();
        pool = null;
      }
      return { ok: true };
    }
    default:
      throw new Error(`unknown op ${msg.op}`);
  }
}

parentPort.on("message", (init) => {
  const { signal, port, readySignal } = init;
  port.on("message", async (msg) => {
    try {
      const result = await handle(msg);
      port.postMessage({ ok: true, result });
    } catch (error) {
      port.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    }
  });
  Atomics.store(readySignal, 0, 1);
  Atomics.notify(readySignal, 0);
});
