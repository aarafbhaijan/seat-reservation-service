import { defineConfig } from "vitest/config";

// Tests run against a REAL MySQL (docker compose up -d mysql). Concurrency bugs
// only show up against a real database, so nothing here is mocked.
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    env: { LOG_LEVEL: "silent" },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
