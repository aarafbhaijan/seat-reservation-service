// MySQL connection pool and the transaction helper every write path uses.
import mysql, { type PoolConnection } from "mysql2/promise";
import { config } from "./config.js";
import { INNODB_LOCK_WAIT_TIMEOUT_SECONDS } from "./constants.js";

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

// Runs `work` inside one transaction on one connection.
// Any thrown error (including a DomainError like "seat taken") rolls everything back.
export async function withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
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

export async function pingDatabase(): Promise<void> {
  await pool.query("SELECT 1");
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
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
