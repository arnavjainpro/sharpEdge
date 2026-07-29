# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

sharpEdge is a personal trading research and decision-support engine (Bun + TypeScript, single process, no build step). It screens a ~1,500-stock liquid universe, tracks market regime/sector rotation, validates trade ideas through an AI pipeline with deterministic stress tests, analyzes intraday setups from chart screenshots, and prices options structures with a real Black-Scholes engine. See `README.md` for the full feature list, config files, and API surface — it's kept current and is the source of truth for product behavior, not duplicated here.

Read-only throughout: it never places or cancels broker orders.

## Supabase MCP — ask before every use

The Supabase MCP tools (`mcp__*Supabase*`) point at the **live production
database**. There is no staging copy: the same project backs local `bun start`,
the test suite, and real accounts with real positions.

**Ask for explicit permission before every Supabase MCP call, including reads.**
A prior approval covers that one call, not the next one, and not a different
tool in the same family. Say which tool, which project, and what the query does.

Never call `apply_migration`, `execute_sql` with DDL/DML, `create_branch`,
`merge_branch`, `reset_branch`, `delete_branch`, `pause_project`, or
`restore_project` on your own initiative — schema changes belong in
`src/schema.sql`, which `db.exec()` applies on boot.

Prefer the alternatives first, and reach for the MCP only when they genuinely
cannot answer the question:
- a throwaway script against `src/db.ts` (`bun run scripts/…`),
- an existing `*.test.ts` (several already hit the real database),
- the app's own HTTP endpoints.

The one honest reason to prefer the MCP is connection pressure: `bun start`
holds a pool of 15 and a second Bun client will hit
`EMAXCONNSESSION: max clients reached`. That is a reason to ask, not a reason
to skip asking.

## Commands

```bash
bun install                          # install deps
bun start                            # bun run src/index.ts — boots the whole app + dashboard on :3000
bun test                             # run all *.test.ts files
bun test src/ai/queue.test.ts        # run a single test file
bun test -t "pattern"                # run tests whose name matches a pattern
bunx tsc --noEmit                    # typecheck (also `bun run typecheck`)
bun run link:robinhood                # bun run scripts/link-robinhood.ts — one-time Robinhood device auth
bun run scripts/rh-account.ts         # inspect a linked Robinhood account
bun run scripts/reset-accounts.ts     # dry run: what a full account wipe would delete (add --yes to do it)
bun run scripts/migrate-to-supabase.ts  # one-time: migrate an old local SQLite db into Supabase Postgres
```

There is no lint script and no bundler/framework — the backend is plain Bun (`Bun.serve`) and the entire frontend is one static file, `src/server/public/index.html`, served directly (no JSX/React/build pipeline).

Several modules carry an inline self-check instead of a `*.test.ts` file, run via `if (import.meta.main)` — e.g. `bun run src/config.ts` exercises ticker normalization and ET/DST market-hours math directly. Check for one of these before assuming a module is untested.

Requires `.env` (copy `.env.example`): `DATABASE_URL` (Supabase Postgres) and `FINNHUB_API_KEY` are mandatory — the app throws on boot without them. Everything else (Anthropic auth, Telegram, model overrides) is optional; each unset key degrades one feature rather than failing the boot.

`src/deleteIdea.test.ts`, `src/engine/heatmap.test.ts`, `src/auth/signup.test.ts`, `src/auth/emailChange.test.ts`, `src/server/isolation.test.ts`, `src/broker/index.test.ts` and `src/ai/advisor.isolation.test.ts` talk to the **real** configured database — they create and delete throwaway rows (`@example.invalid` users, `__canary_test_sector%` sectors, `fanout-test:%` events). They're the only tests that write; keep them self-cleaning if you extend them, and note that a public test event has no `user_id`, so cleanup must key on the dedupe prefix rather than the owner.

