// The cancel transaction: the owner releases a reservation and its seats become re-bookable.
//
// Same lock order as reserve (reservation -> user_quota -> seats), so a cancel and a reserve
// can never deadlock each other.
import type { ResultSetHeader } from "mysql2/promise";
import { RESERVATION_STATUS, SEAT_STATUS } from "../constants.js";
import { withTransaction, type Tx } from "../db.js";
import { DomainError } from "../errors.js";
import { reservationsCancelled } from "../metrics.js";
import {
  RESERVATION_COLUMNS,
  toReservation,
  type Reservation,
  type ReservationRow,
} from "./reservations.js";

export async function cancelReservation(
  reservationId: string,
  userId: string, // from the auth token: you can only ever cancel your own reservation
): Promise<Reservation> {
  return withTransaction(async (tx) => {
    const reservation = await lockOwnReservation(tx, reservationId, userId);

    // Cancelling twice is fine: the second call just returns the cancelled reservation.
    if (reservation.status === RESERVATION_STATUS.CANCELLED) return reservation;

    await markCancelled(tx, reservation.id);
    await releaseQuota(tx, reservation);
    await releaseSeats(tx, reservation);
    reservationsCancelled.inc(); // counted only when this call actually changed something

    return { ...reservation, status: RESERVATION_STATUS.CANCELLED };
  });
}

// FOR UPDATE locks the reservation row, so two concurrent cancels of the same reservation
// run one after the other — the second sees "cancelled" and changes nothing.
async function lockOwnReservation(
  tx: Tx,
  reservationId: string,
  userId: string,
): Promise<Reservation> {
  const [rows] = await tx.query<ReservationRow[]>(
    `SELECT ${RESERVATION_COLUMNS}
       FROM reservations
      WHERE id = ? AND user_id = ?
        FOR UPDATE`,
    [reservationId, userId],
  );
  if (!rows[0]) throw new DomainError("not_found", "Reservation not found");
  return toReservation(rows[0]);
}

async function markCancelled(tx: Tx, reservationId: string): Promise<void> {
  await tx.query(
    "UPDATE reservations SET status = ?, cancelled_at = NOW(3) WHERE id = ? AND status = ?",
    [RESERVATION_STATUS.CANCELLED, reservationId, RESERVATION_STATUS.CONFIRMED],
  );
}

async function releaseQuota(tx: Tx, reservation: Reservation): Promise<void> {
  const seatCount = reservation.seats.length;
  const [result] = await tx.query<ResultSetHeader>(
    `UPDATE user_quota
        SET seats_held = seats_held - ?
      WHERE show_id = ? AND user_id = ? AND seats_held >= ?`,
    [seatCount, reservation.showId, reservation.userId, seatCount],
  );
  // Can only fail if the data is already inconsistent; refuse rather than make it worse.
  if (result.affectedRows !== 1)
    throw new Error(`quota mismatch for reservation ${reservation.id}`);
}

// The guard `reservation_id = ?` is what makes a release safe: it only frees seats THIS
// reservation owns. A seat that was released and re-sold to someone else has a different
// reservation_id, so it can never be "resurrected" back to available.
async function releaseSeats(tx: Tx, reservation: Reservation): Promise<void> {
  await tx.query(
    `UPDATE seats
        SET status = ?, reservation_id = NULL, user_id = NULL
      WHERE show_id = ?
        AND reservation_id = ?`,
    [SEAT_STATUS.AVAILABLE, reservation.showId, reservation.id],
  );
}
