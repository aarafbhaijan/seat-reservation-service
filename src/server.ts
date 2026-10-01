// Process entry point: wait for MySQL, apply migrations, start listening, shut down cleanly.
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { closePools, waitForDatabase } from "./db.js";
import { markShuttingDown } from "./lifecycle.js";
import { logger } from "./logger.js";
import { runMigrations } from "./migrate.js";

// Kernel queue for connections not yet accepted. A burst opens thousands at once;
// the default (511) would reset some of them before Node ever sees them.
const LISTEN_BACKLOG = 4096;
const SHUTDOWN_GRACE_MS = 10_000;

async function main() {
  await waitForDatabase();
  await runMigrations((message) => logger.info(message));

  const server = createApp().listen({ port: config.PORT, backlog: LISTEN_BACKLOG }, () => {
    logger.info({ port: config.PORT }, "listening");
  });

  // A request queued behind a hot seat must finish before anything gives up on it.
  // keepAliveTimeout is longer than the reverse proxy's, so the proxy never reuses a
  // connection Node has just closed (a classic source of random 502s).
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  process.on("SIGTERM", () => shutdown(server, "SIGTERM"));
  process.on("SIGINT", () => shutdown(server, "SIGINT"));
}

// 1. /readyz starts answering 503, 2. stop accepting new connections and let in-flight
// requests finish, 3. close the DB pools. Uncommitted transactions roll back on their own.
function shutdown(server: Server, signal: string) {
  logger.info({ signal }, "shutting down");
  markShuttingDown();

  setTimeout(() => {
    logger.warn("shutdown grace period over, exiting");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();

  server.close(async () => {
    await closePools();
    logger.info("shutdown complete");
    process.exit(0);
  });
  server.closeIdleConnections();
}

main().catch((error) => {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
});
