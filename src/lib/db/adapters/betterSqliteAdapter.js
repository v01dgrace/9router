import Database from "better-sqlite3";
import { PRAGMA_SQL } from "../schema.js";

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000;
const SQLITE_BUSY_RETRIES = 4;
const SQLITE_BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200];

export function createBetterSqliteAdapter(filePath) {
  const db = new Database(filePath, { timeout: 10000 });
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  const stmtCache = new Map();

  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  function withBusyRetry(operation) {
    let lastError;
    for (let attempt = 0; attempt <= SQLITE_BUSY_RETRIES; attempt++) {
      try {
        return operation();
      } catch (error) {
        lastError = error;
        if (error?.code !== "SQLITE_BUSY" || attempt === SQLITE_BUSY_RETRIES) {
          throw error;
        }
        sleepSync(SQLITE_BUSY_RETRY_DELAYS_MS[attempt] || 200);
      }
    }
    throw lastError;
  }

  // Truncate WAL periodically so file stays small for backup/copy
  const checkpointTimer = setInterval(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  // Ensure WAL is flushed and -wal/-shm files removed on shutdown
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", () => { onShutdown(); process.exit(0); });
  process.once("SIGTERM", () => { onShutdown(); process.exit(0); });

  return {
    driver: "better-sqlite3",
    run(sql, params = []) { return withBusyRetry(() => prepare(sql).run(params)); },
    get(sql, params = []) { return withBusyRetry(() => prepare(sql).get(params)); },
    all(sql, params = []) { return withBusyRetry(() => prepare(sql).all(params)); },
    exec(sql) { return withBusyRetry(() => db.exec(sql)); },
    transaction(fn) { return withBusyRetry(() => db.transaction(fn)()); },
    checkpoint() { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
