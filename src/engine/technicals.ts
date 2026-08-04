// Classic indicators: pure math over OHLCV series. Timeframe-agnostic: the
// screener feeds daily bars, the intraday analyzer feeds 1m/5m/15m bars.

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function macd(closes: number[]): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < 35) return null;
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macdLine = fast.map((v, i) => v - slow[i]);
  const signalLine = ema(macdLine.slice(25), 9);
  const m = macdLine[macdLine.length - 1];
  const s = signalLine[signalLine.length - 1];
  return { macd: m, signal: s, histogram: m - s };
}

export function vwap(bars: Bar[]): number | null {
  let pv = 0, vol = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? pv / vol : null;
}

// Rolling stats of 1-min returns for z-score anomaly detection.
export function returnStats(closes: number[]): { mean: number; std: number } | null {
  if (closes.length < 30) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return { mean, std: Math.sqrt(variance) };
}

// ── Volatility, structure, and trend-quality helpers ────────────────────────

// Average True Range over the last `period` bars (Wilder-style simple average).
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  const n = closes.length;
  if (n < period + 1) return null;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    sum += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  return sum / period;
}

// Least-squares slope of the last `period` values, normalized to %-per-bar.
export function slopePctPerBar(values: number[], period = 20): number | null {
  if (values.length < period) return null;
  const ys = values.slice(-period);
  const nBars = ys.length;
  const xMean = (nBars - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / nBars;
  let num = 0, den = 0;
  for (let i = 0; i < nBars; i++) {
    num += (i - xMean) * (ys[i] - yMean);
    den += (i - xMean) ** 2;
  }
  if (den === 0 || yMean === 0) return null;
  return ((num / den) / yMean) * 100;
}

// Swing pivots: local highs/lows confirmed by `wing` bars on each side.
export interface PivotLevels {
  supports: number[];     // pivot lows below price, nearest first
  resistances: number[];  // pivot highs above price, nearest first
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  priorSwingHigh: number | null;  // for lower-high / higher-low structure reads
  priorSwingLow: number | null;
}

export function pivotLevels(highs: number[], lows: number[], price: number, wing = 3, lookback = 120): PivotLevels {
  const n = highs.length;
  const start = Math.max(wing, n - lookback);
  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];
  for (let i = start; i < n - wing; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (highs[j] > highs[i]) isHigh = false;
      if (lows[j] < lows[i]) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivotHighs.push(highs[i]);
    if (isLow) pivotLows.push(lows[i]);
  }
  // Cluster near-identical levels (within 0.4%) so S/R lists stay meaningful.
  const cluster = (levels: number[]) => {
    const sorted = [...levels].sort((a, b) => a - b);
    const out: number[] = [];
    for (const l of sorted) {
      if (out.length && Math.abs(l - out[out.length - 1]) / l < 0.004) {
        out[out.length - 1] = (out[out.length - 1] + l) / 2;
      } else out.push(l);
    }
    return out;
  };
  const allLevels = cluster([...pivotHighs, ...pivotLows]);
  return {
    supports: allLevels.filter((l) => l < price).sort((a, b) => b - a).slice(0, 4),
    resistances: allLevels.filter((l) => l > price).sort((a, b) => a - b).slice(0, 4),
    lastSwingHigh: pivotHighs.at(-1) ?? null,
    lastSwingLow: pivotLows.at(-1) ?? null,
    priorSwingHigh: pivotHighs.at(-2) ?? null,
    priorSwingLow: pivotLows.at(-2) ?? null,
  };
}

// Breakout/breakdown vs the prior `period`-bar range (excluding the last bar),
// with volume confirmation vs the 20-bar average.
export interface RangeBreak {
  state: "breakout" | "breakdown" | "none";
  level: number | null;          // the range edge that broke
  volumeConfirmed: boolean;
}

export function rangeBreak(highs: number[], lows: number[], closes: number[], volumes: number[], period = 20): RangeBreak {
  const n = closes.length;
  if (n < period + 2) return { state: "none", level: null, volumeConfirmed: false };
  const priorHigh = Math.max(...highs.slice(n - 1 - period, n - 1));
  const priorLow = Math.min(...lows.slice(n - 1 - period, n - 1));
  const close = closes[n - 1];
  const avgVol = volumes.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / Math.min(20, n - 1);
  const volumeConfirmed = avgVol > 0 && volumes[n - 1] >= avgVol * 1.3;
  if (close > priorHigh) return { state: "breakout", level: priorHigh, volumeConfirmed };
  if (close < priorLow) return { state: "breakdown", level: priorLow, volumeConfirmed };
  return { state: "none", level: null, volumeConfirmed };
}

// Beta + correlation vs a benchmark over overlapping daily returns.
export function betaVs(closes: number[], benchCloses: number[], window = 60): { beta: number; corr: number } | null {
  const len = Math.min(closes.length, benchCloses.length);
  if (len < window + 1) return null;
  const a = closes.slice(-window - 1), b = benchCloses.slice(-window - 1);
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i <= window; i++) {
    ra.push(a[i] / a[i - 1] - 1);
    rb.push(b[i] / b[i - 1] - 1);
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra), mb = mean(rb);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < window; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  if (vb === 0 || va === 0) return null;
  return { beta: cov / vb, corr: cov / Math.sqrt(va * vb) };
}

export interface TechnicalSnapshot {
  price: number | null;
  rsi14: number | null;
  macdHistogram: number | null;
  sma20: number | null;
  vwap: number | null;
  sessionChangePct: number | null;
}

export function snapshot(bars: Bar[], prevClose: number | null): TechnicalSnapshot {
  const closes = bars.map((b) => b.close);
  const price = closes.at(-1) ?? null;
  const m = macd(closes);
  return {
    price,
    rsi14: rsi(closes),
    macdHistogram: m?.histogram ?? null,
    sma20: sma(closes, 20),
    vwap: vwap(bars),
    sessionChangePct:
      price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
  };
}
