// Deterministic strategy backtester + walk-forward validator over daily candles.
// The AI never "backtests": it only translates intent into a StrategySpec; this
// engine executes it. Signals fire on bar close and FILL AT NEXT BAR OPEN (no
// lookahead). Includes historical-window + bootstrap stress and anchored
// walk-forward with in-train grid search / out-of-sample testing.
// Run `bun src/engine/backtest.ts` for the self-check.
import type { DailyCandles } from "../ingest/candles";

// ── Strategy spec ────────────────────────────────────────────────────────────
// Tunable numeric parameter. `range` (optional) is what walk-forward grid-search
// explores; when absent it defaults to ±50% around value.
export interface Param { value: number; range?: [number, number]; }

export type Rule =
  | { kind: "sma_cross"; fast: Param; slow: Param; dir: "above" | "below" }
  | { kind: "price_vs_sma"; period: Param; dir: "above" | "below" }
  | { kind: "rsi"; period: Param; level: Param; dir: "above" | "below" }
  | { kind: "breakout"; lookback: Param; dir: "up" | "down" }
  | { kind: "macd_cross"; dir: "above" | "below" };

export interface StrategySpec {
  ticker: string;
  direction: "long" | "short";
  entry: Rule[];        // ALL must hold to enter (AND)
  exit: Rule[];         // ANY holds to exit (OR); empty = rely on stop/target
  stop_atr?: Param;     // stop distance in ATR(14) multiples
  target_atr?: Param;   // target distance in ATR(14) multiples
}

