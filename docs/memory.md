# Project Memory

> Running log of decisions, status and open questions. Source material for `WRITEUP.md`
> (especially the AI-usage section). Newest entries first within each section.

## Current status

- **Phase:** planning docs written. Next: repo scaffold → schema/migrations → reserve path → tests → metrics/logs → burst → deploy.
- **Last updated:** 2026-10-01

## Decision log

| Date | Decision | Alternatives considered | Why | Decided by |
|------|----------|-------------------------|-----|------------|
| 2026-10-01 | Deploy on AWS EC2 t3.small + Elastic IP + docker compose (Caddy, app, MySQL), `sslip.io` hostname for TLS | App Runner, ECS + RDS, Railway, Render | App Runner closed to new customers; same compose file locally and in prod; app and DB co-located keeps lock hold times low; no domain needed | Me (AI listed the options and AWS free-tier facts) |
| 2026-10-01 | Hold model v1: confirm immediately, release via owner cancel; schema keeps `held` + `hold_expires_at` | Time-boxed holds with auto-expiry | Spec's 201 body says `confirmed`; simpler; expiry is an easy extension | Me (proposed by AI) |
| 2026-10-01 | Partial requests: all-or-nothing | Best-effort | Simpler invariant, matches user expectations, easy to make atomic | Me (proposed by AI) |
| 2026-10-01 | Idempotent replay returns `200` + `Idempotent-Replayed: true` | Return `201` again | Keeps "exactly one 201 per hot seat" true under retries | Me (proposed by AI) |
| 2026-10-01 | Stack: Node 22 + TypeScript + Express 5 + MySQL 8 + mysql2 (raw SQL) | Go, Spring Boot, Fastify, Postgres, Python/FastAPI | I'm most hands-on with Express + MySQL; must extend it live in the interview; JD mapped to Spring in the write-up | Me (AI recommended Fastify + Postgres first; I chose based on my experience) |
| 2026-10-01 | No Redis, no Kafka, single service | Redis pre-check, queue-based admission | A second source of truth risks breaking reconciliation; not needed at this scale | Me (proposed by AI) |

## Open questions

- [ ] Instance size after the first live burst: is t3.small enough for 20k concurrent, or move to t3.medium?
- [ ] Public logs: screen recording vs Grafana Cloud (Loki) public dashboard.

## AI usage log

| Date | What I asked | What AI produced | What I changed / decided |
|------|--------------|------------------|--------------------------|
| 2026-10-01 | Tech stack for the assignment given the JD (Java/Go) and my background | Compared Go/Spring/TS/Python; recommended TS + Fastify + Postgres | Chose Express + MySQL because that's where my hands-on experience is |
| 2026-10-01 | AWS deployment expectations, DNS needs | Explained "public URL" means any reachable address; EC2 + compose + sslip.io plan; flagged App Runner closure and new free-tier credits model | Going with EC2 |
| 2026-10-01 | Planning docs | Drafted prd/architecture/design/rules/memory | Reviewed; (note edits here) |

## Lessons / gotchas

- 2026-10-01: the per-user-limit concurrency test (10 parallel reserves, same user) returned 500s. Cause:
  concurrent `INSERT IGNORE` of the same new `user_quota` row inside transactions deadlocks (InnoDB
  shared next-key locks on the duplicate key). Fix: create the quota row outside the transaction, so the
  transaction only UPDATEs. The limit itself was never violated — but 5xx is a failure too.
- macOS caps the TCP accept queue at 128 (`kern.ipc.somaxconn`), so the test client limits itself to 64
  connections. Not a server bug; Linux (EC2) defaults to 4096.

- mysql2 reports *matched* rows, so guards must live in `WHERE` for `affectedRows` to mean "won".
- InnoDB default `REPEATABLE READ` uses gap locks, so we use `READ COMMITTED` to cut deadlocks.
- Platform proxy 502/504s count as 5xx, so app-side queueing and timeouts matter as much as SQL correctness.
