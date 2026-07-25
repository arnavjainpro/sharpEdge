# sharpEdge — Persistence, History, Filters, Charts, AI Concision

Branch: `vignesh` | Base: `main` | Commit: 5440b77 | Author: Vignesh
Reviewed via /autoplan. Premise gate: **root-cause first** (D1=A), **auto-save scores** (D2=B).

> **Status:** W1, W2 and W3.1 SHIPPED in PR #10 (2026-07-25). W3.2 (chart
> numbers + hover) and W3.3 (AI concision) remain open.
>
> **Line numbers below were captured before the W1/W2 build** and index.html has
> shifted by several hundred lines since. Grep for the named symbol rather than
> jumping to the line.

## Problem

1. Can't see past analyses, validations, portfolio scores, ideas. Analyses in history should open the stock in full view.
2. Some filters are redundant; filters should be more dynamic and user-friendly.
3. Charts need axis numbers and hover-to-read price. Remove all-time gains from portfolio — inaccurate.
4. Search bar retains the last search; should reset every time.
5. Portfolio scores vanish on refresh; need history/log.
6. AI output is too long.

---

## Root cause (verified, and it is not what the original plan assumed)

**Intraday/swing analyses save correctly and are then filtered out of every read path.**

`src/ai/intraday.ts:402` writes them with `source='intraday'`. All three readers exclude them:

| Reader | Line | Clause |
|---|---|---|
| `recentIdeas()` — powers History | `src/ai/validator.ts:499` | `AND source != 'intraday'` |
| Stock-page recent reports | `src/server/server.ts:698` | `AND source != 'intraday'` |
| Scoreboard / calibration | `src/engine/insights.ts:140` | `AND source != 'intraday'` |

The Analyzer tab is the daily driver. Its output is write-only. **The user's complaint is fully correct**; an earlier draft of this plan called it "half true" and that was wrong.

Why the exclusion exists: intraday plans have a different shape and their own renderer, `planCardHtml()` (index.html:5493), distinct from `reportCardHtml()` (index.html:4606). The filter was a shortcut to avoid rendering the wrong shape — not a deliberate product decision.

### Persistence audit (rest of the surface)

| Feature | Endpoint | Persisted? |
|---|---|---|
| Validations / generated ideas | `/api/ideas/*` | YES → `ideas` |
| Intraday analyses | `/api/intraday/analyze` | YES → `ideas` (but unreadable, above) |
| Journal outcomes | `/api/journal/outcome` | YES → `trade_outcomes` |
| **Portfolio score** | `/api/portfolio/score` (server.ts:603) | **NO** |
| **Backtests** | `/api/backtest` (server.ts:374) | **NO** |
| **Chat** | `/api/ask` (server.ts:613) | **NO** — client array, capped 10 (index.html:5897) |
| **Followups** | `/api/intraday/followup` (server.ts:405) | **NO** |

---

## W1 — Ship now (~20 lines, zero risk)

**W1.1 Unblock intraday in history.** Add a `includeIntraday` option to `recentIdeas()` (validator.ts:497) and drop the clause for the History call only. Leave `insights.ts:140` untouched — scoreboard replay math genuinely needs the idea shape and would break on plan-shaped rows. Leave `server.ts:698` decision to W2.

**W1.2 History renders both shapes.** `loadPastIdeas()` (index.html:4898) dispatches on `rep.source`: `planCardHtml()` for `intraday`, `reportCardHtml()` otherwise. This is the actual reason the exclusion existed; without it W1.1 renders garbage.

**W1.3 Search resets.** `openTickerModal()` (index.html:3725) clears `tickerSearch.value`, resets `#ticker-result` to its hint, nulls `currentSym` / `lastTickerData`.

**W1.4 Remove portfolio all-time gains.** Delete the `#portfolio-total` line (index.html:4101-4103). `cost` basis ignores dividends, splits, partial sells, and closed positions, so "since you invested" is wrong by construction. Keep day change. **Do not touch index.html:5679** — that `Total return` is backtest metrics.

## W2 — Portfolio score history + unified History

