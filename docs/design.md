# Design — Seat Reservation at Scale

> Low-level design: schema, the exact SQL, lock ordering, API contracts, metrics, logs, burst script.
> Read [architecture.md](architecture.md) first.

## 1. Project layout

```
src/
  server.ts            boot: config → pool → migrations → listen; graceful shutdown
  app.ts               express app, middleware order, routes, error handler
  config.ts            env parsing (zod)
  db.ts                mysql2 pool, withTransaction(fn) + retry on 1213/1205
  migrate.ts           runs migrations/*.sql in order, tracked in schema_migrations
  auth.ts              JWT sign/verify (jose), requireUser / requireAdmin middleware
  errors.ts            DomainError(code, http) + error middleware → JSON envelope
  metrics.ts           prom-client registry, counters, gauges, histograms
  logger.ts            pino instance; request-id middleware
  routes/
    auth.ts            POST /auth/token
    shows.ts           POST /shows, GET /shows/:id
    reservations.ts    POST /shows/:id/reserve, POST /reservations/:id/cancel, GET /reservations/:id
    health.ts          /healthz, /readyz, /metrics
  services/
    reserve.ts         reserve transaction (the core)
    cancel.ts          cancel transaction
migrations/
  001_init.sql
scripts/
  burst.ts             stampede + hot-seat storm + reconciliation
burst.sh               ./burst.sh <BASE_URL>
test/                  vitest integration + concurrency tests
Dockerfile, docker-compose.yml, Caddyfile, .env.example
```

## 2. Schema (MySQL 8, InnoDB, utf8mb4)

```sql
CREATE TABLE shows (
  id              CHAR(26)     NOT NULL,          -- ULID
  name            VARCHAR(200) NOT NULL,
  price_paise     BIGINT       NOT NULL,          -- integer minor units, CHECK > 0
  per_user_limit  INT          NOT NULL DEFAULT 4,
  total_seats     INT          NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_price CHECK (price_paise > 0),
  CONSTRAINT chk_limit CHECK (per_user_limit > 0)
);

CREATE TABLE seats (
  show_id         CHAR(26)     NOT NULL,
  label           VARCHAR(16)  NOT NULL,
  status          ENUM('available','held','confirmed') NOT NULL DEFAULT 'available',
  reservation_id  CHAR(26)     NULL,
  user_id         VARCHAR(64)  NULL,
  hold_expires_at DATETIME(3)  NULL,              -- unused in v1 (confirm-immediately model)
  PRIMARY KEY (show_id, label),
  KEY idx_seats_reservation (reservation_id),
  KEY idx_seats_status (show_id, status)
);

CREATE TABLE reservations (
  id               CHAR(26)     NOT NULL,
  show_id          CHAR(26)     NOT NULL,
  user_id          VARCHAR(64)  NOT NULL,
  seats            JSON         NOT NULL,         -- sorted labels
  amount_paise     BIGINT       NOT NULL,
  status           ENUM('confirmed','cancelled') NOT NULL,
  idempotency_key  VARCHAR(128) NOT NULL,
  request_hash     CHAR(64)     NOT NULL,         -- sha256 of canonical request
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at     DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_idem (user_id, idempotency_key)
);

CREATE TABLE user_quota (
  show_id     CHAR(26)    NOT NULL,
  user_id     VARCHAR(64) NOT NULL,
  seats_held  INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (show_id, user_id),
  CONSTRAINT chk_quota CHECK (seats_held >= 0)
);
```

Notes:
- **Seat row = unit of ownership.** No separate "holds" table, so there is no second place that could disagree.
- Idempotency keys are scoped **per user** (`user_id, key`). Two users can pick the same key without colliding.
- IDs are ULIDs generated in the app (sortable, no DB round-trip).

## 3. Session settings

- Pool: `connectionLimit: 20`, `waitForConnections: true`, `queueLimit: 0`, `enableKeepAlive: true`.
- Every connection: `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`, `SET SESSION innodb_lock_wait_timeout = 5`.
- **Always put the guard in the `WHERE` clause.** mysql2 reports *matched* rows (`CLIENT_FOUND_ROWS`), so
  `affectedRows` is only meaningful when non-qualifying rows are filtered by `WHERE`, not by `SET` expressions.

