// Conversational advisor: answers ad-hoc questions ("should I trim NVDA?",
// "what's my biggest risk right now?") grounded in the live system state —
// portfolio, technicals, recent events, and its own past signals.
import Anthropic from "@anthropic-ai/sdk";
import { config, allTickers, type Portfolio } from "../config";
import { universeMeta } from "../ingest/universe";
import { db, recentBars } from "../db";
import { snapshot } from "../engine/technicals";
import { marketContextText } from "../engine/market";
import { accountContextText } from "../broker";
import { cachedQuote, fetchCompanyNews } from "../ingest/finnhub";
import { journalContextText } from "./journal";
import { claudeQueue } from "./queue";
import { opusBreaker, haikuBreaker } from "./breaker";
import { getScreenerRows } from "../engine/screener";

const client = new Anthropic();

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Stable persona — cached; volatile market context goes in the user turn.
function advisorSystemPrompt(portfolio: Portfolio): string {
  const positions = portfolio.holdings
    .map((h) => {
      let line = `- ${h.ticker}: ${h.shares} shares @ $${h.cost_basis} cost basis`;
      if (h.thesis) line += `\n  investor's thesis: ${h.thesis}`;
      return line;
    })
    .join("\n");
  return `You are sharpEdge, a personal equity advisor for one self-directed investor. You answer their questions directly and honestly, grounded in the live market context provided with each question.

Investor's portfolio:
${positions || "(no current positions)"}
Watchlist: ${portfolio.watchlist.join(", ") || "none"}

Rules:
- Ground every claim in the context provided. If the context doesn't contain what you'd need, say so plainly rather than guessing.
- When a position has a stated investor thesis, evaluate events and questions against it: distinguish "thesis broken" (sell case) from "price drifting but thesis intact" (hold case). If a position has no stated thesis, note that once and reason from fundamentals in the context.
- Be position-aware: quantify their actual exposure, unrealized P&L vs cost basis, and concentration when relevant.
- Give a clear recommendation when asked for one, with your conviction level and what would change your mind. Don't hedge into uselessness — but don't manufacture confidence the evidence doesn't support.
- Keep answers tight: lead with the answer, then the reasoning. Use short paragraphs or bullets.
- You are decision support for a self-directed investor, not licensed financial advice; be honest about uncertainty.`;
}

// Tickers the question is actually about — so we can pull fresh news for them
// without paying for headlines across the whole book on every question.
function tickersInQuestion(question: string, portfolio: Portfolio): string[] {
  const q = question.toUpperCase();
  return allTickers(portfolio).filter((t) => new RegExp(`\\b${t}\\b`).test(q));
}

// The two account-scoped reads behind the chat context, exported so the
// isolation suite can pin them directly. They used to be inline SQL that
// drifted out of sync with /api/state and started serving one account's private
// analysis to every other account — a copy of the query in the test would have
// been free to drift the same way, so both callers share these.
//
// Same projection as /api/state (server.ts): the event row is public market
// fact, but the severity is THIS user's triage and the attached signal is THIS
// user's analysis. `position_close`/`option_expiry` events belong to one
// portfolio and must not surface elsewhere. COALESCE keeps events recorded
// before the fan-out existed from going blank.
export async function advisorEvents(userId: number, since: number): Promise<any[]> {
  return await db
    .query(
      `SELECT e.ts, e.ticker, e.kind, e.title,
              COALESCE(t.severity, e.severity) AS severity,
              s.action, s.conviction, s.thesis
       FROM events e
       LEFT JOIN event_triage t ON t.event_id = e.id AND t.user_id = ?
       LEFT JOIN signals s ON s.event_id = e.id AND s.user_id = ?
       WHERE e.ts > ? AND (e.user_id IS NULL OR e.user_id = ?)
         AND COALESCE(t.severity, e.severity) IN ('critical','high')
       ORDER BY e.ts DESC LIMIT 20`
    )
    .all(userId, userId, since, userId) as any[];
}

// briefings.user_id scopes private per-portfolio analysis. Unfiltered, the
// newest briefing anywhere on the instance was quoted into every account's chat.
export async function advisorBriefing(userId: number) {
  return (await db
    .query(`SELECT ts, kind, content FROM briefings WHERE user_id = ? ORDER BY ts DESC LIMIT 1`)
    .get(userId)) as { ts: number; kind: string; content: string } | null;
}

