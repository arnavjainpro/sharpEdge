// Black-Scholes pricing + payoff/stress for multi-leg options structures.
// Pure math, no deps. Two jobs:
//   1. Stress-test the swing analyzer's proposed legs (spot/IV/time shocks).
//   2. Model-price options in backtests: there is NO historical option-quote
//      feed, so legs are repriced along the underlying's path. Results are
//      model-based, not replays of real quotes: label them as such in the UI.
// Run `bun src/engine/optionsMath.ts` to execute the self-check.

export interface Leg {
  action: "buy" | "sell";
  right: "call" | "put";
  strike: number;
  expiry: string;    // ISO date YYYY-MM-DD
  quantity: number;  // contracts (×100 shares)
}

// Standard-normal CDF (Abramowitz & Stegun 26.2.17), good to ~1e-7.
function cnd(x: number): number {
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const a = ((((1.330274429 * k - 1.821255978) * k + 1.781477937) * k - 0.356563782) * k + 0.319381530) * k;
  const w = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp((-x * x) / 2) * a;
  return x >= 0 ? w : 1 - w;
}

// Black-Scholes price per share. T in years, iv/r decimals. At/after expiry
// returns intrinsic value.
export function bsPrice(S: number, K: number, T: number, iv: number, right: "call" | "put", r = 0.04): number {
  if (T <= 0) return Math.max(0, right === "call" ? S - K : K - S);
  if (iv <= 0) iv = 1e-4;
  const sq = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * T) / sq;
  const d2 = d1 - sq;
  return right === "call"
    ? S * cnd(d1) - K * Math.exp(-r * T) * cnd(d2)
    : K * Math.exp(-r * T) * cnd(-d2) - S * cnd(-d1);
}

const sign = (l: Leg) => (l.action === "buy" ? 1 : -1);

// Dollar value of the whole structure at underlying S, given iv and a per-leg
// time-to-expiry resolver. Debit structures value positive, credit negative.
export function structureValue(legs: Leg[], S: number, iv: number, tYears: (l: Leg) => number, r = 0.04): number {
  let v = 0;
  for (const l of legs) v += sign(l) * l.quantity * 100 * bsPrice(S, l.strike, tYears(l), iv, l.right, r);
  return v;
}

// Intrinsic payoff at expiry (all legs expired).
export function payoffAtExpiry(legs: Leg[], S: number): number {
  let v = 0;
  for (const l of legs) {
    const intrinsic = l.right === "call" ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
    v += sign(l) * l.quantity * 100 * intrinsic;
  }
  return v;
}

export interface StressResult {
  spotShocks: number[];   // fractional spot moves
  ivShocks: number[];     // fractional IV moves relative to baseIv
  entryCost: number;      // net debit(+)/credit(−) in dollars
  gridNow: number[][];    // P/L at [ivShock][spotShock], current time-to-expiry
  atExpiry: number[];     // P/L at expiry across spotShocks
  maxLoss: number;
  maxGain: number;
  breakevens: number[];
  note: string;
}

// Spot × IV × time-decay stress grid, P/L relative to entry cost, in dollars.
export function stressStructure(legs: Leg[], spot: number, baseIv: number, r = 0.04): StressResult {
  const now = Date.now();
  const dteYears = (l: Leg) => Math.max(0, (new Date(l.expiry + "T00:00:00Z").getTime() - now) / 86400_000) / 365;
  const entryCost = structureValue(legs, spot, baseIv, dteYears, r);
  const spotShocks = [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2];
  const ivShocks = [-0.4, 0, 0.4];
  const gridNow = ivShocks.map((iv) =>
    spotShocks.map((s) => structureValue(legs, spot * (1 + s), Math.max(1e-4, baseIv * (1 + iv)), dteYears, r) - entryCost)
  );
  const atExpiry = spotShocks.map((s) => payoffAtExpiry(legs, spot * (1 + s)) - entryCost);

  // Max loss/gain + breakevens scanned at expiry over a wide underlying range.
  let maxLoss = Infinity, maxGain = -Infinity;
  const breakevens: number[] = [];
  let prev: { S: number; pl: number } | null = null;
  for (let i = 0; i <= 300; i++) {
    const S = (i / 300) * spot * 3;
    const pl = payoffAtExpiry(legs, S) - entryCost;
    maxLoss = Math.min(maxLoss, pl);
    maxGain = Math.max(maxGain, pl);
    if (prev && prev.pl !== 0 && Math.sign(prev.pl) !== Math.sign(pl)) {
      const t = -prev.pl / (pl - prev.pl);
      breakevens.push(prev.S + t * (S - prev.S));
    }
    prev = { S, pl };
  }
  return {
    spotShocks, ivShocks, entryCost, gridNow, atExpiry, maxLoss, maxGain, breakevens,
    note: "Model-priced (Black-Scholes), not real historical option quotes.",
  };
}

if (import.meta.main) {
  const S = 100, K = 100, T = 0.5, iv = 0.3, r = 0.04;
  const c = bsPrice(S, K, T, iv, "call", r), p = bsPrice(S, K, T, iv, "put", r);
  const parity = Math.abs(c - p - (S - K * Math.exp(-r * T)));
  console.assert(parity < 1e-6, `put-call parity off: ${parity}`);

  const exp = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const ic: Leg[] = [
    { action: "sell", right: "put", strike: 95, expiry: exp, quantity: 1 },
    { action: "buy", right: "put", strike: 90, expiry: exp, quantity: 1 },
    { action: "sell", right: "call", strike: 105, expiry: exp, quantity: 1 },
    { action: "buy", right: "call", strike: 110, expiry: exp, quantity: 1 },
  ];
  const st = stressStructure(ic, 100, 0.3, r);
  const credit = -st.entryCost;                 // premium received (positive)
  const expectedMaxLoss = -(500 - credit);      // width $5 × 100 − credit
  console.assert(credit > 0, "iron condor should be a net credit");
  console.assert(Math.abs(st.maxLoss - expectedMaxLoss) < 5, `IC max loss ${st.maxLoss} vs ${expectedMaxLoss}`);
  console.assert(st.breakevens.length === 2, `IC should have 2 breakevens, got ${st.breakevens.length}`);
  console.log(`optionsMath self-check OK: parity=${parity.toExponential(1)}, IC credit=$${credit.toFixed(2)}, maxLoss=$${st.maxLoss.toFixed(2)}`);
}
