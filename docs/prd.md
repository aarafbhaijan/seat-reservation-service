# PRD — Seat Reservation at Scale

> Product requirements for the Paytm Money "Deploy & Observe" take-home.
> Companion docs: [architecture.md](architecture.md) · [design.md](design.md) · [rules.md](rules.md)

## 1. Problem

A show (concert / movie hall) with N numbered seats goes on sale at t=0. Tens of thousands of buyers hit
"book" in the same second, many fighting over the same few good seats. The service is the **system of
record** that decides, atomically and correctly, who gets each seat and who is turned away.

A seat is unique. Once it is held or sold, nobody else can ever get that exact seat.

## 2. Goals

| # | Goal | How we know |
|---|------|-------------|
| G1 | Never sell the same seat twice | Hot-seat storm of 500 users → exactly one `201`, 499 × `409` |
| G2 | Never let a user exceed their limit | 10 parallel reserves on a limit-4 show → ≤ 4 seats held |
| G3 | Never double-charge a retried request | Same idempotency key → one reservation, same response |
| G4 | Zero 5xx under a ~20k concurrent burst | Burst report shows `5xx = 0` |
| G5 | Reconciliation invariant always holds | `available + held + confirmed == total_seats`, during and after |
| G6 | Identity is token-derived | A spoofed `user_id` in the body is ignored |
| G7 | The running system is observable | Health, readiness, Prometheus metrics, structured logs |
| G8 | Runs the same everywhere | `docker compose up` from a clean clone == what is deployed |

## 3. Non-goals

- UI (a JSON API is enough).
- Real payments. "Confirmed" means the seat is sold; no payment gateway.
- Real identity provider. A test token-issuing endpoint stands in for one (see §5.6).
- Multi-region / multi-database deployment.

## 4. Users & roles

| Role | Can do | How identified |
|------|--------|----------------|
| Admin | Create shows | JWT with `role: "admin"` |
| User | Reserve seats, cancel **own** reservations, view shows | JWT `sub` claim = `user_id` |
| Anonymous | Health, readiness, metrics, view shows | — |

## 5. Functional requirements

All money values are **integer paise**. Never floats.

### 5.1 Create a show — `POST /shows` (admin)

Request:
```json
{ "name": "friday-night", "seats": ["A1","A2","A3"], "price_paise": 25000, "per_user_limit": 4 }
```
- `per_user_limit` is optional, default **4**.
- Seat labels must be unique within the request.
- Returns `201` with the show `id` and every seat in `available` state.

### 5.2 Reserve seats — `POST /shows/{id}/reserve` (user)

Request (idempotency key in the `Idempotency-Key` header **or** the body):
```json
{ "seats": ["A12"], "idempotency_key": "b7c1…" }
```
Success `201`:
```json
{ "reservation_id": "…", "show_id": "…", "user_id": "…", "seats": ["A12"],
  "amount_paise": 25000, "status": "confirmed" }
```

Rules that must hold under concurrency:

| Rule | Behaviour |
|------|-----------|
| No double-sell | A seat confirmed/held for one user can never be confirmed for another. Losers get `409 seat_taken`. |
| Per-user limit | Total seats a user holds for a show ≤ `per_user_limit`. Over the limit → `409 per_user_limit`. |
| Idempotency, same key + same body | Returns the **original** reservation (`200`, header `Idempotent-Replayed: true`). Nothing moves. |
| Idempotency, same key + different body | `409 idempotency_key_conflict`. |
| Partial requests | **All-or-nothing.** If any requested seat is unavailable, nothing is reserved → `409 seat_taken`. |
| Identity | `user_id` comes only from the token. Any `user_id` in the body is ignored. |

### 5.3 Cancel — `POST /reservations/{id}/cancel` (owner only)

- Only the reservation's owner can cancel. For anyone else it looks like `404` (we don't reveal it exists).
- Cancelling returns its seats to `available` and gives back the user's quota.
- A cancel only frees seats **this reservation owns**. It can never free a seat that is confirmed to someone else.
- Cancelling twice is idempotent: the second call returns the already-cancelled reservation.