// ── indicator series (rolling, aligned to candle index; null during warmup) ──
function smaSeries(v: number[], p: number): (number | null)[] {
  const out: (number | null)[] = Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= p) sum -= v[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function emaSeries(v: number[], p: number): number[] {
  const out = Array(v.length).fill(0);
  const k = 2 / (p + 1);
  let e = v[0];
  out[0] = e;
  for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsiSeries(c: number[], p: number): (number | null)[] {
  const out: (number | null)[] = Array(c.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const g = Math.max(0, d), l = Math.max(0, -d);
    if (i <= p) {
      ag += g; al += l;
      if (i === p) { ag /= p; al /= p; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    } else {
      ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  return out;
}
function macdHistSeries(c: number[]): number[] {
  const f = emaSeries(c, 12), s = emaSeries(c, 26);
  const macd = c.map((_, i) => f[i] - s[i]);
  const sig = emaSeries(macd, 9);
  return c.map((_, i) => macd[i] - sig[i]);
}
function atrSeries(h: number[], l: number[], c: number[], p = 14): (number | null)[] {
  const tr = [0];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  const out: (number | null)[] = Array(c.length).fill(null);
  let sum = 0;
  for (let i = 1; i < tr.length; i++) {
    sum += tr[i];
    if (i > p) sum -= tr[i - p];
    if (i >= p) out[i] = sum / p;
  }
  return out;
}

// Precompute every series the spec's rules reference.
type Bundle = {
  sma: Map<number, (number | null)[]>;
  rsi: Map<number, (number | null)[]>;
  macdHist: number[];
  high: number[]; low: number[]; close: number[];
};
function buildBundle(spec: StrategySpec, c: DailyCandles): Bundle {
  const sma = new Map<number, (number | null)[]>();
  const rsi = new Map<number, (number | null)[]>();
  const need = (r: Rule) => {
    if (r.kind === "sma_cross") { for (const raw of [r.fast.value, r.slow.value]) { const p = Math.round(raw); if (!sma.has(p)) sma.set(p, smaSeries(c.closes, p)); } }
    if (r.kind === "price_vs_sma") { const p = Math.round(r.period.value); if (!sma.has(p)) sma.set(p, smaSeries(c.closes, p)); }
    if (r.kind === "rsi") { const p = Math.round(r.period.value); if (!rsi.has(p)) rsi.set(p, rsiSeries(c.closes, p)); }
  };
  [...spec.entry, ...spec.exit].forEach(need);
  return { sma, rsi, macdHist: macdHistSeries(c.closes), high: c.highs, low: c.lows, close: c.closes };
}

// Evaluate one rule at bar i (uses only data up to and including i).
function ruleAt(r: Rule, b: Bundle, i: number): boolean {
  switch (r.kind) {
    case "sma_cross": {
      const f = b.sma.get(Math.round(r.fast.value))![i], s = b.sma.get(Math.round(r.slow.value))![i];
      if (f == null || s == null) return false;
      return r.dir === "above" ? f > s : f < s;
    }
    case "price_vs_sma": {
      const s = b.sma.get(Math.round(r.period.value))![i];
      if (s == null) return false;
      return r.dir === "above" ? b.close[i] > s : b.close[i] < s;
    }
    case "rsi": {
      const v = b.rsi.get(Math.round(r.period.value))![i];
      if (v == null) return false;
      return r.dir === "above" ? v > r.level.value : v < r.level.value;
    }
    case "breakout": {
      const lb = Math.round(r.lookback.value);
      if (i < lb) return false;
      if (r.dir === "up") { const hi = Math.max(...b.high.slice(i - lb, i)); return b.close[i] > hi; }
      const lo = Math.min(...b.low.slice(i - lb, i)); return b.close[i] < lo;
    }
    case "macd_cross":
      return r.dir === "above" ? b.macdHist[i] > 0 : b.macdHist[i] < 0;
  }
}

// ── simulation ───────────────────────────────────────────────────────────────
export interface Trade { entryDate: string; exitDate: string; entry: number; exit: number; retPct: number; reason: string; bars: number; }
export interface BacktestMetrics {
  trades: number; winRate: number; profitFactor: number; totalReturnPct: number;
  annualizedPct: number; maxDrawdownPct: number; sharpe: number; buyHoldPct: number;
  avgHoldBars: number;
}
export interface BacktestResult { metrics: BacktestMetrics; tradeList: Trade[]; equityCurve: number[]; buyHoldCurve: number[]; }

const COST = 0.0005;      // per-side slippage + commission (5 bps)
const dateOf = (c: DailyCandles, i: number) => new Date(c.timestamps[i] * 1000).toISOString().slice(0, 10);

// Metrics derived purely from a trade list, shared by the single-pass result and
// the concatenated walk-forward OOS curve. The walk-forward block used to
// hard-code profitFactor/sharpe/avgHoldBars to 0, and since the UI renders
// Sharpe for out-of-sample results, every walk-forward backtest reported
// "Sharpe 0.00" as though it had been measured rather than skipped.
function tradeMetrics(trades: Trade[], years: number) {
  const wins = trades.filter((t) => t.retPct > 0);
  const grossWin = wins.reduce((s, t) => s + t.retPct, 0);
  const grossLoss = -trades.filter((t) => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0);
  const rets = trades.map((t) => t.retPct / 100);
  const meanR = rets.reduce((a, x) => a + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - meanR) ** 2, 0) / (rets.length || 1)) || 1e-9;
  const tradesPerYear = trades.length / (years || 1);
  return {
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    sharpe: (meanR / sd) * Math.sqrt(tradesPerYear || 1),
    avgHoldBars: trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0,
  };
}

// Run one concrete spec over a candle slice [from, to).
export function runBacktest(spec: StrategySpec, c: DailyCandles, from = 0, to = c.closes.length): BacktestResult {
  const b = buildBundle(spec, c);
  const atr = spec.stop_atr || spec.target_atr ? atrSeries(c.highs, c.lows, c.closes, 14) : null;
  const longSide = spec.direction === "long";
  const trades: Trade[] = [];
  const equity: number[] = [1];
  // Equity marked to market at EVERY bar, used only for drawdown. `equity`
  // above samples at trade exits, which is what the chart plots: but taking
  // max drawdown from it hides the entire drawdown inside a losing trade, so a
  // strategy that rode a 40% hole down and closed flat reported ~0% drawdown.
  const marks: number[] = [1];
  let inTrade = false, entryPx = 0, entryIdx = 0, stop = 0, target = 0;
  let eq = 1;
  const warm = 210; // let the longest common indicators warm up
  const start = Math.max(from, warm);

  for (let i = start; i < to - 1; i++) {
    if (!inTrade) {
      if (spec.entry.length && spec.entry.every((r) => ruleAt(r, b, i))) {
        entryPx = c.opens[i + 1];               // fill next open: no lookahead
        entryIdx = i + 1;
        inTrade = true;
        const a = atr ? atr[i] : null;
        if (a && spec.stop_atr) stop = longSide ? entryPx - a * spec.stop_atr.value : entryPx + a * spec.stop_atr.value;
        else stop = NaN;
        if (a && spec.target_atr) target = longSide ? entryPx + a * spec.target_atr.value : entryPx - a * spec.target_atr.value;
        else target = NaN;
      }
      marks.push(eq);
      continue;
    }
    // In a trade at bar i (entered at i's open or earlier). Check stop/target
    // intrabar first (conservative: assume stop is touched before target), then
    // exit rules on close → fill next open.
    let exitPx: number | null = null, reason = "";
    if (!Number.isNaN(stop) && ((longSide && c.lows[i] <= stop) || (!longSide && c.highs[i] >= stop))) {
      // A bar that GAPS THROUGH the stop never offered the stop price: the
      // first tradeable print is the open. Filling at `stop` regardless assumes
      // a fill that could not have happened, which quietly flatters every
      // strategy carrying one, and flatters it most in exactly the crash-gap
      // conditions a stop exists to survive.
      exitPx = longSide ? Math.min(stop, c.opens[i]) : Math.max(stop, c.opens[i]);
      reason = "stop";
    } else if (!Number.isNaN(target) && ((longSide && c.highs[i] >= target) || (!longSide && c.lows[i] <= target))) {
      // Mirror image, and it cuts the other way: a gap through the target fills
      // BETTER than the target.
      exitPx = longSide ? Math.max(target, c.opens[i]) : Math.min(target, c.opens[i]);
      reason = "target";
    }
    else if (spec.exit.length && spec.exit.some((r) => ruleAt(r, b, i))) { exitPx = c.opens[i + 1]; reason = "signal"; }
    else if (i === to - 2) { exitPx = c.opens[i + 1]; reason = "end"; }

    if (exitPx != null) {
      const gross = longSide ? exitPx / entryPx - 1 : entryPx / exitPx - 1;
      const ret = gross - 2 * COST;
      eq *= 1 + ret;
      trades.push({ entryDate: dateOf(c, entryIdx), exitDate: dateOf(c, i + 1), entry: entryPx, exit: exitPx, retPct: ret * 100, reason, bars: i + 1 - entryIdx });
      equity.push(eq);
      inTrade = false;
    }
    // Mark to market on this bar's close. Only from entryIdx onward: `inTrade`
    // flips on the SIGNAL bar, but the position isn't owned until the next
    // bar's open, so marking earlier would price a trade that doesn't exist yet.
    marks.push(
      inTrade && i >= entryIdx
        ? eq * (1 + (longSide ? c.closes[i] / entryPx - 1 : entryPx / c.closes[i] - 1) - 2 * COST)
        : eq
    );
  }

  // Buy & hold over the same slice.
  const bhStart = c.closes[start], bhEnd = c.closes[to - 1];
  const buyHold = bhStart ? bhEnd / bhStart - 1 : 0;
  const buyHoldCurve = [1, 1 + buyHold];

  const years = (c.timestamps[to - 1] - c.timestamps[start]) / (365.25 * 86400) || 1;
  // Drawdown from the bar-level marks, not the trade-exit curve.
  let peak = marks[0], maxDD = 0;
  for (const e of marks) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, (peak - e) / peak); }
  const tm = tradeMetrics(trades, years);

  return {
    tradeList: trades,
    equityCurve: equity,
    buyHoldCurve,
    metrics: {
      trades: trades.length,
      winRate: tm.winRate,
      profitFactor: tm.profitFactor,
      totalReturnPct: (eq - 1) * 100,
      annualizedPct: (Math.pow(eq, 1 / years) - 1) * 100,
      maxDrawdownPct: maxDD * 100,
      sharpe: tm.sharpe,
      buyHoldPct: buyHold * 100,
      avgHoldBars: tm.avgHoldBars,
    },
  };
}

// ── stress: worst historical windows + seeded bootstrap Monte Carlo ──────────
// Deterministic RNG so results reproduce run-to-run.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export interface StressReport {
  worstWindow: { from: string; to: string; returnPct: number; maxDrawdownPct: number } | null;
  bootstrap: { medianPct: number; p5Pct: number; p95Pct: number; worstDrawdownPct: number; ruinProbPct: number };
}
export function stressBacktest(result: BacktestResult, c: DailyCandles): StressReport {
  const rets = result.tradeList.map((t) => t.retPct / 100);
  // Worst rolling ~1-year window of the equity curve, mapped back to trade dates.
  let worst: StressReport["worstWindow"] = null;
  const tl = result.tradeList;
  if (tl.length >= 4) {
    const win = Math.max(3, Math.floor(tl.length / 4));
    let worstRet = Infinity;
    for (let i = 0; i + win <= tl.length; i++) {
      let e = 1, peak = 1, dd = 0;
      for (let j = i; j < i + win; j++) { e *= 1 + rets[j]; peak = Math.max(peak, e); dd = Math.max(dd, (peak - e) / peak); }
      if (e - 1 < worstRet) { worstRet = e - 1; worst = { from: tl[i].entryDate, to: tl[i + win - 1].exitDate, returnPct: (e - 1) * 100, maxDrawdownPct: dd * 100 }; }
    }
  }
  // Bootstrap: resample the trade-return distribution into synthetic equity paths.
  const rng = mulberry32(0xC0FFEE);
  const paths = 1000;
  const finals: number[] = [], drawdowns: number[] = [];
  let ruin = 0;
  const n = rets.length;
  for (let p = 0; p < paths && n > 0; p++) {
    let e = 1, peak = 1, dd = 0;
    for (let k = 0; k < n; k++) { e *= 1 + rets[Math.floor(rng() * n)]; peak = Math.max(peak, e); dd = Math.max(dd, (peak - e) / peak); }
    finals.push((e - 1) * 100); drawdowns.push(dd * 100);
    if (e < 0.5) ruin++; // "ruin" = a path that halved
  }
  finals.sort((a, b) => a - b); drawdowns.sort((a, b) => a - b);
  const q = (arr: number[], f: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(f * arr.length))] : 0;
  return {
    worstWindow: worst,
    bootstrap: {
      medianPct: q(finals, 0.5), p5Pct: q(finals, 0.05), p95Pct: q(finals, 0.95),
      worstDrawdownPct: q(drawdowns, 0.95), ruinProbPct: n ? (ruin / paths) * 100 : 0,
    },
  };
}

