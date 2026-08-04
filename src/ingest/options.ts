// Options chain context via Yahoo's public options API (cookie + crumb
// bootstrap, no key). Provides implied-volatility context, expected move, and
// candidate strike/expiry ranges for options-aware idea analysis. Degrades
// gracefully: callers must treat null as "IV data unavailable, reason
// qualitatively about premium risk".

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh) sharpEdge personal-use" };

let session: { cookie: string; crumb: string; ts: number } | null = null;

async function yahooSession(): Promise<{ cookie: string; crumb: string } | null> {
  if (session && Date.now() - session.ts < 30 * 60_000) return session;
  try {
    const r1 = await fetch("https://fc.yahoo.com", { headers: UA, signal: AbortSignal.timeout(15_000) });
    const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
    if (!cookie) return null;
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { ...UA, Cookie: cookie },
      signal: AbortSignal.timeout(15_000),
    });
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.includes("<")) return null;
    session = { cookie, crumb, ts: Date.now() };
    return session;
  } catch {
    return null;
  }
}

interface Contract {
  strike: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  impliedVolatility?: number;
  openInterest?: number;
  volume?: number;
}

export interface StrikeRow {
  strike: number;
  callBid: number | null;
  callAsk: number | null;
  callIv: number | null;
  putBid: number | null;
  putAsk: number | null;
  putIv: number | null;
}

export interface ExpirySummary {
  expiry: string;          // ISO date
  daysToExpiry: number;
  atmIv: number | null;    // decimal, e.g. 0.34
  expectedMovePct: number | null;  // ± % move implied through expiry
  atmStrike: number | null;
  atmCallMid: number | null;
  atmPutMid: number | null;
  ladder: StrikeRow[];     // ~7 strikes around ATM with live bid/ask/IV
}

export interface OptionsSummary {
  ticker: string;
  spot: number;
  expiries: ExpirySummary[]; // nearest weekly + ~1 month + ~2 month
  ivNote: string;            // plain-language read of the IV level
}

