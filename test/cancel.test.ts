import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools } from "../src/db.js";
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

const cancel = (token: string, reservationId: string) =>
  call(server.baseUrl, "POST", `/reservations/${reservationId}/cancel`, { token });

async function seatStatus(showId: string, label: string): Promise<string> {
  const { body } = await call(server.baseUrl, "GET", `/shows/${showId}`);
  return body.seats.find((seat: { label: string }) => seat.label === label).status;
}

describe("POST /reservations/:id/cancel", () => {
  it("releases the seats so someone else can book them", async () => {
    const show = await createTestShow(server.baseUrl);
    const owner = await tokenFor(server.baseUrl, uniqueUserId());
    const other = await tokenFor(server.baseUrl, uniqueUserId());
    const { body: booked } = await reserve(server.baseUrl, owner, show.id, ["S1", "S2"]);

    const { status, body } = await cancel(owner, booked.reservation_id);

    expect(status).toBe(200);
    expect(body.status).toBe("cancelled");
    expect(await seatStatus(show.id, "S1")).toBe("available");
    expect((await reserve(server.baseUrl, other, show.id, ["S1"])).status).toBe(201);
    await expectInvariantsHold(show.id);
  });

  it("gives the quota back to the owner", async () => {
    const show = await createTestShow(server.baseUrl, { perUserLimit: 2 });
    const owner = await tokenFor(server.baseUrl, uniqueUserId());
    const { body: booked } = await reserve(server.baseUrl, owner, show.id, ["S1", "S2"]);
    expect((await reserve(server.baseUrl, owner, show.id, ["S3"])).status).toBe(409);

    await cancel(owner, booked.reservation_id);

    expect((await reserve(server.baseUrl, owner, show.id, ["S3", "S4"])).status).toBe(201);
    await expectInvariantsHold(show.id);
  });

  it("only lets the owner cancel (anyone else gets 404)", async () => {
    const show = await createTestShow(server.baseUrl);
    const owner = await tokenFor(server.baseUrl, uniqueUserId());
    const attacker = await tokenFor(server.baseUrl, uniqueUserId());
    const { body: booked } = await reserve(server.baseUrl, owner, show.id, ["S1"]);

    const { status } = await cancel(attacker, booked.reservation_id);

    expect(status).toBe(404);
    expect(await seatStatus(show.id, "S1")).toBe("confirmed");
  });

  it("never frees a seat that was re-sold to someone else", async () => {
    const show = await createTestShow(server.baseUrl);
    const first = await tokenFor(server.baseUrl, uniqueUserId());
    const second = await tokenFor(server.baseUrl, uniqueUserId());
    const { body: original } = await reserve(server.baseUrl, first, show.id, ["S1"]);
    await cancel(first, original.reservation_id);
    expect((await reserve(server.baseUrl, second, show.id, ["S1"])).status).toBe(201);

    const again = await cancel(first, original.reservation_id);

    expect(again.status).toBe(200);
    expect(await seatStatus(show.id, "S1")).toBe("confirmed");
    await expectInvariantsHold(show.id);
  });

  it("is safe when 20 cancels of the same reservation arrive at once", async () => {
    const show = await createTestShow(server.baseUrl);
    const owner = await tokenFor(server.baseUrl, uniqueUserId());
    const { body: booked } = await reserve(server.baseUrl, owner, show.id, ["S1", "S2"]);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => cancel(owner, booked.reservation_id)),
    );

    expect(outcomes(responses)).toEqual({ "200": 20 });
    await expectInvariantsHold(show.id);
  });

  it("keeps the invariant while reserves and cancels race on the same seats", async () => {
    const show = await createTestShow(server.baseUrl, { seats: ["H1", "H2", "H3"] });
    const buyers = await Promise.all(
      Array.from({ length: 30 }, () => tokenFor(server.baseUrl, uniqueUserId())),
    );

    // Every buyer tries to book a hot seat and immediately cancels whatever they got.
    const results = await Promise.all(
      buyers.map(async (token, i) => {
        const booking = await reserve(server.baseUrl, token, show.id, [`H${(i % 3) + 1}`], ulid());
        if (booking.status === 201) await cancel(token, booking.body.reservation_id);
        return booking;
      }),
    );

    expect(results.every((response) => response.status === 201 || response.status === 409)).toBe(
      true,
    );
    await expectInvariantsHold(show.id);
  });
});

describe("GET /reservations/:id", () => {
  it("shows the owner their reservation and hides it from everyone else", async () => {
    const show = await createTestShow(server.baseUrl);
    const owner = await tokenFor(server.baseUrl, uniqueUserId());
    const other = await tokenFor(server.baseUrl, uniqueUserId());
    const { body: booked } = await reserve(server.baseUrl, owner, show.id, ["S1"]);
    const path = `/reservations/${booked.reservation_id}`;

    expect((await call(server.baseUrl, "GET", path, { token: owner })).body).toEqual(booked);
    expect((await call(server.baseUrl, "GET", path, { token: other })).status).toBe(404);
  });
});
