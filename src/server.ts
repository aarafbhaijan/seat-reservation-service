// Process entry point: wait for MySQL, apply migrations, then start listening.
import { createApp } from "./app.js";
import { config } from "./config.js";
import { waitForDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";

async function main() {
  await waitForDatabase();
  await runMigrations();

  createApp().listen(config.PORT, () => {
    console.log(`listening on :${config.PORT}`);
  });
}

main().catch((error) => {
  console.error("failed to start", error);
  process.exit(1);
});
