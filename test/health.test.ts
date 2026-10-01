import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools } from "../src/db.js";
import { call, startServer, type TestServer } from "./helpers.js";

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
  await closePools();
});

describe("health endpoints", () => {
  it("reports liveness without touching the database", async () => {
    const { status, body } = await call(server.baseUrl, "GET", "/healthz");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("reports ready when MySQL is reachable", async () => {
    const { status, body } = await call(server.baseUrl, "GET", "/readyz");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ready", database: "ok" });
  });
});
