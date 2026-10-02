# Seat Reservation Service

A JSON API that sells assigned seats for a show and stays correct under an on-sale stampede:
**no seat is ever sold twice, no user exceeds their limit, and a retried request never books twice.**
Built with Node 22 + TypeScript + Express 5 + MySQL 8.

| | |
|---|---|
| **Live URL** | **https://16-178-3-167.sslip.io** (AWS EC2 t3.small, ap-southeast-2) |
| **Metrics** | https://16-178-3-167.sslip.io/metrics |
| **Health** | [/healthz](https://16-178-3-167.sslip.io/healthz) (liveness) · [/readyz](https://16-178-3-167.sslip.io/readyz) (readiness, checks MySQL) |
| **Design write-up** | [WRITEUP.md](WRITEUP.md) |
| **Docs** | [PRD](docs/prd.md) · [Architecture](docs/architecture.md) · [Design](docs/design.md) · [Rules](docs/rules.md) |

## Run it locally (one command)

Requirements: Docker with the Compose plugin.

```bash
git clone https://github.com/aarafbhaijan/seat-reservation-service.git
cd seat-reservation-service
docker compose up -d --build
curl localhost:3000/readyz        # {"status":"ready","database":"ok"}
```

That's the same image and compose file used in production (production adds Caddy for HTTPS, see below).
Every setting has a safe local default; copy `.env.example` to `.env` to change them.

## Run the burst (one command)

```bash
./burst.sh http://localhost:3000
# against the live service (the admin key, shared privately, is needed to create the test show):
ADMIN_API_KEY=<key> ./burst.sh https://16-178-3-167.sslip.io
```

Needs Node 22+ (it runs `npm ci` the first time). It creates a fresh 1,000-seat show (limit 4 per user), mints
5,000 user tokens, then fires **20,000 reserve requests at once**, shuffled together:

- **hot-seat storm:** 500 different users each grab each of 5 hot seats
- **stampede:** random 1–2 seat requests across the hall
- **idempotent retries:** 200 requests each sent 3× with the same key
- **key conflicts:** 50 already-used keys re-sent with different seats
- **per-user limit:** 20 users each firing 10 parallel reserves
- **spoofing:** a `user_id` in the body (must be ignored)

While the burst runs it polls `GET /shows/:id` and checks the invariant on every snapshot. At the end it prints
the outcome distribution, latency, and a PASS/FAIL list, and exits `1` if anything failed:

```
Outcome distribution (20000 reserve requests in 11.4s, 1750 req/s)
  409 seat_taken                     19051
  201 confirmed                        734
  409 per_user_limit                   125
  409 idempotency_key_conflict          50
  200 idempotent_replay                 40

Checks
  PASS  zero 5xx / network errors                                      0 failed
  PASS  no seat confirmed twice                                        0 double-sold
  PASS  hot seat A1: exactly one winner                                1 × 201, 499 × 409 of 500
  ...
  PASS  reconciliation after burst                                     125 available + 0 held + 875 confirmed = 1000 / 1000
  PASS  reconciliation during burst                                    24 snapshots polled, 0 violations
  PASS  idempotent retries reserve at most once                        200 groups × 3 copies, 0 bad
  PASS  same key + different seats -> 409                              50/50
  PASS  per-user limit 4 (incl. 20 users × 10 parallel)                max seats held by any user: 4
  PASS  identity comes from the token                                  0 attributed to "victim"
  PASS  metrics: confirmed counter matches                             counter +734, API 201s 734
  PASS  metrics: seats_available gauge matches                         gauge 125, API 125
```

Flags: `--total 20000 --seats 1000 --users 5000 --hot-seats 5 --storm 500 --concurrency 1000 --limit 4`.

**Live results (EC2 t3.small, 2 vCPU):** the default 20k burst passes every check, run both from India and from the
instance itself: zero 5xx, one winner per hot seat, invariant held in every snapshot. Throughput is ~500–570 req/s,
CPU-bound on the small instance (app ~85% of a core, Caddy TLS ~40%, MySQL ~35%). Server-side time per declined
request is ~8 ms; most of the client-side latency is queueing behind that throughput plus ~320 ms India↔Sydney RTT.
After a full EC2 reboot the service is ready again in ~35 s with data intact.

## API

All money is integer **paise**. Identity always comes from the `Authorization: Bearer <JWT>` token, never from the body.
Every error has the same shape: `{ "error": { "code": "...", "message": "...", "request_id": "..." } }`.

| Method | Path | Who | What |
|---|---|---|---|
| `POST` | `/auth/token` | anyone | `{ "user_id": "u1" }` → user token. Admin token: add `"role": "admin"` + header `X-Admin-Key`. (A test stand-in for a real identity provider.) |
| `POST` | `/shows` | admin | `{ "name", "seats": ["A1",...], "price_paise", "per_user_limit"? }` → show with every seat `available` |
| `GET` | `/shows/:id` | anyone | per-seat status + `counts` (`available + held + confirmed == total_seats`) |
| `POST` | `/shows/:id/reserve` | user | `{ "seats": ["A12"], "idempotency_key": "…" }` (or `Idempotency-Key` header) |
| `POST` | `/reservations/:id/cancel` | owner | releases the seats; anyone else gets 404 |
| `GET` | `/reservations/:id` | owner | the reservation; anyone else gets 404 |
| `GET` | `/healthz` · `/readyz` · `/metrics` | anyone | liveness · readiness (503 if MySQL is down) · Prometheus |

**Reserve outcomes:**

| Status | When |
|---|---|
| `201` | Reserved (new). |
| `200` + `Idempotent-Replayed: true` | Same key and same seats as an earlier success: the original reservation, nothing moves. |
| `409 seat_taken` | Any requested seat isn't available. **All-or-nothing**: nothing is reserved. |
| `409 per_user_limit` | This would take the user over the show's limit. |
| `409 idempotency_key_conflict` | The key was already used with different seats. |
| `422 unknown_seat` · `404` · `400` · `401` | Bad label · no such show · invalid body/missing key · bad token. |

Walkthrough:

```bash
B=http://localhost:3000
ADMIN=$(curl -s -XPOST $B/auth/token -H 'content-type: application/json' -H 'x-admin-key: local-dev-admin-key' \
  -d '{"user_id":"boss","role":"admin"}' | jq -r .token)
USER=$(curl -s -XPOST $B/auth/token -H 'content-type: application/json' -d '{"user_id":"alice"}' | jq -r .token)

SHOW=$(curl -s -XPOST $B/shows -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"friday-night","seats":["A1","A2","A3"],"price_paise":25000}' | jq -r .id)

curl -s -XPOST $B/shows/$SHOW/reserve -H "authorization: Bearer $USER" -H 'content-type: application/json' \
  -H 'Idempotency-Key: k1' -d '{"seats":["A1"]}'
# {"reservation_id":"…","show_id":"…","user_id":"alice","seats":["A1"],"amount_paise":25000,"status":"confirmed"}

curl -s $B/shows/$SHOW | jq .counts     # {"available":2,"held":0,"confirmed":1}
```

## How correctness works (short version)

Full reasoning is in [WRITEUP.md](WRITEUP.md) and [docs/design.md](docs/design.md).

- **No double-sell.** One `UPDATE seats SET status='confirmed' … WHERE label IN (…) AND status='available'`, and success only if
  `affectedRows` equals the number of seats requested. The check and the write are one statement under InnoDB row locks,
  so for any seat exactly one transaction can flip it. Otherwise everything rolls back.
- **Per-user limit.** A conditional `UPDATE user_quota SET seats_held = seats_held + n WHERE … AND seats_held + n <= limit`
  on one row per (show, user). That row serialises a user's parallel requests.
- **Idempotency.** `UNIQUE (user_id, idempotency_key)` on `reservations`. A concurrent duplicate waits on the first INSERT's
  key lock, then gets a duplicate-key error and replays.
- **No deadlocks.** Every write transaction locks in the same order: idempotency key → quota row → seats (primary-key order).
  Bounded retry on MySQL 1213/1205 is a safety net.
- **Fast path.** In a stampede most requests lose, so plain reads decline them early (seat already taken, over limit)
  without opening a transaction. Reads only ever *decline*; granting is always the atomic UPDATE.

## Observability

- **Metrics** (`/metrics`): `reservations_confirmed_total`, `reservations_declined_total{reason}` (`seat_taken`,
  `per_user_limit`, `idempotent_replay`, `idempotency_key_conflict`, …), `reservations_failed_total` (5xx, should be 0),
  `reservations_cancelled_total`, `seats{show_id,status}` and `seats_available{show_id}` (read from the DB at scrape time,
  so they always match the API), `http_request_duration_seconds`, `db_pool_connections{state}`,
  `db_transaction_retries_total`, and Node process metrics.
- **Logs:** one JSON line per request (pino) with `req_id` (from `X-Request-Id` or generated, echoed back in the
  response header), method, URL, status and latency. Errors log the stack; tokens and keys are redacted.
  - Locally: `docker compose logs -f app`
  - On the server: `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f app`

## Tests

```bash
docker compose up -d mysql
npm ci
npm test              # 37 integration + concurrency tests against real MySQL
npm run lint && npm run typecheck
```

They include 200 concurrent buyers on one seat (exactly one wins), opposite-order seat pairs (no deadlock, no split pair),
10 parallel reserves by one user (exactly the limit), 20 simultaneous copies of one request (one reservation), and racing
reserves and cancels. Every write test checks the invariants directly in the database afterwards.

## Deploy (AWS EC2)

Production is the same compose file plus `docker-compose.prod.yml`, which adds **Caddy** for automatic HTTPS on an
`<ip>.sslip.io` hostname (no domain needed) and stops exposing the app port directly.

1. Launch **Ubuntu 24.04+** (the live box runs 26.04), **t3.small**. The live deployment is in `ap-southeast-2` (the
   free-plan account's region). Attach an **Elastic IP**. Security group: 80 and 443 open to everyone, 22 only from
   your IP + the EC2 Instance Connect range. (MySQL's 3306 and the app's 3000 are never exposed.)
2. SSH in and run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/aarafbhaijan/seat-reservation-service/main/deploy/ec2-setup.sh | bash
   ```
   This installs Docker, tunes kernel connection limits, clones the repo, generates secrets into `.env`, and starts
   the stack. `restart: always` brings everything back after a reboot (the app waits for MySQL and runs migrations on boot).
3. Check `https://<ip-with-dashes>.sslip.io/readyz`.

## Project layout

```
src/
  server.ts            boot (wait for DB, migrate, listen) + graceful shutdown
  app.ts               middleware order and routes
  routes/              HTTP only: validate -> call service -> respond
  services/
    reserve.ts         the reserve flow (fast path + atomic transaction)  <- start here
    cancel.ts          owner-only cancel
    shows.ts           create show / show state
    reservations.ts    Reservation type and lookups
  db.ts                pool, withTransaction (+ deadlock retry), probe pool
  auth.ts errors.ts logger.ts metrics.ts metrics-db.ts config.ts constants.ts
migrations/            plain SQL, applied in order at boot
scripts/burst.ts       the burst (wrapped by ./burst.sh)
test/                  vitest, real MySQL
deploy/                Caddyfile, EC2 setup script
```