async function buildMarketContext(userId: number, portfolio: Portfolio, question: string): Promise<string> {
  const lines: string[] = [];

  lines.push(await marketContextText(), "", accountContextText(userId), "");
  // Past-trade journal, scoped to a ticker if the question names exactly one.
  const askedTickers = tickersInQuestion(question, portfolio);
  const journal = await journalContextText(userId, askedTickers.length === 1 ? askedTickers[0] : undefined);
  if (journal) lines.push(journal, "");
  lines.push("CURRENT PRICES & TECHNICALS:");
  for (const t of allTickers(portfolio)) {
    const stats = await db.query(`SELECT prev_close FROM daily_stats WHERE ticker = ?`).get(t) as { prev_close: number } | null;
    const tech = snapshot(await recentBars(t, 120), stats?.prev_close ?? null);
    // Bars are empty when the market is quiet (overnight/weekends) — fall back to a REST quote.
    let price = tech.price;
    let chg = tech.sessionChangePct;
    if (price == null) {
      try {
        const q = await cachedQuote(t);
        price = q.c;
        chg = q.dp;
      } catch {}
    }
    lines.push(
      `${t}: price=$${price?.toFixed(2) ?? "n/a"} chg=${chg?.toFixed(2) ?? "n/a"}% RSI14=${tech.rsi14?.toFixed(0) ?? "n/a"} MACDh=${tech.macdHistogram?.toFixed(3) ?? "n/a"} VWAP=$${tech.vwap?.toFixed(2) ?? "n/a"}`
    );
  }

  // Fresh headlines (last 7 days) for tickers named in the question — fills the
  // gap where the local events table is empty or the app wasn't running.
  const asked = tickersInQuestion(question, portfolio);
  for (const t of asked.slice(0, 3)) {
    try {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
      const news = (await fetchCompanyNews(t, from, to)).slice(0, 6);
      if (news.length) {
        lines.push("", `RECENT HEADLINES for ${t} (last 7 days, via Finnhub):`);
        for (const n of news) {
          lines.push(`- [${new Date(n.datetime * 1000).toISOString().slice(0, 10)}] ${n.headline} (${n.source})`);
        }
      }
    } catch {}
  }

  const since = Math.floor(Date.now() / 1000) - 72 * 3600;
  const events = await advisorEvents(userId, since);
  lines.push("", "SIGNIFICANT EVENTS + SIGNALS (last 72h):");
  if (events.length === 0) lines.push("(none)");
  for (const e of events) {
    let line = `- [${new Date(e.ts * 1000).toISOString().slice(0, 16)}] (${e.severity}) ${e.title}`;
    if (e.action) line += ` → signal: ${e.action} (${e.conviction})`;
    lines.push(line);
  }

  const briefing = await advisorBriefing(userId);
  if (briefing) {
    lines.push("", `LATEST BRIEFING (${briefing.kind}, ${new Date(briefing.ts * 1000).toISOString().slice(0, 16)}):`, briefing.content.slice(0, 2000));
  }

  return lines.join("\n");
}

export async function askAdvisor(
  userId: number,
  question: string,
  history: ChatTurn[],
  portfolio: Portfolio
): Promise<string> {
  if (!opusBreaker.allow()) {
    return "⚠️ The AI circuit breaker is tripped (unusually high call volume was detected). Reset it from the dashboard status bar or restart the app.";
  }

  const trimmedHistory = history.slice(-10); // cap context growth
  const marketContext = await buildMarketContext(userId, portfolio, question);
  const response = await claudeQueue(() =>
    client.messages.create({
      model: config.modelDeep,
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: advisorSystemPrompt(portfolio),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        ...trimmedHistory,
        {
          role: "user",
          content: `${marketContext}\n\n---\nQUESTION: ${question}`,
        },
      ],
    })
  );

  return response.content.find((b) => b.type === "text")?.text ?? "(no answer)";
}

// One-tap news digest for a ticker: last 7 days of headlines → a few plain-
// English bullets on the fast model (pennies per call, user-initiated).
export async function summarizeTickerNews(ticker: string): Promise<string> {
  if (!haikuBreaker.allow()) throw new Error("AI circuit breaker is tripped — reset it from the status bar.");
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const news = (await fetchCompanyNews(ticker, iso(Date.now() - 7 * 86400_000), iso(Date.now()))).slice(0, 15);
  if (!news.length) return `No news found for ${ticker} in the last 7 days.`;
  const items = news
    .map((n) => `- [${iso(n.datetime * 1000)}] ${n.headline} (${n.source})${n.summary ? ` — ${n.summary.slice(0, 200)}` : ""}`)
    .join("\n");
  const response = await claudeQueue(() =>
    client.messages.create({
      model: config.modelFast,
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `Summarize this week's news for ${ticker} for a self-directed investor. 3-5 short bullets: what happened, what matters for the stock, and overall sentiment (positive/negative/mixed). Skip fluff and duplicate stories. Headlines:\n\n${items}`,
      }],
    })
  );
  return response.content.find((b) => b.type === "text")?.text ?? "(no summary)";
}

