// F3: portfolio concentration: deterministic risk read, no AI.
// Groups holdings into exposures (a stock and its options on the same underlying
// are one bet), sums by sector, computes a value-weighted portfolio beta over
// the holdings whose beta is known, and flags anything over the size limits.
// Pure: the caller resolves value/sector/beta per holding; this does the math.

export interface ConcHolding {
  key: string;             // exposure key: option underlying, else the ticker
  value: number;           // current market value (equity: shares×quote; option: broker MV)
  sector: string;          // "Unknown" when the universe has none
  beta: number | null;     // 60d beta vs SPY; null → excluded from the beta number
}

export interface Concentration {
  totalValue: number;
  sectors: { sector: string; value: number; pct: number }[];       // desc by value
  positions: { key: string; value: number; pct: number }[];        // desc by value
  portfolioBeta: number | null;   // value-weighted over known-beta holdings
  betaCoveragePct: number;        // share of total value that had a known beta
  excludedNoBeta: number;         // holdings dropped from the beta number
  warnings: { kind: "position" | "sector"; label: string; pct: number; limit: number }[];
}

export function computeConcentration(items: ConcHolding[], maxPositionPct: number, sectorLimitPct = 40): Concentration {
  // Merge by exposure key so a stock + its calls read as one position.
  const merged = new Map<string, { value: number; sector: string; beta: number | null }>();
  for (const it of items) {
    if (!(it.value > 0)) continue;                 // skip zero/negative/NaN values
    const m = merged.get(it.key);
    if (m) { m.value += it.value; if (m.beta == null) m.beta = it.beta; }
    else merged.set(it.key, { value: it.value, sector: it.sector || "Unknown", beta: it.beta });
  }

  const totalValue = [...merged.values()].reduce((a, m) => a + m.value, 0);
  if (totalValue <= 0) {
    return { totalValue: 0, sectors: [], positions: [], portfolioBeta: null, betaCoveragePct: 0, excludedNoBeta: 0, warnings: [] };
  }

  const positions = [...merged.entries()]
    .map(([key, m]) => ({ key, value: m.value, pct: (m.value / totalValue) * 100 }))
    .sort((a, b) => b.value - a.value);

  const sectorMap = new Map<string, number>();
  for (const m of merged.values()) sectorMap.set(m.sector, (sectorMap.get(m.sector) ?? 0) + m.value);
  const sectors = [...sectorMap.entries()]
    .map(([sector, value]) => ({ sector, value, pct: (value / totalValue) * 100 }))
    .sort((a, b) => b.value - a.value);

  // Value-weighted beta over the covered slice only, so a half-unknown book
  // reports the beta of the half we can measure, plus honest coverage. Computed
  // over ORIGINAL holdings, not merged exposures: an option carries no equity
  // beta, so its value is excluded even when it merges into a stock position.
  let betaValue = 0, betaCovered = 0, excludedNoBeta = 0;
  for (const it of items) {
    if (!(it.value > 0)) continue;
    if (it.beta == null) { excludedNoBeta++; continue; }
    betaValue += it.value * it.beta;
    betaCovered += it.value;
  }
  const portfolioBeta = betaCovered > 0 ? betaValue / betaCovered : null;
  const betaCoveragePct = (betaCovered / totalValue) * 100;

  const warnings: Concentration["warnings"] = [];
  for (const p of positions) if (p.pct > maxPositionPct) warnings.push({ kind: "position", label: p.key, pct: p.pct, limit: maxPositionPct });
  for (const s of sectors) if (s.pct > sectorLimitPct) warnings.push({ kind: "sector", label: s.sector, pct: s.pct, limit: sectorLimitPct });

  return { totalValue, sectors, positions, portfolioBeta, betaCoveragePct, excludedNoBeta, warnings };
}

// ── self-check: `bun src/engine/concentration.ts` ────────────────────────────
if (import.meta.main) {
  const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  // Stock + option on same underlying merge into one position; sectors sum.
  const c = computeConcentration([
    { key: "AAPL", value: 6000, sector: "Technology", beta: 1.2 },
    { key: "AAPL", value: 2000, sector: "Technology", beta: null }, // an AAPL call, no equity beta
    { key: "JPM", value: 2000, sector: "Finance", beta: 0.9 },
  ], 20);
  assert(near(c.totalValue, 10000), "total 10000");
  assert(c.positions[0].key === "AAPL" && near(c.positions[0].value, 8000), "AAPL merged to 8000");
  assert(near(c.positions[0].pct, 80), "AAPL 80% of book");
  assert(c.sectors[0].sector === "Technology" && near(c.sectors[0].pct, 80), "Tech sector 80%");
  // Beta covers only the known-beta value: (6000*1.2 + 2000*0.9)/8000 = 1.125
  assert(near(c.portfolioBeta!, 1.125), `portfolioBeta ${c.portfolioBeta}`);
  assert(near(c.betaCoveragePct, 80), "beta covers 80% of value");
  assert(c.excludedNoBeta === 1, "1 holding excluded (merged AAPL kept its beta)");
  // Warnings: AAPL 80% > 20% (position), Tech 80% > 40% (sector).
  assert(c.warnings.some((w) => w.kind === "position" && w.label === "AAPL"), "position warning");
  assert(c.warnings.some((w) => w.kind === "sector" && w.label === "Technology"), "sector warning");

  // No known betas → null beta, 0 coverage, no crash.
  const c2 = computeConcentration([{ key: "XYZ", value: 100, sector: "Unknown", beta: null }], 20);
  assert(c2.portfolioBeta === null && c2.betaCoveragePct === 0 && c2.excludedNoBeta === 1, "all-unknown beta");
  // Empty / zero-value book → safe zeros.
  const c3 = computeConcentration([{ key: "Z", value: 0, sector: "X", beta: 1 }], 20);
  assert(c3.totalValue === 0 && c3.warnings.length === 0, "zero-value book safe");

  console.log("concentration self-check: OK");
}
