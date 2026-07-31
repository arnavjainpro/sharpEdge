-- sharpEdge Postgres schema (Supabase). Translated from the original bun:sqlite
-- schema. Integer unix-second timestamps use int4 (fits until 2038, returns as a
-- JS number); prices/volumes/scores use double precision; booleans stay 0/1
-- integers to match the app's existing logic.

CREATE TABLE IF NOT EXISTS bars (
  ticker text NOT NULL,
  ts integer NOT NULL,               -- unix seconds, minute-aligned
  open double precision, high double precision, low double precision,
  close double precision, volume double precision,
  PRIMARY KEY (ticker, ts)
);

CREATE TABLE IF NOT EXISTS daily_stats (
  ticker text PRIMARY KEY,
  avg_volume_20d double precision,
  prev_close double precision,
  week52_high double precision,
  week52_low double precision,
  updated_at integer
);

CREATE TABLE IF NOT EXISTS events (
  id serial PRIMARY KEY,
  ts integer NOT NULL,
  ticker text NOT NULL,
  kind text NOT NULL,                -- price_move | volume_spike | gap | week52 | news | filing | earnings
  title text NOT NULL,
  detail text,                       -- JSON payload from the detector
  dedupe_key text UNIQUE,            -- prevents re-alerting the same underlying event
  severity text,                     -- set by triage: critical | high | info
  triage_rationale text
);

CREATE TABLE IF NOT EXISTS signals (
  id serial PRIMARY KEY,
  event_id integer REFERENCES events(id),
  ts integer NOT NULL,
  ticker text NOT NULL,
  action text NOT NULL,              -- buy | sell | trim | add | hold | watch
  conviction text NOT NULL,          -- high | medium | low
  thesis text NOT NULL,
  invalidation text,
  portfolio_impact text,
  plain_headline text
);

CREATE TABLE IF NOT EXISTS briefings (
  id serial PRIMARY KEY,
  ts integer NOT NULL,
  kind text NOT NULL,                -- open | close
  content text NOT NULL
);

CREATE TABLE IF NOT EXISTS screener (
  ticker text PRIMARY KEY,
  score double precision NOT NULL,
  cross_status text NOT NULL,        -- golden_formed | golden_soon | death_formed | none
  indicators text NOT NULL,          -- JSON blob of computed factors
  updated_at integer NOT NULL,
  long_score double precision,
  short_score double precision,
  direction text,
  sector text
);

CREATE TABLE IF NOT EXISTS settings (
  user_id integer NOT NULL DEFAULT 0,  -- 0 = global (background pipeline switches, not per-user)
  key text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at integer NOT NULL,
  full_name text,
  phone text
);

CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Signups awaiting email verification. Deliberately a separate table and NOT a
-- `verified` flag on `users`: since SHARP-29 every row in users joins
-- monitoredUserIds(), so an unverified row would immediately start spending
-- Finnhub calls and AI tokens on a portfolio nobody has proven they own — and
-- it would hold the UNIQUE email slot, letting anyone squat an address they
-- don't control. Keeping them apart preserves the invariant "a row in users is
-- a real, verified account", so nothing downstream needs to learn about
-- verification at all. Verified status here IS the promotion into users.
CREATE TABLE IF NOT EXISTS pending_signups (
  email text PRIMARY KEY,
  password_hash text NOT NULL,       -- already bcrypt-hashed, never plaintext
  code text NOT NULL,                -- 6 digits, uniformly sampled from a CSPRNG
  expires_at integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0,  -- 6 digits is only ~20 bits, so the cap is
                                        -- the real defence, not the expiry window
  created_at integer NOT NULL,
  verified_at integer                -- NULL until the code comes back, set exactly once,
                                     -- so a resubmit reads as "already done", not an error
);
-- CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so any earlier
-- shape has to be moved forward by hand: 73c8b86 shipped this without
-- verified_at, and an intermediate build swapped `code` for a link token. The
-- table has never held a row, so none of this touches real data.
ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS verified_at integer;
ALTER TABLE pending_signups DROP COLUMN IF EXISTS token;
DROP INDEX IF EXISTS idx_pending_signups_token;

