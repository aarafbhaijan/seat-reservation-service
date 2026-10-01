// Test helpers: start the real app on a random port and talk to it over HTTP,
// exactly like a client would.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { RowDataPacket } from "mysql2/promise";
import { ulid } from "ulid";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const server: Server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests inspect arbitrary JSON
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

/** A unique user id per test, so tests never share quota rows or idempotency keys. */
export function uniqueUserId(prefix = "user"): string {
  return `${prefix}-${ulid()}`;
}

export async function tokenFor(baseUrl: string, userId: string): Promise<string> {
  const { body } = await call(baseUrl, "POST", "/auth/token", { body: { user_id: userId } });
  return body.token;
}

export async function adminToken(baseUrl: string): Promise<string> {
  const { body } = await call(baseUrl, "POST", "/auth/token", {
    body: { user_id: "test-admin", role: "admin" },
    headers: { "x-admin-key": config.ADMIN_API_KEY },
  });
  return body.token;
}

export function seatLabels(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `S${i + 1}`);
}

export async function createTestShow(
  baseUrl: string,
  options: { seats?: string[]; pricePaise?: number; perUserLimit?: number } = {},
): Promise<{ id: string; seats: string[] }> {
  const seats = options.seats ?? seatLabels(20);
  const { status, body } = await call(baseUrl, "POST", "/shows", {
    token: await adminToken(baseUrl),
    body: {
      name: `test-show-${ulid()}`,
      seats,
      price_paise: options.pricePaise ?? 25_000,
      per_user_limit: options.perUserLimit ?? 4,
    },
  });
  expect(status).toBe(201);
  return { id: body.id, seats };
}

/**
 * The reconciliation invariant, checked straight against the database:
 *  1. available + held + confirmed == total_seats
 *  2. every user's quota row equals the seats they actually own
 *  3. every confirmed reservation owns exactly the seats it lists
 */
export async function expectInvariantsHold(showId: string): Promise<void> {
  const [[show]] = await pool.query<RowDataPacket[]>("SELECT total_seats FROM shows WHERE id = ?", [
    showId,
  ]);
  const [statusRows] = await pool.query<RowDataPacket[]>(
    "SELECT status, COUNT(*) AS n FROM seats WHERE show_id = ? GROUP BY status",
    [showId],
  );
  const sum = statusRows.reduce((total, row) => total + Number(row.n), 0);
  expect(sum).toBe(show!.total_seats);

  const [quotaMismatches] = await pool.query<RowDataPacket[]>(
    `SELECT q.user_id, q.seats_held, COUNT(s.label) AS owned
       FROM user_quota q
       LEFT JOIN seats s ON s.show_id = q.show_id AND s.user_id = q.user_id
      WHERE q.show_id = ?
      GROUP BY q.user_id, q.seats_held
     HAVING q.seats_held <> owned`,
    [showId],
  );
  expect(quotaMismatches).toEqual([]);

  const [reservationMismatches] = await pool.query<RowDataPacket[]>(
    `SELECT r.id, JSON_LENGTH(r.seats) AS listed, COUNT(s.label) AS owned
       FROM reservations r
       LEFT JOIN seats s ON s.reservation_id = r.id
      WHERE r.show_id = ? AND r.status = 'confirmed'
      GROUP BY r.id, listed
     HAVING listed <> owned`,
    [showId],
  );
  expect(reservationMismatches).toEqual([]);
}
