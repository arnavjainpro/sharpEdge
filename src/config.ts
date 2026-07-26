import { parse } from "yaml";
import { readFileSync } from "fs";
import { join } from "path";

export interface Holding {
  ticker: string;
  shares: number;       // shares; contracts for options
  cost_basis: number;
  thesis?: string;      // why you own it — lets the AI judge "thesis broken vs. just drifting"
  asset_class?: "equity" | "option"; // default equity — this is an equity/options tool, crypto isn't supported
  market_value?: number; // broker-provided current value — options can't be quoted by ticker
  option?: { type: "call" | "put"; strike: number; expiry: string; underlying: string };
}

export interface Portfolio {
  holdings: Holding[];
  watchlist: string[];
}

// How the trader wants trades shaped, not just sized. Drives which options
// structures the swing analyzer is allowed to propose (see APPETITE_PLAYBOOK in
// ai/intraday.ts) — income/defined-risk at one end, convexity at the other.
export type RiskAppetite = "conservative" | "balanced" | "aggressive";
export const RISK_APPETITES: readonly RiskAppetite[] = ["conservative", "balanced", "aggressive"];
// Single coercion chokepoint: yaml, the settings PUT, and old rows all funnel
// through here, so an unknown value can never reach a prompt or the strategy gate.
export const asRiskAppetite = (v: unknown): RiskAppetite =>
  RISK_APPETITES.includes(v as RiskAppetite) ? (v as RiskAppetite) : "balanced";

// Risk-management knobs (portfolio.yaml `risk:` section). account_equity is a
// fallback used for position sizing when no brokerage account is linked.
export interface RiskConfig {
  account_equity: number | null;
  max_risk_per_trade_pct: number; // % of equity risked between entry and stop
  max_position_pct: number;       // % of equity in any single position
  target_rr_ratio: number;        // minimum R:R the trader wants for a "strong" idea rating
  risk_appetite: RiskAppetite;    // which options structures fit this trader
}

const ROOT = join(import.meta.dir, "..");

function readPortfolioYaml(): any {
  return parse(readFileSync(join(ROOT, "config/portfolio.yaml"), "utf-8"));
}

export function loadPortfolio(): Portfolio {
  const raw = readPortfolioYaml();
  const holdings: Holding[] = (raw.holdings ?? []).map((h: any) => ({
    ticker: String(h.ticker).toUpperCase(),
    shares: Number(h.shares),
    cost_basis: Number(h.cost_basis),
    ...(h.thesis ? { thesis: String(h.thesis) } : {}),
  }));
  const watchlist: string[] = (raw.watchlist ?? []).map((t: any) => String(t).toUpperCase());
  return { holdings, watchlist };
}

export function loadRiskConfig(): RiskConfig {
  let raw: any = {};
  try {
    raw = readPortfolioYaml().risk ?? {};
  } catch {}
  return {
    account_equity: raw.account_equity != null ? Number(raw.account_equity) : null,
    max_risk_per_trade_pct: Number(raw.max_risk_per_trade_pct ?? 1),
    max_position_pct: Number(raw.max_position_pct ?? 20),
    target_rr_ratio: Number(raw.target_rr_ratio ?? 2),
    risk_appetite: asRiskAppetite(raw.risk_appetite),
  };
}

// Universe filters (screener.yaml `filters:` section, env-overridable for tests).
export interface UniverseFilters {
  min_market_cap: number;
  min_price: number;
  min_volume: number;   // most recent session share volume
  max_stocks: number;   // cap, ranked by dollar volume (S&P 500 + portfolio always kept)
  concurrency: number;  // parallel Yahoo candle fetches during a scan
}

export function loadUniverseFilters(): UniverseFilters {
  let raw: any = {};
  try {
    raw = parse(readFileSync(join(ROOT, "config/screener.yaml"), "utf-8"))?.filters ?? {};
  } catch {}
  return {
    min_market_cap: Number(process.env.UNIVERSE_MIN_MCAP ?? raw.min_market_cap ?? 300_000_000),
    min_price: Number(process.env.UNIVERSE_MIN_PRICE ?? raw.min_price ?? 3),
    min_volume: Number(process.env.UNIVERSE_MIN_VOLUME ?? raw.min_volume ?? 300_000),
    max_stocks: Number(process.env.UNIVERSE_MAX_STOCKS ?? raw.max_stocks ?? 1500),
    concurrency: Math.max(1, Number(process.env.UNIVERSE_CONCURRENCY ?? raw.concurrency ?? 6)),
  };
}

