import { expect, test } from "bun:test";
import {
  scoreProcess, gradePass, atrAt, readableAt,
  CURRENT_COHORT, INTERVAL, VISIBLE, HORIZON, GRADING_VERSION,
  type Plan,
} from "./practice";

// Process scoring is the claim the whole feature rests on: that a plan can be
// judged on its own terms, before anyone knows whether it won. These tests pin
// each of the four criteria independently, because a bug that quietly zeroes one
// of them would still produce a plausible-looking score.

// ATR 2, price ~100, so a 2-point stop is exactly 1x ATR.
const ctx = { atr: 2, recentLow: 95, recentHigh: 105, targetRR: 2 };
const long = (p: Partial<Plan>): Plan => ({ direction: "long", entry: 100, stop: 98, target: 104, ...p });
const got = (r: ReturnType<typeof scoreProcess>, name: string) =>
  r.detail.find((d) => d.criterion === name)!.got;

test("a textbook plan scores full marks", () => {
  const r = scoreProcess(long({}), ctx);
  expect(r.score).toBe(100);
  expect(r.detail).toHaveLength(4);
  // The four criteria must actually sum to the headline score, or the UI
  // breakdown and the number above it disagree.
  expect(r.detail.reduce((a, d) => a + d.got, 0)).toBe(r.score);
});

test("a stop on the wrong side of entry zeroes risk-defined and everything downstream of it", () => {
  const r = scoreProcess(long({ stop: 102 }), ctx);
  expect(got(r, "Risk defined")).toBe(0);
  // R:R and stop distance are meaningless once the stop is inverted — they must
  // not hand out marks off an absurd plan.
  expect(got(r, "Reward vs risk")).toBe(0);
  expect(got(r, "Stop distance")).toBe(0);
});

test("a short is graded with the sides flipped", () => {
  const good = scoreProcess({ direction: "short", entry: 100, stop: 102, target: 96 }, ctx);
  expect(good.score).toBe(100);
  const bad = scoreProcess({ direction: "short", entry: 100, stop: 98, target: 96 }, ctx);
  expect(got(bad, "Risk defined")).toBe(0);
});

test("reward:risk ramps from 1R and caps at the trader's target", () => {
  // risk 2 throughout; target moves to set the R multiple.
  const at1R = scoreProcess(long({ target: 102 }), ctx);   // exactly 1R → no credit
  const at15 = scoreProcess(long({ target: 103 }), ctx);   // 1.5R → half
  const at2R = scoreProcess(long({ target: 104 }), ctx);   // 2R → full
  const at5R = scoreProcess(long({ target: 110 }), ctx);   // beyond target → still full, not more
  expect(got(at1R, "Reward vs risk")).toBe(0);
  expect(got(at15, "Reward vs risk")).toBe(13);            // round(0.5 * 25)
  expect(got(at2R, "Reward vs risk")).toBe(25);
  expect(got(at5R, "Reward vs risk")).toBe(25);
});

test("stop distance rejects both a noise-tight stop and a runaway-wide one", () => {
  const tight = scoreProcess(long({ stop: 99.8 }), ctx);   // 0.1x ATR
  const wide = scoreProcess(long({ stop: 90, target: 130 }), ctx); // 5x ATR
  const ok = scoreProcess(long({ stop: 98 }), ctx);        // 1x ATR
  expect(got(tight, "Stop distance")).toBe(0);
  expect(got(wide, "Stop distance")).toBe(0);
  expect(got(ok, "Stop distance")).toBe(25);
  // A 5x-ATR stop is still a *defined* risk, so that criterion stays earned —
  // the criteria have to be independent or the score stops being diagnostic.
  expect(got(wide, "Risk defined")).toBe(25);
});

test("entry realism rejects a fill outside the recent range", () => {
  const inside = scoreProcess(long({ entry: 100 }), ctx);
  const below = scoreProcess(long({ entry: 80, stop: 78, target: 84 }), ctx);
  expect(got(inside, "Entry realism")).toBe(25);
  expect(got(below, "Entry realism")).toBe(0);
});

test("a missing stop or target does not throw and earns nothing", () => {
  const noStop = scoreProcess({ direction: "long", entry: 100, stop: null, target: 104 }, ctx);
  expect(got(noStop, "Risk defined")).toBe(0);
  expect(noStop.score).toBe(25); // entry realism only
});

test("no_trade earns full process marks and is graded on the pass instead", () => {
  const r = scoreProcess({ direction: "no_trade" }, ctx);
  expect(r.score).toBe(100);
  expect(r.detail).toHaveLength(1);
});

// gradePass is ATR-relative on purpose: "went nowhere" has to mean the same
// thing on a $4 stock and a $400 one.
test("passing is correct when price goes nowhere and wrong when it runs", () => {
  const flat = gradePass({ closes: [100, 100.5, 99.7, 100.2, 100.1] }, 2);
  expect(flat.outcome).toBe("pass_correct");
  expect(flat.netAtr).toBeLessThan(1);

  const ran = gradePass({ closes: [100, 102, 105, 108, 112] }, 2);
  expect(ran.outcome).toBe("pass_missed");
  expect(ran.netAtr).toBeCloseTo(6, 5);

  // Direction does not matter — a hard move down is just as missed.
  expect(gradePass({ closes: [100, 90] }, 2).outcome).toBe("pass_missed");
});

