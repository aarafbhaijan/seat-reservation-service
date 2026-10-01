# Rules — How this codebase is built

> Non-negotiable engineering rules for anyone (human or AI assistant) changing this repo.
> The prime directive: **the author must be able to read, explain and change any file without help.**

## Readability rules (read these first)

1. **Code is written for the next reader, not the compiler.** If a choice is between clever and obvious,
   pick obvious.
2. **Names say what things are.** `seatsToReserve`, `perUserLimit`, `affectedRows`, not `arr`, `lim`, `res2`.
   Functions are verbs (`reserveSeats`, `cancelReservation`); booleans read as questions (`isReady`, `hasKey`).
3. **One file, one job.** Each file starts with a short comment saying what it is responsible for.
   Routes handle HTTP only; services hold business logic and SQL; nothing else does both.
4. **Small functions.** A function should fit on one screen (~40 lines). If it needs a scroll, split it into
   named steps.
5. **Linear flow over nesting.** Use early returns and guard clauses. Avoid more than 2 levels of `if`.
6. **Comments explain *why*, not *what*.** Every concurrency-critical statement (the conditional `UPDATE`s,
   lock order, retries, idempotency) gets a comment saying *why it is race-free*. Obvious code gets none.
7. **SQL lives as readable, formatted strings** next to the code that runs it, one clause per line,
   with named intent:
   ```ts
   // Atomic decision: the status check and the write happen in ONE statement,
   // so two buyers can never both see "available" and both take the seat.
   const TAKE_SEATS_SQL = `
     UPDATE seats
        SET status = 'confirmed', reservation_id = ?, user_id = ?
      WHERE show_id = ?
        AND label IN (?)
        AND status = 'available'`;
   ```
8. **No magic values.** Status strings, error codes, limits and timeouts are named constants in one place
   (`src/constants.ts` / `config.ts`).
9. **Explicit types at boundaries.** Request bodies, DB rows and responses have named TypeScript types.
   Inside a function, let inference work.
10. **Consistent patterns everywhere.** Every route looks the same (validate → call service → respond), and every
    domain failure is a `DomainError`. Once you've read one, you've read them all.
11. **No premature abstraction.** No generic repositories, base classes, DI containers or decorators. Plain
    functions and modules. Duplicate twice before abstracting.
12. **Few dependencies,** each with a reason recorded in `architecture.md`.

## Correctness rules

13. **Never read-then-write to GRANT.** Granting a seat, quota or idempotency key is always one conditional
    statement (`UPDATE … WHERE <guard>`) or a unique constraint. A plain read may only ever **decline early**
    (a committed read showing the seat taken is a true answer at that instant). It never grants anything.
14. **The guard goes in `WHERE`.** Judge success only by `affectedRows`, and only when non-qualifying rows are
    excluded by `WHERE`.
15. **Fixed lock order** in every write transaction:
    `reservations(user_id, key)` → `user_quota(show_id, user_id)` → `seats(show_id, label ASC)`.
    A new write path must follow it or document why it can't deadlock.
16. **Transactions stay short.** No HTTP calls, timers, or unbounded loops inside `withTransaction`.
17. **All-or-nothing.** A failed step rolls back the whole transaction. No partial reservations.
18. **Money is integer paise** (`BIGINT` / JS `number` validated as a safe integer). No floats, no decimals in JSON.
19. **Identity only from the token.** Never read `user_id` from the body, query, or params for authorization.

## Error-handling rules

20. **Domain declines are 4xx; 5xx means a bug or an outage.** Every expected DB error (1062 duplicate,
    1213 deadlock, 1205 lock wait) is handled explicitly.
21. **Fail closed.** If the DB is unavailable, return `503`. Never serve a reservation decision from memory or a cache.
22. **One error envelope:** `{ "error": { "code", "message", "request_id" } }`.

## Code hygiene rules

23. TypeScript `strict`. No `any` in domain code.
24. Raw SQL with placeholders only (`?`). Never string-concatenate user input into SQL.
25. No ORM. Keep the SQL visible and reviewable.
26. Validate every request with zod at the edge.
27. Config only from env (validated at boot). Secrets never committed; `.env.example` documents them.
28. Log as structured JSON with `req_id`. Never log tokens or keys.
29. Formatting is automatic (Prettier) and linting is enforced (ESLint). No style debates.

## Testing rules

30. Concurrency behaviour is tested against **real MySQL**, never mocks.
31. Every test that writes checks the reconciliation invariant afterwards.
32. A change to the reserve/cancel path needs a concurrency test that would fail without it.
33. Test names read as sentences: `it("gives a hot seat to exactly one of 200 concurrent buyers")`.

## Git rules

34. Small, incremental commits that each build and pass tests. Reviewers read the history.
35. Conventional Commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`, `perf:`, `ci:`.
36. Never commit `.env`, secrets, `node_modules`, `dist`, or `docs/commit_history.md`.
37. No force-pushes to `main`.

## AI-assistant rules

38. AI drafts; the author decides. Every design decision is recorded in `docs/memory.md` with who decided it.
39. AI-generated code must be read, understood and explainable by the author before it is committed.
    If the author can't explain a block, it gets simplified or rewritten.
40. AI usage is disclosed honestly in `WRITEUP.md` (directed vs decided).
41. Don't add dependencies, services (Redis, queues) or abstractions beyond what a requirement needs.
42. After each feature, the AI gives the author a short walkthrough: which file, which function, why it's correct,
    and how to change it.