// The scannable/searchable symbol for a holding. Option holdings carry a
// composite display ticker ("MRVL 2026-07-24 203C") that is NOT a real symbol —
// map it to the underlying. Crypto ("SOL-USD") is unsupported and dropped. This
// is the chokepoint every caller (search universe, detectors, daily-stats,
// briefing) funnels through, so normalizing here keeps composites out of all of
// them at once instead of each caller re-deriving it.
function holdingSymbol(h: Holding): string | null {
  if (h.asset_class === "option") return h.option?.underlying?.toUpperCase() ?? null;
  const t = h.ticker.toUpperCase();
  if (t.includes(" ") || t.endsWith("-USD")) return null; // composite option / crypto → not a real symbol
  return t;
}

export function allTickers(p: Portfolio): string[] {
  const held = p.holdings.map(holdingSymbol).filter((t): t is string => !!t);
  const watched = p.watchlist.map((t) => t.toUpperCase()).filter((t) => !t.includes(" ") && !t.endsWith("-USD"));
  return [...new Set([...held, ...watched])];
}

// Self-check (bun src/config.ts): the normalization is the money path for
// keeping option/crypto junk out of ticker search and the detector loops.
if (import.meta.main) {
  const p: Portfolio = {
    holdings: [
      { ticker: "AAPL", shares: 10, cost_basis: 180 },
      { ticker: "BRK-B", shares: 1, cost_basis: 400 },
      { ticker: "MRVL 2026-07-24 203C", shares: 1, cost_basis: 2, asset_class: "option", option: { type: "call", strike: 203, expiry: "2026-07-24", underlying: "MRVL" } },
    ],
    watchlist: ["NVDA", "SOL-USD", "DRAM 2026-07-24 62C"],
  };
  const got = allTickers(p).sort();
  const want = ["AAPL", "BRK-B", "MRVL", "NVDA"].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`allTickers normalization failed: ${JSON.stringify(got)}`);
  console.log("allTickers self-check ok:", got);

  // Risk appetite is the other money path through here: it selects which options
  // structures the swing analyzer may propose, and it arrives from yaml, a raw
  // settings PUT, and pre-migration DB rows. Anything unrecognized must land on
  // 'balanced' rather than falling through as undefined and breaking the lookup.
  for (const good of RISK_APPETITES) {
    if (asRiskAppetite(good) !== good) throw new Error(`asRiskAppetite mangled a valid value: ${good}`);
  }
  for (const junk of [null, undefined, "", "AGGRESSIVE", "yolo", 3, {}, ["aggressive"]]) {
    if (asRiskAppetite(junk) !== "balanced") throw new Error(`asRiskAppetite let junk through: ${JSON.stringify(junk)}`);
  }
  console.log("asRiskAppetite self-check ok");
}

export const config = {
  finnhubKey: process.env.FINNHUB_API_KEY ?? "",
  port: Number(process.env.PORT ?? 3000),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  // Supabase Postgres connection string. Required — the app has no local fallback.
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Legacy SQLite path, retained only for the one-time migration script.
  dbPath: join(ROOT, "data/sharpedge.db"),
  // Deep-reasoning model (analysis, validation, chat) and fast triage model.
  // Sonnet 5 is ~40% cheaper than Opus 4.8 ($3/$15 vs $5/$25 per 1M tokens) and
  // near-Opus quality on this kind of analysis. Override with SHARPEDGE_MODEL_DEEP.
  modelDeep: process.env.SHARPEDGE_MODEL_DEEP ?? "claude-sonnet-5",
  modelFast: process.env.SHARPEDGE_MODEL_FAST ?? "claude-haiku-4-5",
};

// Eastern Time components, extracted directly from Intl parts —
// no round-trip through a locale-string Date parse.
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  minute: "numeric",
});
const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function etParts(now: Date) {
  const p = Object.fromEntries(
    ET_FMT.formatToParts(now).map((x) => [x.type, x.value])
  ) as Record<string, string>;
  const hour = Number(p.hour) % 24; // Intl may render midnight as "24"
  return {
    year: Number(p.year), month: Number(p.month), dom: Number(p.day),
    day: DAY_INDEX[p.weekday] ?? 0, mins: hour * 60 + Number(p.minute),
  };
}