## 4. Reserve: the core transaction

Input: `showId`, `userId` (from the JWT), `seats[]`, `idempotencyKey`.

**Pre-transaction (no DB):**
1. Validate: 1 ≤ `seats.length` ≤ 10, labels match `^[A-Za-z0-9-]{1,16}$`, no duplicates, key 1–128 chars.
2. `sorted = seats.sort()`.
3. `requestHash = sha256(JSON.stringify({ show_id, seats: sorted }))`.
4. Load the show (`price_paise`, `per_user_limit`). `404` if missing. (Immutable, so safe to read outside the tx.)
5. `sorted.length > per_user_limit` → `409 per_user_limit` (fast decline, no tx).

6. `INSERT IGNORE INTO user_quota (show_id, user_id, 0)` as its **own auto-committed statement**.
   Found by the concurrency test: when 10 parallel transactions INSERT the same *new* quota row, InnoDB's
   shared locks on the duplicate key deadlock them (→ 500). Creating the row up front means the transaction
   only ever UPDATEs an existing row, which just queues.

**Fast path (plain reads, no transaction, no locks; can only decline).** In a stampede ~95% of requests lose,
so we detect that cheaply instead of opening a transaction and queueing on row locks:
- a. `SELECT label, status FROM seats WHERE show_id = ? AND label IN (…)`: a missing label → `422 unknown_seat`.
- b. `SELECT … FROM reservations WHERE user_id = ? AND idempotency_key = ?`: found → replay or `409` conflict.
  This is checked **before** declining a taken seat, because a retry of a successful request sees its own seat as taken.
- c. Any seat not `available` → `409 seat_taken`.
- d. `SELECT seats_held FROM user_quota …`: over the limit → `409 per_user_limit`. If there's no row, create it (step 6).

Shows are immutable, so they're cached in memory (no query per request). Verified JWTs are cached too (only the expiry
is re-checked). Measured on a local 20k burst: 459 → 1,750 req/s, with every check still passing.

**Transaction (`READ COMMITTED`, retried on 1213/1205 up to 3×):**

```sql
-- Step 1: claim the idempotency key (lock order #1)
INSERT INTO reservations
  (id, show_id, user_id, seats, amount_paise, status, idempotency_key, request_hash)
VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?);
--   ER_DUP_ENTRY (1062) → ROLLBACK → go to "Replay path"

-- Step 2: per-user limit (lock order #2)
-- (the quota row itself is created BEFORE the transaction — see note below)
UPDATE user_quota
   SET seats_held = seats_held + ?            -- n
 WHERE show_id = ? AND user_id = ?
   AND seats_held + ? <= ?;                   -- n, per_user_limit
--   affectedRows = 0 → ROLLBACK → 409 per_user_limit

-- Step 3: take the seats (lock order #3 — the atomic decision)
UPDATE seats
   SET status = 'confirmed', reservation_id = ?, user_id = ?
 WHERE show_id = ? AND label IN (?, ?, …)     -- sorted labels
   AND status = 'available';
--   affectedRows ≠ n → ROLLBACK → classify (below)

COMMIT;  -- → 201
```

**Classifying a step-3 failure (after ROLLBACK, informational read):**
`SELECT label FROM seats WHERE show_id = ? AND label IN (…)`. Any label missing → `422 unknown_seat`,
otherwise → `409 seat_taken`. This read only picks the error message; the decision was already made atomically.

**Replay path (duplicate key on step 1):**
```sql
SELECT * FROM reservations WHERE user_id = ? AND idempotency_key = ?;
```
- `request_hash` matches → `200` + original body + `Idempotent-Replayed: true` (metric reason `idempotent_replay`).
- `request_hash` differs → `409 idempotency_key_conflict`.

Replays return `200`, not `201`: "exactly one 201 per hot seat" stays true even when the winner retries,
and the body is byte-identical to the original.

**Declines are not stored.** A declined request rolls back, so its key isn't consumed. A retry re-evaluates
from scratch, which is correct, because a seat may have been freed since. Only successful reservations are
replayed.

