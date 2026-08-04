import { test, expect } from "bun:test";
import { toFinnhub, fromFinnhub, cachedQuote, patchQuoteFromTrade, type Quote } from "./finnhub";
import { SYMBOL_RE, normalizeSymbol } from "./universe";

test("symbol regex accepts class shares, rejects garbage", () => {
  for (const ok of ["AAPL", "BRK.B", "BRK/B", "BF.B", "BRK-B", "A"]) expect(SYMBOL_RE.test(ok)).toBe(true);
  for (const bad of [".....", "-A-B-", "^SPX", "ABR^D", "ABCDE.FG", "ABCDEF", "AAPL.", "AAPL-", "BRK//B"]) expect(SYMBOL_RE.test(bad)).toBe(false);
});

test("normalization round-trip", () => {
  expect(normalizeSymbol("brk.b ")).toBe("BRK-B");
  expect(normalizeSymbol("BRK/B")).toBe("BRK-B");
  expect(toFinnhub("BRK-B")).toBe("BRK.B");
  expect(fromFinnhub("BRK.B")).toBe("BRK-B");
  expect(toFinnhub("AAPL")).toBe("AAPL");
});

const quote = (over: Partial<Quote> = {}): Quote => ({ c: 100, d: 1, dp: 1, h: 101, l: 99, o: 100, pc: 99, t: 1_700_000_000, ...over });

function stubFetch(body: object) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  return () => calls;
}

test("cachedQuote is single-flight and caches for the TTL", async () => {
  const calls = stubFetch(quote());
  const [a, b] = await Promise.all([cachedQuote("AAPL"), cachedQuote("AAPL")]);
  await cachedQuote("AAPL"); // within TTL: still cached
  expect(calls()).toBe(1);
  expect(a.c).toBe(100);
  expect(b).toBe(a);
});

test("rejected fetch is evicted, not cached", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(quote({ c: 55 })));
  }) as unknown as typeof fetch;
  await expect(cachedQuote("MSFT")).rejects.toThrow();
  await Bun.sleep(1); // let the eviction .catch run
  const q = await cachedQuote("MSFT");
  expect(q.c).toBe(55);
  expect(calls).toBe(2);
});

test("WS trade patches existing entry: price, d/dp, t in seconds", async () => {
  stubFetch(quote({ c: 100, pc: 100, d: 0, dp: 0 }));
  const q = await cachedQuote("BRK-B");
  patchQuoteFromTrade("BRK-B", 110, 1_700_000_123_456);
  expect(q.c).toBe(110);
  expect(q.d).toBeCloseTo(10);
  expect(q.dp).toBeCloseTo(10);
  expect(q.t).toBe(1_700_000_123);
});

test("WS trade never creates an entry; pc=0 guard holds", async () => {
  patchQuoteFromTrade("ZZZZ", 5, Date.now()); // no entry: must be a no-op, no throw
  stubFetch(quote({ c: 1, pc: 0, d: 0, dp: 0 }));
  const q = await cachedQuote("BADQ");
  patchQuoteFromTrade("BADQ", 2, Date.now());
  expect(q.c).toBe(2);
  expect(q.dp).toBe(0); // untouched: no Infinity
});