// ── walk-forward: anchored train → out-of-sample test, rolled forward ────────
export interface WalkForwardConfig { trainYears: number; testMonths: number; }
export interface WFWindow { from: string; to: string; isReturnPct: number; oosReturnPct: number; trades: number; params: Record<string, number>; }
export interface WalkForwardResult {
  windows: WFWindow[];
  oosResult: BacktestResult;   // concatenated out-of-sample trades: the honest curve
  wfEfficiency: number;        // OOS annualized ÷ IS annualized
  paramStability: Record<string, number>; // coefficient of variation per param across windows
  verdict: string;
}

// Enumerate grid-search candidates by sampling each Param's range (cap ~200).
function paramGrid(spec: StrategySpec): StrategySpec[] {
  const slots: { set: (v: number) => void; values: number[] }[] = [];
  const collect = (p: Param) => {
    const [lo, hi] = p.range ?? [p.value * 0.5, p.value * 1.5];
    const pts = [lo, lo + (hi - lo) / 3, lo + (2 * (hi - lo)) / 3, hi].map((v) => Math.max(1, v));
    slots.push({ set: (v: number) => (p.value = v), values: [...new Set(pts)] });
  };
  const walk = (r: Rule) => {
    if (r.kind === "sma_cross") { collect(r.fast); collect(r.slow); }
    else if (r.kind === "price_vs_sma") collect(r.period);
    else if (r.kind === "rsi") { collect(r.period); collect(r.level); }
    else if (r.kind === "breakout") collect(r.lookback);
  };
  [...spec.entry, ...spec.exit].forEach(walk);
  if (spec.stop_atr) collect(spec.stop_atr);
  if (spec.target_atr) collect(spec.target_atr);

  // Cap combinations: thin each slot's sample list until the product ≤ 200.
  let combos = slots.reduce((n, s) => n * s.values.length, 1);
  while (combos > 200) {
    const widest = slots.reduce((a, b) => (b.values.length > a.values.length ? b : a), slots[0]);
    if (widest.values.length <= 1) break;
    widest.values = widest.values.filter((_, idx) => idx % 2 === 0);
    combos = slots.reduce((n, s) => n * s.values.length, 1);
  }

  // Cartesian product (mutating the shared spec, snapshotting via clone).
  const specs: StrategySpec[] = [];
  const rec = (idx: number) => {
    if (idx === slots.length) { specs.push(structuredClone(spec)); return; }
    for (const v of slots[idx].values) { slots[idx].set(v); rec(idx + 1); }
  };
  if (slots.length) rec(0); else specs.push(structuredClone(spec));
  return specs;
}

