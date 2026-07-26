# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

sharpEdge is a personal trading research and decision-support engine (Bun + TypeScript, single process, no build step). It screens a ~1,500-stock liquid universe, tracks market regime/sector rotation, validates trade ideas through an AI pipeline with deterministic stress tests, analyzes intraday setups from chart screenshots, and prices options structures with a real Black-Scholes engine. See `README.md` for the full feature list, config files, and API surface — it's kept current and is the source of truth for product behavior, not duplicated here.

Read-only throughout: it never places or cancels broker orders.

## Commands

```bash
bun install                          # install deps
bun start                            # bun run src/index.ts — boots the whole app + dashboard on :3000
bun test                             # run all *.test.ts files
bun test src/ai/queue.test.ts        # run a single test file
bun test -t "pattern"                # run tests whose name matches a pattern
bunx tsc --noEmit                    # typecheck (also `bun run typecheck`)
bun run link:robinhood                # bun run scripts/link-robinhood.ts — one-time Robinhood device auth
bun run test:email you@example.com    # send one real email to check RESEND_API_KEY/EMAIL_FROM
bun run scripts/rh-account.ts         # inspect a linked Robinhood account
bun run scripts/migrate-to-supabase.ts  # one-time: migrate an old local SQLite db into Supabase Postgres
```

There is no lint script and no bundler/framework — the backend is plain Bun (`Bun.serve`) and the entire frontend is one static file, `src/server/public/index.html`, served directly (no JSX/React/build pipeline).

Several modules carry an inline self-check instead of a `*.test.ts` file, run via `if (import.meta.main)` — e.g. `bun run src/config.ts` exercises ticker normalization and ET/DST market-hours math directly. Check for one of these before assuming a module is untested.

Requires `.env` (copy `.env.example`): `DATABASE_URL` (Supabase Postgres) and `FINNHUB_API_KEY` are mandatory — the app throws on boot without them. Everything else (Anthropic auth, Telegram, `RESEND_API_KEY`, model overrides) is optional; each unset key degrades one feature rather than failing the boot.

`src/auth/emailChange.test.ts` and `src/engine/heatmap.test.ts` talk to the **real** configured database — they create and delete throwaway rows (`@example.invalid` users, `__canary_test_sector%` sectors). They're the only tests that write; keep them self-cleaning if you extend them.

## Architecture

### Boot and scheduling — `src/index.ts`

Everything is one process. `index.ts` wires ingest → engine → AI → notify together and owns every `setInterval`/`setTimeout` (detectors ~90s/5m/30m by market phase, screener every 6h, sweep every 15m, briefings at 9:00/16:15 ET, broker refresh, etc). There's no job queue or external scheduler — if you're adding a recurring task, it goes here as another `schedule*()` function.

**Background monitoring is single-tenant.** `PRIMARY_USER_ID = 1` (whoever signed up first) is the only account the detector/triage/briefing pipeline watches. Other users get the interactive, on-demand endpoints (validate, generate, intraday, chat, journal, their own linked broker) but no independent background event monitoring. This asymmetry is easy to miss when reading a single file — check `index.ts` before assuming a new background feature applies per-user.

### Layers, in data-flow order

