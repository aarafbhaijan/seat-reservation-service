// POST /auth/token — a stand-in for a real identity provider, so load tests can act as
// thousands of different users. Admin tokens require the X-Admin-Key header.
import { Router } from "express";
import { z } from "zod";
import { isValidAdminKey, signToken } from "../auth.js";
import { DomainError } from "../errors.js";

export const authRouter = Router();

const TokenRequest = z.object({
  user_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "1-64 letters, digits, _ or -"),
  role: z.enum(["user", "admin"]).default("user"),
});

authRouter.post("/auth/token", async (req, res) => {
  const { user_id, role } = TokenRequest.parse(req.body ?? {});

  if (role === "admin" && !isValidAdminKey(req.headers["x-admin-key"])) {
    throw new DomainError("forbidden", "Admin tokens require a valid X-Admin-Key header");
  }

  res.status(201).json({ token: await signToken(user_id, role), user_id, role });
});
