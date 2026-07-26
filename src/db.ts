import { SQL } from "bun";
import { AsyncLocalStorage } from "async_hooks";
import { readFileSync } from "fs";
import { join } from "path";
import { config, asRiskAppetite, type RiskAppetite } from "./config";

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is not set — point it at your Supabase Postgres connection string (see .env.example).");
}

// Single pooled Postgres client (Supabase). Bun's native SQL client.
export const sql = new SQL(config.databaseUrl);

// Transaction routing: db.transaction(fn) runs fn inside `sql.begin`, and the
// shim below routes every query issued within that async context through the
// transaction connection — so existing call sites need no changes beyond `await`.
const txStore = new AsyncLocalStorage<any>();
const conn = () => txStore.getStore() ?? sql;

// Rewrite bun:sqlite-style `?` placeholders to Postgres `$1..$n`. Safe here: no
// SQL string in this codebase contains a literal `?` outside a bind position.
function toPg(text: string): string {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

// Async shim mirroring the bun:sqlite `db.query(sql).{get,all,run}(...params)`
// surface, backed by Postgres. Every method returns a Promise.
export const db = {
  query(text: string) {
    const pg = toPg(text);
    return {
      get: async <T = any>(...params: any[]): Promise<T | null> =>
        ((await conn().unsafe(pg, params))[0] ?? null) as T | null,
      all: async <T = any>(...params: any[]): Promise<T[]> =>
        (await conn().unsafe(pg, params)) as T[],
      run: async (...params: any[]): Promise<{ changes: number }> => {
        const res = await conn().unsafe(pg, params);
        return { changes: (res as any).count ?? (res as any).length ?? 0 };
      },
    };
  },
  // Runs a raw (possibly multi-statement) SQL script.
  exec: async (text: string): Promise<void> => {
    await sql.unsafe(text).simple();
  },
  // db.transaction(fn) → an async function that runs fn atomically.
  transaction<A extends any[], R>(fn: (...args: A) => R | Promise<R>) {
    return async (...args: A): Promise<R> =>
      (await sql.begin(async (tx: any) => txStore.run(tx, () => fn(...args)))) as R;
  },
};

// Apply the schema on boot (idempotent CREATE TABLE IF NOT EXISTS ...), so a
// fresh Supabase project is provisioned automatically. Top-level await blocks
// importers until the tables exist.
await db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));

