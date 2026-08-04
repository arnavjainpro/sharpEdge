// F2b part 2: detect closed/reduced positions by diffing two broker snapshots.
// Pure and quote-free so it's fully testable: the wiring layer enriches each
// event with an estimated P&L from a live quote. Only ever diffs same-source
// robinhood snapshots (the caller guarantees this), so a provider fallback or a
// restart can't read as a mass liquidation.

export interface PosSnap {
  key: string;                    // stable position identity (the holding ticker string)
  ticker: string;                 // display/underlying ticker for the journal
  direction: "long" | "short";
  qty: number;                    // compared by magnitude; sign encodes direction
  assetClass: "equity" | "option";
  expiry?: string | null;         // ISO date for options
  costBasis?: number | null;
}

export interface CloseEvent {
  key: string;
  ticker: string;
  direction: "long" | "short";
  kind: "closed" | "reduced";
  prevQty: number;
  nowQty: number;
  closedQty: number;
  costBasis: number | null;
  note?: string;                  // e.g. possible symbol change
}

// prev/next: position snapshots. todayISO: YYYY-MM-DD, to suppress options that
// simply expired (a natural close the trader didn't act on, not worth a prompt).
export function closeDetect(prev: PosSnap[], next: PosSnap[], todayISO: string): CloseEvent[] {
  const nextByKey = new Map(next.map((p) => [p.key, p]));
  const prevByKey = new Map(prev.map((p) => [p.key, p]));
  // A brand-new position appearing in the same update hints a symbol/CUSIP
  // change (splits, ticker renames) rather than a clean close.
  const hasNewPosition = next.some((p) => !prevByKey.has(p.key));

  const events: CloseEvent[] = [];
  for (const p of prev) {
    const n = nextByKey.get(p.key);
    const prevQty = Math.abs(p.qty);
    const nowQty = n ? Math.abs(n.qty) : 0;
    if (nowQty >= prevQty) continue;                        // unchanged or added: not a close
    // Option that vanished on/after its expiry expired on its own: don't prompt.
    if (nowQty === 0 && p.assetClass === "option" && p.expiry && p.expiry <= todayISO) continue;
    events.push({
      key: p.key, ticker: p.ticker, direction: p.direction,
      kind: nowQty === 0 ? "closed" : "reduced",
      prevQty, nowQty, closedQty: prevQty - nowQty,
      costBasis: p.costBasis ?? null,
      note: hasNewPosition && nowQty === 0 ? "a new position appeared in the same update: possible symbol change" : undefined,
    });
  }
  return events;
}

// ── self-check: `bun src/broker/closeDetect.ts` ──────────────────────────────
if (import.meta.main) {
  const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  const eq = (k: string, d: "long" | "short", q: number, extra: Partial<PosSnap> = {}): PosSnap =>
    ({ key: k, ticker: k, direction: d, qty: q, assetClass: "equity", ...extra });
  const TODAY = "2026-07-19";

  // Full close of a long.
  let ev = closeDetect([eq("AAPL", "long", 100)], [], TODAY);
  assert(ev.length === 1 && ev[0].kind === "closed" && ev[0].closedQty === 100, "full close");

  // Partial reduction.
  ev = closeDetect([eq("AAPL", "long", 100)], [eq("AAPL", "long", 40)], TODAY);
  assert(ev.length === 1 && ev[0].kind === "reduced" && ev[0].nowQty === 40 && ev[0].closedQty === 60, "reduced");

  // Unchanged and grew → nothing.
  assert(closeDetect([eq("AAPL", "long", 100)], [eq("AAPL", "long", 100)], TODAY).length === 0, "unchanged");
  assert(closeDetect([eq("AAPL", "long", 100)], [eq("AAPL", "long", 150)], TODAY).length === 0, "added");

  // Short covered (magnitude drops to 0).
  ev = closeDetect([eq("TSLA", "short", -10)], [], TODAY);
  assert(ev.length === 1 && ev[0].direction === "short" && ev[0].kind === "closed", "short cover");

  // Expired option vanishing is suppressed; an in-force one is not.
  const opt = (exp: string): PosSnap => ({ key: `AAPL ${exp} C`, ticker: "AAPL", direction: "long", qty: 2, assetClass: "option", expiry: exp });
  assert(closeDetect([opt("2026-07-18")], [], TODAY).length === 0, "expired option suppressed");
  assert(closeDetect([opt("2026-12-19")], [], TODAY).length === 1, "in-force option close detected");

  // Vanish + a new position in the same diff → symbol-change note.
  ev = closeDetect([eq("FB", "long", 50)], [eq("META", "long", 50)], TODAY);
  assert(ev.length === 1 && !!ev[0].note, "symbol-change note set");

  console.log("closeDetect self-check: OK");
}
