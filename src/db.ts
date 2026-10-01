// MySQL connection pool and the transaction helper every write path uses.
import mysql, { type PoolConnection } from "mysql2/promise";
import { config } from "./config.js";
import { INNODB_LOCK_WAIT_TIMEOUT_SECONDS, MYSQL_ERRNO } from "./constants.js";
import { logger } from "./logger.js";
import { transactionRetries } from "./metrics.js";

// The pool size caps how many queries run in MySQL at once. Requests beyond this
// wait in Node's memory (cheap) instead of piling onto the database (expensive).
export const pool = mysql.createPool({
  uri: config.DATABASE_URL,
  connectionLimit: config.DB_POOL_SIZE,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  supportBigNumbers: true,
});

// Every connection gets the same session settings, even if the server defaults differ
// (e.g. a managed MySQL left at REPEATABLE READ).
pool.on("connection", (connection) => {
  connection.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
  connection.query(`SET SESSION innodb_lock_wait_timeout = ${INNODB_LOCK_WAIT_TIMEOUT_SECONDS}`);
});

export type Tx = PoolConnection;

const MAX_TRANSACTION_ATTEMPTS = 3;

// Runs `work` inside one transaction, retrying if MySQL aborted it because of a deadlock or a
// lock-wait timeout. Our fixed lock order means deadlocks shouldn't happen — this is a safety
// net, so a rare one becomes a short delay instead of a 500.
// `work` must only touch the database (it may run more than once).
export async function withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runInTransaction(work);
    } catch (error) {
      if (!isRetryableLockError(error) || attempt >= MAX_TRANSACTION_ATTEMPTS) throw error;
      logger.warn({ errno: errnoOf(error), attempt }, "transaction aborted by MySQL, retrying");
      transactionRetries.inc({ errno: String(errnoOf(error)) });
      await sleep(Math.random() * 20 * attempt); // jitter, so the retriers don't collide again
    }
  }
}

function errnoOf(error: unknown): number | undefined {
  return (error as { errno?: number }).errno;
}

function isRetryableLockError(error: unknown): boolean {
  const errno = errnoOf(error);
  return errno === MYSQL_ERRNO.DEADLOCK || errno === MYSQL_ERRNO.LOCK_WAIT_TIMEOUT;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Any thrown error (including a DomainError like "seat taken") rolls everything back.
async function runInTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// A tiny separate pool for health checks and metrics scrapes. During a burst every main-pool
// connection may be busy with reservations; probes must still get an honest, fast answer.
export const probePool = mysql.createPool({
  uri: config.DATABASE_URL,
  connectionLimit: 2,
  waitForConnections: true,
  enableKeepAlive: true,
});

const PROBE_TIMEOUT_MS = 1_000;

export async function pingDatabase(): Promise<void> {
  await probePool.query({ sql: "SELECT 1", timeout: PROBE_TIMEOUT_MS });
}

export async function closePools(): Promise<void> {
  await Promise.all([pool.end(), probePool.end()]);
}

// On a cold start MySQL may still be booting; keep trying for a while before giving up.
export async function waitForDatabase(maxWaitMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await pingDatabase();
      return;
    } catch (error) {
      if (Date.now() - startedAt > maxWaitMs) throw error;
      await sleep(1_000);
    }
  }
}
