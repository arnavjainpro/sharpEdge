// Trade-outcome journal: the trader logs how each closed trade actually went
// (win/loss, what went wrong, in their own words) and relevant history is fed
// back into future AI analysis as PROMPT CONTEXT: retrieval-augmented, not
// fine-tuning (Anthropic exposes no fine-tuning API for Claude, and at this
// scale a compact text block outperforms one anyway). Same "compact text block
// for AI prompts" pattern as accountContextText()/optionsContextText().
import { db } from "../db";

export interface TradeOutcome {
  id: number;
  ticker: string;
  direction: "long" | "short";
  idea_id: number | null;
  entry_price: number | null;
  exit_price: number | null;
  outcome: "win" | "loss" | "breakeven";
  pnl_pct: number | null;
  notes: string;
  closed_at: number;
}

export async function logOutcome(
  userId: number,
  o: {
    ticker: string;
    direction: "long" | "short";
    outcome: "win" | "loss" | "breakeven";
    idea_id?: number | null;
    entry_price?: number | null;
    exit_price?: number | null;
    pnl_pct?: number | null;
    notes?: string;
    closed_at?: number;
  }
): Promise<number> {
  const res = await db
    .query(
      `INSERT INTO trade_outcomes (user_id, ticker, direction, idea_id, entry_price, exit_price, outcome, pnl_pct, notes, closed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, extract(epoch from now())::int) RETURNING id`
    )
    .get<{ id: number }>(
      userId, o.ticker.toUpperCase().trim(), o.direction, o.idea_id ?? null,
      o.entry_price ?? null, o.exit_price ?? null, o.outcome, o.pnl_pct ?? null,
      (o.notes ?? "").trim(), o.closed_at ?? Math.floor(Date.now() / 1000)
    );
  return res!.id;
}

export async function listOutcomes(userId: number, limit = 50): Promise<TradeOutcome[]> {
  return await db
    .query(`SELECT id, ticker, direction, idea_id, entry_price, exit_price, outcome, pnl_pct, notes, closed_at FROM trade_outcomes WHERE user_id = ? ORDER BY closed_at DESC LIMIT ?`)
    .all<TradeOutcome>(userId, limit);
}

export async function deleteOutcome(userId: number, id: number): Promise<boolean> {
  return (await db.query(`DELETE FROM trade_outcomes WHERE user_id = ? AND id = ?`).run(userId, id)).changes > 0;
}

// ── F2b: open-trade tracking (feeds the journal on close) ─────────────────────
export interface TrackedTrade {
  id: number; ticker: string; direction: "long" | "short";
  idea_id: number | null; entry_price: number | null; opened_at: number;
}

// Start tracking an idea toward a journal entry. Re-tracking the same
// ticker+direction refreshes entry/idea rather than erroring (UNIQUE upsert).
export async function trackTrade(userId: number, t: {
  ticker: string; direction: "long" | "short"; idea_id?: number | null; entry_price?: number | null;
}): Promise<number> {
  const res = await db.query(
    `INSERT INTO tracked_trades (user_id, ticker, direction, idea_id, entry_price, opened_at)
     VALUES (?, ?, ?, ?, ?, extract(epoch from now())::int)
     ON CONFLICT(user_id, ticker, direction) DO UPDATE SET idea_id = excluded.idea_id, entry_price = excluded.entry_price, opened_at = excluded.opened_at
     RETURNING id`
  ).get<{ id: number }>(userId, t.ticker.toUpperCase().trim(), t.direction, t.idea_id ?? null, t.entry_price ?? null);
  return res!.id;
}

export async function listTracked(userId: number): Promise<TrackedTrade[]> {
  return await db.query(
    `SELECT id, ticker, direction, idea_id, entry_price, opened_at FROM tracked_trades WHERE user_id = ? ORDER BY opened_at DESC`
  ).all<TrackedTrade>(userId);
}

export async function untrack(userId: number, id: number): Promise<boolean> {
  return (await db.query(`DELETE FROM tracked_trades WHERE user_id = ? AND id = ?`).run(userId, id)).changes > 0;
}

// Clear any open track for a ticker+direction: called when the trade is
// journaled (manually or from a broker-detected close) so it can't linger.
export async function untrackByKey(userId: number, ticker: string, direction: "long" | "short"): Promise<void> {
  await db.query(`DELETE FROM tracked_trades WHERE user_id = ? AND ticker = ? AND direction = ?`).run(userId, ticker.toUpperCase().trim(), direction);
}

// The set of ticker|direction keys the user is tracking: lets idea cards show
// a "Tracking" state without a round-trip per card.
export async function trackedKeys(userId: number): Promise<string[]> {
  return (await db.query(`SELECT ticker, direction FROM tracked_trades WHERE user_id = ?`).all<any>(userId))
    .map((r) => `${r.ticker}|${r.direction}`);
}

// Compact prompt block: the trader's last few outcomes overall plus every
// outcome on the specific ticker being analyzed ("I've lost on this exact name
// twice the same way" is the highest-value context). Capped small: roughly ten
// bullets: so it never bloats the prompt.
export async function journalContextText(userId: number, ticker?: string): Promise<string> {
  const recent = await db
    .query(`SELECT * FROM trade_outcomes WHERE user_id = ? ORDER BY closed_at DESC LIMIT 5`)
    .all<TradeOutcome>(userId);
  const forTicker = ticker
    ? (await db
        .query(`SELECT * FROM trade_outcomes WHERE user_id = ? AND ticker = ? ORDER BY closed_at DESC LIMIT 5`)
        .all<TradeOutcome>(userId, ticker.toUpperCase().trim()))
    : [];
  const seen = new Set<number>();
  const rows = [...forTicker, ...recent].filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, 10);
  if (!rows.length) return "";

  const line = (r: TradeOutcome) => {
    const date = new Date(r.closed_at * 1000).toISOString().slice(0, 10);
    const pnl = r.pnl_pct != null ? ` (${r.pnl_pct >= 0 ? "+" : ""}${r.pnl_pct.toFixed(1)}%)` : "";
    const px = r.entry_price != null && r.exit_price != null ? ` $${r.entry_price}→$${r.exit_price}` : "";
    return `- ${r.ticker} ${r.direction}, closed ${date}: ${r.outcome.toUpperCase()}${pnl}${px}${r.notes ? `. Trader's notes: "${r.notes}"` : ""}`;
  };
  return [
    `TRADER'S PAST-TRADE JOURNAL (their own logged outcomes: real history, weigh it):`,
    ...rows.map(line),
  ].join("\n");
}