**W2.1 Schema.** One table, `kind` discriminator (mirrors the existing `ideas.source` pattern):

```sql
CREATE TABLE IF NOT EXISTS artifacts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  ts integer NOT NULL,
  kind text NOT NULL,          -- portfolio_score | backtest
  ticker text,
  summary text NOT NULL,       -- one-line for the history list
  payload text NOT NULL        -- full JSON
);
CREATE INDEX IF NOT EXISTS idx_artifacts_user_ts ON artifacts(user_id, ts DESC);
```

**W2.2 Portfolio score auto-saves** (D2=B). `/api/portfolio/score` writes a row every run. History shows score + date, with a delete affordance and a score-over-time sparkline.

**W2.3 Backtests store the spec, not the payload.** A backtest is deterministic from `spec` + candles (server.ts:379-389) and costs $0 to re-run. Store the ~200-byte spec plus headline metrics; re-run on open. Avoids fat walk-forward blobs.

**W2.4 Chat and followups are NOT persisted.** Chat is a stateless advisor — transcripts have no recall value. Followups are fragments of a parent plan. Revisit if a second complaint arrives.

**W2.5 Unified History feed.** `GET /api/history?kind=&limit=&before=` merging `ideas` + `artifacts`, time-sorted, paginated (default 30, "Load more") — replaces the hard cap of 20 (server.ts:302). Kind chips: All / Ideas / Analyses / Scores / Backtests.

**W2.6 Full stock view from history.** Every ticker-bearing row routes to the existing `#stock/<ticker>` view (index.html:3609-3610). The route exists; History just never linked to it.

## W3 — Separate plans (deferred, not cut)

**W3.1 Filters (E4).** Collapse the redundant pair: `numFilters.minScore`/`minCapB` duplicate `CUSTOM_METRICS.score`/`.mcapB` (index.html:4374-4375), which already exist but are omitted from the `#cf-metric` dropdown. Two storage keys, two chip paths, two removal handlers for one job.
- **Migration must cover the server**: `numFilters` persists inside `filter_presets` (server.ts:521), not just localStorage. Deleting it without migrating orphans every saved preset.
- **Bug to fix regardless**: `passesFilters()` rejects null for custom rules (index.html:4400) but *accepts* null market cap (index.html:4404-4406), so "Cap ≥ $10B" silently includes unknown-cap tickers.
- User asked for *fewer* filters — do not add `between`/searchable-dropdown/live-count in the same pass.

**W3.2 Chart numbers + hover (E5).** All chart SVGs are `preserveAspectRatio="none"` (index.html:3062, 3877, 4265, 4580, 5184, 5669). A 100-unit viewBox stretched to ~600×200 scales SVG `<text>` 6× horizontally and 2× vertically — **axis labels must be HTML overlay positioned by CSS, not `<text>`**. Hover math is unaffected: `none` keeps the inverse mapping linear.

**W3.3 AI concision (E8).** Rule: **shorten free-form prose only, never schema'd fields.** `advisor.ts:231` is free-form markdown, safe to cut hard (3-5 bullets → max 3, one line each, one-sentence verdict on top). `validator.ts` uses `output_config: json_schema` — entry/stop/target survive concision, but aggressive prompt caps risk degrading them anyway, and `ideaScoreboard()` parses those levels to compute your hit rate. Surface the scoreboard's `skipped/total` ratio in the UI as the regression alarm before touching validator prompts.

---

## NOT in scope

- Data-feed canary checks (Yahoo/Finnhub/Robinhood shape-change detection). TODOS.md:56-63 flags this as the real existential risk, still P3 and unshipped since 2026-07-19. **Raised again here; user chose to keep it out of this plan.**
- AI report schema rewrite (breaks stored `ideas.report` JSON).
- Charting library (new dependency for ~40 lines of hover math).
- Persisting news summaries, chat, followups.
- Server-side filter execution.

## What already exists (reuse, don't rebuild)

