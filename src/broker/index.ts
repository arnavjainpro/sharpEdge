// Broker resolution + cached snapshot. Priority: linked brokerage (Robinhood) >
// one-shot JSON import > portfolio.yaml. YAML theses are merged onto broker
// positions by ticker either way, so "why you own it" survives auto-linking.
import { loadPortfolio, loadRiskConfig, type Portfolio, type RiskConfig } from "../config";
import { db, getRiskPrefs, getSettingFor, setSettingFor, insertEvent } from "../db";
import { yamlProvider, importProvider } from "./manual";
import { robinhoodProvider } from "./robinhood";
import { closeDetect, type PosSnap } from "./closeDetect";
import { cachedQuote } from "../ingest/finnhub";
import { isFuture } from "../ingest/futures";
import { notifyTelegram, telegramEnabled } from "../notify/telegram";
import type { BrokerSnapshot } from "./types";

// Priority: linked Robinhood > one-shot import > portfolio.yaml.
const providers = [robinhoodProvider, importProvider, yamlProvider];

// Per-user cache — each signed-in user may have their own linked broker/import.
const cached = new Map<number, BrokerSnapshot>();
const inFlight = new Map<number, Promise<BrokerSnapshot>>();

export async function refreshBroker(userId: number): Promise<BrokerSnapshot> {
  // Collapse concurrent refreshes per user (interval timer + user clicking Refresh).
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const p = doRefresh(userId).finally(() => { inFlight.delete(userId); });
  inFlight.set(userId, p);
  return p;
}

// Watchlist-edit overlays. Applied on every path that returns a snapshot to
// the caller — including the stale-fallback path below — so a just-saved
// watchlist change is never silently absent from a response just because the
// live provider happened to fail on that poll.
//
// The manual account_equity is deliberately NOT overlaid here: it's an
// analyzer-only bankroll (position sizing in intraday/swing), not a portfolio
// figure. Overlaying it used to pin the dashboard's displayed equity to the
// typed value, so live broker equity never moved on refresh. The override now
// lives only in positionSizing()/accountContextText().
async function applyOverlays(userId: number, snap: BrokerSnapshot): Promise<BrokerSnapshot> {
  const wp = await watchlistPrefs(userId);
  snap.watchlist = [...new Set([...snap.watchlist, ...wp.add])].filter((t) => !wp.remove.includes(t));
  return snap;
}

// ── SHARP-28: durable last-good snapshot ─────────────────────────────────────
// `cached` above is process memory, so killing the port used to throw away every
// account's positions. These two helpers give the in-memory stale-fallback below
// something to fall back TO after a restart.
//
// Only a real provider is ever written. "manual" is the portfolio.yaml
// fallback: persisting it would mean the first failed Robinhood refresh after a
// restart overwrites the good snapshot with a near-empty one — destroying
// exactly what this exists to protect.
export async function persistSnapshot(userId: number, snap: BrokerSnapshot): Promise<void> {
  if (snap.source === "manual") return;
  try {
    await db.query(
      `INSERT INTO broker_snapshots (user_id, snapshot, source, as_of, updated_at)
       VALUES (?, ?, ?, ?, extract(epoch from now())::int)
       ON CONFLICT(user_id) DO UPDATE SET snapshot = excluded.snapshot, source = excluded.source,
         as_of = excluded.as_of, updated_at = excluded.updated_at`
    ).run(userId, JSON.stringify(snap), snap.source, snap.asOf);
  } catch (err) {
    // Never let a bookkeeping write fail a refresh the caller already succeeded at.
    console.error(`[broker] persist failed for user ${userId}:`, err);
  }
}

export async function loadPersisted(userId: number): Promise<BrokerSnapshot | null> {
  try {
    const row = await db.query(`SELECT snapshot FROM broker_snapshots WHERE user_id = ?`)
      .get(userId) as { snapshot: string } | null;
    if (!row) return null;
    const snap = JSON.parse(row.snapshot) as BrokerSnapshot;
    // A corrupt row must degrade to the yaml path, not throw on a boot request.
    if (!Array.isArray(snap?.holdings)) return null;
    // The last-good rule is enforced on the way in AND on the way out. Nothing
    // writes a 'manual' row today, but this table outlives any one writer — a
    // migration, a hand-run INSERT, or a future caller that forgets the rule
    // would otherwise get a portfolio.yaml snapshot restored as "last good",
    // which is exactly the silent downgrade persistSnapshot exists to prevent.
    if (snap.source === "manual") {
      console.warn(`[broker] ignoring persisted 'manual' snapshot for user ${userId} — not a last-good source`);
      return null;
    }
    return snap;
  } catch (err) {
    console.error(`[broker] persisted snapshot unreadable for user ${userId}:`, err);
    return null;
  }
}

