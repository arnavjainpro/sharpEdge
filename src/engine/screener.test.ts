import { expect, test } from "bun:test";
import { downsampleIndices, sparkTimestamps, SPARK_POINTS, SPARK_WINDOW } from "./screener";

// The balance chart dates its curve with a timestamp array that has to line up,
// point for point, with the price array drawn beside it (SHARP-23). Nothing at
// runtime can notice a drift: a chart labelled with the wrong dates renders
// perfectly and is simply untrue. These pin the alignment instead.

test("downsampleIndices picks the same count it is asked for, in order, in range", () => {
  const idx = downsampleIndices(90, 30);
  expect(idx).toHaveLength(30);
  expect(idx[0]).toBe(0);
  expect(idx[idx.length - 1]).toBe(89);       // the latest bar is always kept
  for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1] - 1);
  expect(Math.min(...idx)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...idx)).toBeLessThan(90);
});

test("a series shorter than the target keeps every point", () => {
  expect(downsampleIndices(12, 30)).toEqual([...Array(12).keys()]);
});

// The real invariant: values and timestamps must be selected by the SAME rule.
// Two independent downsample passes would look right and drift silently.
test("values and timestamps downsample to the same indices", () => {
  const closes = Array.from({ length: SPARK_WINDOW }, (_, i) => 100 + i);
  const stamps = Array.from({ length: SPARK_WINDOW }, (_, i) => 1_700_000_000 + i * 86400);

  const idx = downsampleIndices(closes.length, SPARK_POINTS);
  const values = idx.map((i) => closes[i]);
  const ts = sparkTimestamps(stamps);

  expect(ts).toHaveLength(values.length);
  // Point i of the curve must carry the timestamp of the bar that produced it.
  ts.forEach((t, i) => expect(t).toBe(stamps[closes.indexOf(values[i])]));
});

test("sparkTimestamps only ever describes the window the spark is drawn from", () => {
  // 300 sessions in, 90 charted: the axis must start inside the last 90, never
  // at the beginning of history.
  const stamps = Array.from({ length: 300 }, (_, i) => 1_700_000_000 + i * 86400);
  const ts = sparkTimestamps(stamps);
  expect(ts).toHaveLength(SPARK_POINTS);
  expect(ts[0]).toBe(stamps[300 - SPARK_WINDOW]);
  expect(ts[ts.length - 1]).toBe(stamps[299]);
});

test("a short history still yields an axis that matches its own length", () => {
  const stamps = Array.from({ length: 10 }, (_, i) => 1_700_000_000 + i * 86400);
  expect(sparkTimestamps(stamps)).toHaveLength(10);
});
