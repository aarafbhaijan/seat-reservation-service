// Runs once before all test files: make sure MySQL is up and the schema is current.
import { pool, waitForDatabase } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";

export default async function setup() {
  await waitForDatabase(30_000);
  await runMigrations(() => {});
  await pool.end();
}
