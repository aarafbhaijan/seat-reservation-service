// Gauges computed from the database at scrape time. Because they are read from the same
// `seats` table the API reads, metrics and GET /shows/:id can never disagree.
import type { RowDataPacket } from "mysql2/promise";
import { Gauge } from "prom-client";
import { SEAT_STATUS } from "./constants.js";
import { pool, probePool } from "./db.js";
import { logger } from "./logger.js";
import { registry } from "./metrics.js";

interface SeatCountRow extends RowDataPacket {
  show_id: string;
  status: string;
  n: number;
}

// prom-client collects all metrics in parallel, so both seat gauges ask for the counts at
// the same moment. They share one in-flight query: one DB read per scrape, one consistent
// snapshot for both gauges.
let inFlightSeatCounts: Promise<SeatCountRow[]> | null = null;

function loadSeatCounts(): Promise<SeatCountRow[]> {
  inFlightSeatCounts ??= probePool
    .query<SeatCountRow[]>({
      sql: "SELECT show_id, status, COUNT(*) AS n FROM seats GROUP BY show_id, status",
      timeout: 2_000,
    })
    .then(([rows]) => rows)
    .catch((error: unknown) => {
      // A scrape must never fail (that would be a 5xx); missing series signal the problem.
      logger.warn({ err: error }, "could not read seat gauges from the database");
      return [];
    })
    .finally(() => {
      inFlightSeatCounts = null;
    });
  return inFlightSeatCounts;
}

const seatsByStatus = new Gauge({
  name: "seats",
  help: "Seats per show by status (available + held + confirmed == total)",
  labelNames: ["show_id", "status"] as const,
  registers: [registry],
  async collect() {
    const rows = await loadSeatCounts();
    seatsByStatus.reset();
    // GROUP BY returns no row for a status with zero seats; publish an explicit 0 instead.
    for (const showId of new Set(rows.map((row) => row.show_id))) {
      for (const status of Object.values(SEAT_STATUS)) {
        seatsByStatus.set({ show_id: showId, status }, 0);
      }
    }
    for (const row of rows) {
      seatsByStatus.set({ show_id: row.show_id, status: row.status }, Number(row.n));
    }
  },
});

const seatsAvailable = new Gauge({
  name: "seats_available",
  help: "Seats currently available per show",
  labelNames: ["show_id"] as const,
  registers: [registry],
  async collect() {
    const rows = await loadSeatCounts();
    seatsAvailable.reset();
    for (const showId of new Set(rows.map((row) => row.show_id))) {
      seatsAvailable.set({ show_id: showId }, 0);
    }
    for (const row of rows) {
      if (row.status === SEAT_STATUS.AVAILABLE) {
        seatsAvailable.set({ show_id: row.show_id }, Number(row.n));
      }
    }
  },
});

// mysql2 doesn't expose pool stats publicly; these private fields are stable across v3.
interface PoolInternals {
  _allConnections: { length: number };
  _freeConnections: { length: number };
  _connectionQueue: { length: number };
}

const dbPoolConnections = new Gauge({
  name: "db_pool_connections",
  help: "Main DB pool: connections in use, idle, and requests queued waiting for one",
  labelNames: ["state"] as const,
  registers: [registry],
  collect() {
    const internals = pool.pool as unknown as PoolInternals;
    const total = internals._allConnections.length;
    const free = internals._freeConnections.length;
    dbPoolConnections.set({ state: "in_use" }, total - free);
    dbPoolConnections.set({ state: "free" }, free);
    dbPoolConnections.set({ state: "queued" }, internals._connectionQueue.length);
  },
});
