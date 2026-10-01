# Architecture — Seat Reservation at Scale

> High-level system shape and the reasons behind it. Exact SQL, schema and contracts are in [design.md](design.md).

## 1. One-line summary

One stateless Express 5 (TypeScript) service in front of **one MySQL 8 database**. Every "who gets this seat"
decision is made **inside MySQL** in a single short transaction, never in application memory.

## 2. Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node 22 + TypeScript | Familiar stack (defensible in a live extension); the event loop queues thousands of waiting requests cheaply |
| HTTP | Express 5 | Familiar; v5 forwards rejected async handlers to the error middleware (no hung requests or crashes) |
| Validation | zod | Typed request schemas |
| Database | MySQL 8 (InnoDB), `READ COMMITTED` | Row locks + conditional updates + unique constraints; RC avoids gap-lock deadlocks |
| DB driver | mysql2/promise, raw SQL | No ORM: the atomic statement is visible and explainable |
| Auth | JWT HS256 via `jose` | Identity = `sub` claim |
| Logs | pino + pino-http | JSON lines with a request id |
| Metrics | prom-client | Prometheus exposition |
| Tests | Vitest against a real MySQL (docker compose) | Concurrency bugs only show up against a real DB |
| Load | Node + undici (`scripts/burst.ts`) | Exact outcome distribution + reconciliation report |
| Packaging | Multi-stage Dockerfile + docker-compose | Local == deployed |
| Hosting | AWS EC2 t3.small (ap-south-1) + Elastic IP, Caddy for TLS | See §7 |

**Deliberately not used:**
- **Redis:** a second source of truth that could disagree with MySQL and break reconciliation.
- **Kafka/queues:** nothing in this problem needs async messaging.
- **Microservices:** one bounded context, so one service.

## 3. System diagram

```
                        ┌──────────────────────────── EC2 t3.small (ap-south-1) ───────────────────────────┐
 graders / burst.sh     │                                                                                   │
 ───────HTTPS──────────▶│  Caddy :443 ──▶  app :3000 (Express 5)                     MySQL 8 :3306          │
  <ip>.sslip.io         │  (TLS, LE cert)   ├─ request-id + pino-http logs            (docker volume)       │
                        │                   ├─ auth (JWT → user_id)                   not exposed publicly  │
                        │                   ├─ routes: shows / reserve / cancel                             │
                        │                   ├─ /healthz /readyz /metrics                                    │
                        │                   └─ mysql2 pool (≈20 conns) ───────────────▶                     │
                        └───────────────────────────────────────────────────────────────────────────────────┘
```

## 4. Request lifecycle (reserve)

```
client ─▶ Caddy ─▶ request-id mw ─▶ pino-http ─▶ auth mw ─▶ zod validate ─▶ reserve handler
                                                                               │
                                                     withTransaction(retry 1213/1205 ×3)
                                                                               │
                         1. claim idempotency key   (INSERT reservations … UNIQUE(user_id, key))
                         2. reserve quota           (conditional UPDATE user_quota)
                         3. take seats              (conditional UPDATE seats … status='available')
                                                                               │
                                                       COMMIT → 201  |  ROLLBACK → 4xx
                                                                               │
                                                        metrics.inc(outcome) + log line
```

## 5. Where the atomic decision lives

| Guarantee | Mechanism | Why race-free |
|-----------|-----------|---------------|
| No double-sell | `UPDATE seats … WHERE status='available'` + check `affectedRows` | Check and write are one statement under an InnoDB row X-lock. Waiters re-read the committed row and match 0 rows. |
| Per-user limit | `UPDATE user_quota SET seats_held = seats_held + n WHERE … AND seats_held + n <= limit` | One quota row per (show, user) serialises that user's parallel requests |
| Exactly-once | `UNIQUE (user_id, idempotency_key)` on `reservations` | A second insert blocks on the first's key lock, then fails with a duplicate key → replay |
| All-or-nothing | Single transaction; `affectedRows ≠ n` → ROLLBACK | Steps 1–3 undo together |
| Reconciliation | One row per seat with a single `status` column | A seat can't be in two states, so the sum always equals the total |

**No deadlocks by construction:** every transaction takes locks in the same global order:
idempotency key → quota row → seat rows (primary-key order). Bounded retry on MySQL `1213`/`1205` is a safety
net, not the design.

## 6. Concurrency & load model