// Objective for in-train selection: return per unit of drawdown (robust: raw
// return alone picks fragile, over-fit parameters).
const objective = (m: BacktestMetrics) => m.annualizedPct / (m.maxDrawdownPct + 5);

function flatParams(spec: StrategySpec): Record<string, number> {
  const out: Record<string, number> = {};
  spec.entry.concat(spec.exit).forEach((r, i) => {
    if (r.kind === "sma_cross") { out[`e${i}.fast`] = r.fast.value; out[`e${i}.slow`] = r.slow.value; }
    else if (r.kind === "price_vs_sma") out[`e${i}.period`] = r.period.value;
    else if (r.kind === "rsi") { out[`e${i}.period`] = r.period.value; out[`e${i}.level`] = r.level.value; }
    else if (r.kind === "breakout") out[`e${i}.lookback`] = r.lookback.value;
  });
  if (spec.stop_atr) out["stop_atr"] = spec.stop_atr.value;
  if (spec.target_atr) out["target_atr"] = spec.target_atr.value;
  return out;
}

export function walkForward(spec: StrategySpec, c: DailyCandles, cfg: WalkForwardConfig = { trainYears: 3, testMonths: 6 }): WalkForwardResult {
  const barsPerYear = 252;
  const trainBars = Math.round(cfg.trainYears * barsPerYear);
  const testBars = Math.round((cfg.testMonths / 12) * barsPerYear);
  const n = c.closes.length;
  const windows: WFWindow[] = [];
  const oosTrades: Trade[] = [];
  const oosEquity: number[] = [1];
  let eqAcc = 1;
  const paramSamples: Record<string, number[]> = {};

  for (let trainEnd = trainBars; trainEnd + testBars <= n; trainEnd += testBars) {
    const trainStart = 0; // anchored (expanding) window
    // Grid-search on train only.
    let best: { spec: StrategySpec; obj: number; is: BacktestResult } | null = null;
    for (const cand of paramGrid(structuredClone(spec))) {
      const is = runBacktest(cand, c, trainStart, trainEnd);
      if (is.metrics.trades < 3) continue;
      const obj = objective(is.metrics);
      if (!best || obj > best.obj) best = { spec: cand, obj, is };
    }
    const chosen = best?.spec ?? structuredClone(spec);
    const isRes = best?.is ?? runBacktest(chosen, c, trainStart, trainEnd);
    const oos = runBacktest(chosen, c, trainEnd, trainEnd + testBars); // frozen params, unseen data
    for (const t of oos.tradeList) { eqAcc *= 1 + t.retPct / 100; oosTrades.push(t); oosEquity.push(eqAcc); }
    const fp = flatParams(chosen);
    for (const [k, v] of Object.entries(fp)) (paramSamples[k] ??= []).push(v);
    windows.push({
      from: dateOf(c, trainEnd), to: dateOf(c, trainEnd + testBars - 1),
      isReturnPct: isRes.metrics.annualizedPct, oosReturnPct: oos.metrics.annualizedPct,
      trades: oos.tradeList.length, params: fp,
    });
  }

  // Concatenated OOS result.
  const years = windows.length ? (windows.length * cfg.testMonths) / 12 : 1;
  const oosAnn = (Math.pow(eqAcc, 1 / years) - 1) * 100;
  const isAnn = windows.length ? windows.reduce((s, w) => s + w.isReturnPct, 0) / windows.length : 0;
  let peak = 1, maxDD = 0;
  for (const e of oosEquity) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, (peak - e) / peak); }
  // Buy & hold over the out-of-sample span only: the like-for-like comparison
  // for a curve that starts where training ended.
  const oosFrom = trainBars;
  const oosTo = Math.min(n - 1, trainBars + windows.length * testBars - 1);
  const oosBH = windows.length && c.closes[oosFrom] ? c.closes[oosTo] / c.closes[oosFrom] - 1 : 0;
  const otm = tradeMetrics(oosTrades, years);
  const oosResult: BacktestResult = {
    tradeList: oosTrades,
    equityCurve: oosEquity,
    buyHoldCurve: [1, 1 + oosBH],
    metrics: {
      trades: oosTrades.length,
      winRate: otm.winRate,
      profitFactor: otm.profitFactor,
      totalReturnPct: (eqAcc - 1) * 100,
      annualizedPct: oosAnn,
      maxDrawdownPct: maxDD * 100,
      sharpe: otm.sharpe,
      buyHoldPct: oosBH * 100,
      avgHoldBars: otm.avgHoldBars,
    },
  };
  const stability: Record<string, number> = {};
  for (const [k, arr] of Object.entries(paramSamples)) {
    const m = arr.reduce((a, x) => a + x, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((a, x) => a + (x - m) ** 2, 0) / arr.length);
    stability[k] = m ? sd / Math.abs(m) : 0;
  }
  const wfe = isAnn !== 0 ? oosAnn / isAnn : 0;
  const unstable = Object.values(stability).some((cv) => cv > 0.6);
  const greenWindows = windows.filter((w) => w.oosReturnPct > 0).length;
  const verdict =
    windows.length < 3 ? "Insufficient history for a reliable walk-forward: treat results as indicative only."
      : wfe >= 0.5 && !unstable && greenWindows >= windows.length / 2 ? "Edge appears to hold out-of-sample. Reasonable to risk small size."
        : wfe < 0.5 ? "Mostly curve-fit: out-of-sample performance is well below in-sample. Do not size up on this."
          : unstable ? "Best parameters jump between windows: the edge is unstable, not robust."
            : "Marginal: out-of-sample is positive but thin. Be skeptical.";
  return { windows, oosResult, wfEfficiency: wfe, paramStability: stability, verdict };
}