- `ideas` table + `recentIdeas()` — extend with a flag, don't replace.
- `planCardHtml()` (5493) and `reportCardHtml()` (4606) — both already written.
- `#stock/<ticker>` routing (3609).
- `filter_presets` API (server.ts:508) — must keep working through W3.1.
- `money()`, `signed()`, `pct()`, `esc()`.

## Risks

- W1.1 without W1.2 renders intraday plans through the wrong template — ship them together.
- W3.1 migration missing the server-side preset store orphans saved user state.
- W3.3 concision degrading parseable price levels silently raises `ideaScoreboard()`'s skip count with nobody watching.
- Chart hover on mobile must not block scroll.

---

## Review corrections (Phases 2-3, all verified against code)

**C1 (critical) — W2.2 has nothing to store.** `scorePortfolio()` returns `Promise<string>` (advisor.ts:188); the 0-100 score exists only as `## Portfolio score: N/100` inside model-authored markdown (advisor.ts:228). No structured field. Fix: add `score integer` (nullable) to `artifacts`, extract once at write time with `/Portfolio score:\s*(\d{1,3})/`, store null on miss. `summary` must NOT be `NOT NULL`. Longer term move the score to a `json_schema` field so W3.3 concision can't break the chart.

**C2 (critical) — W1.2 breaks on the summary row, not the card body.** `recentIdeas()` selects only `ts, source, report` and spreads the parsed JSON (validator.ts:499-500). `IntradayPlan` has `setup_quality`, not `rating` (intraday.ts:38) — so index.html:4915 renders `rbadge undefined` on every intraday row. The `rating` column already holds the mapped value (intraday.ts:403, `no_trade`→`reject`). Fix: `SELECT ts, source, ticker, direction, rating, report` and build the summary from **columns**, body from `report`. Same contract W2.5 needs.

**C3 (critical) — History puts the answer third.** Pane order is Validator calibration → Idea scoreboard → Past analyses (index.html:3453-3477). The feed the user asked for is below the fold. Fix: feed first; collapse calibration + scoreboard into `<details>` beneath it.

**C4 (high) — the merged-feed cursor is not a total order.** `ideas.id` and `artifacts.id` are independent sequences; `ts` is second-granularity, and `/api/ideas/generate` writes several rows in one second (server.ts:345-348). `WHERE ts < before` drops the rest of the boundary second; `<=` loops. Fix: row-wise `(ts, src, id) < (?, ?, ?)` with a literal `'i'`/`'a'` src, exposed as an opaque cursor. Use `UNION ALL`, and `ORDER BY ts DESC LIMIT n` inside each branch so the existing indexes are used.

**C5 (high) — one row grammar, not four.** Scores have no ticker/direction/rating; backtests have no direction/rating. Three blank slots per row = ragged list. Fix: `[kind dot] [primary label] [one metric chip] [relative time]`, reusing the `.journal-item` layout (index.html:5086-5092). Scores read "Portfolio · 72/100", backtests "AAPL · +14% / 0.8 Sharpe".

**C6 (high) — unguarded JSON.parse.** `recentIdeas()` parses without try/catch (validator.ts:500) while `insights.ts:148` guards the same call. Opening a new row population to a poison row 500s the whole History tab. Fix: guard and skip.

**C7 (medium) — `server.ts:698` was deferred to W2 and W2 never covered it.** W2.6 routes an intraday row to `#stock/<ticker>` whose own recent-reports list still excludes intraday — the analysis you clicked isn't there. Decided: include intraday there too.