// Unlinking a broker must also retire its durable copy, or a later failed
// refresh would restore positions from an account the user just disconnected.
export async function retirePersistedSnapshot(userId: number): Promise<void> {
  try {
    await db.query(`DELETE FROM broker_snapshots WHERE user_id = ?`).run(userId);
    cached.delete(userId);
  } catch (err) {
    console.error(`[broker] failed to retire persisted snapshot for user ${userId}:`, err);
  }
}

async function doRefresh(userId: number): Promise<BrokerSnapshot> {
  for (const p of providers) {
    if (!(await p.available(userId))) continue;
    try {
      const snap = await p.fetchSnapshot(userId);
      // Merge YAML context: theses onto positions, watchlist union, equity fallback.
      if (p.name !== "manual") {
        const yaml = loadPortfolio();
        const theses = new Map(yaml.holdings.filter((h) => h.thesis).map((h) => [h.ticker, h.thesis!]));
        for (const h of snap.holdings) {
          const t = theses.get(h.ticker);
          if (t) h.thesis = t;
        }
        snap.watchlist = [...new Set([...snap.watchlist, ...yaml.watchlist])];
        // Do NOT fall back to the risk-prefs equity here: that's the analyzer
        // bankroll the trader types into the Analyze form, and borrowing it for
        // the portfolio's displayed equity is exactly the leak we're removing.
        // A live provider with a null equity shows "unknown", never the bankroll.
      }
      await applyOverlays(userId, snap);
      cached.set(userId, snap);
      await persistSnapshot(userId, snap);
      console.log(
        `[broker] snapshot via ${snap.source} (user ${userId}): ${snap.holdings.length} positions, ${snap.watchlist.length} watched, ` +
        `${snap.openOrders.length} open orders${snap.account.equity != null ? `, equity $${snap.account.equity.toLocaleString()}` : ""}`
      );
      // F2b: only ever diff robinhood-vs-robinhood (real fills) — a fallback or
      // import snapshot must never touch the baseline. Runs for every account
      // with a live link now (SHARP-29); broker_positions is already keyed by
      // user_id, so the baselines never collided, they were just never written.
      if (snap.source === "robinhood") {
        try { await detectAndRecordCloses(userId, snap); } catch (err) { console.error("[broker] close-detect failed:", err); }
      }
      return snap;
    } catch (err) {
      console.error(`[broker] ${p.name} failed for user ${userId}:`, err);
      // A transient failure of a live provider must NOT downgrade the cached
      // snapshot to a lower-priority source — options/positions would silently
      // vanish from the dashboard until the next successful poll. Serve the
      // last good snapshot instead; stale beats wrong-source.
      //
      // On a cold boot `cached` is empty by definition, which is why the
      // durable copy is consulted here: without it, one failed refresh at
      // startup falls through to an empty portfolio.yaml and the dashboard
      // shows nothing until the next tick minutes later (SHARP-28).
      let prev = cached.get(userId);
      if (!prev) {
        const restored = await loadPersisted(userId);
        if (restored) {
          prev = restored;
          cached.set(userId, restored);
          console.warn(`[broker] restored persisted ${restored.source} snapshot for user ${userId} after a failed refresh`);
        }
      }
      if (prev) {
        await applyOverlays(userId, prev); // reapply in case Settings/watchlist changed since prev was cached
        console.warn(`[broker] keeping previous ${prev.source} snapshot (as of ${new Date(prev.asOf * 1000).toISOString().slice(0, 16)})`);
        return prev;
      }
    }
  }
  // yamlProvider never throws, but keep a hard fallback anyway.
  const snap = await yamlProvider.fetchSnapshot(userId);
  await applyOverlays(userId, snap);
  cached.set(userId, snap);
  return snap;
}

export function brokerSnapshot(userId: number): BrokerSnapshot | null {
  return cached.get(userId) ?? null;
}