Because they all end by deleting their throwaway account, **every `user_id` foreign key to `users(id)` carries `ON DELETE CASCADE`** — a `DO` block near the end of `schema.sql` enforces this on every boot and rewrites any constraint that drifts, scoped to the `public` schema (this database also hosts Supabase's `auth` schema, whose FKs are not ours). So `DELETE FROM users WHERE id = ?` is sufficient cleanup for anything user-owned; a new table needs no bespoke teardown.

`DELETE FROM users WHERE id = ?` is now sufficient for **every** user-owned table, verified against all of them at once. `ideas` and `alerts` had no FK at all and got one (their `NOT NULL DEFAULT 1` is vestigial — every insert passes `user_id` explicitly). `settings` cannot take one, because its `user_id` doubles as a namespace where `0` means "global" and is part of the composite primary key, so an `AFTER DELETE` trigger on `users` covers it instead; the trigger guards on `id <> 0` so the global namespace can never be wiped.

The one thing still needing an explicit delete is anything keyed by something other than the owner — public `events` are deliberately unowned, so key those on the `dedupe_key` prefix.

Keep cleanup hooks to a handful of set-based statements rather than a loop per row, and pass an explicit timeout (`afterAll(fn, 60_000)`). Dozens of sequential round trips against the 15-connection pool blew bun's 5s default, and a hook that times out midway has already deleted the children but not the account — which is how 74 throwaway accounts ended up stranded in the live database. They are not inert there: the running app treats every row in `users` as a real account, so it kept fetching broker snapshots and paying to triage events for each one.

The cascade rule and the explicit deletes are belt and braces, deliberately. Cascade makes a new user-owned table correct without anyone remembering it; the explicit per-table deletes in the cleanup hooks cover the tables cascade cannot reach.

## Task tracking

sharpEdge planning, TODOs and bug reports live in Jira, project key **SHARP** (`vigneshwinner.atlassian.net`) — not in `docs/` or a TODO file in this repo. When you finish work that closes or advances a ticket, update it (comment + transition status) as part of the same change; when you start work that isn't already tracked, create a ticket rather than letting it exist only in a commit message or chat history.

## Architecture

### Boot and scheduling — `src/index.ts`

Everything is one process. `index.ts` wires ingest → engine → AI → notify together and owns every `setInterval`/`setTimeout` (detectors ~90s/5m/30m by market phase, screener every 6h, sweep every 15m, briefings at 9:00/16:15 ET, broker refresh, etc). There's no job queue or external scheduler — if you're adding a recurring task, it goes here as another `schedule*()` function.

**Background monitoring covers every account** (SHARP-29; `PRIMARY_USER_ID` is gone). The split that makes it affordable, and the rule to follow when adding anything to the pipeline:

- **Detection is shared.** Each ticker in the union of every account's holdings + watchlist is fetched **once** per cycle. `events` has no owner by default and `dedupe_key` is globally UNIQUE, so external API cost is driven by the size of the union, not by users × tickers. `buildWatchMap()` in `engine/fanout.ts` produces `ticker → [userId]`.
- **Interpretation fans out.** Triage, deep analysis and briefings run per account against that account's portfolio, because "is this important" is a question about your positions. This is the part that costs tokens, and it only runs for accounts that actually watch the ticker.
- **Ownership.** Per-user triage lives in `event_triage(event_id, user_id)`; `signals.user_id` and `briefings.user_id` scope private analysis. Most events are public market fact and leave `events.user_id` NULL — the exceptions are `position_close` and `option_expiry`, which are about one account and **must** set both `userId` and a user-qualified `dedupeKey` (otherwise the first holder silences the warning for every other holder).
- **Pushing to the dashboard.** `broadcast()` goes to every connected client (market-wide news only); anything derived from a portfolio uses `broadcastTo(userId, …)`.

If you add a background feature, decide which half it belongs to first. Adding a per-user loop around something detection-shaped multiplies the Finnhub bill; leaving something portfolio-shaped global leaks one account's positions into another's dashboard.

### Layers, in data-flow order

- **`src/ingest/`** — raw external data, no business logic. Yahoo (daily/intraday candles, free), Finnhub (real-time quotes/news/websocket, needs a key), EDGAR (SEC filings), `universe.ts` (NASDAQ symbol master → ~12k stored/searchable tickers, liquidity-filtered down to the ~1,500-name scan subset), `options.ts` (strike chain), `futures.ts`.
- **`src/engine/`** — deterministic math, **zero AI cost**. `screener.ts` (long/short confluence scoring), `technicals.ts`, `market.ts` (regime/breadth/sector rotation), `backtest.ts` (walk-forward, Monte Carlo), `alerts.ts`, `detectors.ts` (raw event generation), `insights.ts` (idea scoreboard/calibration replay), `optionsMath.ts` (Black-Scholes — max loss/gain/breakevens are **always** computed here, never taken on the model's word), `concentration.ts`, `sweep.ts` (15-min full-universe mover promotion), `ticker.ts` (on-demand scoring for any symbol, in-universe or not), `canary.ts` (per-feed shape probes; alerts on the ok↔broken transition only, surfaced in `/api/state`'s `health.canaries` and the header status pill).
- **`src/ai/`** — every Claude call. Two-tier: `triage.ts` (Haiku, cheap severity screen on every event) → `analyst.ts` (deep model, only for high/critical events). Also `validator.ts` (6-dimension idea scoring + stress tests), `intraday.ts` (chart-screenshot analysis), `advisor.ts` (chat + portfolio scoring), `strategy.ts` (backtest spec parsing from plain English), `briefing.ts`, `breaker.ts` (circuit breaker on runaway spend), `queue.ts`.
  - **`claudeQueue()` in `queue.ts` is a mandatory chokepoint** — every `client.messages.create()` call in this codebase is wrapped in it. It throttles to ~3 calls/sec and is the only place token usage gets recorded (`recordSpend` → `ai_spend` table). A new AI call site that bypasses it breaks both rate-limiting and spend tracking.
  - Model selection is centralized in `config.ts` (`modelDeep`/`modelFast`, overridable via `SHARPEDGE_MODEL_DEEP`/`SHARPEDGE_MODEL_FAST`), not hardcoded per call site.
- **`src/broker/`** — position/equity source of truth, priority order **Robinhood link > JSON import > `config/portfolio.yaml`**. `robinhood.ts` talks to undocumented private endpoints (no official API — can break without notice); `index.ts`'s `currentPortfolio(userId)` is what every other layer reads, so it always reflects the freshest source regardless of which one is active.
- **`src/auth/`** — email/password, server-side sessions stored in Postgres (no JWT). Gates the whole app; each user gets their own portfolio/broker link/journal/alerts.
- **`src/notify/`** — macOS native + Telegram. Notifications fire **only** for actionable buy/sell signals (`action: buy|sell|add|trim`), never for informational severity — don't wire a new notification path without that filter.
- **`src/server/server.ts`** — one large `fetch()` handler matching on `url.pathname` (no router library, no middleware chain beyond `auth/middleware.ts`'s manual cookie/session check per route). Adding an endpoint means adding another `if (url.pathname === ...)` branch.

### Data layer — `src/db.ts` + `src/schema.sql`

Postgres (Supabase) accessed through a hand-written shim that mimics the old `bun:sqlite` synchronous API (`db.query(text).get/all/run(...params)`) but is fully async and backed by Bun's native `SQL` client. `?` placeholders are rewritten to `$1..$n` automatically — don't hand-write `$1` style params.

- `db.exec(schema.sql)` runs on every boot; every statement is `CREATE ... IF NOT EXISTS`. **This makes new tables safe but column additions silent no-ops** — a new column on an existing table needs an explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `schema.sql`, or it will never appear.
- `db.transaction(fn)` runs `fn` through an `AsyncLocalStorage`-scoped connection so nested `db.query()` calls inside it automatically join the transaction — no connection object to thread through manually.
- The merged history feed (`historyFeed()`) pages over two tables (`ideas`, `artifacts`) with independent `id` sequences using a row-wise `(ts, src, id)` cursor, not a plain `ts <` comparison — `ts` is second-granularity and multiple rows can land in the same second. Follow this pattern for any future merged/paginated feed across tables.

### Config — `src/config.ts`

Loads `config/portfolio.yaml` (holdings, watchlist, `risk:` sizing knobs) and `config/screener.yaml` (universe filters), plus ET market-hours helpers (`marketPhase`, `nextMarketTransition`, DST-correct). `allTickers()`/`holdingSymbol()` is the single normalization chokepoint that strips option composites (`"MRVL 2026-07-24 203C"`) and crypto (`"SOL-USD"`) out of every ticker list (search, detectors, daily-stats) — extend it there, not at each call site, if a new non-scannable holding shape shows up.