**Hold model (v1):** a reserve confirms immediately, and release is an explicit cancel. The schema
already supports a `held` state with `hold_expires_at`, so a hold → confirm → expiry flow can be added later
(a likely live-interview extension).

### 5.4 Show state — `GET /shows/{id}`

Returns per-seat status and counts:
```json
{ "id": "…", "name": "friday-night", "price_paise": 25000, "per_user_limit": 4,
  "total_seats": 3, "counts": { "available": 2, "held": 0, "confirmed": 1 },
  "seats": [ { "label": "A1", "status": "confirmed" }, … ] }
```
`counts.available + counts.held + counts.confirmed == total_seats`, always.

### 5.5 Reservation lookup — `GET /reservations/{id}` (owner only)

Returns the reservation. Anyone other than the owner gets `404`.

### 5.6 Test token issuer — `POST /auth/token`

- `{ "user_id": "u123" }` → user JWT. Stands in for a real identity provider so load tests can simulate
  thousands of users.
- An admin token needs the `X-Admin-Key` header to match the server's `ADMIN_API_KEY`.

### 5.7 Operational endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | Liveness: the process is up. No dependency checks. |
| `GET /readyz` | Readiness: `SELECT 1` against MySQL with a timeout. `503` if the DB is down or the app is shutting down. |
| `GET /metrics` | Prometheus exposition format. |

## 6. Error contract

Every non-2xx response has the same shape:
```json
{ "error": { "code": "seat_taken", "message": "One or more seats are not available", "request_id": "…" } }
```

| HTTP | `code` | When |
|------|--------|------|
| 400 | `invalid_request` | Bad JSON / schema / missing idempotency key |
| 401 | `unauthorized` | Missing / invalid / expired token |
| 403 | `forbidden` | Non-admin calling an admin route |
| 404 | `not_found` | Show/reservation missing, or not yours |
| 409 | `seat_taken` | Any requested seat is not available |
| 409 | `per_user_limit` | Request would exceed the per-user limit |
| 409 | `idempotency_key_conflict` | Same key, different body |
| 422 | `unknown_seat` | A requested label doesn't exist in this show |
| 503 | `unavailable` | Dependency down (fail closed). Never used for domain declines. |

Domain declines are **always 4xx**. A 5xx means a real bug or an outage.

## 7. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Correctness | Atomic decision in the database (conditional update / unique constraint / row lock). Never read-then-write. |
| Load | ~20,000 concurrent reserve requests against one show, zero 5xx. |
| Latency | Hot path is a handful of short statements; target p99 < 2 s under the burst on a t3.small. |
| Observability | Prometheus metrics that match API state; JSON logs with a request id. |
| Deployability | Public URL; survives a cold start/reboot; `docker compose up` from a clean clone. |
| Security | Token-derived identity; admin routes gated; DB port never public; secrets via env. |

## 8. Deliverables

1. Public Git repo with incremental commit history.
2. Live URL (AWS EC2, see [architecture.md](architecture.md) §7).
3. One-command burst script (`./burst.sh <BASE_URL>`), documented in the README.
4. Metrics (`/metrics`) and logs (recording or public link).
5. `WRITEUP.md`: atomic decision, idempotency, holds, CAP stance, paging, AI usage, next steps.

## 9. Acceptance checklist

- [ ] Hot-seat storm: exactly one `201` per hot seat, everyone else `409`
- [ ] Zero 5xx across the full burst
- [ ] Invariant holds during (polled) and after the burst
- [ ] Idempotent retries move nothing; different body on the same key → `409`
- [ ] 10 parallel reserves, limit 4 → ≤ 4 seats held
- [ ] Spoofed body `user_id` ignored; can't cancel someone else's reservation
- [ ] `/readyz` returns `503` when MySQL is stopped
- [ ] Metrics counters/gauges match `GET /shows/{id}` after the burst
- [ ] Clean clone → `docker compose up` → healthy
- [ ] Live URL healthy after an EC2 reboot