// Portfolio health check: deterministic evidence (positions, screener scores,
// sector concentration, regime) → deep-model rundown with a 0-100 score,
// pros, and cons. Markdown out; the frontend renders it as-is.
export async function scorePortfolio(userId: number, portfolio: Portfolio): Promise<string> {
  if (!opusBreaker.allow()) throw new Error("AI circuit breaker is tripped — reset it from the status bar.");
  const rows = new Map((await getScreenerRows(portfolio)).map((r) => [r.ticker, r]));
  const lines: string[] = ["POSITIONS:"];
  let hasEtf = false;
  for (const h of portfolio.holdings) {
    const cls = h.asset_class ?? "equity";
    // An ETF held as an equity position is internally diversified — mark it so
    // the model doesn't read a single fund as a concentrated single-stock bet.
    const meta = await universeMeta(h.ticker);
    const isEtf = meta?.sector === "ETF";
    if (isEtf) hasEtf = true;
    const tag = isEtf ? `ETF — ${meta!.name}` : cls;
    let line = `- ${h.ticker} (${tag}): ${h.shares} ${cls === "option" ? "contracts" : "shares"} @ $${h.cost_basis} cost`;
    if (h.market_value != null) line += `, market value $${Math.round(h.market_value).toLocaleString()}`;
    else {
      try { const q = await cachedQuote(h.ticker); line += `, now $${q.c} (${q.dp?.toFixed(1)}% today), value $${Math.round(q.c * h.shares).toLocaleString()}`; } catch {}
    }
    const r = rows.get(h.ticker);
    if (r) line += ` — sector ${r.sector}, long score ${r.long_score}/100, short score ${r.short_score}/100`;
    else if (meta) line += ` — sector ${meta.sector}`;
    if (h.thesis) line += `\n  thesis: ${h.thesis}`;
    lines.push(line);
  }
  if (hasEtf) lines.push("", "NOTE: positions marked ETF are diversified funds, not single stocks — a single ETF holding is NOT concentration; do not tell the trader to diversify out of one ETF.");
  if (!portfolio.holdings.length) lines.push("(no positions)");
  lines.push("", await marketContextText(), "", accountContextText(userId));

  const response = await claudeQueue(() =>
    client.messages.create({
      model: config.modelDeep,
      max_tokens: 1600,
      thinking: { type: "adaptive" },
      messages: [{
        role: "user",
        content: `${lines.join("\n")}

---
Grade this portfolio like a conservative risk manager. Respond in markdown, exactly this structure:

## Portfolio score: N/100
One-sentence verdict.

**Pros** — up to 3 bullets (what's working: diversification, alignment with regime/rotation, quality of setups held, cash buffer...)

**Cons** — up to 3 bullets (concentration, correlated bets, positions fighting the market regime, weak-scoring holdings, missing hedges, oversized options exposure...)

**Biggest risk** — one bullet, the single thing most likely to hurt.

**Suggested next steps** — 2-3 concrete, optional actions.

Be terse — this is read between trades, not studied. Every bullet is ONE line: the point plus the number behind it, no preamble and no restating the position list. Say only what's worth acting on; three sharp bullets beat five padded ones, and fewer is fine when there's less to say.

Score honestly: 80+ means genuinely well-constructed, 50-79 solid with real issues, below 50 needs restructuring. Ground every claim in the data above; if data is missing (no equity figure, unquoted options), say so instead of guessing.`,
      }],
    })
  );
  return response.content.find((b) => b.type === "text")?.text ?? "(no analysis)";
}

// The 0-100 lives only inside the model's markdown ("## Portfolio score: N/100"),
// so pull it out once at write time for the history list and the trend sparkline.
// Returns null when the model phrased it differently — callers must treat the
// score as optional rather than constraining on it.
export function extractPortfolioScore(markdown: string): number | null {
  const m = markdown.match(/portfolio score:\s*(\d{1,3})/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

// First non-empty line after the score heading — the model's one-sentence verdict.
export function extractPortfolioVerdict(markdown: string): string | null {
  const lines = markdown.split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => /portfolio score:/i.test(l));
  if (i < 0) return null;
  const verdict = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
  return verdict ? verdict.replace(/^[*_>\s-]+/, "").slice(0, 200) : null;
}
