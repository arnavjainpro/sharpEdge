// The merged history feed pages over two tables whose `id` sequences are
// independent and whose `ts` is second-granularity. /api/ideas/generate writes
// several rows inside one second, so a bare `ts < before` cursor drops the rest
// of the boundary second and `ts <= before` loops forever. Neither failure is
// visible in the UI: the list just quietly misses rows: so it gets the one test.
import { expect, test } from "bun:test";

type Row = { ts: number; src: "i" | "a"; id: number };

// Mirrors the SQL predicate `(ts, src, id) < (?, ?, ?)` plus the outer
// `ORDER BY ts DESC, src DESC, id DESC`.
const before = (r: Row, c: Row) =>
  r.ts !== c.ts ? r.ts < c.ts : r.src !== c.src ? r.src < c.src : r.id < c.id;

const order = (a: Row, b: Row) =>
  b.ts - a.ts || (a.src === b.src ? 0 : a.src < b.src ? 1 : -1) || b.id - a.id;

function page(all: Row[], limit: number, cursor: Row | null): Row[] {
  return all.filter((r) => !cursor || before(r, cursor)).sort(order).slice(0, limit);
}

function drain(all: Row[], limit: number): Row[] {
  const seen: Row[] = [];
  let cursor: Row | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const p = page(all, limit, cursor);
    if (!p.length) break;
    seen.push(...p);
    cursor = p.at(-1)!;
  }
  return seen;
}

const key = (r: Row) => `${r.ts}.${r.src}.${r.id}`;

test("pages through a same-ts tie without dropping or repeating", () => {
  // Three ideas written in the same second, plus artifacts either side. The
  // id sequences deliberately collide across the two tables (id 1 in both).
  const all: Row[] = [
    { ts: 300, src: "a", id: 1 },
    { ts: 200, src: "i", id: 1 },
    { ts: 200, src: "i", id: 2 },
    { ts: 200, src: "i", id: 3 },
    { ts: 200, src: "a", id: 2 },
    { ts: 100, src: "i", id: 4 },
  ];

  // Page size 2 forces the cursor to land INSIDE the ts=200 tie.
  const drained = drain(all, 2);
  expect(drained.map(key)).toEqual([...all].sort(order).map(key));
  expect(new Set(drained.map(key)).size).toBe(all.length); // no repeats
});

test("terminates when every row shares one ts", () => {
  const all: Row[] = [1, 2, 3, 4, 5].map((id) => ({ ts: 200, src: "i" as const, id }));
  const drained = drain(all, 2);
  expect(drained.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
});

test("a ts-only cursor would drop rows: proving the composite key is needed", () => {
  const all: Row[] = [
    { ts: 200, src: "i", id: 1 },
    { ts: 200, src: "i", id: 2 },
    { ts: 100, src: "i", id: 3 },
  ];
  // Naive: WHERE ts < cursor.ts
  const naiveFirst = [...all].sort(order).slice(0, 2);
  const naiveRest = all.filter((r) => r.ts < naiveFirst.at(-1)!.ts);
  expect(naiveFirst.length + naiveRest.length).toBe(3);

  // With page size 1 the naive cursor skips the rest of the ts=200 second.
  const naiveOne = [...all].sort(order).slice(0, 1);
  const naiveOneRest = all.filter((r) => r.ts < naiveOne.at(-1)!.ts);
  expect(naiveOne.length + naiveOneRest.length).toBe(2); // row id=2 lost
  expect(drain(all, 1).length).toBe(3);                  // composite key keeps it
});