- **Hot seat (500 users → A12):** updates to A12 queue on its row lock. Each holds it for ~1 ms (UPDATE →
  COMMIT), so the queue drains in well under a second.
- **App-side backpressure:** the mysql2 pool is capped (≈20 connections, under MySQL's `max_connections`).
  Excess requests wait in Node memory, not in MySQL. Timeouts are set so a queued request still finishes
  before the proxy gives up, avoiding 502/504 (which would count as 5xx).
- **Short transactions:** no network calls, no reads of other services, no sleeps inside a transaction.
- **Fail closed:** if MySQL is unreachable, `/readyz` → `503` and reserves → `503 unavailable`. We never
  guess or sell from a cache.

## 7. Deployment (AWS)

| Item | Choice |
|------|--------|
| Compute | EC2 **t3.small** (2 GB), Amazon Linux 2023, region **ap-south-1 (Mumbai)** |
| Stable address | **Elastic IP** (the URL survives stop/start) |
| URL / TLS | `https://<ip-with-dashes>.sslip.io`, Caddy auto-provisions a Let's Encrypt cert. No domain/DNS purchase. |
| Runtime | `docker compose up -d`: `caddy`, `app`, `mysql` (named volume) |
| Cold start | `restart: always`; app waits for MySQL, runs migrations, then reports ready |
| Network | Security group: 80/443 open to all, 22 from my IP only, **3306 never exposed** |
| Cost guard | AWS Budget alert at $10; free-plan credits cover the review period |

Why EC2 + compose (and not App Runner/ECS/RDS)? App Runner is closed to new customers (since 2026-04-30).
ECS + RDS adds network latency between app and DB (so locks are held longer) plus setup time. A single box
running the same compose file as local is the most faithful "clean checkout runs the same way we deploy it".
RDS is listed as a next step.

## 8. Observability

| Signal | What |
|--------|------|
| Metrics | `reservations_confirmed_total`, `reservations_declined_total{reason}`, `reservations_cancelled_total`, `seats{show_id,status}` gauge (read from the DB on scrape), HTTP latency histogram, DB pool in-use/queued, tx retries |
| Logs | JSON (pino): `req_id`, method, route, status, latency, `user_id`, `show_id`, `outcome`. `X-Request-Id` accepted and echoed. |
| Health | `/healthz` liveness, `/readyz` readiness (DB check, fails closed) |
| Paging (2am) | 5xx rate > 0; readiness failing; invariant violation; p99 latency / pool queue growth; deadlock retry spike |

## 9. Consistency vs availability (partition stance)

**CP.** One MySQL primary is the only authority. If the app can't reach it, we refuse to sell (`503`) rather
than risk a double-sell. Reads (`GET /shows`) could be served stale from a replica in future; writes never.

## 10. Failure modes

| Failure | Behaviour |
|---------|-----------|
| MySQL down | `/readyz` 503, reserves 503, liveness stays 200 (no restart loop) |
| Deadlock / lock wait timeout | Transparent retry ×3 with jitter, then `503` (should never occur by design) |
| App crash / reboot | Docker restarts it; uncommitted transactions roll back, so there is no partial state |
| SIGTERM (deploy) | Readiness flips to 503, in-flight requests drain, pool closes |
| Duplicate submit / client retry | Idempotency key replays the original reservation |

## 11. Scaling path (beyond this assignment)

1. Vertical: bigger instance / RDS with provisioned IOPS.
2. Horizontal app replicas behind a load balancer (the app is stateless; metrics are aggregated by Prometheus).
3. Read replicas for `GET /shows/{id}`.
4. Virtual waiting room / admission queue in front of on-sale spikes.
5. Shard by `show_id`. Each show is independent, so there are no cross-shard transactions.

## 12. Mapping to Java / Spring Boot (JD alignment)

| Here | Spring Boot equivalent |
|------|------------------------|
| `withTransaction()` helper | `@Transactional(isolation = READ_COMMITTED)` |
| mysql2 pool | HikariCP (`maximumPoolSize`) |
| Conditional `UPDATE` + `affectedRows` | `@Modifying @Query` returning `int` updated rows |
| zod | Bean Validation (`@Valid`, `@NotNull`) |
| prom-client | Micrometer + Actuator `/actuator/prometheus` |
| `/healthz` `/readyz` | Actuator liveness/readiness probes |
| pino + request id | Logback JSON encoder + MDC `requestId` |
| Deadlock retry | Spring Retry `@Retryable(CannotAcquireLockException)` |
