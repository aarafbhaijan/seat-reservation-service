import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db.js";
import {
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

describe("per-user limit", () => {
  it("lets one user firing 10 parallel reserves on a limit-4 show get exactly 4 seats", async () => {
    const show = await createTestShow(server.baseUrl, { perUserLimit: 4 });
    const token = await tokenFor(server.baseUrl, uniqueUserId());

    const responses = await Promise.all(
      show.seats.slice(0, 10).map((seat) => reserve(server.baseUrl, token, show.id, [seat])),
    );

    expect(outcomes(responses)).toEqual({ "201": 4, "409:per_user_limit": 6 });
    await expectInvariantsHold(show.id);
  });

  it("counts seats already held: 3 held + 2 requested on a limit-4 show is declined", async () => {
    const show = await createTestShow(server.baseUrl, { perUserLimit: 4 });
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    expect((await reserve(server.baseUrl, token, show.id, ["S1", "S2", "S3"])).status).toBe(201);

    const { status, body } = await reserve(server.baseUrl, token, show.id, ["S4", "S5"]);

    expect(status).toBe(409);
    expect(body.error.code).toBe("per_user_limit");
    expect((await reserve(server.baseUrl, token, show.id, ["S4"])).status).toBe(201);
    await expectInvariantsHold(show.id);
  });

  it("declines a single request for more seats than the limit", async () => {
    const show = await createTestShow(server.baseUrl, { perUserLimit: 2 });
    const token = await tokenFor(server.baseUrl, uniqueUserId());

    const { status, body } = await reserve(server.baseUrl, token, show.id, ["S1", "S2", "S3"]);

    expect(status).toBe(409);
    expect(body.error.code).toBe("per_user_limit");
  });

  it("gives back the quota when the seat step fails", async () => {
    const show = await createTestShow(server.baseUrl, { perUserLimit: 2 });
    const rival = await tokenFor(server.baseUrl, uniqueUserId());
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    await reserve(server.baseUrl, rival, show.id, ["S1"]);

    expect((await reserve(server.baseUrl, token, show.id, ["S1", "S2"])).status).toBe(409);

    expect((await reserve(server.baseUrl, token, show.id, ["S2", "S3"])).status).toBe(201);
    await expectInvariantsHold(show.id);
  });
});