### 4.1 Why each step is race-free

| Race | What InnoDB does |
|------|------------------|
| 500 txns `UPDATE` A12 | The first takes an X-lock on row A12. The others block. On commit, each waiter re-evaluates `status='available'` on the latest committed version (RC semi-consistent read), matches 0 rows and declines. |
| Same user, 10 parallel reserves | All block on the single `user_quota` row. Each sees the committed `seats_held`; at most `limit` seats pass the `+ n <= limit` guard. |
| Same key sent twice at once | The 2nd `INSERT` waits on the 1st's unique-key lock. 1st commits → 2nd gets 1062 → replay. 1st rolls back → 2nd proceeds. |
| Multi-seat vs multi-seat (A12,A13 vs A13,A12) | Both are sorted, and InnoDB scans the PK in order, so both lock A12 then A13. No cycle. |

### 4.2 Lock order (deadlock freedom)

```
reservations(user_id, idempotency_key)  →  user_quota(show_id, user_id)  →  seats(show_id, label ASC)
```
Every write transaction (reserve **and** cancel) follows this order. The known InnoDB edge case (concurrent
duplicate-key inserts can deadlock via shared next-key locks) is absorbed by the 1213 retry.

## 5. Cancel transaction

```sql
BEGIN;
SELECT id, show_id, seats, status FROM reservations
 WHERE id = ? AND user_id = ? FOR UPDATE;              -- lock order #1; not found → 404
-- status = 'cancelled' → COMMIT → 200 (idempotent)
UPDATE reservations SET status = 'cancelled', cancelled_at = NOW(3)
 WHERE id = ? AND status = 'confirmed';
UPDATE user_quota SET seats_held = seats_held - ?      -- lock order #2
 WHERE show_id = ? AND user_id = ? AND seats_held >= ?;
UPDATE seats SET status = 'available', reservation_id = NULL, user_id = NULL
 WHERE show_id = ? AND reservation_id = ?;             -- lock order #3; only THIS reservation's seats
COMMIT;
```
The `reservation_id = ?` guard means a cancel can never touch a seat now owned by another reservation.

## 6. Create show

- Validate: name 1–200 chars, 1 ≤ seats ≤ 10,000, unique labels, `price_paise` a positive integer, limit 1–10.
- One transaction: insert `shows`, then bulk-insert `seats` in chunks of 1,000 (`INSERT … VALUES (…),(…)`).

## 7. Get show

```sql
SELECT label, status FROM seats WHERE show_id = ? ORDER BY label;
```
Counts are computed in the app **from this same result set**, so a single statement snapshot gives
`available + held + confirmed == total_seats` exactly in every response.

## 8. Auth

- JWT HS256, secret `JWT_SECRET`, claims `{ sub: user_id, role: "user" | "admin", exp }`, TTL 24h.
- `requireUser`: `Authorization: Bearer …` → `req.user = { id: sub, role }`. Body fields are never used for identity.
- `requireAdmin`: `role === "admin"`.
- `POST /auth/token`: `user_id` must match `^[A-Za-z0-9_-]{1,64}$`. `role: "admin"` requires
  `X-Admin-Key == ADMIN_API_KEY`.

## 9. Idempotency key input

- Header `Idempotency-Key` takes precedence over the body `idempotency_key`. If both are present and differ → `400`.
- Missing key → `400 invalid_request` (required, so retries are always safe).

## 10. Metrics (prom-client)

