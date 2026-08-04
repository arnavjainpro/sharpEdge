import { expect, test, afterAll } from "bun:test";
import { db } from "../db";
import { sectorHeatmap } from "./market";

// sector_history is appended irregularly: on a state change, or hourly,
// whichever comes first: so the bucketing is where this can silently go wrong:
// pick the wrong row in a week and the heatmap shows a transient intraday blip
// as if it were the week's verdict. These pin "last row in the week wins" and
// the shape of the axis.
//
// NOTE: writes to the configured database. Rows use a sector name no real
// taxonomy contains, and are deleted before and after so a crashed run can't
// leave a phantom row in the live heatmap.

const FAKE = "__canary_test_sector__";
const FAKE_B = "__canary_test_sector_b__";
const cleanup = () => db.query(`DELETE FROM sector_history WHERE sector LIKE '__canary_test_sector%'`).run();

// Monday 2026-07-06 00:00 UTC, and the two Mondays after it. date_trunc('week')
// is Monday-based, so these are exact week boundaries.
const MON_1 = Math.floor(Date.UTC(2026, 6, 6) / 1000);
const WEEK = 7 * 86400;

async function seed(rows: [sector: string, ts: number, state: string, rel1m: number][]) {
  for (const [sector, ts, state, rel1m] of rows) {
    await db.query(`INSERT INTO sector_history (sector, ts, state, rel1m) VALUES (?, ?, ?, ?) ON CONFLICT (sector, ts) DO NOTHING`)
      .run(sector, ts, state, rel1m);
  }
}

// The real table holds live rows too, so assertions look only at the fake ones.
const rowFor = (hm: Awaited<ReturnType<typeof sectorHeatmap>>, sector: string) => hm.rows.find((r) => r.sector === sector);

afterAll(cleanup);

test("each cell is the week's LAST reading, not its first or its loudest", async () => {
  await cleanup();
  // Three readings inside week 1. The Friday one is what the week closed at,
  // even though Tuesday's was a more extreme number.
  await seed([
    [FAKE, MON_1 + 86400, "lagging", -9],           // Tue, the loudest
    [FAKE, MON_1 + 2 * 86400, "improving", -1],     // Wed
    [FAKE, MON_1 + 4 * 86400, "leading", 3.5],      // Fri, the close
  ]);

  // Window must reach back past MON_1: these are fixed historical dates.
  const weeksBack = Math.ceil((Date.now() / 1000 - MON_1) / WEEK) + 2;
  const cells = rowFor(await sectorHeatmap(weeksBack), FAKE)!.cells.filter(Boolean);
  expect(cells).toHaveLength(1);
  expect(cells[0]!.state).toBe("leading");
  expect(cells[0]!.rel1m).toBeCloseTo(3.5);
});

test("weeks with no reading stay null instead of borrowing a neighbour", async () => {
  await cleanup();
  // Week 1 and week 3 have data; week 2 is a gap (app was off, say).
  await seed([
    [FAKE, MON_1 + 4 * 86400, "leading", 3],
    [FAKE, MON_1 + 2 * WEEK + 4 * 86400, "lagging", -4],
  ]);

  const weeksBack = Math.ceil((Date.now() / 1000 - MON_1) / WEEK) + 2;
  const hm = await sectorHeatmap(weeksBack);
  const row = rowFor(hm, FAKE)!;

  // The axis only contains weeks that some sector actually has data for, so
  // locate our two by their week stamps rather than assuming adjacency.
  const w1 = hm.weeks.indexOf(MON_1);
  const w3 = hm.weeks.indexOf(MON_1 + 2 * WEEK);
  expect(w1).toBeGreaterThanOrEqual(0);
  expect(w3).toBeGreaterThanOrEqual(0);
  expect(row.cells[w1]!.state).toBe("leading");
  expect(row.cells[w3]!.state).toBe("lagging");
  // A gap week for this sector is null even if the axis includes it.
  const w2 = hm.weeks.indexOf(MON_1 + WEEK);
  if (w2 >= 0) expect(row.cells[w2]).toBeNull();
});

test("the axis runs oldest → newest and every row aligns to it", async () => {
  await cleanup();
  await seed([
    [FAKE, MON_1 + 4 * 86400, "leading", 3],
    [FAKE, MON_1 + WEEK + 4 * 86400, "weakening", 1],
    [FAKE_B, MON_1 + WEEK + 4 * 86400, "lagging", -6],
  ]);

  const weeksBack = Math.ceil((Date.now() / 1000 - MON_1) / WEEK) + 2;
  const hm = await sectorHeatmap(weeksBack);
  expect(hm.weeks).toEqual([...hm.weeks].sort((a, b) => a - b));
  // Every row is padded to the axis length: the UI indexes cells by column.
  for (const r of hm.rows) expect(r.cells).toHaveLength(hm.weeks.length);
  // Stronger sector first: FAKE (+1) outranks FAKE_B (-6) on their latest week.
  const order = hm.rows.map((r) => r.sector).filter((s) => s.startsWith("__canary_test_sector"));
  expect(order).toEqual([FAKE, FAKE_B]);
});

test("nothing in the window is an empty heatmap, not a crash", async () => {
  await cleanup();
  // 0 weeks back = a window that starts now, so even live rows fall outside it.
  const hm = await sectorHeatmap(0);
  expect(hm.weeks).toEqual([]);
  expect(hm.rows).toEqual([]);
});