// ── F2b: broker-fill close detection ─────────────────────────────────────────
function toPosSnaps(holdings: BrokerSnapshot["holdings"]): PosSnap[] {
  return holdings
    .filter((h) => (h.asset_class as string) !== "crypto")
    .map((h) => ({
      key: h.ticker,
      ticker: (h.option?.underlying ?? h.ticker).toUpperCase(),
      direction: h.shares < 0 ? "short" : "long",
      qty: h.shares,
      assetClass: h.asset_class === "option" ? "option" : "equity",
      expiry: h.option?.expiry ?? null,
      costBasis: h.cost_basis ?? null,
    }));
}

// Diff this robinhood snapshot against the persisted baseline, raise a
// "journal it?" Activity event (+ Telegram) per detected close, then persist
// the new baseline. First-ever snapshot (no baseline) records silently, so
// linking an account never floods the feed with phantom closes.
async function detectAndRecordCloses(userId: number, snap: BrokerSnapshot): Promise<void> {
  const row = await db.query(`SELECT positions, close_seq FROM broker_positions WHERE user_id = ?`).get(userId) as { positions: string; close_seq: number } | null;
  const next = toPosSnaps(snap.holdings);
  let seq = row?.close_seq ?? 0;

  if (row) {
    let prev: PosSnap[] = [];
    try { prev = JSON.parse(row.positions); } catch { /* corrupt baseline → treat as empty, re-seed below */ }
    const today = new Date().toISOString().slice(0, 10);
    for (const e of closeDetect(prev, next, today)) {
      seq++; // monotonic → unique dedupe key even if the same ticker closes twice
      let estPnlPct: number | null = null;
      if (e.costBasis && e.costBasis > 0) {
        try { const q = await cachedQuote(e.ticker); if (q?.c) estPnlPct = ((q.c - e.costBasis) / e.costBasis) * 100 * (e.direction === "short" ? -1 : 1); } catch { /* no quote → no estimate */ }
      }
      const pnl = estPnlPct != null ? ` ~${estPnlPct >= 0 ? "+" : ""}${estPnlPct.toFixed(1)}% (est.)` : "";
      const title = e.kind === "closed"
        ? `📓 Closed ${e.ticker} (${e.direction})${pnl} — journal it?`
        : `📓 Trimmed ${e.ticker} ${e.direction} to ${e.nowQty} of ${e.prevQty}${pnl} — journal it?`;
      // Owned: this is your fill, not a market event — nobody else's Activity
      // feed should show it.
      const id = await insertEvent({ ts: Math.floor(Date.now() / 1000), ticker: e.ticker, kind: "position_close", title, detail: { ...e, estPnlPct }, dedupeKey: `brokerclose:${userId}:${seq}`, userId });
      if (id && telegramEnabled()) { try { await notifyTelegram(title + (e.note ? ` (${e.note})` : "")); } catch { /* delivery best-effort */ } }
    }
  }

  await db.query(
    `INSERT INTO broker_positions (user_id, positions, close_seq, updated_at) VALUES (?, ?, ?, extract(epoch from now())::int)
     ON CONFLICT(user_id) DO UPDATE SET positions = excluded.positions, close_seq = excluded.close_seq, updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(next), seq);
}

// ── UI watchlist edits (persisted per user, merged onto every snapshot) ─────
// add[] = tickers starred in the UI; remove[] = tickers explicitly unstarred,
// which also suppresses broker/YAML-sourced entries.
async function watchlistPrefs(userId: number): Promise<{ add: string[]; remove: string[] }> {
  try {
    const raw = JSON.parse(await getSettingFor(userId, "watchlist_prefs", "{}"));
    return { add: Array.isArray(raw.add) ? raw.add : [], remove: Array.isArray(raw.remove) ? raw.remove : [] };
  } catch {
    return { add: [], remove: [] };
  }
}

export async function updateWatchlist(userId: number, rawTicker: string, action: "add" | "remove"): Promise<string[]> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!isFuture(ticker) && !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) throw new Error("bad ticker");
  const wp = await watchlistPrefs(userId);
  if (action === "add") {
    wp.add = [...new Set([...wp.add, ticker])].slice(0, 50);
    wp.remove = wp.remove.filter((t) => t !== ticker);
  } else {
    wp.add = wp.add.filter((t) => t !== ticker);
    wp.remove = [...new Set([...wp.remove, ticker])].slice(0, 100);
  }
  await setSettingFor(userId, "watchlist_prefs", JSON.stringify(wp));
  const snap = await refreshBroker(userId); // re-merge so the change is visible immediately
  return snap.watchlist;
}

// Sync portfolio view for everything that previously called loadPortfolio().
export function currentPortfolio(userId: number): Portfolio {
  const snap = cached.get(userId);
  if (snap) return { holdings: snap.holdings, watchlist: snap.watchlist };
  return loadPortfolio();
}

// Per-user risk settings (target R:R etc. layer on in a later phase), falling
// back to the shared portfolio.yaml risk: block until a user sets their own.
export async function loadRiskConfigFor(userId: number): Promise<RiskConfig> {
  const row = await getRiskPrefs(userId);
  if (row) return row;
  return loadRiskConfig();
}

export interface SizingPlan {
  accountEquity: number | null;
  riskPct: number;            // max risk per trade, % of equity
  riskDollars: number | null; // dollars at risk between entry and stop
  shares: number | null;      // suggested share count
  notional: number | null;    // suggested position value
  cappedByPositionLimit: boolean;
  note: string;
}

// Risk-first position sizing: risk a fixed % of the chosen capital base between
// entry and stop, capped by the max single-position share.
//
// The two callers want different bases, and must stay independent:
// - Analyze tab (short-term): buying power + the trader's per-user risk prefs.
// - Ideas tab (medium/long): equity + fixed account defaults, so nothing the
//   trader tunes in the Analyze form leaks into idea validation.
export async function positionSizing(
  userId: number, entry: number, stop: number,
  opts: { risk?: RiskConfig; basis?: "buyingPower" | "equity" } = {}
): Promise<SizingPlan> {
  const risk = opts.risk ?? await loadRiskConfigFor(userId);
  const acct = cached.get(userId)?.account;
  const equity = opts.basis === "equity"
    ? (acct?.equity ?? acct?.buying_power ?? acct?.cash)
    : (acct?.buying_power ?? acct?.cash ?? acct?.equity);
  const perShareRisk = Math.abs(entry - stop);
  if (!equity || !perShareRisk || !Number.isFinite(perShareRisk)) {
    return {
      accountEquity: equity ?? null,
      riskPct: risk.max_risk_per_trade_pct,
      riskDollars: null, shares: null, notional: null, cappedByPositionLimit: false,
      note: equity
        ? "Stop distance unavailable — cannot size the trade."
        : "No account equity known (link a broker, import positions, or set risk.account_equity in portfolio.yaml) — express size as % risk instead of shares.",
    };
  }
  const riskDollars = (equity * risk.max_risk_per_trade_pct) / 100;
  let shares = Math.floor(riskDollars / perShareRisk);
  const maxNotional = (equity * risk.max_position_pct) / 100;
  let capped = false;
  if (shares * entry > maxNotional) {
    shares = Math.floor(maxNotional / entry);
    capped = true;
  }
  return {
    accountEquity: equity,
    riskPct: risk.max_risk_per_trade_pct,
    riskDollars: Math.round(riskDollars),
    shares: Math.max(0, shares),
    notional: Math.round(Math.max(0, shares) * entry),
    cappedByPositionLimit: capped,
    note: capped
      ? `Size capped by the ${risk.max_position_pct}% single-position limit.`
      : `Risks ~${risk.max_risk_per_trade_pct}% of equity if the stop is hit.`,
  };
}

// Compact text block for AI prompts.
export function accountContextText(userId: number): string {
  const snap = cached.get(userId);
  if (!snap) return "ACCOUNT: no broker snapshot yet (manual YAML portfolio in use).";
  const a = snap.account;
  const lines = [
    `ACCOUNT (source: ${snap.source}, as of ${new Date(snap.asOf * 1000).toISOString().slice(0, 16)} UTC):`,
    `- equity: ${a.equity != null ? "$" + a.equity.toLocaleString() : "unknown"}, cash: ${a.cash != null ? "$" + a.cash.toLocaleString() : "unknown"}, buying power (sizing is against this): ${a.buying_power != null ? "$" + a.buying_power.toLocaleString() : "unknown"}`,
  ];
  if (snap.openOrders.length) {
    lines.push(`- open orders: ${snap.openOrders.map((o) => `${o.side} ${o.qty} ${o.ticker} (${o.type}${o.limit_price ? ` @$${o.limit_price}` : ""})`).join("; ")}`);
  }
  return lines.join("\n");
}
