// Builds the Express app: middleware order and route registration.
// Kept separate from server.ts so tests can create an app without opening a port.
import express from "express";
import { errorHandler, notFoundHandler } from "./errors.js";
import { httpLogger } from "./logger.js";
import { healthRouter } from "./routes/health.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(httpLogger); // first, so every later log line and error carries the request id
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler); // last: turns every thrown error into the JSON error envelope

  return app;
}
