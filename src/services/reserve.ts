// The reserve transaction — the heart of the service.
//
// Every write transaction takes its locks in the same order, which is why two reserves
// can never deadlock each other:
//     1. reservations (user_id, idempotency_key)   — claim the idempotency key
//     2. seats (show_id, label) in primary-key order — take the seats
import { createHash } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ulid } from "ulid";
import { RESERVATION_STATUS, SEAT_STATUS, type ReservationStatus } from "../constants.js";
import { pool, withTransaction, type Tx } from "../db.js";
import { DomainError } from "../errors.js";
import { getShowOrThrow } from "./shows.js";

export interface ReserveInput {
  showId: string;
  userId: string; // from the auth token, never from the request body
  seats: string[];
  idempotencyKey: string;
}

export interface Reservation {
  id: string;
  showId: string;
  userId: string;
  seats: string[];
  amountPaise: number;
  status: ReservationStatus;
}

export interface ReserveResult {
  reservation: Reservation;
  isReplay: boolean;
}

export async function reserveSeats(input: ReserveInput): Promise<ReserveResult> {
  const show = await getShowOrThrow(input.showId);

  // Sorted so the same set of seats always produces the same request hash.
  const seats = [...input.seats].sort();

  const reservation: Reservation = {
    id: ulid(),
    showId: show.id,
    userId: input.userId,
    seats,
    amountPaise: show.pricePaise * seats.length, // integer paise × integer count
    status: RESERVATION_STATUS.CONFIRMED,
  };
  const requestHash = hashRequest(show.id, seats);

  try {
    await withTransaction(async (tx) => {
      await insertReservation(tx, reservation, input.idempotencyKey, requestHash);
      await takeSeatsOrFail(tx, reservation);
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === "seat_taken") {
      await failIfAnySeatIsUnknown(show.id, seats);
    }
    throw error;
  }

  return { reservation, isReplay: false };
}

function hashRequest(showId: string, sortedSeats: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ show_id: showId, seats: sortedSeats }))
    .digest("hex");
}

async function insertReservation(
  tx: Tx,
  reservation: Reservation,
  idempotencyKey: string,
  requestHash: string,
): Promise<void> {
  await tx.query(
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
  );
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
