import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db.js";
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
  await pool.end();
});

async function newBuyers(count: number): Promise<{ userId: string; token: string }[]> {
  return Promise.all(
    Array.from({ length: count }, async () => {
      const userId = uniqueUserId("buyer");
      return { userId, token: await tokenFor(server.baseUrl, userId) };
    }),
  );
}

describe("POST /shows/:id/reserve", () => {
  it("confirms a free seat for the token's user", async () => {
    const show = await createTestShow(server.baseUrl, { pricePaise: 25_000 });
    const [buyer] = await newBuyers(1);

    const { status, body } = await reserve(server.baseUrl, buyer!.token, show.id, ["S2", "S1"]);

    expect(status).toBe(201);
    expect(body).toMatchObject({
      show_id: show.id,
      user_id: buyer!.userId,
      seats: ["S1", "S2"],
      amount_paise: 50_000,
      status: "confirmed",
    });
    const state = await call(server.baseUrl, "GET", `/shows/${show.id}`);
    expect(state.body.counts).toEqual({ available: 18, held: 0, confirmed: 2 });
    await expectInvariantsHold(show.id);
  });

  it("ignores a spoofed user_id in the body", async () => {
    const show = await createTestShow(server.baseUrl);
    const [buyer] = await newBuyers(1);

    const { body } = await reserve(server.baseUrl, buyer!.token, show.id, ["S1"], undefined, {
      user_id: "victim",
    });

    expect(body.user_id).toBe(buyer!.userId);
  });

  it("gives a hot seat to exactly one of 200 concurrent buyers", async () => {
    const show = await createTestShow(server.baseUrl);
    const buyers = await newBuyers(200);

    const responses = await Promise.all(
      buyers.map((buyer) => reserve(server.baseUrl, buyer.token, show.id, ["S7"])),
    );

    expect(outcomes(responses)).toEqual({ "201": 1, "409:seat_taken": 199 });
    await expectInvariantsHold(show.id);
  });

  it("is all-or-nothing: no seat is taken if any requested seat is unavailable", async () => {
    const show = await createTestShow(server.baseUrl);
    const [first, second] = await newBuyers(2);
    await reserve(server.baseUrl, first!.token, show.id, ["S2"]);

    const { status, body } = await reserve(server.baseUrl, second!.token, show.id, ["S1", "S2"]);

    expect(status).toBe(409);
    expect(body.error.code).toBe("seat_taken");
    const state = await call(server.baseUrl, "GET", `/shows/${show.id}`);
    expect(state.body.seats.find((seat: { label: string }) => seat.label === "S1").status).toBe(
      "available",
    );
    await expectInvariantsHold(show.id);
  });

  it("never deadlocks or splits a pair when buyers request the same seats in opposite orders", async () => {
    const show = await createTestShow(server.baseUrl);
    const buyers = await newBuyers(100);

    const responses = await Promise.all(
      buyers.map((buyer, i) =>
        reserve(server.baseUrl, buyer.token, show.id, i % 2 === 0 ? ["S3", "S4"] : ["S4", "S3"]),
      ),
    );

    expect(outcomes(responses)).toEqual({ "201": 1, "409:seat_taken": 99 });
    await expectInvariantsHold(show.id);
  });

  it("returns 422 for a seat that does not exist", async () => {
    const show = await createTestShow(server.baseUrl);
    const [buyer] = await newBuyers(1);

    const { status, body } = await reserve(server.baseUrl, buyer!.token, show.id, ["S1", "Z99"]);

    expect(status).toBe(422);
    expect(body.error.unknown_seats).toEqual(["Z99"]);
    await expectInvariantsHold(show.id);
  });

  it("requires an idempotency key", async () => {
    const show = await createTestShow(server.baseUrl);
    const [buyer] = await newBuyers(1);

    const { status } = await call(server.baseUrl, "POST", `/shows/${show.id}/reserve`, {
      token: buyer!.token,
      body: { seats: ["S1"] },
    });

    expect(status).toBe(400);
  });

  it("requires a token", async () => {
    const show = await createTestShow(server.baseUrl);
    const { status } = await reserve(server.baseUrl, "not-a-token", show.id, ["S1"]);
    expect(status).toBe(401);
  });
});
