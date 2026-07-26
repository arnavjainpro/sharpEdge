import { expect, test } from "bun:test";
import { APPETITE_PLAYBOOK } from "./intraday";
import { RISK_APPETITES } from "../config";

// TypeScript already guarantees every entry is a real member of the structure
// enum. What it can't check is whether the lists still mean what the settings UI
// promises the trader — these pin that, since the playbook is what decides which
// options structures the analyzer is allowed to hand back.

test("every appetite offers something, and never the escape hatch", () => {
  for (const a of RISK_APPETITES) {
    // An empty list would make the analyzer answer "none" forever.
    expect(APPETITE_PLAYBOOK[a].structures.length).toBeGreaterThan(0);
    // "none" is the no-play signal, not a structure to pick from.
    expect(APPETITE_PLAYBOOK[a].structures).not.toContain("none");
    expect(new Set(APPETITE_PLAYBOOK[a].structures).size).toBe(APPETITE_PLAYBOOK[a].structures.length);
    expect(APPETITE_PLAYBOOK[a].profile.length).toBeGreaterThan(20);
  }
});

test("conservative and balanced never buy naked premium; aggressive does", () => {
  const naked = ["long_call", "long_put", "straddle", "strangle"] as const;
  for (const a of ["conservative", "balanced"] as const) {
    for (const s of naked) expect(APPETITE_PLAYBOOK[a].structures).not.toContain(s);
  }
  expect(APPETITE_PLAYBOOK.aggressive.structures).toContain("long_call");
  expect(APPETITE_PLAYBOOK.aggressive.structures).toContain("long_put");
});

test("conservative keeps the income structures the settings note advertises", () => {
  for (const s of ["covered_call", "cash_secured_put", "iron_condor"] as const) {
    expect(APPETITE_PLAYBOOK.conservative.structures).toContain(s);
  }
});

// Defined-risk spreads are the common ground: they're the reason "balanced" is a
// safe default for a row that predates the setting.
test("verticals are available at every appetite", () => {
  for (const a of RISK_APPETITES) {
    expect(APPETITE_PLAYBOOK[a].structures).toContain("vertical_call_spread");
    expect(APPETITE_PLAYBOOK[a].structures).toContain("vertical_put_spread");
  }
});
