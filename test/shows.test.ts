import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools } from "../src/db.js";
import {
  adminToken,
  call,
  createTestShow,
  expectInvariantsHold,
  startServer,
  tokenFor,
  uniqueUserId,
  type TestServer,
} from "./helpers.js";

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
  await closePools();
});

describe("POST /shows", () => {
  it("creates a show with every seat available", async () => {
    const { id } = await createTestShow(server.baseUrl, { seats: ["A1", "A2", "A10"] });

    const { status, body } = await call(server.baseUrl, "GET", `/shows/${id}`);

    expect(status).toBe(200);
    expect(body.total_seats).toBe(3);
    expect(body.counts).toEqual({ available: 3, held: 0, confirmed: 0 });
    expect(body.seats.map((seat: { label: string }) => seat.label)).toEqual(["A1", "A2", "A10"]);
    await expectInvariantsHold(id);
  });

  it("rejects non-admin users", async () => {
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    const { status, body } = await call(server.baseUrl, "POST", "/shows", { token, body: {} });
    expect(status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects float prices and duplicate seat labels", async () => {
    const { status, body } = await call(server.baseUrl, "POST", "/shows", {
      token: await adminToken(server.baseUrl),
      body: { name: "bad", seats: ["A1", "A1"], price_paise: 99.5 },
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
  });
});

describe("GET /shows/:id", () => {
  it("returns 404 for an unknown show", async () => {
    const { status } = await call(server.baseUrl, "GET", "/shows/does-not-exist");
    expect(status).toBe(404);
  });
});
