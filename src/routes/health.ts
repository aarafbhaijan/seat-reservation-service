// Operational endpoints. Liveness only says "the process is up" — it never touches the DB,
// so a database outage doesn't make the platform restart a perfectly healthy process.
import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});
