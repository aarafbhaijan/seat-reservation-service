// One-command on-sale stampede against a running service:
//
//   ./burst.sh <BASE_URL> [--total 20000] [--seats 1000] [--users 5000] [--hot-seats 5]
//                         [--storm 500] [--concurrency 1000] [--limit 4]
//
// It creates a fresh show, then fires everything at once (shuffled):
//   - hot-seat storm:  --storm different users all grab each of the --hot-seats seats
//   - stampede:        random 1-2 seat requests across the rest of the hall
//   - retries:         the same request sent several times with the same idempotency key
//   - key conflicts:   a used key re-sent with different seats (must be 409)
//   - per-user limit:  users firing 10 parallel reserves on a limit-4 show
//   - spoofing:        a body "user_id" (must be ignored) and cancelling someone else's booking
// While it runs, it polls GET /shows/:id to check the invariant DURING the burst.
// Finally it prints the outcome distribution, verifies every rule, and exits 1 on any failure.
//
// Env: ADMIN_API_KEY (default: the local docker-compose key).
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Agent, request } from "undici";

// ---------- configuration ----------

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    total: { type: "string", default: "20000" },
    seats: { type: "string", default: "1000" },
    users: { type: "string", default: "5000" },
    "hot-seats": { type: "string", default: "5" },
    storm: { type: "string", default: "500" },
    concurrency: { type: "string", default: "1000" },
    limit: { type: "string", default: "4" },
  },
});

