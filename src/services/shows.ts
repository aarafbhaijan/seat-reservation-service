// Show creation and show state. Reservation logic lives in reserve.ts / cancel.ts.
import type { RowDataPacket } from "mysql2/promise";
import { ulid } from "ulid";
import { SEAT_INSERT_CHUNK_SIZE, SEAT_STATUS, type SeatStatus } from "../constants.js";
import { pool, withTransaction } from "../db.js";
import { DomainError } from "../errors.js";

export interface Show {
  id: string;
  name: string;
  pricePaise: number;
  perUserLimit: number;
  totalSeats: number;
}

export interface SeatCounts {
  available: number;
  held: number;
  confirmed: number;
}

export interface ShowState {
  show: Show;
  counts: SeatCounts;
  seats: { label: string; status: SeatStatus }[];
}

export interface NewShow {
  name: string;
  seats: string[];
  pricePaise: number;
  perUserLimit: number;
}

export async function createShow(input: NewShow): Promise<ShowState> {
  const show: Show = {
    id: ulid(),
    name: input.name,
    pricePaise: input.pricePaise,
    perUserLimit: input.perUserLimit,
    totalSeats: input.seats.length,
  };

  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO shows (id, name, price_paise, per_user_limit, total_seats)
       VALUES (?, ?, ?, ?, ?)`,
      [show.id, show.name, show.pricePaise, show.perUserLimit, show.totalSeats],
    );

    // Bulk insert in chunks: one round-trip per 1,000 seats instead of one per seat.
    for (let start = 0; start < input.seats.length; start += SEAT_INSERT_CHUNK_SIZE) {
      const chunk = input.seats.slice(start, start + SEAT_INSERT_CHUNK_SIZE);
      const rows = chunk.map((label, index) => [show.id, label, start + index]);
      await tx.query("INSERT INTO seats (show_id, label, position) VALUES ?", [rows]);
    }
  });

  return {
    show,
    counts: { available: show.totalSeats, held: 0, confirmed: 0 },
    seats: input.seats.map((label) => ({ label, status: SEAT_STATUS.AVAILABLE })),
  };
}

interface ShowRow extends RowDataPacket {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  total_seats: number;
}

export async function findShow(showId: string): Promise<Show | null> {
  const [rows] = await pool.query<ShowRow[]>(
    "SELECT id, name, price_paise, per_user_limit, total_seats FROM shows WHERE id = ?",
    [showId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    pricePaise: Number(row.price_paise),
    perUserLimit: row.per_user_limit,
    totalSeats: row.total_seats,
  };
}

export async function getShowOrThrow(showId: string): Promise<Show> {
  const show = await findShow(showId);
  if (!show) throw new DomainError("not_found", "Show not found");
  return show;
}

interface SeatRow extends RowDataPacket {
  label: string;
  status: SeatStatus;
}

export async function getShowState(showId: string): Promise<ShowState> {
  const show = await getShowOrThrow(showId);

  const [seatRows] = await pool.query<SeatRow[]>(
    "SELECT label, status FROM seats WHERE show_id = ? ORDER BY position",
    [showId],
  );

  // Counts come from the SAME result set as the seat list (one statement = one snapshot),
  // so available + held + confirmed == total_seats exactly, in every response.
  const counts: SeatCounts = { available: 0, held: 0, confirmed: 0 };
  for (const seat of seatRows) counts[seat.status] += 1;

  return {
    show,
    counts,
    seats: seatRows.map((seat) => ({ label: seat.label, status: seat.status })),
  };
}