-- An in-flight email change (SHARP-17). The new address lives here, NOT in
-- users.email, until a code mailed to it comes back — so an unverified or
-- mistyped address can never become the thing you sign in with. At most one
-- pending change per user, which is why these are columns and not a table like
-- pending_signups (which needs one row per not-yet-a-user, keyed on the email
-- itself — there's no user id to hang columns off yet).
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_code text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_expires integer;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_attempts integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS broker_links (
  user_id integer PRIMARY KEY REFERENCES users(id),
  provider text NOT NULL,
  auth_json text NOT NULL,
  linked_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  id serial PRIMARY KEY,
  ts integer NOT NULL,
  ticker text NOT NULL,
  direction text NOT NULL,           -- long | short
  rating text NOT NULL,              -- strong | moderate | weak | reject
  confidence text NOT NULL,          -- high | medium | low
  source text NOT NULL,              -- validate | generate | intraday
  report text NOT NULL,              -- full JSON IdeaReport
  user_id integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS trade_outcomes (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  ticker text NOT NULL,
  direction text NOT NULL,           -- long | short
  idea_id integer REFERENCES ideas(id),
  entry_price double precision,
  exit_price double precision,
  outcome text NOT NULL,             -- win | loss | breakeven
  pnl_pct double precision,
  notes text,
  closed_at integer NOT NULL,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_user_ticker ON trade_outcomes(user_id, ticker);
CREATE INDEX IF NOT EXISTS idx_outcomes_user_closed ON trade_outcomes(user_id, closed_at DESC);

CREATE TABLE IF NOT EXISTS risk_prefs (
  user_id integer PRIMARY KEY REFERENCES users(id),
  account_equity double precision,
  max_risk_per_trade_pct double precision NOT NULL DEFAULT 1,
  max_position_pct double precision NOT NULL DEFAULT 20,
  target_rr_ratio double precision NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS universe (
  ticker text PRIMARY KEY,
  name text,
  sector text,                       -- NASDAQ sector taxonomy (Technology, Finance, ...)
  industry text,
  market_cap double precision,       -- USD
  last_price double precision,
  day_volume double precision,       -- most recent session share volume
  sp500 integer DEFAULT 0,           -- 1 = current S&P 500 constituent
  in_scan integer DEFAULT 0,         -- 1 = inside the active screener universe
  updated_at integer
);

CREATE TABLE IF NOT EXISTS market_snapshot (
  id integer PRIMARY KEY CHECK (id = 1),  -- single-row current snapshot
  ts integer NOT NULL,
  regime text NOT NULL,              -- JSON: trend/volatility/breadth/riskOff/label
  sectors text NOT NULL,             -- JSON: per-sector rotation stats
  benchmarks text NOT NULL           -- JSON: SPY/QQQ/IWM/VIX quick stats
);

-- F6a: append-only sector rotation history (market_snapshot is a singleton).
CREATE TABLE IF NOT EXISTS sector_history (
  sector text NOT NULL,
  ts integer NOT NULL,
  state text NOT NULL,               -- leading | improving | weakening | lagging
  rel1m double precision,            -- relative strength vs SPY (heatmap intensity)
  PRIMARY KEY (sector, ts)
);
CREATE INDEX IF NOT EXISTS idx_sector_history ON sector_history(sector, ts DESC);

-- F2b: open trades the user is tracking toward a journal entry (closed-only
-- trade_outcomes is kept separate so open positions never pollute AI context).
CREATE TABLE IF NOT EXISTS tracked_trades (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  ticker text NOT NULL,
  direction text NOT NULL,           -- long | short
  idea_id integer REFERENCES ideas(id),
  entry_price double precision,
  opened_at integer NOT NULL,
  UNIQUE(user_id, ticker, direction)
);
CREATE INDEX IF NOT EXISTS idx_tracked_user ON tracked_trades(user_id, opened_at DESC);

-- F2b: last-seen broker positions per user — the baseline the close detector
-- diffs the next Robinhood snapshot against.
CREATE TABLE IF NOT EXISTS broker_positions (
  user_id integer PRIMARY KEY REFERENCES users(id),
  positions text NOT NULL,           -- JSON PosSnap[]
  close_seq integer NOT NULL DEFAULT 0,
  updated_at integer NOT NULL
);

-- SHARP-28: last GOOD broker snapshot per user, so a restart doesn't blank the
-- portfolio. `cached` in broker/index.ts is process memory; this is the copy
-- that survives. Only a real provider (robinhood/import) is ever written here —
-- persisting a yaml fallback would let one failed refresh destroy the very
-- snapshot this table exists to protect.
CREATE TABLE IF NOT EXISTS broker_snapshots (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  snapshot text NOT NULL,            -- JSON BrokerSnapshot
  source text NOT NULL,              -- robinhood | import (never 'manual', the yaml fallback)
  as_of integer NOT NULL,            -- the snapshot's OWN time, not the write time
  updated_at integer NOT NULL
);

-- F1b: per-call Anthropic token usage so AI spend is never invisible.
CREATE TABLE IF NOT EXISTS ai_spend (
  id serial PRIMARY KEY,
  ts integer NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_spend_ts ON ai_spend(ts DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL DEFAULT 1,  -- owner; the global evaluator fires them all to the shared notify channel
  ticker text NOT NULL,
  kind text NOT NULL,                -- price_above | price_below | score_gte
  threshold double precision NOT NULL,
  last_value double precision,       -- last observed value; seeds crossing detection
  active integer NOT NULL DEFAULT 1,
  created_ts integer NOT NULL,
  last_fired_ts integer,
  recurring integer NOT NULL DEFAULT 0,
  UNIQUE(user_id, ticker, kind, threshold)   -- double-click "create alert" = one row, not two
);

-- Non-idea AI artifacts that used to vanish on refresh (portfolio scores,
-- backtests). One table with a `kind` discriminator mirrors the existing
-- ideas.source pattern rather than a table per kind.
--
-- `score` is nullable on purpose: scorePortfolio() returns markdown, so the
-- 0-100 is extracted from prose at write time and may legitimately be absent.
-- `summary` is likewise not NOT NULL — never constrain on a value parsed out
-- of model output.
CREATE TABLE IF NOT EXISTS artifacts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  ts integer NOT NULL,
  kind text NOT NULL,                -- portfolio_score | backtest | practice
  ticker text,                       -- null for portfolio_score
  score integer,                     -- 0-100 for portfolio_score, null otherwise
  summary text,                      -- one-line for the history feed
  payload text NOT NULL              -- full JSON
);
CREATE INDEX IF NOT EXISTS idx_artifacts_user_ts ON artifacts(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_user_kind ON artifacts(user_id, kind, ts DESC);

-- Practice drills: a past chart with the future hidden, the user's committed
-- plan, and the grade. `ticker` and `as_of_ts` live here rather than in the
-- client so the answer can't be read out of the network tab or replayed with a
-- different as-of point.
CREATE TABLE IF NOT EXISTS practice_attempts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  ts integer NOT NULL,               -- drill created
  ticker text NOT NULL,              -- withheld from the client until graded
  as_of_ts integer NOT NULL,         -- last bar the user was allowed to see
  horizon integer NOT NULL,          -- bars revealed on grade
  status text NOT NULL,              -- open | graded
  direction text,                    -- long | short | no_trade
  entry double precision,
  stop double precision,
  target double precision,
  outcome text,                      -- win | loss | open | pass_correct | pass_missed
  r_multiple double precision,       -- planned R; null for an unresolved or passed drill
  process_score integer,             -- 0-100, computed from the plan alone
  process_detail text,               -- JSON: per-criterion breakdown
  graded_at integer
);
CREATE INDEX IF NOT EXISTS idx_practice_user_ts ON practice_attempts(user_id, ts DESC);

-- NOTE: db.ts applies this file on every boot, and every statement here is
-- CREATE ... IF NOT EXISTS. That provisions NEW tables on an existing database
-- but silently no-ops for new COLUMNS on existing tables. Adding a column later
-- requires its own explicit line:
--   ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <col> <type>;

-- Which options structures the swing analyzer may propose for this trader.
-- 'balanced' matches the behavior every existing row had before the setting existed.
ALTER TABLE risk_prefs ADD COLUMN IF NOT EXISTS risk_appetite text NOT NULL DEFAULT 'balanced';

-- SHARP-32: drills moved from daily bars to 15-minute bars. A drill's numbers
-- only mean something next to other drills posed the SAME way, so the cohort it
-- was created under is stamped on the row and practiceStats() filters to one
-- cohort. Without this, "Avg R" would silently average a 40-day-horizon swing
-- drill with a 26-bar intraday one.
--
-- The defaults are deliberately the OLD values: every row that already exists
-- was posed with 120 daily bars under the v1 grader, so the default backfills
-- history truthfully. A '15m' default here would relabel real daily drills as
-- intraday and corrupt the very stats this is meant to protect.
ALTER TABLE practice_attempts ADD COLUMN IF NOT EXISTS interval text NOT NULL DEFAULT '1d';
ALTER TABLE practice_attempts ADD COLUMN IF NOT EXISTS visible_bars integer NOT NULL DEFAULT 120;
ALTER TABLE practice_attempts ADD COLUMN IF NOT EXISTS grading_version integer NOT NULL DEFAULT 1;
-- (horizon is NOT duplicated here — practice_attempts.horizon above already
--  stores exactly the forward bar count.)

-- The bars the drill was actually posed with, stored at creation.
-- Grading used to re-fetch from Yahoo and match on as_of_ts, which meant a drill
-- could become ungradeable once the rolling intraday window advanced past it,
-- and could be graded against revised OHLC values the trader never saw. Storing
-- the issued slice makes grading deterministic and offline. NULL on legacy rows,
-- which still take the re-fetch path.
ALTER TABLE practice_attempts ADD COLUMN IF NOT EXISTS bars text;

-- SHARP-29: background monitoring fans out to every account.
--
-- `events` stays GLOBAL and is deliberately not given a user_id. An event is a
-- fact about the market — a 6% move on NVDA is the same event no matter who is
-- watching — and dedupe_key is UNIQUE across the table, which is what lets the
-- detector fetch each ticker once instead of once per user. Duplicating rows
-- per user would break that dedupe and multiply the Finnhub call budget.
--
-- What IS per-user is the interpretation: triage weighs the event against your
-- holdings, so the same event is "critical" to a holder and "info" to everyone
-- else. That lives here, one row per (event, user).
--
-- ...with one exception. Most events are public (a price move, a filing, a
-- headline), but a couple are inherently about ONE account: "you closed NVDA,
-- journal it?" and "your calls expire tomorrow". Those set user_id and are shown
-- only to their owner. NULL means public market fact, which is the default and
-- the overwhelming majority.
ALTER TABLE events ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_events_owner ON events(user_id, ts DESC);

CREATE TABLE IF NOT EXISTS event_triage (
  event_id integer NOT NULL REFERENCES events(id),
  user_id integer NOT NULL REFERENCES users(id),
  severity text NOT NULL,            -- critical | high | info, for THIS user
  rationale text,
  ts integer NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_triage_user ON event_triage(user_id, event_id);

-- Signals and briefings are private analysis, not market fact — they name your
-- positions and your sizing, so they are owned. NULL means "written before the
-- fan-out existed", backfilled to user 1 below.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id);
ALTER TABLE briefings ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_signals_user ON signals(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_briefings_user ON briefings(user_id, ts DESC);

-- One-time backfill: everything written before this change was produced against
-- the single account the pipeline used to watch.
-- Idempotent — every row inserted from now on carries a user_id, so after the
-- first boot this matches nothing.
--
-- Resolved rather than hard-coded to 1. Both columns are REFERENCES users(id),
-- and this file is applied on EVERY boot, so a database whose lowest account id
-- is not 1 (any environment seeded after the original single-user one) would
-- fail the FK here and take down db.ts import — meaning no boot and no tests.
-- The EXISTS guard covers a fresh, empty users table for the same reason.
UPDATE signals   SET user_id = (SELECT min(id) FROM users)
  WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users);
UPDATE briefings SET user_id = (SELECT min(id) FROM users)
  WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_bars_ticker_ts ON bars(ticker, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_ts ON ideas(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_user_ts ON ideas(user_id, ts DESC);

-- Monetization (freemium + a single $24/mo Pro tier).
--
-- 'plan' gates the AI-heavy, higher-cost features (validation, backtest, chat
-- advisor, intraday, briefings, journal-that-learns) and lifts the free-tier
-- usage ceilings. The DEFAULT is 'free' so every existing account, and every
-- new signup, starts on the free tier — nobody is silently granted Pro. Values:
-- 'free' | 'pro'. Billing (Stripe) flips this column via webhook; until then it
-- is only ever 'free' in practice, which is the safe closed state.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_since integer;

-- Per-user, per-metric usage meter for the free-tier ceilings (e.g. 3 AI
-- validations and 1 backtest per calendar month). `period` is a coarse bucket
-- string — 'YYYY-MM' for monthly counters — so a new month is simply a new row
-- and old rows are self-expiring history, no cron sweep needed. The PK makes
-- the increment an idempotent UPSERT target. Pro accounts never write here;
-- their ceilings are unlimited so entitlements.ts short-circuits before metering.
CREATE TABLE IF NOT EXISTS usage_counters (
  user_id integer NOT NULL REFERENCES users(id),
  metric text NOT NULL,              -- 'ai_validation' | 'backtest' | ...
  period text NOT NULL,              -- 'YYYY-MM' for monthly ceilings
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, metric, period)
);
CREATE INDEX IF NOT EXISTS idx_usage_counters_user ON usage_counters(user_id, period);

-- Every time a free user hits the paywall and clicks "Upgrade to Pro" we log it
-- here. Until Stripe checkout exists this is the product's most valuable number:
-- how many people, on which feature, wanted to pay. Append-only; one row per
-- click (a user can appear many times, which is itself signal — they kept trying).
CREATE TABLE IF NOT EXISTS billing_interest (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  feature text,                      -- which gate triggered the paywall
  reason text,                       -- 'pro_only' | 'limit_reached'
  ts integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_interest_ts ON billing_interest(ts DESC);
