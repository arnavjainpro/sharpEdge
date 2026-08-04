import { expect, test, afterAll } from "bun:test";
import { db } from "../db";
import { createUser, hashPassword } from "../auth";
import { persistSnapshot, loadPersisted, retirePersistedSnapshot } from "./index";
import type { BrokerSnapshot } from "./types";

// SHARP-28: the snapshot cache is process memory, so a restart used to blank the
// portfolio. These pin the durable copy that replaces it.
//
// NOTE: writes to the configured database, using throwaway @example.invalid
// accounts that are deleted afterwards: same convention as isolation.test.ts.

const made: number[] = [];
async function throwawayUser(): Promise<number> {
  const id = await createUser(`broker-test-${crypto.randomUUID()}@example.invalid`, await hashPassword("x"));
  made.push(id);
  return id;
}

afterAll(async () => {
  for (const id of made) {
    await db.query(`DELETE FROM broker_snapshots WHERE user_id = ?`).run(id);
    await db.query(`DELETE FROM users WHERE id = ?`).run(id);
  }
});

const snap = (source: BrokerSnapshot["source"], tickers: string[], equity: number | null = 1000): BrokerSnapshot => ({
  source,
  asOf: Math.floor(Date.now() / 1000),
  holdings: tickers.map((t) => ({ ticker: t, shares: 1 })),
  watchlist: [],
  openOrders: [],
  account: { equity, cash: null, buying_power: null },
} as unknown as BrokerSnapshot);

const storedSource = async (userId: number) =>
  ((await db.query(`SELECT source FROM broker_snapshots WHERE user_id = ?`).get(userId)) as { source: string } | null)?.source ?? null;

test("a live snapshot is written and comes back whole", async () => {
  const u = await throwawayUser();
  await persistSnapshot(u, snap("robinhood", ["AAPL", "NVDA"], 4242));

  const back = await loadPersisted(u);
  expect(back).not.toBeNull();
  expect(back!.source).toBe("robinhood");
  expect(back!.holdings.map((h) => h.ticker)).toEqual(["AAPL", "NVDA"]);
  expect(back!.account.equity).toBe(4242);
});

// The single most important assertion in SHARP-28. `manual` is the portfolio.yaml
// fallback: doRefresh reaches it whenever the live provider throws, so if it were
// persisted, the FIRST failed Robinhood refresh after a restart would overwrite
// the good snapshot with a near-empty one: destroying the thing this table
// exists to protect, silently, and looking like a successful refresh.
test("a yaml fallback never overwrites the last good live snapshot", async () => {
  const u = await throwawayUser();
  await persistSnapshot(u, snap("robinhood", ["AAPL", "NVDA", "MSFT"], 9999));

  await persistSnapshot(u, snap("manual", ["ONLY_YAML"], null));

  expect(await storedSource(u)).toBe("robinhood");
  const back = await loadPersisted(u);
  expect(back!.holdings.map((h) => h.ticker)).toEqual(["AAPL", "NVDA", "MSFT"]);
  expect(back!.account.equity).toBe(9999);
});

test("an imported snapshot is durable too: only yaml is excluded", async () => {
  const u = await throwawayUser();
  await persistSnapshot(u, snap("import", ["TSLA"]));
  expect(await storedSource(u)).toBe("import");
});

test("a later live refresh replaces the stored snapshot rather than duplicating it", async () => {
  const u = await throwawayUser();
  await persistSnapshot(u, snap("robinhood", ["OLD"]));
  await persistSnapshot(u, snap("robinhood", ["NEW"]));

  const rows = await db.query(`SELECT count(*)::int AS n FROM broker_snapshots WHERE user_id = ?`).get(u) as { n: number };
  expect(rows.n).toBe(1);
  expect((await loadPersisted(u))!.holdings.map((h) => h.ticker)).toEqual(["NEW"]);
});

// A corrupt row must degrade to the yaml path, not throw on a boot request -
// this runs inside doRefresh's failure branch, where throwing would turn a
// recoverable refresh failure into a dead endpoint.
test("a corrupt stored snapshot reads as absent instead of throwing", async () => {
  const u = await throwawayUser();
  await db.query(
    `INSERT INTO broker_snapshots (user_id, snapshot, source, as_of, updated_at)
     VALUES (?, ?, 'robinhood', 0, 0)`
  ).run(u, "{not json at all");

  expect(await loadPersisted(u)).toBeNull();
});

// The last-good rule is enforced on read as well as on write. persistSnapshot
// is not the only thing that can put a row in this table over its lifetime: a
// migration, a hand-run INSERT, or a future caller that forgets could: and a
// restored portfolio.yaml snapshot is exactly the silent downgrade the rule
// exists to prevent.
test("a 'manual' row already in the table is refused on read", async () => {
  const u = await throwawayUser();
  await db.query(
    `INSERT INTO broker_snapshots (user_id, snapshot, source, as_of, updated_at)
     VALUES (?, ?, 'manual', 0, 0)`
  ).run(u, JSON.stringify(snap("manual", ["YAML_ONLY"], null)));

  expect(await loadPersisted(u)).toBeNull();
});

test("one account's stored snapshot is never served to another", async () => {
  const a = await throwawayUser();
  const b = await throwawayUser();
  await persistSnapshot(a, snap("robinhood", ["A_ONLY"]));

  expect((await loadPersisted(a))!.holdings[0].ticker).toBe("A_ONLY");
  expect(await loadPersisted(b)).toBeNull();
});

// Unlinking has to retire the durable copy: otherwise a later failed refresh
// would restore positions from a brokerage the user just disconnected.
test("unlinking retires the stored snapshot", async () => {
  const u = await throwawayUser();
  await persistSnapshot(u, snap("robinhood", ["AAPL"]));
  expect(await loadPersisted(u)).not.toBeNull();

  await retirePersistedSnapshot(u);
  expect(await loadPersisted(u)).toBeNull();
});
