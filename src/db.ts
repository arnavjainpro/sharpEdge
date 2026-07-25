import { SQL } from "bun";
import { AsyncLocalStorage } from "async_hooks";
import { readFileSync } from "fs";
import { join } from "path";
import { config } from "./config";

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
}

export async function getRiskPrefs(userId: number): Promise<RiskPrefs | null> {
  return await db.query(`SELECT account_equity, max_risk_per_trade_pct, max_position_pct, target_rr_ratio FROM risk_prefs WHERE user_id = ?`).get<RiskPrefs>(userId);
}

export async function setRiskPrefs(userId: number, prefs: RiskPrefs) {
  await db.query(
    `INSERT INTO risk_prefs (user_id, account_equity, max_risk_per_trade_pct, max_position_pct, target_rr_ratio) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET account_equity = excluded.account_equity,
       max_risk_per_trade_pct = excluded.max_risk_per_trade_pct, max_position_pct = excluded.max_position_pct,
       target_rr_ratio = excluded.target_rr_ratio`
  ).run(userId, prefs.account_equity, prefs.max_risk_per_trade_pct, prefs.max_position_pct, prefs.target_rr_ratio);
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
