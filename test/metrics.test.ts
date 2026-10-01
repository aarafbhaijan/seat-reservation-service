import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools } from "../src/db.js";
import {
  createTestShow,
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

async function scrape(): Promise<string> {
  return (await fetch(`${server.baseUrl}/metrics`)).text();
}

function metricValue(text: string, series: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : NaN;
}

describe("GET /metrics", () => {
  it("counts confirmations and declines by reason", async () => {
    const show = await createTestShow(server.baseUrl, { perUserLimit: 1 });
    const alice = await tokenFor(server.baseUrl, uniqueUserId());
    const bob = await tokenFor(server.baseUrl, uniqueUserId());
    const before = await scrape();

    await reserve(server.baseUrl, alice, show.id, ["S1"], "alice-key");
    await reserve(server.baseUrl, alice, show.id, ["S1"], "alice-key"); // replay
    await reserve(server.baseUrl, bob, show.id, ["S1"]); // seat taken
    await reserve(server.baseUrl, alice, show.id, ["S2"]); // over limit
    const after = await scrape();

    const delta = (series: string) => metricValue(after, series) - metricValue(before, series);
    expect(delta("reservations_confirmed_total")).toBe(1);
    expect(delta('reservations_declined_total{reason="idempotent_replay"}')).toBe(1);
    expect(delta('reservations_declined_total{reason="seat_taken"}')).toBe(1);
    expect(delta('reservations_declined_total{reason="per_user_limit"}')).toBe(1);
  });

  it("reports seat gauges that match the show state", async () => {
    const show = await createTestShow(server.baseUrl, { seats: ["A1", "A2", "A3"] });
    const token = await tokenFor(server.baseUrl, uniqueUserId());
    await reserve(server.baseUrl, token, show.id, ["A1"]);

    const text = await scrape();

    expect(metricValue(text, `seats_available{show_id="${show.id}"}`)).toBe(2);
    expect(metricValue(text, `seats{show_id="${show.id}",status="confirmed"}`)).toBe(1);
    expect(metricValue(text, `seats{show_id="${show.id}",status="held"}`)).toBe(0);
  });
});
