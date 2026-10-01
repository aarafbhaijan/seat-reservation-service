// Builds the Express app: middleware order and route registration.
// Kept separate from server.ts so tests can create an app without opening a port.
import express from "express";
import { healthRouter } from "./routes/health.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter);

  return app;
}