| Name | Type | Labels | Meaning |
|------|------|--------|---------|
| `reservations_confirmed_total` | counter | — | New reservations committed |
| `reservation_seats_confirmed_total` | counter | — | Seats in those reservations |
| `reservations_declined_total` | counter | `reason` = `seat_taken` / `per_user_limit` / `idempotent_replay` / `idempotency_key_conflict` / `unknown_seat` / `not_found` | Reserve requests that did not create a new reservation (4xx + replays) |
| `reservations_failed_total` | counter | `code` | Server-side failures (5xx) — should stay 0 |
| `seats_available` | gauge | `show_id` | Available seats (DB-derived) |
| `reservations_cancelled_total` | counter | — | Cancels committed |
| `seats` | gauge | `show_id`, `status` | Read from the DB at scrape time (`GROUP BY show_id, status`), so it always matches the API |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status` | Latency |
| `db_pool_connections` | gauge | `state` = `in_use` / `free` / `queued` | Backpressure visibility |
| `db_transaction_retries_total` | counter | `errno` | Deadlock / lock-wait retries |

Counters live in a single process and reset on restart. The `seats` gauge is authoritative because it is
derived from the DB.

## 11. Logging

- `X-Request-Id` accepted if valid, else a generated ULID. Echoed in the response header and in error bodies.
- One pino JSON line per request (pino-http), plus domain events:
  ```json
  {"level":30,"time":…,"req_id":"…","msg":"reserve","user_id":"u42","show_id":"…","seats":["A12"],"outcome":"seat_taken","ms":3.1}
  ```
- Never log tokens or `ADMIN_API_KEY`.

## 12. Boot & shutdown

1. Parse env (fail fast).
2. Create the pool; retry the DB connection with backoff (up to ~60 s) for a cold start where MySQL boots slowly.
3. Run migrations (idempotent; take a `GET_LOCK('migrate', 30)` named lock).
4. Listen. `/readyz` turns 200.
5. SIGTERM → `ready = false` → `server.close()` → drain → `pool.end()`.

Timeouts: `server.requestTimeout = 30s`, `keepAliveTimeout = 65s` (longer than Caddy's), so queued requests
finish instead of the proxy returning 502/504.

## 13. Config (env)

| Var | Example | Notes |
|-----|---------|-------|
| `PORT` | `3000` | |
| `DATABASE_URL` | `mysql://app:pass@mysql:3306/seats` | |
| `DB_POOL_SIZE` | `20` | |
| `JWT_SECRET` | 32+ random bytes | required |
| `ADMIN_API_KEY` | random | required |
| `LOG_LEVEL` | `info` | |

## 14. Burst script (`./burst.sh <BASE_URL>`)

Env: `ADMIN_API_KEY`. Flags: `--seats 1000 --users 2000 --hot-seats 5 --storm 500 --total 20000 --concurrency 1000`.

1. **Setup:** mint an admin token, create a fresh show (default 1,000 seats, limit 4), mint N user tokens.
2. **Fire everything concurrently** (undici pool):
   - **Hot-seat storm:** `storm` distinct users × each of `hot-seats` seats.
   - **Stampede:** random 1–2 seat requests across the hall.
   - **Idempotent retries:** a sample re-sent with the same key/body (expect `200` replay); some with the same key
     and different seats (expect `409 idempotency_key_conflict`).
   - **Per-user limit:** one user, 10 parallel distinct-seat reserves.
   - **Spoof:** body `user_id: "victim"` → the reservation must belong to the token user. Cancel someone else's → `404`.
   - **Invariant poller:** `GET /shows/{id}` every 200 ms during the burst, checking the sum.
3. **Report and assert** (exit code ≠ 0 on any failure):
   ```
   outcome            count
   201 confirmed       …
   200 replay          …
   409 seat_taken      …
   409 per_user_limit  …
   409 idem_conflict   …
   5xx                 0
   hot seats: A1=1 winner ✓ … | per-user: 4/4 ✓ | spoof ✓
   reconciliation: available+held+confirmed = 1000 ✓ (during: N polls ✓)
   metrics delta vs API ✓ | latency p50/p95/p99
   ```

## 15. Testing strategy

- **Unit:** request hashing, validation, error mapping.
- **Integration (real MySQL):** each endpoint's happy path and declines.
- **Concurrency:** `Promise.all` of 200 reserves on one seat → exactly 1 success; 10 parallel same-user → ≤ limit;
  20 parallel same key → 1 reservation row; A12+A13 vs A13+A12 mixes → no deadlock surfaced, no partial reservations.
- **Invariant check** after every test: the `GROUP BY status` sum equals `total_seats`, and `user_quota.seats_held` equals the actual confirmed seats per user.
