// Market-open and market-close portfolio briefings (deep model).
import Anthropic from "@anthropic-ai/sdk";
import { config, allTickers, type Portfolio } from "../config";
import { db } from "../db";
import { cachedQuote } from "../ingest/finnhub";
import { marketContextText, getMarketSnapshot } from "../engine/market";
import { claudeQueue } from "./queue";

const client = new Anthropic();

export async function generateBriefing(kind: "open" | "close", portfolio: Portfolio): Promise<string> {
  // Gather current quotes + today's events/signals as raw material.
  const tickers = allTickers(portfolio);
  const quotes: string[] = [];
  for (const t of tickers) {
    try {
      const q = await cachedQuote(t);
      quotes.push(`${t}: $${q.c} (${q.dp >= 0 ? "+" : ""}${q.dp.toFixed(2)}% today)`);
    } catch {}
  }

  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const events = await db
    .query(`SELECT ticker, kind, title, severity FROM events WHERE ts > ? AND severity IN ('critical','high') ORDER BY ts DESC LIMIT 25`)
    .all(since) as { ticker: string; kind: string; title: string; severity: string }[];
  const signals = await db
    .query(`SELECT ticker, action, conviction, thesis FROM signals WHERE ts > ? ORDER BY ts DESC LIMIT 10`)
    .all(since) as { ticker: string; action: string; conviction: string; thesis: string }[];

  const positions = portfolio.holdings
    .map((h) => `- ${h.ticker}: ${h.shares} shares @ $${h.cost_basis}`)
    .join("\n");

  const sectorLine = await (async () => {
    const snap = await getMarketSnapshot();
    if (!snap) return "";
    const leading = snap.sectors.filter((s) => s.state === "leading").map((s) => s.sector);
    const lagging = snap.sectors.filter((s) => s.state === "lagging").map((s) => s.sector);
    return `Sector rotation: leading — ${leading.join(", ") || "none"}; lagging — ${lagging.join(", ") || "none"}.`;
  })();
  const marketCtx = await marketContextText();

  const response = await claudeQueue(() => client.messages.create({
    model: config.modelDeep,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: `You write a concise ${kind === "open" ? "pre-market" : "end-of-day"} briefing for one self-directed investor. Lead with what matters most to their actual positions. Format as short markdown: a 2-3 sentence overview that includes the market regime and any sector-rotation shift that affects their money, then per-ticker bullets only where there is something worth saying, then "What to watch ${kind === "open" ? "today" : "tomorrow"}". No filler, no generic market commentary without a position link. This is decision support, not licensed financial advice.`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          `Portfolio:\n${positions || "(none)"}`,
          `Watchlist: ${portfolio.watchlist.join(", ") || "none"}`,
          ``,
          marketCtx,
          sectorLine,
          ``,
          `Live quotes:\n${quotes.join("\n") || "unavailable"}`,
          ``,
          `Significant events (last 24h):\n${events.map((e) => `[${e.severity}] ${e.title}`).join("\n") || "none"}`,
          ``,
          `Recent AI signals:\n${signals.map((s) => `${s.ticker} ${s.action} (${s.conviction}): ${s.thesis}`).join("\n") || "none"}`,
        ].join("\n"),
      },
    ],
  }));

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  await db.query(`INSERT INTO briefings (ts, kind, content) VALUES (extract(epoch from now())::int, ?, ?)`).run(kind, text);
  return text;
}
