// Process entry point: wait for MySQL, apply migrations, then start listening.
import { createApp } from "./app.js";
import { config } from "./config.js";
import { waitForDatabase } from "./db.js";
import { logger } from "./logger.js";
import { runMigrations } from "./migrate.js";

async function main() {
  await waitForDatabase();
  await runMigrations((message) => logger.info(message));

  createApp().listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "listening");
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
});
