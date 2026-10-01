// The reserve transaction — the heart of the service.
//
// Every write transaction takes its locks in the same order, which is why two reserves
// can never deadlock each other:
//     1. reservations (user_id, idempotency_key)   — claim the idempotency key
//     2. user_quota (show_id, user_id)               — reserve the user's quota
//     3. seats (show_id, label) in primary-key order — take the seats
import { createHash } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ulid } from "ulid";
import { MYSQL_ERRNO, RESERVATION_STATUS, SEAT_STATUS } from "../constants.js";
import { pool, withTransaction, type Tx } from "../db.js";
import { DomainError } from "../errors.js";
import { recordReserveFailure, recordReserveSuccess } from "../metrics.js";
import {
  RESERVATION_COLUMNS,
  toReservation,
  type Reservation,
  type ReservationRow,
} from "./reservations.js";
import { getShowOrThrow } from "./shows.js";

export interface ReserveInput {
  showId: string;
  userId: string; // from the auth token, never from the request body
  seats: string[];
  idempotencyKey: string;
}

export interface ReserveResult {
  reservation: Reservation;
  isReplay: boolean;
}

// Public entry point: runs the reserve and records the outcome in metrics.
export async function reserveSeats(input: ReserveInput): Promise<ReserveResult> {
  try {
    const result = await reserveSeatsOnce(input);
    recordReserveSuccess(result.reservation.seats.length, result.isReplay);
    return result;
  } catch (error) {
    recordReserveFailure(error);
    throw error;
  }
}

async function reserveSeatsOnce(input: ReserveInput): Promise<ReserveResult> {
  const show = await getShowOrThrow(input.showId);

  // Sorted so the same set of seats always produces the same request hash.
  const seats = [...input.seats].sort();

  // Fast decline: a request bigger than the limit can never succeed, no transaction needed.
  if (seats.length > show.perUserLimit) throw new DomainError("per_user_limit");

  const reservation: Reservation = {
    id: ulid(),
    showId: show.id,
    userId: input.userId,
    seats,
    amountPaise: show.pricePaise * seats.length, // integer paise × integer count
    status: RESERVATION_STATUS.CONFIRMED,
  };
  const requestHash = hashRequest(show.id, seats);

  await ensureQuotaRowExists(show.id, input.userId);

  try {
    await withTransaction(async (tx) => {
      await insertReservation(tx, reservation, input.idempotencyKey, requestHash);
      await reserveQuotaOrFail(tx, reservation, show.perUserLimit);
      await takeSeatsOrFail(tx, reservation);
    });
  } catch (error) {
    if (error instanceof IdempotencyKeyAlreadyUsed) {
      return replayExistingReservation(input.userId, input.idempotencyKey, requestHash);
    }
    if (error instanceof DomainError && error.code === "seat_taken") {
      await failIfAnySeatIsUnknown(show.id, seats);
    }
    throw error;
  }

  return { reservation, isReplay: false };
}

// Creates the user's quota row (0 seats) if it doesn't exist yet — deliberately OUTSIDE the
// transaction, as its own auto-committed statement. Why: when several transactions INSERT the
// same new row at once, InnoDB takes shared locks on the duplicate key and they can deadlock
// each other. Committing the row up front means the transaction only ever UPDATEs an existing
// row, which simply queues. A leftover row with 0 seats is harmless.
async function ensureQuotaRowExists(showId: string, userId: string): Promise<void> {
  await pool.query(
    "INSERT IGNORE INTO user_quota (show_id, user_id, seats_held) VALUES (?, ?, 0)",
    [showId, userId],
  );
}

function hashRequest(showId: string, sortedSeats: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ show_id: showId, seats: sortedSeats }))
    .digest("hex");
}

// Thrown inside the transaction when the (user_id, idempotency_key) row already exists.
// Throwing (instead of returning) makes withTransaction roll back before we read the original.
class IdempotencyKeyAlreadyUsed extends Error {}

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { errno?: number }).errno === MYSQL_ERRNO.DUPLICATE_KEY;
}

