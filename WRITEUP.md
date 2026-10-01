# Write-up: Seat Reservation at Scale

Short version: one Express 5 service and one MySQL 8 database. Every grant (a seat, quota, an idempotency key) is
decided by **one conditional statement or one unique constraint inside a short InnoDB transaction**. Plain reads are
used only to **decline early**, which keeps the stampede cheap. Details and exact SQL are in [docs/design.md](docs/design.md).

## 1. The atomic decision

**Mechanism:** a guarded update, judged by `affectedRows`:

```sql
UPDATE seats
   SET status = 'confirmed', reservation_id = ?, user_id = ?
 WHERE show_id = ? AND label IN (?, ?) AND status = 'available';
-- success only if affectedRows == number of seats requested, else ROLLBACK
```

**Why it's race-free:** the availability check and the write are the same statement. InnoDB takes an exclusive row lock
on each matching seat, so a second transaction updating the same seat blocks. When it resumes it re-evaluates
`status = 'available'` against the latest committed row (READ COMMITTED semi-consistent read), sees `confirmed`,
matches zero rows and declines. There is no window between "is it free?" and "take it". With 500 buyers on A12, exactly
one update matches; the other 499 get `409 seat_taken`. The burst confirms this on every run.

Two details matter:
- mysql2 reports matched rows, so the guard has to live in `WHERE` (not in a `SET` expression) for `affectedRows` to mean "won".
- **One row per seat with a single `status` column** is the source of truth. A seat can't be in two states, so
  `available + held + confirmed == total_seats` holds by construction, not by bookkeeping.

**Multi-seat and deadlocks.** Requests are all-or-nothing: if `affectedRows` is less than the number of seats, the whole
transaction (reservation row and quota) rolls back. Every write transaction takes its locks in one global order:

```
reservations (user_id, idempotency_key)  →  user_quota (show_id, user_id)  →  seats (show_id, label) in PK order
```

Seat labels are sorted, and InnoDB scans the primary key in order, so `[A12, A13]` and `[A13, A12]` both lock A12
first. No wait cycle can form. A bounded retry (3 attempts, jitter) on MySQL 1213/1205 is a safety net, not the design.
In practice the burst shows `db_transaction_retries_total` = 0.

**Per-user limit:** `UPDATE user_quota SET seats_held = seats_held + n WHERE show_id = ? AND user_id = ? AND seats_held + n <= limit`.
All of one user's requests for a show hit the same row, so InnoDB serialises them. 10 parallel requests on a limit-4
show give exactly 4 × 201 and 6 × 409.

**A bug the tests caught.** Originally the quota row was created inside the transaction with `INSERT IGNORE`. With 10
parallel first-time requests from one user, InnoDB's shared locks on the duplicate key deadlocked them, and some
returned 500. The limit itself was never broken, but 5xx is a failure. Fix: create the quota row in its own
auto-committed statement before the transaction, so the transaction only ever UPDATEs an existing row.

**Fast path (performance without weakening correctness).** The first full 20k burst passed every check but ran at
459 req/s, because ~95% of requests lose and each one still opened a transaction and queued on row locks. Now plain reads
decline early: seat already taken, user already at the limit, unknown label. **Reads only ever decline, never grant.**
A decline based on a committed read is a true answer at that instant. The one subtlety: the idempotency key is checked
*before* declining a taken seat, because a retry of a request that already succeeded sees its own seat as taken and
must get a replay, not a 409. With immutable shows and verified JWTs cached in memory, throughput went from 459 to
~1,750 req/s locally with zero errors.

## 2. Idempotency

- **Where the key lives:** on the reservation row itself, `UNIQUE (user_id, idempotency_key)` in `reservations`,
  together with `request_hash = sha256({show_id, sorted seats})`. Keys are scoped per user, so two users can't collide.
  The key comes from the `Idempotency-Key` header or the body (required; if both are sent and differ → 400).
- **Exactly-once:** the reservation INSERT is the first statement of the transaction. A concurrent copy of the same
  request blocks on the first INSERT's unique-key lock. If the first commits, the copy gets duplicate-key error 1062,
  rolls back and reads the original. If the first rolls back (seat taken), the copy proceeds as if it were first.
  The burst sends 200 requests × 3 simultaneous copies, and every group produces at most one reservation.
- **Same key, same body:** `200` with header `Idempotent-Replayed: true` and the original body, byte for byte.
  I chose 200 rather than 201 so that "exactly one 201 per hot seat" stays true even when the winner retries.
- **Same key, different body:** `409 idempotency_key_conflict`, and nothing moves.
- **Declines don't consume the key.** A declined request rolls back, so a retry is evaluated fresh. That's
  correct, since the seat may have been freed in the meantime.

## 3. Holds and expiry

I chose **confirm immediately + explicit owner cancel**, because the spec's 201 body is `"status": "confirmed"`.

- `POST /reservations/:id/cancel` locks the reservation with `WHERE id = ? AND user_id = <token user> FOR UPDATE`.
  Someone else's reservation looks exactly like a missing one (404).
- It frees seats with `UPDATE seats … WHERE reservation_id = ?`. **That guard is what prevents resurrection:** a seat that
  was released and re-sold carries a different `reservation_id`, so a late or repeated cancel can't touch it. The
  test suite cancels, re-sells to another user, cancels again, and the seat stays with the new owner.
- Cancel follows the same lock order as reserve. Double cancel is a no-op. The quota is returned in the same transaction.

