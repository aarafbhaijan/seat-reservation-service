// Applies migrations/*.sql in filename order, once each, tracked in `schema_migrations`.
// A MySQL named lock makes it safe if two app instances boot at the same time.
import { readdir, readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { config } from "./config.js";

// Works from both src/ (dev) and dist/ (prod): migrations/ sits next to either folder.
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

export async function runMigrations(log: (message: string) => void = console.log): Promise<void> {
  // A dedicated connection: migration files contain several statements each.
  const connection = await mysql.createConnection({
    uri: config.DATABASE_URL,
    multipleStatements: true,
  });

  try {
    await connection.query("SELECT GET_LOCK('schema_migrations', 30)");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      )`);

    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT name FROM schema_migrations",
    );
    const alreadyApplied = new Set(rows.map((row) => row.name as string));

    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      await connection.query(sql);
      await connection.query("INSERT INTO schema_migrations (name) VALUES (?)", [file]);
      log(`applied migration ${file}`);
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK('schema_migrations')").catch(() => {});
    await connection.end();
  }
}