// Step 1 — claim the idempotency key. UNIQUE (user_id, idempotency_key) makes "apply this
// request twice" impossible: if two copies arrive at once, the second INSERT waits on the
// first's key lock. First commits -> second gets a duplicate-key error -> replay.
// First rolls back (e.g. seat taken) -> second proceeds as if it were the first.
async function insertReservation(
  tx: Tx,
  reservation: Reservation,
  idempotencyKey: string,
  requestHash: string,
): Promise<void> {
  await tx
    .query(
      `INSERT INTO reservations
       (id, show_id, user_id, seats, amount_paise, status, idempotency_key, request_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reservation.id,
        reservation.showId,
        reservation.userId,
        JSON.stringify(reservation.seats),
        reservation.amountPaise,
        reservation.status,
        idempotencyKey,
        requestHash,
      ],
    )
    .catch((error: unknown) => {
      if (isDuplicateKeyError(error)) throw new IdempotencyKeyAlreadyUsed();
      throw error;
    });
}

// Same key + same request  -> return the original reservation (nothing moves).
// Same key + different request -> 409, so a buggy client can't silently get the wrong seats.
async function replayExistingReservation(
  userId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<ReserveResult> {
  const [rows] = await pool.query<ReservationRow[]>(
    `SELECT ${RESERVATION_COLUMNS}
       FROM reservations
      WHERE user_id = ? AND idempotency_key = ?`,
    [userId, idempotencyKey],
  );
  const row = rows[0];
  if (!row) throw new Error("idempotency key vanished after a duplicate-key error");

  if (row.request_hash !== requestHash) throw new DomainError("idempotency_key_conflict");

  return { reservation: toReservation(row), isReplay: true };
}

// Per-user limit. All of one user's requests for a show must update the SAME quota row, so
// InnoDB runs them one at a time. Each sees the committed `seats_held` and the guard in WHERE
// only lets the update through if the new total stays within the limit — so 10 parallel
// requests on a limit-4 show can never get more than 4 seats.
// (If the seat step later fails, the rollback gives the quota back automatically.)

const RESERVE_QUOTA_SQL = `
  UPDATE user_quota
     SET seats_held = seats_held + ?
   WHERE show_id = ?
     AND user_id = ?
     AND seats_held + ? <= ?`;

async function reserveQuotaOrFail(
  tx: Tx,
  reservation: Reservation,
  perUserLimit: number,
): Promise<void> {
  const seatCount = reservation.seats.length;
  const [result] = await tx.query<ResultSetHeader>(RESERVE_QUOTA_SQL, [
    seatCount,
    reservation.showId,
    reservation.userId,
    seatCount,
    perUserLimit,
  ]);

  if (result.affectedRows !== 1) throw new DomainError("per_user_limit");
}

// THE atomic decision. The "is it available?" check and the write are ONE statement:
// InnoDB locks each matching seat row, and anyone else updating the same seat waits, then
// re-checks `status = 'available'` against the committed row — sees 'confirmed' — and matches
// nothing. So for any seat, exactly one transaction can ever flip it.
// All-or-nothing: if we didn't get EVERY requested seat, we throw and the whole transaction
// (including the reservation row) rolls back.
const TAKE_SEATS_SQL = `
  UPDATE seats
     SET status = ?, reservation_id = ?, user_id = ?
   WHERE show_id = ?
     AND label IN (?)
     AND status = ?`;

async function takeSeatsOrFail(tx: Tx, reservation: Reservation): Promise<void> {
  const [result] = await tx.query<ResultSetHeader>(TAKE_SEATS_SQL, [
    SEAT_STATUS.CONFIRMED,
    reservation.id,
    reservation.userId,
    reservation.showId,
    reservation.seats,
    SEAT_STATUS.AVAILABLE,
  ]);

  if (result.affectedRows !== reservation.seats.length) {
    throw new DomainError("seat_taken");
  }
}

// Runs only AFTER a failed transaction has rolled back, to pick the right error message.
// It never decides who gets a seat. (Seat labels never change after a show is created,
// so this read can't be stale in a way that matters.)
async function failIfAnySeatIsUnknown(showId: string, seats: string[]): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT label FROM seats WHERE show_id = ? AND label IN (?)",
    [showId, seats],
  );
  if (rows.length === seats.length) return;

  const existing = new Set(rows.map((row) => row.label as string));
  const unknownSeats = seats.filter((label) => !existing.has(label));
  throw new DomainError("unknown_seat", undefined, { unknown_seats: unknownSeats });
}