**Adding time-boxed holds** (a likely extension): the schema already has `status = 'held'` and `hold_expires_at`.
Reserve would set `held` with `hold_expires_at = NOW() + TTL`, and a confirm endpoint would do
`UPDATE … SET status='confirmed' WHERE reservation_id = ? AND status='held' AND hold_expires_at > NOW()`.
Expiry is a periodic `UPDATE … SET status='available' WHERE status='held' AND hold_expires_at < NOW()`, plus the
take-seat guard becomes `status='available' OR (status='held' AND hold_expires_at < NOW())`. That way an expired hold
is re-bookable even before the sweeper runs, and a confirm racing an expiry has exactly one winner.

## 4. Consistency vs availability under a partition

**CP.** There's one MySQL primary and it is the only authority. If the app can't reach it, `/readyz` returns 503 and
reserve returns `503 unavailable`. We refuse to sell rather than risk selling twice. I verified this by stopping the
MySQL container: readyz 503, healthz 200 (so nothing restarts a healthy process), API 503, and automatic recovery when
MySQL comes back. Reads (`GET /shows/:id`) could be served slightly stale from a replica in the future; grants never.

## 5. Observability: what pages me at 2am

Metrics at `/metrics`. The seat gauges are read from the `seats` table at scrape time (through a separate 2-connection
probe pool, so scrapes and readiness work even when the main pool is saturated). They therefore always match the API.

| Page | Signal | Why |
|---|---|---|
| **Any 5xx** | `reservations_failed_total` rate > 0, or `http_request_duration_seconds_count{status=~"5.."}` | Declines are 4xx by design, so a 5xx is a bug or an outage |
| **Not ready** | `/readyz` failing for > 1 min | DB unreachable, so we're refusing to sell |
| **Invariant broken** | `sum by (show_id) (seats)` ≠ total seats, or confirmed seats ≠ seats in confirmed reservations | Should be impossible; if it happens, stop sales |
| **Saturation** | `db_pool_connections{state="queued"}` growing, p99 latency climbing | Clients will start timing out before we decline them |
| **Lock trouble** | `db_transaction_retries_total` rate rising | The lock-order assumption is broken somewhere |

Watch-only (no page): `reservations_declined_total{reason}` mix, confirmed rate, event-loop lag.
Logs: one JSON line per request with `req_id` (accepted from `X-Request-Id` or generated, echoed back), status and
latency. Errors include the stack. Tokens and keys are redacted.

## 6. Results

Local (MacBook, Docker Desktop), default `./burst.sh`: 20,000 reserves, 1,000 seats, 5 hot seats × 500 buyers.
Every check passes: zero 5xx, one winner per hot seat, no seat in two 201s, the invariant holds in every snapshot taken
during the burst and after it, idempotency, conflicts, per-user limit, token identity, and metrics matching the API.
~1,750 req/s direct, ~1,100 req/s through Caddy. Live EC2 numbers: *to be added after deploy.*

## 7. AI usage: directed vs decided

> **Author's note: rewrite this section in your own words before submitting.** The facts below are what happened.

I built this with an AI coding assistant (Claude Code) in one session. It wrote most of the code, tests and docs.
I directed it, made the product and technology decisions, and reviewed and ran everything.

**What I decided:**
- **Stack.** The assistant first recommended Fastify + Postgres (and noted Go/Spring matches the JD better). I chose
  Express + MySQL because that's where my hands-on experience is, and I'll be extending this live.
- **Deploy target.** AWS EC2. The assistant laid out the options and flagged that App Runner is closed to new customers.
- **Code style.** I required simple, readable, modifiable code before any code was written, so I can change it myself.
  This became `docs/rules.md`.
- **Repo setup and history.** Planning docs first, then small commits.

**What the AI proposed and I accepted:** the schema (one row per seat, quota row, per-user idempotency key), the lock
order, all-or-nothing partial requests, 200 for replays, confirm-plus-cancel instead of holds, no Redis or Kafka, the
fast-path optimisation, and Caddy + sslip.io for HTTPS without a domain.

**Where the AI was wrong or incomplete and testing caught it:**
- The quota-row deadlock (§1) appeared only under the concurrency test.
- The first metrics version published `seats_available` before its DB query finished (prom-client collects in parallel);
  a test caught it.
- The first full burst exposed poor throughput. Profiling showed the time was in the app, not the database.

Every decision is logged with who made it in [docs/memory.md](docs/memory.md).

## 8. What I'd do next

1. **Holds with TTL + confirm** (design in §3), with a payment step between hold and confirm.
2. **Throughput:** run one Node process per core (cluster mode, metrics aggregated with prom-client's `AggregatorRegistry`),
   then add more app instances behind a load balancer. The app is stateless; the caches are safe because shows and
   tokens are immutable.
3. **Database:** move to RDS Multi-AZ for failover. Point `GET /shows` at a read replica.
4. **On-sale admission control:** a virtual waiting room or token bucket in front of the reserve endpoint, so a
   100k-user spike queues fairly instead of piling onto the database.
5. **Shard by `show_id`:** shows are independent, so there are no cross-shard transactions.
6. **Outbox pattern** for "reservation confirmed" events (payments, notifications), written in the same transaction.
7. **Real identity provider** (verify the provider's JWTs with its JWKS) in place of `/auth/token`.

### Java / Spring Boot mapping (JD)

| Here | Spring Boot |
|---|---|
| `withTransaction()` + 1213/1205 retry | `@Transactional(isolation = READ_COMMITTED)` + Spring Retry `@Retryable(CannotAcquireLockException.class)` |
| Conditional `UPDATE` + `affectedRows` | `@Modifying @Query(...)` returning the updated-row `int` |
| mysql2 pool | HikariCP `maximumPoolSize` |
| zod | Bean Validation (`@Valid`) |
| prom-client | Micrometer + Actuator `/actuator/prometheus` |
| `/healthz` `/readyz` | Actuator liveness/readiness groups |
| pino + `req_id` | Logback JSON encoder + MDC |
