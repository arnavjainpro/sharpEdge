# TODOS

## Infrastructure

### Adopt VERSION/CHANGELOG.md convention

**What:** This repo has never had a `VERSION` file or `CHANGELOG.md` — `/ship` skipped the version-bump step for that reason.

**Why:** Without it there's no single source of truth for "what shipped when," and future `/ship` runs can't auto-bump or auto-changelog.

**Context:** `package.json` sits at a static `0.1.0`. If this stays a single-maintainer personal tool, it may not be worth adopting; if it grows collaborators or gets deployed anywhere versioned, it's worth doing then.

**Effort:** S
**Priority:** P3
**Depends on:** None

## sharpEdge

### AI spend meter

**What:** Log Anthropic token usage per call (the API response carries usage) and show a running $/day figure in Settings with a soft monthly cap.

**Why:** Spend is currently invisible until something fails (e.g. the empty-credits incident on 2026-07-12) — no visibility into cost before it becomes a problem.

**Context:** Every `client.messages.create()` call in `src/ai/*.ts` already goes through `claudeQueue()` — the natural hook point is wrapping that queue to record `response.usage` per call into a new table, then a Settings card summing it.

**Effort:** M
**Priority:** P2
**Depends on:** None

### PWA / phone-usable dashboard

**What:** Add a web manifest and a responsive pass so the dashboard works well on a phone home screen, complementing the existing Telegram alert delivery.

**Why:** Alerts already reach a phone via Telegram, but tapping through to act on them currently means a desktop-shaped dashboard.

**Context:** `src/server/public/index.html` is a single-file dashboard with sidebar nav — the main work is a mobile nav pattern (bottom tab bar or drawer) plus a `manifest.json` + icons.

**Effort:** L
**Priority:** P3
**Depends on:** None

### Sector rotation heatmap UI (F6b)

**What:** Market-tab heatmap of 11 sectors × trailing weeks colored by rotation state, drawn from the `sector_history` table.

**Why:** Turns "what's rotating now" into "what's been rotating for 3 weeks."

**Context:** Deferred from the 2026-07-19 autoplan until `sector_history` (F6a, approved) has ≥8 weeks of rows — nothing to draw before then.

**Effort:** M
**Priority:** P3
**Depends on:** F6a shipped + 8 weeks of data

### Data-feed canary checks

**What:** One degradation test per external feed (Yahoo chart API, Finnhub REST/ws, Robinhood private endpoints) that alerts when a feed's shape changes.

**Why:** Each can break the product overnight; today breakage is discovered by symptoms. Flagged in the 2026-07-19 autoplan CEO review as the real existential risk for this tool.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Chart axis numbers + hover readout (W3.2)

**What:** Add min/mid/max Y labels, first/mid/last X date labels, and a hover crosshair with a price readout (O/H/L/C for candles, date + price for lines) to `sparkSvg()` and `candleSvg()`.

**Why:** Charts today are shape-only — you can see a trend but not read a value off any point.

**Context:** Every chart SVG is `preserveAspectRatio="none"`, so a 100-unit viewBox stretched to ~600x200 scales SVG `<text>` 6x horizontally and 2x vertically. Axis labels MUST be an HTML overlay positioned by CSS, not `<text>`. Hover math is unaffected — `none` keeps the pixel->data inverse mapping linear. Bind `touchmove` alongside `mousemove`, and don't block scroll on mobile. Full detail in `docs/plans/2026-07-24-history-filters-charts.md`.

**Effort:** M
**Priority:** P2
**Depends on:** None

### AI concision pass (W3.3)

**What:** Cut AI output length. Portfolio score: 3-5 pros/cons -> max 3 each, one line per bullet, one-sentence verdict on top.

**Why:** Reports are too long to read in the moment.

**Context:** Rule is **shorten free-form prose only, never schema'd fields**. `advisor.ts` portfolio-score prompt is free-form markdown and safe to cut hard. `validator.ts` uses `output_config: json_schema` — `ideaScoreboard()` parses entry/stop/target off stored reports to compute hit rate and already tracks a `skipped` count for unparseable ones, so aggressive prompt caps can silently degrade your only feedback loop. Surface the scoreboard's `skipped/total` ratio in the UI as a regression alarm BEFORE touching validator prompts. A large part of the felt verbosity is presentation, not tokens: the live `showReport` path renders the full card expanded while History already collapses it — consider progressive disclosure first.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Completed

### History feed, persisted scores, one filter mechanism (PR #10, 2026-07-25)

Shipped W1, W2 and W3.1 of `docs/plans/2026-07-24-history-filters-charts.md`.

Root cause of "most things don't save": intraday analyses were written to
`ideas` and then filtered out of every read path by `AND source != 'intraday'`.
The Analyze tab's output was write-only.

Also shipped: `artifacts` table (portfolio scores + backtests persist), merged
`/api/history` feed with a row-wise `(ts, src, id)` cursor, filters collapsed
from two mechanisms to one, Robinhood linking restored and buying power read
from the live field. Bugs fixed: null market cap passing the cap filter,
all-time portfolio return computed from a changing share set, no in-flight
guard on portfolio scoring, unguarded `JSON.parse` 500ing the History tab.

Remaining from that plan: W3.2 and W3.3 above.
