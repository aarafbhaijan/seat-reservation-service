// HTTP layer for shows: validate -> call service -> respond. No SQL here.
import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { DEFAULT_PER_USER_LIMIT, MAX_PER_USER_LIMIT, MAX_SEATS_PER_SHOW } from "../constants.js";
import { createShow, getShowState, type ShowState } from "../services/shows.js";

export const showsRouter = Router();

export const SeatLabel = z.string().regex(/^[A-Za-z0-9-]{1,16}$/, "1-16 letters, digits or -");

const CreateShowRequest = z.object({
  name: z.string().trim().min(1).max(200),
  seats: z
    .array(SeatLabel)
    .min(1)
    .max(MAX_SEATS_PER_SHOW)
    .refine((seats) => new Set(seats).size === seats.length, "Seat labels must be unique"),
  // Money is integer paise — never a float.
  price_paise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  per_user_limit: z.number().int().min(1).max(MAX_PER_USER_LIMIT).default(DEFAULT_PER_USER_LIMIT),
});

function toShowResponse({ show, counts, seats }: ShowState) {
  return {
    id: show.id,
    name: show.name,
    price_paise: show.pricePaise,
    per_user_limit: show.perUserLimit,
    total_seats: show.totalSeats,
    counts,
    seats,
  };
}

showsRouter.post("/shows", requireAdmin, async (req, res) => {
  const body = CreateShowRequest.parse(req.body ?? {});

  const created = await createShow({
    name: body.name,
    seats: body.seats,
    pricePaise: body.price_paise,
    perUserLimit: body.per_user_limit,
  });

  res.status(201).json(toShowResponse(created));
});

showsRouter.get("/shows/:showId", async (req, res) => {
  const state = await getShowState(req.params.showId);
  res.json(toShowResponse(state));
});