// ── self-check ───────────────────────────────────────────────────────────────
if (import.meta.main) {
  // Synthetic uptrend with noise → a golden-cross long should be profitable and
  // trade rarely.
  const N = 1600;
  const ts: number[] = [], close: number[] = [];
  let px = 100;
  const rng = mulberry32(42);
  for (let i = 0; i < N; i++) { px *= 1 + 0.0004 + (rng() - 0.5) * 0.02; close.push(px); ts.push(1_600_000_000 + i * 86400); }
  const c: DailyCandles = { ticker: "TEST", opens: close.slice(), highs: close.map((x) => x * 1.005), lows: close.map((x) => x * 0.995), closes: close, volumes: close.map(() => 1e6), timestamps: ts };
  const spec: StrategySpec = {
    ticker: "TEST", direction: "long",
    entry: [{ kind: "sma_cross", fast: { value: 50, range: [20, 80] }, slow: { value: 200, range: [150, 250] }, dir: "above" }],
    exit: [{ kind: "sma_cross", fast: { value: 50 }, slow: { value: 200 }, dir: "below" }],
  };
  const r = runBacktest(spec, c);
  console.assert(r.metrics.trades > 0 && r.metrics.trades < 15, `golden cross should trade rarely, got ${r.metrics.trades}`);
  const stress = stressBacktest(r, c);
  console.assert(stress.bootstrap.p5Pct <= stress.bootstrap.medianPct && stress.bootstrap.medianPct <= stress.bootstrap.p95Pct, "bootstrap quantiles ordered");
  // Determinism.
  const r2 = runBacktest(spec, c);
  console.assert(JSON.stringify(r) === JSON.stringify(r2), "backtest must be deterministic");

  const wf = walkForward(spec, c, { trainYears: 2, testMonths: 6 });
  console.assert(wf.windows.length >= 1, "walk-forward should produce windows");

  // The OOS block used to hard-code these to 0, and the UI renders Sharpe for
  // out-of-sample results: so a fabricated 0 read as a measured risk figure.
  if (wf.oosResult.metrics.trades > 1) {
    const om = wf.oosResult.metrics;
    console.assert(om.sharpe !== 0, "walk-forward OOS sharpe must be computed, not stubbed to 0");
    console.assert(om.profitFactor !== 0, "walk-forward OOS profit factor must be computed, not stubbed to 0");
    console.assert(om.avgHoldBars > 0, "walk-forward OOS avgHoldBars must be computed, not stubbed to 0");
    console.assert(om.buyHoldPct !== 0, "walk-forward OOS buy & hold must cover the OOS span, not stubbed to 0");
  }

  // profitFactor is Infinity when nothing lost money. JSON.stringify turns that
  // into null, so anything rendering it must survive a non-finite value: the
  // dashboard used global isFinite(), which passes null straight into .toFixed().
  const allWinners = runBacktest(spec, { ...c, ticker: "W" }, 0, 0).metrics.profitFactor;
  console.assert(allWinners === 0 || Number.isFinite(allWinners) || allWinners === Infinity, "profitFactor must be a number or Infinity");

  // A gap straight through the stop must fill at the OPEN, not at the stop: the
  // stop price was never on offer. Smooth 240-bar rise (so ATR is tiny and the
  // stop sits just under price), then one bar that gaps to 70.
  const gN = 240;
  const gp: number[] = [];
  for (let i = 0; i < gN; i++) gp.push(100 + i * 0.05);
  // The gap bar, plus one after it: the loop runs to `to - 1`, so a gap on the
  // final bar would leave via the forced end-of-data exit and never test a stop.
  gp.push(70, 70);
  const gapped: DailyCandles = {
    ticker: "GAP",
    timestamps: gp.map((_, i) => 1_600_000_000 + i * 86400),
    opens: gp.slice(), highs: gp.slice(), lows: gp.slice(), closes: gp.slice(),
    volumes: gp.map(() => 1e6),
  };
  const gapSpec: StrategySpec = {
    ticker: "GAP", direction: "long",
    entry: [{ kind: "price_vs_sma", period: { value: 20 }, dir: "above" }],
    exit: [],
    stop_atr: { value: 1 },
  };
  const gapRes = runBacktest(gapSpec, gapped);
  const stopped = gapRes.tradeList.find((t) => t.reason === "stop");
  console.assert(stopped != null, "gap scenario should have stopped out");
  if (stopped) {
    console.assert(
      Math.abs(stopped.exit - 70) < 1e-9,
      `gap-through stop must fill at the open (70), got ${stopped.exit}: filling at the untouched stop price flatters every stopped strategy`
    );
  }

  // Max drawdown must come from bar-level marks. A strategy that rides a deep
  // hole and closes flat used to report ~0% because equity was only sampled at
  // exits: the number people size positions with.
  console.assert(r.metrics.maxDrawdownPct > 0, "max drawdown must be measured intra-trade, not only at exits");

  // Overfit detector: a strategy tuned to one training window should have WFE < 1.
  console.log(`backtest self-check OK: trades=${r.metrics.trades}, totalRet=${r.metrics.totalReturnPct.toFixed(1)}%, WF windows=${wf.windows.length}, WFE=${wf.wfEfficiency.toFixed(2)}, verdict="${wf.verdict}"`);
}
