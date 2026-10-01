// HTTP layer for reservations: validate -> call service -> respond. No SQL here.
import { Router, type Request } from "express";
import { z } from "zod";
import { currentUser, requireUser } from "../auth.js";
import { MAX_SEATS_PER_REQUEST } from "../constants.js";
import { DomainError } from "../errors.js";
import { reserveSeats, type Reservation } from "../services/reserve.js";
import { SeatLabel } from "./shows.js";

export const reservationsRouter = Router();

// Unknown fields (e.g. a spoofed "user_id") are stripped by zod and never reach the service.
const ReserveRequest = z.object({
  seats: z
    .array(SeatLabel)
    .min(1)
    .max(MAX_SEATS_PER_REQUEST)
    .refine((seats) => new Set(seats).size === seats.length, "Seats must not repeat"),
  idempotency_key: z.string().min(1).max(128).optional(),
});

// The key may come from the Idempotency-Key header or the body. Required either way,
// so every client retry is safe.
function idempotencyKeyFrom(req: Request, bodyKey: string | undefined): string {
  const headerKey = req.get("Idempotency-Key");

  if (headerKey !== undefined && bodyKey !== undefined && headerKey !== bodyKey) {
    throw new DomainError("invalid_request", "Idempotency-Key header and body key differ");
  }

  const key = headerKey ?? bodyKey;
  if (!key || key.length > 128) {
    throw new DomainError("invalid_request", "An idempotency key (1-128 chars) is required");
  }
  return key;
}

function toReservationResponse(reservation: Reservation) {
  return {
    reservation_id: reservation.id,
    show_id: reservation.showId,
    user_id: reservation.userId,
    seats: reservation.seats,
    amount_paise: reservation.amountPaise,
    status: reservation.status,
  };
}

// <{ showId: string }> types req.params, which the requireUser middleware would otherwise widen.
reservationsRouter.post<{ showId: string }>(
  "/shows/:showId/reserve",
  requireUser,
  async (req, res) => {
    const body = ReserveRequest.parse(req.body ?? {});

    const { reservation, isReplay } = await reserveSeats({
      showId: req.params.showId,
      userId: currentUser(req).id,
      seats: body.seats,
      idempotencyKey: idempotencyKeyFrom(req, body.idempotency_key),
    });

    // A replay answers 200 (not 201) with the original body, so "exactly one 201 per seat"
    // stays true even when the winner retries.
    if (isReplay) res.status(200).setHeader("Idempotent-Replayed", "true");
    else res.status(201);
    res.json(toReservationResponse(reservation));
  },
);
