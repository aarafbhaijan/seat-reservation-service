import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, pool } from "../src/db.js";
import {
  call,
  createTestShow,
  expectInvariantsHold,
  outcomes,
  reserve,
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

describe("idempotency", () => {
  it("returns the original reservation on a retry with the same key", async () => {
    const show = await createTestShow(server.baseUrl);
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    const key = ulid();

    const first = await reserve(server.baseUrl, token, show.id, ["S1"], key);
    const retry = await reserve(server.baseUrl, token, show.id, ["S1"], key);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.body).toEqual(first.body);
  });

  it("reserves exactly once when 20 copies of the same request arrive at once", async () => {
    const show = await createTestShow(server.baseUrl);
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    const key = ulid();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => reserve(server.baseUrl, token, show.id, ["S1", "S2"], key)),
    );

    expect(outcomes(responses)).toEqual({ "201": 1, "200": 19 });
    const ids = new Set(responses.map((response) => response.body.reservation_id));
    expect(ids.size).toBe(1);
    const [[{ n }]] = (await pool.query(
      "SELECT COUNT(*) AS n FROM reservations WHERE show_id = ?",
      [show.id],
    )) as unknown as [[{ n: number }]];
    expect(n).toBe(1);
    await expectInvariantsHold(show.id);
  });

  it("rejects the same key with different seats (409) and moves nothing", async () => {
    const show = await createTestShow(server.baseUrl);
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    const key = ulid();
    await reserve(server.baseUrl, token, show.id, ["S1"], key);

    const { status, body } = await reserve(server.baseUrl, token, show.id, ["S2"], key);

    expect(status).toBe(409);
    expect(body.error.code).toBe("idempotency_key_conflict");
    const state = await call(server.baseUrl, "GET", `/shows/${show.id}`);
    expect(state.body.counts.confirmed).toBe(1);
    await expectInvariantsHold(show.id);
  });

  it("treats seat order as the same request", async () => {
    const show = await createTestShow(server.baseUrl);
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    const key = ulid();

    await reserve(server.baseUrl, token, show.id, ["S1", "S2"], key);
    const retry = await reserve(server.baseUrl, token, show.id, ["S2", "S1"], key);

    expect(retry.status).toBe(200);
  });

  it("accepts the key from the Idempotency-Key header", async () => {
    const show = await createTestShow(server.baseUrl);
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    const key = ulid();
    const send = () =>
      call(server.baseUrl, "POST", `/shows/${show.id}/reserve`, {
        token,
        headers: { "idempotency-key": key },
        body: { seats: ["S1"] },
      });

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(200);
  });

  it("does not consume the key when the request is declined", async () => {
    const show = await createTestShow(server.baseUrl);
    const rival = await tokenFor(server.baseUrl, uniqueUserId());
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    const key = ulid();
    await reserve(server.baseUrl, rival, show.id, ["S1"]);

    expect((await reserve(server.baseUrl, token, show.id, ["S1"], key)).status).toBe(409);
    expect((await reserve(server.baseUrl, token, show.id, ["S1"], key)).status).toBe(409);
  });

  it("scopes keys per user: two users may use the same key", async () => {
    const show = await createTestShow(server.baseUrl);
    const key = ulid();
    const alice = await tokenFor(server.baseUrl, uniqueUserId("alice"));
    const bob = await tokenFor(server.baseUrl, uniqueUserId("bob"));

    expect((await reserve(server.baseUrl, alice, show.id, ["S1"], key)).status).toBe(201);
    expect((await reserve(server.baseUrl, bob, show.id, ["S2"], key)).status).toBe(201);
  });
});