export function etNow(now = new Date()): { mins: number; day: number } {
  const { mins, day } = etParts(now);
  return { mins, day };
}

// Real UTC epoch (ms) for a given ET wall-clock date+time — DST-correct. Finds
// the ET offset at a first guess, then refines once in case the guess landed on
// the far side of a spring-forward/fall-back boundary.
function etWallToEpoch(year: number, month1: number, dom: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month1 - 1, dom, hour, minute);
  const off1 = etOffsetMs(guess);
  const epoch = guess - off1;
  const off2 = etOffsetMs(epoch);
  return off1 === off2 ? epoch : guess - off2;
}
// ET UTC-offset (ms) at a given instant: what ET wall-clock does this epoch show?
function etOffsetMs(epochMs: number): number {
  const { year, month, dom, mins } = etParts(new Date(epochMs));
  const shownAsUTC = Date.UTC(year, month - 1, dom, 0, mins);
  const epochMin = Math.floor(epochMs / 60000) * 60000;
  return shownAsUTC - epochMin;
}

// US market hours in ET. Returns "open" | "extended" | "closed".
export function marketPhase(now = new Date()): "open" | "extended" | "closed" {
  const { mins, day } = etNow(now);
  if (day === 0 || day === 6) return "closed";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "open";
  if (mins >= 4 * 60 && mins < 20 * 60) return "extended";
  return "closed";
}

// Next regular-session open/close as an absolute epoch (seconds). Boundaries are
// ET (9:30/16:00) built as real instants, so the client can render them in local
// time and they stay correct across DST switches.
export function nextMarketTransition(now = new Date()): { ts: number; kind: "open" | "close" } {
  const OPEN = 9 * 60 + 30, CLOSE = 16 * 60;
  const p = etParts(now);
  // In session on a weekday → next transition is today's close.
  if (p.day >= 1 && p.day <= 5 && p.mins >= OPEN && p.mins < CLOSE) {
    return { ts: Math.floor(etWallToEpoch(p.year, p.month, p.dom, 16, 0) / 1000), kind: "close" };
  }
  // Before open on a weekday → today's open. Otherwise the next weekday's open.
  if (p.day >= 1 && p.day <= 5 && p.mins < OPEN) {
    return { ts: Math.floor(etWallToEpoch(p.year, p.month, p.dom, 9, 30) / 1000), kind: "open" };
  }
  // Probe forward from ET noon (avoids DST/day-boundary drift) to the next weekday.
  let probe = etWallToEpoch(p.year, p.month, p.dom, 12, 0);
  for (let i = 0; i < 8; i++) {
    probe += 24 * 3600 * 1000;
    const q = etParts(new Date(probe));
    if (q.day >= 1 && q.day <= 5) {
      return { ts: Math.floor(etWallToEpoch(q.year, q.month, q.dom, 9, 30) / 1000), kind: "open" };
    }
  }
  return { ts: Math.floor(now.getTime() / 1000), kind: "open" }; // unreachable
}

if (import.meta.main) {
  const at = (iso: string) => nextMarketTransition(new Date(iso));
  const etMinsOf = (ts: number) => etParts(new Date(ts * 1000)).mins;
  const wed_open = at("2026-07-15T14:00:00Z"); // 10:00 ET Wed → in session
  const wed_pre = at("2026-07-15T12:00:00Z");  // 08:00 ET Wed → before open
  const fri_post = at("2026-07-17T21:00:00Z"); // 17:00 ET Fri → next open Monday
  console.assert(wed_open.kind === "close" && etMinsOf(wed_open.ts) === 16 * 60, "in-session → 16:00 ET close");
  console.assert(wed_pre.kind === "open" && etMinsOf(wed_pre.ts) === 9 * 60 + 30, "pre-market → 09:30 ET open");
  console.assert(fri_post.kind === "open" && fri_post.ts - Date.parse("2026-07-17T21:00:00Z") / 1000 > 2 * 86400, "fri → Monday open");
  // DST correctness: Fri Oct 30 2026 (EDT) post-close → Mon Nov 2 open must be 09:30 EST, not 08:30.
  const dst = at("2026-10-30T21:00:00Z"); // 17:00 EDT Fri, after fall-back Nov 1
  console.assert(etMinsOf(dst.ts) === 9 * 60 + 30, "open lands on 09:30 ET across the DST switch");
  console.log("nextMarketTransition self-check passed", { wed_open, wed_pre, fri_post, dst });
}