export async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await db.query(`SELECT value FROM settings WHERE user_id = 0 AND key = ?`).get<{ value: string }>(key);
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: string) {
  await db.query(`INSERT INTO settings (user_id, key, value) VALUES (0, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// Per-user settings (e.g. broker JSON import blob).
export async function getSettingFor(userId: number, key: string, fallback: string): Promise<string> {
  const row = await db.query(`SELECT value FROM settings WHERE user_id = ? AND key = ?`).get<{ value: string }>(userId, key);
  return row?.value ?? fallback;
}

export async function setSettingFor(userId: number, key: string, value: string) {
  await db.query(`INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(userId, key, value);
}

export interface RiskPrefs {
  account_equity: number | null;
  max_risk_per_trade_pct: number;
  max_position_pct: number;
  target_rr_ratio: number; // minimum R:R for a "strong" rating in idea validation
  risk_appetite: RiskAppetite;
}

export async function getRiskPrefs(userId: number): Promise<RiskPrefs | null> {
  const row = await db.query(`SELECT account_equity, max_risk_per_trade_pct, max_position_pct, target_rr_ratio, risk_appetite FROM risk_prefs WHERE user_id = ?`).get<RiskPrefs>(userId);
  // Rows written before the column existed default to 'balanced' at the DB level,
  // but coerce anyway — this value selects which structures the analyzer may propose.
  return row && { ...row, risk_appetite: asRiskAppetite(row.risk_appetite) };
}

export async function setRiskPrefs(userId: number, prefs: RiskPrefs) {
  await db.query(
    `INSERT INTO risk_prefs (user_id, account_equity, max_risk_per_trade_pct, max_position_pct, target_rr_ratio, risk_appetite) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET account_equity = excluded.account_equity,
       max_risk_per_trade_pct = excluded.max_risk_per_trade_pct, max_position_pct = excluded.max_position_pct,
       target_rr_ratio = excluded.target_rr_ratio, risk_appetite = excluded.risk_appetite`
  ).run(userId, prefs.account_equity, prefs.max_risk_per_trade_pct, prefs.max_position_pct, prefs.target_rr_ratio, asRiskAppetite(prefs.risk_appetite));
}

export interface BrokerLink {
  provider: string;
  auth_json: string;
}

export async function getBrokerLink(userId: number): Promise<BrokerLink | null> {
  return await db.query(`SELECT provider, auth_json FROM broker_links WHERE user_id = ?`).get<BrokerLink>(userId);
}

export async function setBrokerLink(userId: number, provider: string, authJson: string) {
  await db.query(
    `INSERT INTO broker_links (user_id, provider, auth_json, linked_at) VALUES (?, ?, ?, extract(epoch from now())::int)
     ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, auth_json = excluded.auth_json, linked_at = excluded.linked_at`
  ).run(userId, provider, authJson);
}

export async function clearBrokerLink(userId: number) {
  await db.query(`DELETE FROM broker_links WHERE user_id = ?`).run(userId);
}

// ── artifacts: non-idea AI output that survives a refresh ────────────────────
export const ARTIFACT_KINDS = ["portfolio_score", "backtest"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactRow {
  id: number; ts: number; kind: string;
  ticker: string | null; score: number | null; summary: string | null; payload: string;
}

export async function insertArtifact(a: {
  userId: number; kind: ArtifactKind; ticker?: string | null;
  score?: number | null; summary?: string | null; payload: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO artifacts (user_id, ts, kind, ticker, score, summary, payload)
     VALUES (?, extract(epoch from now())::int, ?, ?, ?, ?, ?)`
  ).run(a.userId, a.kind, a.ticker ?? null, a.score ?? null, a.summary ?? null, a.payload);
}

export async function deleteArtifact(userId: number, id: number): Promise<boolean> {
  // Scoped by user_id so an id from another account can't be deleted.
  const rows = await db.query(`DELETE FROM artifacts WHERE user_id = ? AND id = ? RETURNING id`).all(userId, id);
  return rows.length > 0;
}

// Validated ideas and intraday plans live in `ideas`, the other half of the
// history feed. Without this they could only be dismissed from the DOM and came
// straight back on reload — which is what "I can't delete it" meant.
//
// outcomes.idea_id and tracked_trades.idea_id reference this row with no ON
// DELETE rule, so they're detached first, inside one transaction. The journal
// entry and the tracked trade survive on their own; only the link goes.
export async function deleteIdea(userId: number, id: number): Promise<boolean> {
  return await db.transaction(async () => {
    // Ownership is checked before anything is detached: the FKs force the
    // UPDATEs to run first, and an id belonging to another account must not get
    // its journal links cleared on the way to a DELETE that matches nothing.
    const own = await db.query(`SELECT id FROM ideas WHERE id = ? AND user_id = ?`).get(id, userId);
    if (!own) return false;
    await db.query(`UPDATE outcomes SET idea_id = NULL WHERE idea_id = ?`).run(id);
    await db.query(`UPDATE tracked_trades SET idea_id = NULL WHERE idea_id = ?`).run(id);
    await db.query(`DELETE FROM ideas WHERE id = ?`).run(id);
    return true;
  })();
}

export async function scoreHistory(userId: number, limit = 30): Promise<{ ts: number; score: number }[]> {
  const rows = await db.query(
    `SELECT ts, score FROM artifacts
     WHERE user_id = ? AND kind = 'portfolio_score' AND score IS NOT NULL
     ORDER BY ts DESC, id DESC LIMIT ?`
  ).all(userId, limit) as { ts: number; score: number }[];
  return rows.reverse(); // oldest -> newest, ready to plot
}

// Merged history feed over two tables with independent id sequences.
//
// The cursor is row-wise on (ts, src, id), NOT plain `ts < before`: ts is
// second-granularity and /api/ideas/generate writes several rows inside one
// second, so a ts-only cursor drops the rest of the boundary second (with `<`)
// or loops forever (with `<=`). `src` is a literal 'a'/'i' per branch, which
// makes the composite a total order across both tables.
//
// UNION ALL, not UNION: plain UNION would dedupe across the big text payload —
// wrong (rows are never equal) and expensive. Each branch orders and limits
// before the union so idx_ideas_user_ts / idx_artifacts_user_ts get used.
export interface HistoryCursor { ts: number; src: string; id: number }

export async function historyFeed(
  userId: number, limit: number, cursor: HistoryCursor | null, kinds: string[] | null
): Promise<any[]> {
  const wantIdeas = !kinds || kinds.some((k) => k === "idea" || k === "intraday");
  const wantArtifacts = !kinds || kinds.some((k) => (ARTIFACT_KINDS as readonly string[]).includes(k));
  const cur = cursor ? [cursor.ts, cursor.src, cursor.id] : null;
  const branches: string[] = [];
  const params: any[] = [];

  if (wantIdeas) {
    const onlyIntraday = kinds?.includes("intraday") && !kinds.includes("idea");
    const onlyIdeas = kinds?.includes("idea") && !kinds.includes("intraday");
    branches.push(
      `(SELECT ts, 'i' AS src, id, source AS kind, ticker, direction, rating, NULL::int AS score, NULL::text AS summary, report AS payload
        FROM ideas WHERE user_id = ?
        ${onlyIntraday ? "AND source = 'intraday'" : ""}${onlyIdeas ? "AND source != 'intraday'" : ""}
        ${cur ? "AND (ts, 'i', id) < (?, ?, ?)" : ""}
        ORDER BY ts DESC, id DESC LIMIT ?)`
    );
    params.push(userId, ...(cur ?? []), limit);
  }
  if (wantArtifacts) {
    const ks = kinds?.filter((k) => (ARTIFACT_KINDS as readonly string[]).includes(k)) ?? null;
    // Placeholder COUNT is interpolated, never the values — and ks is already
    // filtered to the ARTIFACT_KINDS allowlist, so nothing user-supplied can
    // reach the SQL text. Expanded IN (?,?) rather than = ANY(?) to avoid
    // depending on array-parameter binding.
    branches.push(
      `(SELECT ts, 'a' AS src, id, kind, ticker, NULL::text AS direction, NULL::text AS rating, score, summary, payload
        FROM artifacts WHERE user_id = ?
        ${ks?.length ? `AND kind IN (${ks.map(() => "?").join(",")})` : ""}
        ${cur ? "AND (ts, 'a', id) < (?, ?, ?)" : ""}
        ORDER BY ts DESC, id DESC LIMIT ?)`
    );
    params.push(userId, ...(ks ?? []), ...(cur ?? []), limit);
  }
  if (!branches.length) return [];

  // Wrapped in a subselect: with a single branch (any one-kind filter) a bare
  // `(SELECT ... ORDER BY ... LIMIT) ORDER BY ... LIMIT` is a Postgres syntax
  // error ("multiple ORDER BY clauses not allowed"). The wrapper makes the
  // one-branch and two-branch shapes identical.
  return await db.query(
    `SELECT * FROM (${branches.join(" UNION ALL ")}) feed ORDER BY ts DESC, src DESC, id DESC LIMIT ?`
  ).all(...params, limit) as any[];
}

// Master switch for automatic AI calls (triage, analysis, scheduled briefings).
// User-initiated actions (chat, manual briefing, screener deep-dive) always work.
export const aiLive = async () => (await getSetting("ai_live", "1")) === "1";
export const setAiLive = async (on: boolean) => await setSetting("ai_live", on ? "1" : "0");

export interface EventRow {
  id: number;
  ts: number;
  ticker: string;
  kind: string;
  title: string;
  detail: string | null;
  severity: string | null;
  triage_rationale: string | null;
}

export async function insertEvent(e: {
  ts: number;
  ticker: string;
  kind: string;
  title: string;
  detail?: object;
  dedupeKey: string;
}): Promise<number | null> {
  const res = await db
    .query(
      `INSERT INTO events (ts, ticker, kind, title, detail, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`
    )
    .get<{ id: number }>(e.ts, e.ticker, e.kind, e.title, JSON.stringify(e.detail ?? {}), e.dedupeKey);
  return res?.id ?? null;
}

export async function setTriage(eventId: number, severity: string, rationale: string) {
  await db.query(`UPDATE events SET severity = ?, triage_rationale = ? WHERE id = ?`).run(
    severity,
    rationale,
    eventId
  );
}

export async function insertSignal(s: {
  event_id: number;
  ticker: string;
  action: string;
  conviction: string;
  plain_headline: string;
  thesis: string;
  invalidation: string;
  portfolio_impact: string;
}): Promise<number> {
  const res = await db
    .query(
      `INSERT INTO signals (event_id, ts, ticker, action, conviction, plain_headline, thesis, invalidation, portfolio_impact)
       VALUES (?, extract(epoch from now())::int, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get<{ id: number }>(s.event_id, s.ticker, s.action, s.conviction, s.plain_headline, s.thesis, s.invalidation, s.portfolio_impact);
  return res!.id;
}

export async function upsertBar(ticker: string, ts: number, o: number, h: number, l: number, c: number, v: number) {
  await db.query(
    `INSERT INTO bars (ticker, ts, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, ts) DO UPDATE SET high=GREATEST(bars.high,excluded.high), low=LEAST(bars.low,excluded.low),
       close=excluded.close, volume=bars.volume+excluded.volume`
  ).run(ticker, ts, o, h, l, c, v);
}

export async function recentBars(ticker: string, limit = 120): Promise<{ ts: number; open: number; high: number; low: number; close: number; volume: number }[]> {
  return (await db
    .query(`SELECT ts, open, high, low, close, volume FROM bars WHERE ticker = ? ORDER BY ts DESC LIMIT ?`)
    .all(ticker, limit))
    .reverse() as any;
}

// ── F1b: AI spend logging ────────────────────────────────────────────────────
// Fire-and-forget insert of one Anthropic response's token usage. Never throws
// into the AI call path (a logging failure must not break analysis).
export async function recordSpend(model: string, u: {
  input_tokens?: number; output_tokens?: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ai_spend (ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES (extract(epoch from now())::int, ?, ?, ?, ?, ?)`
    ).run(model, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0);
  } catch { /* logging is best-effort */ }
}

export interface SpendDay {
  day: string; calls: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
}

// Token usage grouped by day (ET) for the last `days` days (Settings card).
export async function spendByDay(days = 7): Promise<SpendDay[]> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return await db.query(
    `SELECT to_char(to_timestamp(ts) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS calls,
            SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens,
            SUM(cache_read_tokens)::int AS cache_read_tokens, SUM(cache_write_tokens)::int AS cache_write_tokens
     FROM ai_spend WHERE ts > ? GROUP BY day ORDER BY day DESC`
  ).all<SpendDay>(since);
}
