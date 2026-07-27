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

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_bars_ticker_ts ON bars(ticker, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_ts ON ideas(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_user_ts ON ideas(user_id, ts DESC);
