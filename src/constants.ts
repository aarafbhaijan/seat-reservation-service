// Named values used across the codebase. Change limits and timeouts here, not inline.

export const SEAT_STATUS = {
  AVAILABLE: "available",
  HELD: "held",
  CONFIRMED: "confirmed",
} as const;
export type SeatStatus = (typeof SEAT_STATUS)[keyof typeof SEAT_STATUS];

export const RESERVATION_STATUS = {
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
} as const;
export type ReservationStatus = (typeof RESERVATION_STATUS)[keyof typeof RESERVATION_STATUS];

export const DEFAULT_PER_USER_LIMIT = 4;
export const MAX_PER_USER_LIMIT = 10;
export const MAX_SEATS_PER_SHOW = 10_000;
export const MAX_SEATS_PER_REQUEST = 10;
export const SEAT_INSERT_CHUNK_SIZE = 1_000;

// MySQL error numbers we handle on purpose.
export const MYSQL_ERRNO = {
  DUPLICATE_KEY: 1062,
  LOCK_WAIT_TIMEOUT: 1205,
  DEADLOCK: 1213,
} as const;

// A row-lock wait longer than this is treated as an error (and retried), not waited out forever.
export const INNODB_LOCK_WAIT_TIMEOUT_SECONDS = 5;