const BASE_URL = (positionals[0] ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "local-dev-admin-key";
const TOTAL = Number(flags.total);
const SEAT_COUNT = Number(flags.seats);
const USER_COUNT = Number(flags.users);
const HOT_SEAT_COUNT = Number(flags["hot-seats"]);
const STORM_PER_SEAT = Number(flags.storm);
const CONCURRENCY = Number(flags.concurrency);
const PER_USER_LIMIT = Number(flags.limit);

const RETRY_GROUPS = 200; // each: one request sent RETRY_COPIES times with the same key
const RETRY_COPIES = 3;
const CONFLICT_USERS = 50; // each: reuses a consumed key with different seats
const LIMIT_USERS = 20; // each: 10 parallel single-seat reserves
const LIMIT_PARALLEL = 10;
const SPOOF_REQUESTS = 100;

const dispatcher = new Agent({
  connections: CONCURRENCY,
  headersTimeout: 120_000,
  bodyTimeout: 120_000,
});

// The invariant poller gets its own connection so its GETs aren't stuck behind the burst.
const pollerDispatcher = new Agent({ connections: 1 });

// ---------- HTTP ----------

interface Result {
  status: number; // 0 = network error (counts as a failure)
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- arbitrary JSON
  ms: number;
}

async function send(
  method: "GET" | "POST",
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    via?: Agent;
  } = {},
): Promise<Result> {
  const startedAt = performance.now();
  try {
    const response = await request(BASE_URL + path, {
      method,
      dispatcher: options.via ?? dispatcher,
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.body.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body (e.g. a proxy error page) — keep the raw text
    }
    return { status: response.statusCode, body, ms: performance.now() - startedAt };
  } catch (error) {
    return { status: 0, body: { error: String(error) }, ms: performance.now() - startedAt };
  }
}

function outcomeOf(result: Result): string {
  if (result.status === 0) return "network_error";
  if (result.status >= 500) return `${result.status} server_error`;
  if (result.status === 201) return "201 confirmed";
  if (result.status === 200) return "200 idempotent_replay";
  return `${result.status} ${result.body?.error?.code ?? "unknown"}`;
}

// ---------- setup ----------

function seatLabels(count: number): string[] {
  const perRow = 50;
  return Array.from({ length: count }, (_, i) => {
    const row = String.fromCharCode(65 + (Math.floor(i / perRow) % 26));
    const lap = Math.floor(i / (perRow * 26)); // beyond row Z: AA.., BB.. style prefix
    return `${lap ? row.repeat(lap + 1) : row}${(i % perRow) + 1}`;
  });
}

async function mintToken(userId: string, role: "user" | "admin" = "user"): Promise<string> {
  const result = await send("POST", "/auth/token", {
    body: { user_id: userId, role },
    headers: role === "admin" ? { "x-admin-key": ADMIN_API_KEY } : {},
  });
  if (result.status !== 201) {
    throw new Error(
      `could not mint token for ${userId}: ${result.status} ${JSON.stringify(result.body)}`,
    );
  }
  return result.body.token;
}

interface User {
  id: string;
  token: string;
}

async function setup() {
  const ready = await send("GET", "/readyz");
  if (ready.status !== 200)
    throw new Error(`service not ready: ${ready.status} ${JSON.stringify(ready.body)}`);

  const adminToken = await mintToken("burst-admin", "admin");
  const seats = seatLabels(SEAT_COUNT);
  const created = await send("POST", "/shows", {
    token: adminToken,
    body: {
      name: `burst-${new Date().toISOString()}`,
      seats,
      price_paise: 25_000,
      per_user_limit: PER_USER_LIMIT,
    },
  });
  if (created.status !== 201)
    throw new Error(`could not create show: ${created.status} ${JSON.stringify(created.body)}`);

  const runId = randomUUID().slice(0, 8);
  const users: User[] = await Promise.all(
    Array.from({ length: USER_COUNT }, async (_, i) => {
      const id = `burst-${runId}-u${i}`;
      return { id, token: await mintToken(id) };
    }),
  );

  return { showId: created.body.id as string, seats, users };
}

// ---------- the plan: every request we'll fire, built up front ----------

type Kind = "storm" | "stampede" | "retry" | "conflict" | "limit" | "spoof";

interface Planned {
  kind: Kind;
  user: User;
  seats: string[];
  key: string;
  group?: string; // which hot seat / retry group / limit user this belongs to
  extraBody?: Record<string, unknown>;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

function buildPlan(seats: string[], users: User[]) {
  const hotSeats = seats.slice(0, HOT_SEAT_COUNT);
  const limitSeats = seats.slice(HOT_SEAT_COUNT, HOT_SEAT_COUNT + LIMIT_USERS * LIMIT_PARALLEL);
  const openSeats = seats.slice(HOT_SEAT_COUNT + limitSeats.length);
  const plan: Planned[] = [];
  let nextUser = 0;
  const takeUser = () => users[nextUser++ % users.length]!;

  // Hot-seat storm: many different users, same seat.
  for (const seat of hotSeats) {
    for (let i = 0; i < STORM_PER_SEAT; i++) {
      plan.push({ kind: "storm", user: takeUser(), seats: [seat], key: randomUUID(), group: seat });
    }
  }

  // Per-user limit: each limit user fires 10 parallel reserves for its own block of seats.
  for (let u = 0; u < LIMIT_USERS; u++) {
    const user = takeUser();
    for (let i = 0; i < LIMIT_PARALLEL; i++) {
      const seat = limitSeats[u * LIMIT_PARALLEL + i]!;
      plan.push({ kind: "limit", user, seats: [seat], key: randomUUID(), group: user.id });
    }
  }

  // Retries: identical request, identical key, sent several times at once.
  for (let g = 0; g < RETRY_GROUPS; g++) {
    const user = takeUser();
    const seatsForGroup = [pick(openSeats)];
    const key = randomUUID();
    for (let c = 0; c < RETRY_COPIES; c++) {
      plan.push({ kind: "retry", user, seats: seatsForGroup, key, group: `retry-${g}` });
    }
  }

  // Spoofing: try to book "as" someone else via the body.
  for (let i = 0; i < SPOOF_REQUESTS; i++) {
    plan.push({
      kind: "spoof",
      user: takeUser(),
      seats: [pick(openSeats)],
      key: randomUUID(),
      extraBody: { user_id: "victim" },
    });
  }

  // Stampede: fill up to --total with random 1-2 seat requests.
  while (plan.length < TOTAL - CONFLICT_USERS) {
    const first = pick(openSeats);
    const seatsWanted = Math.random() < 0.3 ? [...new Set([first, pick(openSeats)])] : [first];
    plan.push({ kind: "stampede", user: takeUser(), seats: seatsWanted, key: randomUUID() });
  }

  return { plan: shuffle(plan), hotSeats, openSeats };
}

// Key conflicts need a key that is already consumed, so these users book first (before the burst).
async function prepareConflicts(
  showId: string,
  users: User[],
  openSeats: string[],
): Promise<Planned[]> {
  const conflicts: Planned[] = [];
  for (let i = 0; i < CONFLICT_USERS; i++) {
    const user = users[users.length - 1 - i]!;
    const key = randomUUID();
    const first = await send("POST", `/shows/${showId}/reserve`, {
      token: user.token,
      body: { seats: [openSeats[openSeats.length - 1 - i]!], idempotency_key: key },
    });
    if (first.status !== 201) continue; // seat already gone; skip this pair
    conflicts.push({
      kind: "conflict",
      user,
      seats: [openSeats[openSeats.length - 1 - i - CONFLICT_USERS]!],
      key,
    });
  }
  return conflicts;
}

// ---------- run ----------

interface Fired extends Planned {
  result: Result;
}

async function fire(showId: string, plan: Planned[]): Promise<Fired[]> {
  return Promise.all(
    plan.map(async (planned) => ({
      ...planned,
      result: await send("POST", `/shows/${showId}/reserve`, {
        token: planned.user.token,
        body: { seats: planned.seats, idempotency_key: planned.key, ...planned.extraBody },
      }),
    })),
  );
}

// Polls the show while the burst runs; every snapshot must satisfy the invariant.
function startInvariantPoller(showId: string, totalSeats: number) {
  const snapshots: { ok: boolean; counts: unknown }[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const state = await send("GET", `/shows/${showId}`, { via: pollerDispatcher });
      if (state.status === 200) {
        const { available, held, confirmed } = state.body.counts;
        snapshots.push({
          ok: available + held + confirmed === totalSeats,
          counts: state.body.counts,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return snapshots;
    },
  };
}

async function scrapeMetrics(): Promise<Map<string, number>> {
  const result = await send("GET", "/metrics");
  const values = new Map<string, number>();
  if (typeof result.body !== "string") return values;
  for (const line of result.body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const space = line.lastIndexOf(" ");
    values.set(line.slice(0, space), Number(line.slice(space + 1)));
  }
  return values;
}

// ---------- verify & report ----------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function percentile(sorted: number[], p: number): number {
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
    : 0;
}

function verify(
  fired: Fired[],
  hotSeats: string[],
  finalState: Result,
  snapshots: { ok: boolean }[],
  metricsBefore: Map<string, number>,
  metricsAfter: Map<string, number>,
): Check[] {
  const checks: Check[] = [];
  const confirmed = fired.filter((f) => f.result.status === 201);

  const failures = fired.filter((f) => f.result.status === 0 || f.result.status >= 500);
  checks.push({
    name: "zero 5xx / network errors",
    pass: failures.length === 0,
    detail: `${failures.length} failed`,
  });

  // No seat in two different 201 responses = no double-sell.
  const owners = new Map<string, string>();
  const doubleSold: string[] = [];
  for (const f of confirmed) {
    for (const seat of f.result.body.seats as string[]) {
      const previous = owners.get(seat);
      if (previous && previous !== f.result.body.reservation_id) doubleSold.push(seat);
      owners.set(seat, f.result.body.reservation_id);
    }
  }
  checks.push({
    name: "no seat confirmed twice",
    pass: doubleSold.length === 0,
    detail: `${doubleSold.length} double-sold`,
  });

  for (const seat of hotSeats) {
    const storm = fired.filter((f) => f.kind === "storm" && f.group === seat);
    const wins = storm.filter((f) => f.result.status === 201).length;
    const declines = storm.filter((f) => f.result.status === 409).length;
    checks.push({
      name: `hot seat ${seat}: exactly one winner`,
      pass: wins === 1 && wins + declines === storm.length,
      detail: `${wins} × 201, ${declines} × 409 of ${storm.length}`,
    });
  }

  const counts = finalState.body?.counts ?? {};
  const total = finalState.body?.total_seats;
  checks.push({
    name: "reconciliation after burst",
    pass: counts.available + counts.held + counts.confirmed === total,
    detail: `${counts.available} available + ${counts.held} held + ${counts.confirmed} confirmed = ${counts.available + counts.held + counts.confirmed} / ${total}`,
  });
  checks.push({
    name: "confirmed seats == seats in 201 responses (+ conflict pre-bookings)",
    pass: counts.confirmed === owners.size + fired.filter((f) => f.kind === "conflict").length,
    detail: `${counts.confirmed} confirmed in state, ${owners.size} from burst 201s`,
  });
  const badSnapshots = snapshots.filter((s) => !s.ok).length;
  checks.push({
    name: "reconciliation during burst",
    pass: snapshots.length > 0 && badSnapshots === 0,
    detail: `${snapshots.length} snapshots polled, ${badSnapshots} violations`,
  });

  const groups = new Map<string, Fired[]>();
  for (const f of fired.filter((f) => f.kind === "retry"))
    groups.set(f.group!, [...(groups.get(f.group!) ?? []), f]);
  const badGroups = [...groups.values()].filter((copies) => {
    const created = copies.filter((c) => c.result.status === 201).length;
    const ids = new Set(
      copies.filter((c) => c.result.status < 300).map((c) => c.result.body.reservation_id),
    );
    return created > 1 || ids.size > 1;
  });
  checks.push({
    name: "idempotent retries reserve at most once",
    pass: badGroups.length === 0,
    detail: `${groups.size} groups × ${RETRY_COPIES} copies, ${badGroups.length} bad`,
  });

  const conflicts = fired.filter((f) => f.kind === "conflict");
  const goodConflicts = conflicts.filter(
    (f) => f.result.status === 409 && f.result.body?.error?.code === "idempotency_key_conflict",
  );
  checks.push({
    name: "same key + different seats -> 409",
    pass: goodConflicts.length === conflicts.length,
    detail: `${goodConflicts.length}/${conflicts.length}`,
  });

  // Seats each user ended up with, across every kind of request (+ conflict pre-bookings).
  const seatsPerUser = new Map<string, number>();
  for (const f of confirmed) {
    seatsPerUser.set(f.user.id, (seatsPerUser.get(f.user.id) ?? 0) + f.result.body.seats.length);
  }
  for (const f of conflicts) seatsPerUser.set(f.user.id, (seatsPerUser.get(f.user.id) ?? 0) + 1);
  const maxHeld = Math.max(0, ...seatsPerUser.values());
  const limitUserWins = new Map<string, number>();
  for (const f of confirmed.filter((f) => f.kind === "limit")) {
    limitUserWins.set(f.group!, (limitUserWins.get(f.group!) ?? 0) + 1);
  }
  checks.push({
    name: `per-user limit ${PER_USER_LIMIT} (incl. ${LIMIT_USERS} users × ${LIMIT_PARALLEL} parallel)`,
    pass: maxHeld <= PER_USER_LIMIT,
    detail: `max seats held by any user: ${maxHeld}; limit users won ${Math.max(0, ...limitUserWins.values())} max`,
  });

  const spoofs = fired.filter((f) => f.kind === "spoof" && f.result.status === 201);
  const spoofLeaks = spoofs.filter((f) => f.result.body.user_id !== f.user.id);
  checks.push({
    name: "identity comes from the token",
    pass: spoofLeaks.length === 0,
    detail: `${spoofs.length} spoofed bookings, ${spoofLeaks.length} attributed to "victim"`,
  });

  const delta = (series: string) =>
    (metricsAfter.get(series) ?? NaN) - (metricsBefore.get(series) ?? 0);
  const metricConfirmed = delta("reservations_confirmed_total");
  checks.push({
    name: "metrics: confirmed counter matches",
    pass: metricConfirmed === confirmed.length,
    detail: `counter +${metricConfirmed}, API 201s ${confirmed.length} (other traffic would skew this)`,
  });
  const showGauge = metricsAfter.get(`seats_available{show_id="${finalState.body?.id}"}`);
  checks.push({
    name: "metrics: seats_available gauge matches",
    pass: showGauge === counts.available,
    detail: `gauge ${showGauge}, API ${counts.available}`,
  });

  return checks;
}

function printReport(fired: Fired[], checks: Check[], elapsedMs: number) {
  const distribution = new Map<string, number>();
  for (const f of fired)
    distribution.set(outcomeOf(f.result), (distribution.get(outcomeOf(f.result)) ?? 0) + 1);

  console.log(
    `\nOutcome distribution (${fired.length} reserve requests in ${(elapsedMs / 1000).toFixed(1)}s, ${Math.round(fired.length / (elapsedMs / 1000))} req/s)`,
  );
  for (const [outcome, count] of [...distribution].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome.padEnd(32)} ${String(count).padStart(7)}`);
  }

  const latencies = fired.map((f) => f.result.ms).sort((a, b) => a - b);
  console.log(
    `\nLatency  p50 ${percentile(latencies, 50).toFixed(0)}ms  p95 ${percentile(latencies, 95).toFixed(0)}ms  p99 ${percentile(latencies, 99).toFixed(0)}ms  max ${percentile(latencies, 100).toFixed(0)}ms`,
  );

  console.log("\nChecks");
  for (const check of checks) {
    console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name.padEnd(62)} ${check.detail}`);
  }
}

async function main() {
  console.log(
    `Burst against ${BASE_URL}: ${TOTAL} reserves, ${SEAT_COUNT} seats, ${USER_COUNT} users, ` +
      `${HOT_SEAT_COUNT} hot seats × ${STORM_PER_SEAT}, concurrency ${CONCURRENCY}`,
  );

  const { showId, seats, users } = await setup();
  console.log(`show ${showId} created, ${users.length} tokens minted`);

  const { plan, hotSeats, openSeats } = buildPlan(seats, users);
  const conflicts = await prepareConflicts(showId, users, openSeats);
  const fullPlan = shuffle([...plan, ...conflicts]);

  const metricsBefore = await scrapeMetrics();
  const poller = startInvariantPoller(showId, seats.length);
  const startedAt = performance.now();
  const fired = await fire(showId, fullPlan);
  const elapsedMs = performance.now() - startedAt;
  const snapshots = await poller.stop();

  const finalState = await send("GET", `/shows/${showId}`);
  const metricsAfter = await scrapeMetrics();
  const checks = verify(fired, hotSeats, finalState, snapshots, metricsBefore, metricsAfter);
  printReport(fired, checks, elapsedMs);

  const failed = checks.filter((check) => !check.pass).length;
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
  await Promise.all([dispatcher.close(), pollerDispatcher.close()]);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