async function fetchChain(ticker: string, dateUnix?: number): Promise<any | null> {
  const s = await yahooSession();
  const qs = new URLSearchParams();
  if (s) qs.set("crumb", s.crumb);
  if (dateUnix) qs.set("date", String(dateUnix));
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?${qs}`;
  try {
    const res = await fetch(url, {
      headers: s ? { ...UA, Cookie: s.cookie } : UA,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data?.optionChain?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

const mid = (c: Contract | undefined): number | null => {
  if (!c) return null;
  if (c.bid && c.ask && c.ask >= c.bid) return (c.bid + c.ask) / 2;
  return c.lastPrice ?? null;
};

function summarizeExpiry(spot: number, expiryUnix: number, calls: Contract[], puts: Contract[]): ExpirySummary {
  const dte = Math.max(1, Math.round((expiryUnix * 1000 - Date.now()) / 86400_000));
  const nearest = (cs: Contract[]) =>
    cs.reduce<Contract | undefined>((best, c) => (!best || Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best), undefined);
  const atmCall = nearest(calls);
  const atmPut = nearest(puts);
  const ivs = [atmCall?.impliedVolatility, atmPut?.impliedVolatility].filter(
    (v): v is number => v != null && v > 0.01 && v < 5
  );
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;

  // Strike ladder: ~7 strikes nearest spot, with live bid/ask/IV for each side -
  // lets the model choose real, priced contracts and build spreads.
  const callBy = new Map(calls.map((c) => [c.strike, c]));
  const putBy = new Map(puts.map((c) => [c.strike, c]));
  const allStrikes = [...new Set([...calls, ...puts].map((c) => c.strike))];
  const near = allStrikes.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, 7).sort((a, b) => a - b);
  const ladder: StrikeRow[] = near.map((k) => {
    const c = callBy.get(k), p = putBy.get(k);
    return {
      strike: k,
      callBid: c?.bid ?? null, callAsk: c?.ask ?? null, callIv: c?.impliedVolatility ?? null,
      putBid: p?.bid ?? null, putAsk: p?.ask ?? null, putIv: p?.impliedVolatility ?? null,
    };
  });

  return {
    expiry: new Date(expiryUnix * 1000).toISOString().slice(0, 10),
    daysToExpiry: dte,
    atmIv,
    expectedMovePct: atmIv != null ? atmIv * Math.sqrt(dte / 365) * 100 : null,
    atmStrike: atmCall?.strike ?? atmPut?.strike ?? null,
    atmCallMid: mid(atmCall),
    atmPutMid: mid(atmPut),
    ladder,
  };
}

export async function fetchOptionsSummary(ticker: string): Promise<OptionsSummary | null> {
  const root = await fetchChain(ticker);
  if (!root?.expirationDates?.length) return null;
  const spot: number = root.quote?.regularMarketPrice ?? 0;
  if (!spot) return null;

  // Pick nearest expiry, ~30 days out, and ~60 days out.
  const now = Date.now() / 1000;
  const dates: number[] = root.expirationDates.filter((d: number) => d > now);
  const pick = (targetDays: number) =>
    dates.reduce((best, d) => (Math.abs((d - now) / 86400 - targetDays) < Math.abs((best - now) / 86400 - targetDays) ? d : best), dates[0]);
  const targets = [...new Set([dates[0], pick(30), pick(60)])];

  const expiries: ExpirySummary[] = [];
  for (const dt of targets) {
    // The root response already contains the first expiry's chain.
    const node =
      root.options?.[0]?.expirationDate === dt ? root.options[0] : (await fetchChain(ticker, dt))?.options?.[0];
    if (!node) continue;
    expiries.push(summarizeExpiry(spot, dt, node.calls ?? [], node.puts ?? []));
    await Bun.sleep(250);
  }
  if (!expiries.length) return null;

  const monthIv = expiries.find((e) => e.daysToExpiry >= 20)?.atmIv ?? expiries[0].atmIv;
  const ivNote =
    monthIv == null
      ? "IV unavailable for this chain."
      : monthIv > 0.8
        ? `Very high IV (~${(monthIv * 100).toFixed(0)}%): options are expensive: buying premium needs a big move to profit; defined-risk spreads or selling premium usually make more sense.`
        : monthIv > 0.45
          ? `Elevated IV (~${(monthIv * 100).toFixed(0)}%): premium is rich; favor spreads over naked long options, and mind IV crush after catalysts.`
          : monthIv > 0.25
            ? `Moderate IV (~${(monthIv * 100).toFixed(0)}%): premium reasonably priced for directional plays.`
            : `Low IV (~${(monthIv * 100).toFixed(0)}%): premium is cheap: long calls/puts are viable if a real catalyst or move is expected.`;

  return { ticker, spot, expiries, ivNote };
}

// Compact text block for AI prompts.
export function optionsContextText(o: OptionsSummary | null): string {
  if (!o) return "OPTIONS DATA: unavailable (treat premium/IV considerations qualitatively).";
  const px = (n: number | null) => (n != null ? "$" + n.toFixed(2) : "N/A");
  const iv = (n: number | null) => (n != null ? (n * 100).toFixed(0) + "%" : "N/A");
  const lines = [`OPTIONS DATA for ${o.ticker} (spot $${o.spot.toFixed(2)}): live chain (Yahoo, ~15-min delayed):`];
  for (const e of o.expiries) {
    lines.push(
      `\n${e.expiry} (${e.daysToExpiry}d): ATM IV ${iv(e.atmIv)}, implied move ±${e.expectedMovePct?.toFixed(1) ?? "n/a"}%`
    );
    if (e.ladder?.length) {
      lines.push(`  strike | call bid/ask (IV) | put bid/ask (IV)`);
      for (const r of e.ladder) {
        lines.push(`  ${r.strike} | ${px(r.callBid)}/${px(r.callAsk)} (${iv(r.callIv)}) | ${px(r.putBid)}/${px(r.putAsk)} (${iv(r.putIv)})`);
      }
    }
  }
  lines.push(`\n${o.ivNote}`);
  lines.push(`Pick strikes and build spreads from the ladder above; use the bid/ask to estimate net debit/credit. If a needed strike/expiry is missing here, say so.`);
  return lines.join("\n");
}
