// The Reservation type, how it maps from a DB row, and read-only lookups.
// Shared by reserve.ts and cancel.ts.
import type { RowDataPacket } from "mysql2/promise";
import type { ReservationStatus } from "../constants.js";
import { pool } from "../db.js";

export interface Reservation {
  id: string;
  showId: string;
  userId: string;
  seats: string[];
  amountPaise: number;
  status: ReservationStatus;
}

export interface ReservationRow extends RowDataPacket {
  id: string;
  show_id: string;
  user_id: string;
  seats: string[]; // mysql2 parses JSON columns
  amount_paise: number;
  status: ReservationStatus;
  request_hash: string;
}

export const RESERVATION_COLUMNS =
  "id, show_id, user_id, seats, amount_paise, status, request_hash";

export function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    showId: row.show_id,
    userId: row.user_id,
    seats: row.seats,
    amountPaise: Number(row.amount_paise),
    status: row.status,
  };
}

// Owner-only lookup: someone else's reservation is indistinguishable from a missing one.
export async function findReservationForUser(
  reservationId: string,
  userId: string,
): Promise<Reservation | null> {
  const [rows] = await pool.query<ReservationRow[]>(
    `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = ? AND user_id = ?`,
    [reservationId, userId],
  );
  return rows[0] ? toReservation(rows[0]) : null;
}
