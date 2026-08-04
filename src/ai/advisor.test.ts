import { expect, test } from "bun:test";
import { extractPortfolioScore, extractPortfolioVerdict } from "./advisor";

// The score and the verdict live only inside the model's markdown, so the
// scorePortfolio() prompt and these two parsers are one contract. Any edit to
// that prompt's heading or its "one-sentence verdict" line has to keep this
// passing: a silent miss here empties the history list and the score trend.
const reply = `## Portfolio score: 62/100
Solid core holdings, but too much of the book rides on one semiconductor trade.

**Pros**
- Cash buffer of $12,400 covers 3 months of drawdown.
- SPY and JPM both score 71+ long with the regime risk-on.

**Cons**
- NVDA + MRVL are 58% of equity: one sector, correlated.

**Biggest risk**: a semiconductor drawdown hits 58% of the book at once.

**Suggested next steps**
- Trim MRVL to bring semis under 40%.`;

test("pulls the score and the verdict out of a portfolio grade", () => {
  expect(extractPortfolioScore(reply)).toBe(62);
  expect(extractPortfolioVerdict(reply)).toBe(
    "Solid core holdings, but too much of the book rides on one semiconductor trade."
  );
});

test("a missing or out-of-range score is null, not a guess", () => {
  expect(extractPortfolioScore("No heading here.")).toBeNull();
  expect(extractPortfolioScore("## Portfolio score: 240/100")).toBeNull();
  expect(extractPortfolioVerdict("No heading here.")).toBeNull();
});
