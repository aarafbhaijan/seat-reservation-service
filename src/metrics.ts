// Prometheus metrics (prom-client). Counters are recorded where the event happens;
// seat gauges are read from the database at scrape time (see metrics-db.ts), so they always
// match what GET /shows/:id returns.
//
// This file must not import db.ts (db.ts imports it to count retries).
import type { RequestHandler } from "express";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { DomainError } from "./errors.js";

export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // CPU, memory, event-loop lag, GC

export const reservationsConfirmed = new Counter({
  name: "reservations_confirmed_total",
  help: "New reservations committed",
  registers: [registry],
});

export const reservationSeatsConfirmed = new Counter({
  name: "reservation_seats_confirmed_total",
  help: "Seats in newly committed reservations",
  registers: [registry],
});

export const reservationsDeclined = new Counter({
  name: "reservations_declined_total",
  help: "Reserve requests that did not create a new reservation, by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const reservationsFailed = new Counter({
  name: "reservations_failed_total",
  help: "Reserve requests that failed with a server-side error (should stay at 0)",
  labelNames: ["code"] as const,
  registers: [registry],
});

export const reservationsCancelled = new Counter({
  name: "reservations_cancelled_total",
  help: "Reservations cancelled (first cancel only; repeats are no-ops)",
  registers: [registry],
});

export const transactionRetries = new Counter({
  name: "db_transaction_retries_total",
  help: "Transactions re-run after MySQL aborted them (deadlock / lock wait timeout)",
  labelNames: ["errno"] as const,
  registers: [registry],
});

const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Pre-create every reason at 0 so dashboards show a flat line instead of "no data".
for (const reason of [
  "seat_taken",
  "per_user_limit",
  "idempotent_replay",
  "idempotency_key_conflict",
  "unknown_seat",
  "not_found",
]) {
  reservationsDeclined.inc({ reason }, 0);
}

export function recordReserveSuccess(seatCount: number, isReplay: boolean): void {
  if (isReplay) {
    reservationsDeclined.inc({ reason: "idempotent_replay" });
    return;
  }
  reservationsConfirmed.inc();
  reservationSeatsConfirmed.inc(seatCount);
}

export function recordReserveFailure(error: unknown): void {
  if (error instanceof DomainError && error.httpStatus < 500) {
    reservationsDeclined.inc({ reason: error.code });
  } else {
    reservationsFailed.inc({ code: error instanceof DomainError ? error.code : "internal_error" });
  }
}

// Route label is the pattern (/shows/:showId/reserve), not the URL, to keep cardinality low.
export const httpMetrics: RequestHandler = (req, res, next) => {
  const stopTimer = httpDuration.startTimer();
  res.on("finish", () => {
    const route = req.route ? `${req.baseUrl}${req.route.path}` : "unmatched";
    stopTimer({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
};