- **`src/ingest/`** — raw external data, no business logic. Yahoo (daily/intraday candles, free), Finnhub (real-time quotes/news/websocket, needs a key), EDGAR (SEC filings), `universe.ts` (NASDAQ symbol master → ~12k stored/searchable tickers, liquidity-filtered down to the ~1,500-name scan subset), `options.ts` (strike chain), `futures.ts`.
- **`src/engine/`** — deterministic math, **zero AI cost**. `screener.ts` (long/short confluence scoring), `technicals.ts`, `market.ts` (regime/breadth/sector rotation), `backtest.ts` (walk-forward, Monte Carlo), `alerts.ts`, `detectors.ts` (raw event generation), `insights.ts` (idea scoreboard/calibration replay), `optionsMath.ts` (Black-Scholes — max loss/gain/breakevens are **always** computed here, never taken on the model's word), `concentration.ts`, `sweep.ts` (15-min full-universe mover promotion), `ticker.ts` (on-demand scoring for any symbol, in-universe or not), `canary.ts` (per-feed shape probes; alerts on the ok↔broken transition only, surfaced in `/api/state`'s `health.canaries` and the header status pill).
- **`src/ai/`** — every Claude call. Two-tier: `triage.ts` (Haiku, cheap severity screen on every event) → `analyst.ts` (deep model, only for high/critical events). Also `validator.ts` (6-dimension idea scoring + stress tests), `intraday.ts` (chart-screenshot analysis), `advisor.ts` (chat + portfolio scoring), `strategy.ts` (backtest spec parsing from plain English), `briefing.ts`, `breaker.ts` (circuit breaker on runaway spend), `queue.ts`.
  - **`claudeQueue()` in `queue.ts` is a mandatory chokepoint** — every `client.messages.create()` call in this codebase is wrapped in it. It throttles to ~3 calls/sec and is the only place token usage gets recorded (`recordSpend` → `ai_spend` table). A new AI call site that bypasses it breaks both rate-limiting and spend tracking.
  - Model selection is centralized in `config.ts` (`modelDeep`/`modelFast`, overridable via `SHARPEDGE_MODEL_DEEP`/`SHARPEDGE_MODEL_FAST`), not hardcoded per call site.
- **`src/broker/`** — position/equity source of truth, priority order **Robinhood link > JSON import > `config/portfolio.yaml`**. `robinhood.ts` talks to undocumented private endpoints (no official API — can break without notice); `index.ts`'s `currentPortfolio(userId)` is what every other layer reads, so it always reflects the freshest source regardless of which one is active.
- **`src/auth/`** — email/password, server-side sessions stored in Postgres (no JWT). Gates the whole app; each user gets their own portfolio/broker link/journal/alerts.
- **`src/notify/`** — macOS native + Telegram for alerts; `email.ts` (Resend HTTP API, no dep) is separate and is **not** an alert channel — it exists solely to verify a new sign-in address. Alert notifications fire **only** for actionable buy/sell signals (`action: buy|sell|add|trim`), never for informational severity — don't wire a new notification path without that filter.
- **`src/server/server.ts`** — one large `fetch()` handler matching on `url.pathname` (no router library, no middleware chain beyond `auth/middleware.ts`'s manual cookie/session check per route). Adding an endpoint means adding another `if (url.pathname === ...)` branch.

### Data layer — `src/db.ts` + `src/schema.sql`

Postgres (Supabase) accessed through a hand-written shim that mimics the old `bun:sqlite` synchronous API (`db.query(text).get/all/run(...params)`) but is fully async and backed by Bun's native `SQL` client. `?` placeholders are rewritten to `$1..$n` automatically — don't hand-write `$1` style params.

- `db.exec(schema.sql)` runs on every boot; every statement is `CREATE ... IF NOT EXISTS`. **This makes new tables safe but column additions silent no-ops** — a new column on an existing table needs an explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `schema.sql`, or it will never appear.
- `db.transaction(fn)` runs `fn` through an `AsyncLocalStorage`-scoped connection so nested `db.query()` calls inside it automatically join the transaction — no connection object to thread through manually.
- The merged history feed (`historyFeed()`) pages over two tables (`ideas`, `artifacts`) with independent `id` sequences using a row-wise `(ts, src, id)` cursor, not a plain `ts <` comparison — `ts` is second-granularity and multiple rows can land in the same second. Follow this pattern for any future merged/paginated feed across tables.

### Config — `src/config.ts`

Loads `config/portfolio.yaml` (holdings, watchlist, `risk:` sizing knobs) and `config/screener.yaml` (universe filters), plus ET market-hours helpers (`marketPhase`, `nextMarketTransition`, DST-correct). `allTickers()`/`holdingSymbol()` is the single normalization chokepoint that strips option composites (`"MRVL 2026-07-24 203C"`) and crypto (`"SOL-USD"`) out of every ticker list (search, detectors, daily-stats) — extend it there, not at each call site, if a new non-scannable holding shape shows up.