**C8 (medium) — schema migrations are create-only.** `db.exec(schema.sql)` runs every boot and every statement is `CREATE ... IF NOT EXISTS` (db.ts:57). New tables are safe; **column adds are silent no-ops**. Any future column (including C1's `score`) needs explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Comment this in schema.sql.

**C9 (medium) — saved backtests won't reproduce.** Re-run is free of AI (`parseStrategy` is skipped when `spec` is present, server.ts:379-385) but `fetchDailyCandles(ticker,"max",250)` is a growing window, so metrics drift. Also `walkForward` isn't part of `spec`. Decided: store headline metrics, label re-runs "recomputed through today", persist the `walkForward` flag, and render stored metrics with a "couldn't re-run" note on candle failure (never an error card).

**C10 (medium) — `/api/portfolio/score` has no in-flight guard** (server.ts:603), unlike `generateInFlight` (server.ts:326). It's a slow deep-model call, so double-clicks are normal: two Opus charges and two same-second rows that then collide with C4. Fix: per-user in-flight guard.

**C11 (medium) — input validation.** `db.query().all()` binds parameters (db.ts:33-36) so the builder is injection-safe, but `/api/history` must clamp `limit` to 1..100 (unvalidated `Number("abc")`→NaN 500s the query), allowlist `kind` (never string-build `IN (...)`; use `= ANY(?)`), and `Number.isFinite` the cursor. Match the clamping at server.ts:330. Keep `payload` as `text` — `toPg` rewrites every `?`, so `jsonb` containment operators would be mangled.

**C12 (medium) — missing states.** Follow the calibration pattern (index.html:4821-4866): skeleton, `!ok` empty, zero-data empty with a reason, catch → empty. `loadPastIdeas` has no skeleton; `loadJournal` swallows errors (`catch { }`, index.html:5100). Spec per-filter empties ("No backtests yet" ≠ "No history yet"), retry on error, **partial** (an `artifacts` failure must not 500 the merged feed), and hide "Load more" when exhausted.

**C13 (medium) — W1.4 leaves dead markup.** Delete `#portfolio-total` div (index.html:3061) and its CSS (1070-1074), not just the assignment. No visual hole: `#portfolio-spark` carries `margin-top:16px`.

**C14 (low) — chat cap is 10** (index.html:5897), not 8; index.html:5601 is the separate intraday-followup store. Two stores, not one.

## Testing

`package.json` has no `test` script and the repo has two test files total, neither covering SQL or rendering. Minimum viable check for this plan: one test asserting the merged cursor advances past a 3-row same-`ts` tie without dropping or repeating. That is the only failure here that is invisible in the UI.

## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|-------|----------|-------|-----------|-----------|
| 1 | CEO | Drop "half true" framing; user complaint is fully correct | Mechanical | P4 | Verified: 3 readers exclude intraday |
| 2 | CEO | Root-cause first, rescope to W1/W2/W3 | **User gate** | — | D1=A, user chose |
| 3 | CEO | Auto-save scores with delete | **User gate** | — | D2=B, user chose |
| 4 | CEO | Data-feed canary raised, kept out of scope | Mechanical | P6 | User scoped to A |
| 5 | CEO | Cut chat + followup persistence | Mechanical | P1/P4 | No recall value |
| 6 | Design | History feed first, calibration/scoreboard collapsed | Mechanical | P5 | Answer was below fold |
| 7 | Design | One row grammar for all kinds, reuse `.journal-item` | Mechanical | P4 | Reuse existing layout |
| 8 | Design | Sparkline in portfolio hero, not per row | Mechanical | P5 | Per-row charts destroy rhythm |
| 9 | Design | Don't backfill the removed total-return slot | Mechanical | P1 | Spark margin holds rhythm |
| 10 | Eng | Summary from columns, body from JSON | Mechanical | P1 | Fixes `rbadge undefined` |
| 11 | Eng | Row-wise `(ts,src,id)` cursor + UNION ALL | Mechanical | P1 | Naive cursor drops rows |
| 12 | Eng | `score integer` column, `summary` nullable | Mechanical | P1 | Nothing structured to store |
| 13 | Eng | In-flight guard on portfolio score | Mechanical | P1 | Double-charge + dup rows |
| 14 | Eng | Clamp/allowlist all `/api/history` params | Mechanical | Never-lazy | Trust boundary |
| 15 | Eng | Include intraday on stock page (server.ts:698) | Mechanical | P2 | Blast radius; W2.6 reads broken otherwise |
| 16 | Eng | Label backtest re-runs, store headline metrics | Mechanical | P3 | Simpler than pinning asOf |
| 17 | Eng | One cursor-tie test | Mechanical | P1 | Only invisible failure |