test("gradePass degrades safely on empty or zero-volatility input", () => {
  expect(gradePass({ closes: [] }, 2).outcome).toBe("pass_correct");
  expect(gradePass({ closes: [100, 130] }, 0).outcome).toBe("pass_correct");
});

test("atrAt measures volatility as of the given bar, not the end of the series", () => {
  // Calm for 20 bars, then violent. ATR at the calm bar must not see the storm.
  const n = 40;
  const highs: number[] = [], lows: number[] = [], closes: number[] = [];
  for (let i = 0; i < n; i++) {
    const wild = i >= 20;
    highs.push(wild ? 120 : 101);
    lows.push(wild ? 80 : 99);
    closes.push(100);
  }
  const c = { ticker: "T", opens: closes, highs, lows, closes, volumes: closes, timestamps: closes.map((_, i) => i) };
  const calm = atrAt(c as any, 19)!;
  const storm = atrAt(c as any, 39)!;
  expect(calm).toBeCloseTo(2, 5);
  expect(storm).toBeGreaterThan(20);
});

// ── SHARP-32: the reveal must describe what was READABLE, never what happened ──
// This is the invariant the whole drill rests on. If a level, average or momentum
// reading shifts because future bars exist in the series, the "what you could
// have seen" panel is quietly grading with hindsight and the feature is a lie.

// Calm, gently rising bars up to the as-of point, then a violent spike after it.
// Anything that leaks the future will move when the tail is attached.
function series(n: number, spikeFrom: number) {
  const opens: number[] = [], highs: number[] = [], lows: number[] = [], closes: number[] = [], timestamps: number[] = [];
  for (let i = 0; i < n; i++) {
    const spiked = i >= spikeFrom;
    const base = spiked ? 400 : 100 + (i % 7);
    opens.push(base); closes.push(base);
    highs.push(base + (spiked ? 60 : 1));
    lows.push(base - (spiked ? 60 : 1));
    // 15-minute bars, so the session-boundary logic gets realistic spacing.
    timestamps.push(1_700_000_000 + i * 900);
  }
  return { ticker: "T", opens, highs, lows, closes, volumes: closes.map(() => 1000), timestamps };
}

const plan: Plan = { direction: "long", entry: 100, stop: 98, target: 106 };

test("readableAt is identical with and without the bars that came after it", () => {
  const asOf = 119;
  const visibleOnly = series(asOf + 1, 9_999);          // no future at all
  const withFuture = series(asOf + 1 + 26, asOf + 1);   // violent spike after as-of

  const a = readableAt(visibleOnly as any, asOf, 2, plan);
  const b = readableAt(withFuture as any, asOf, 2, plan);

  expect(b).toEqual(a);
});

test("every level the reveal draws sits inside the range the trader could see", () => {
  const asOf = 119;
  const c = series(asOf + 1 + 26, asOf + 1);
  const visHigh = Math.max(...c.highs.slice(0, asOf + 1));
  const visLow = Math.min(...c.lows.slice(0, asOf + 1));

  for (const r of readableAt(c as any, asOf, 2, plan)) {
    if (r.level == null) continue;
    expect(r.level).toBeLessThanOrEqual(visHigh);
    expect(r.level).toBeGreaterThanOrEqual(visLow);
  }
});

test("the reveal explains every reading it shows", () => {
  const asOf = 119;
  const out = readableAt(series(asOf + 1, 9_999) as any, asOf, 2, plan);
  expect(out.length).toBeGreaterThan(0);
  for (const r of out) {
    // A number with no explanation is decoration, which is what this panel exists
    // not to be.
    expect(r.label.length).toBeGreaterThan(0);
    expect(r.value.length).toBeGreaterThan(0);
    expect(r.meant.length).toBeGreaterThan(20);
    expect(r.plan.length).toBeGreaterThan(10);
  }
  expect(out.some((r) => r.label === "ATR")).toBe(true);
});

test("a passed drill still gets its read explained, without a direction to judge", () => {
  const asOf = 119;
  const out = readableAt(series(asOf + 1, 9_999) as any, asOf, 2, { direction: "no_trade" });
  expect(out.length).toBeGreaterThan(0);
  for (const r of out) expect(r.plan.length).toBeGreaterThan(0);
});

test("the current cohort is the one new drills are stamped with", () => {
  // Stats filter on these four values, so a drift between the constants used to
  // POSE a drill and the ones used to COUNT it would silently empty the record.
  expect(CURRENT_COHORT).toEqual({
    interval: INTERVAL, visibleBars: VISIBLE, horizon: HORIZON, gradingVersion: GRADING_VERSION,
  });
  expect(INTERVAL).toBe("15m");
  // "at most a week" of context: 120 bars of 15m is well under 5 sessions.
  expect(VISIBLE / 26).toBeLessThan(5);
});
