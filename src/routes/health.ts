// Operational endpoints.
//  /healthz — liveness: "the process is up". Never touches the DB, so a database outage
//             doesn't make the platform restart a perfectly healthy process.
//  /readyz  — readiness: "send me traffic". Checks MySQL and FAILS CLOSED (503) if it's
//             unreachable or the process is shutting down.
import { Router } from "express";
import { pingDatabase } from "../db.js";
import { isShuttingDown } from "../lifecycle.js";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/readyz", async (req, res) => {
  if (isShuttingDown()) {
    res.status(503).json({ status: "not_ready", reason: "shutting_down" });
    return;
  }

  try {
    await pingDatabase();
    res.json({ status: "ready", database: "ok" });
  } catch (error) {
    req.log.warn({ err: error }, "readiness check failed");
    res.status(503).json({ status: "not_ready", database: "unreachable" });
  }
});
