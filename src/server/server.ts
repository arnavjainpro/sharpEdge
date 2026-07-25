import { db, aiLive, setAiLive } from "../db";
import { config, marketPhase, nextMarketTransition } from "../config";
import { cachedQuote, wsStatus, fetchCompanyNews } from "../ingest/finnhub";
import { opusBreaker, haikuBreaker } from "../ai/breaker";
import { askAdvisor, summarizeTickerNews, scorePortfolio, type ChatTurn } from "../ai/advisor";
import { validateIdea, pickCandidates, recentIdeas, type IdeaReport, type IdeaFilters } from "../ai/validator";
import { universeMeta } from "../ingest/universe";
import { analyzeIntraday, manageTrade, type IntradayRequest, type FollowupRequest } from "../ai/intraday";
import { parseStrategy } from "../ai/strategy";
import { runBacktest, stressBacktest, walkForward, type StrategySpec } from "../engine/backtest";
import { fetchDailyCandles, fetchIntradayBars } from "../ingest/yahoo";
import { getScreenerRows, sectorBoards } from "../engine/screener";
import { scoreTicker } from "../engine/ticker";
import { listAlerts, createAlert, deleteAlert, type AlertKind } from "../engine/alerts";
import { getMarketSnapshot } from "../engine/market";
import { currentPortfolio, brokerSnapshot, refreshBroker, loadRiskConfigFor, updateWatchlist } from "../broker";
import { earningsFor, ideaScoreboard, calibration } from "../engine/insights";
import { computeConcentration, type ConcHolding } from "../engine/concentration";
import { getRiskPrefs, setRiskPrefs, spendByDay, getSettingFor, setSettingFor } from "../db";
import { saveImport, clearImport, type ImportPayload } from "../broker/manual";
import { getBrokerLink } from "../db";
import { allTickers } from "../config";
import { logOutcome, listOutcomes, deleteOutcome, trackTrade, listTracked, untrack, untrackByKey, trackedKeys } from "../ai/journal";
import { hashPassword, verifyPassword, createUser, findUserByEmail, findUserById, getProfile, updateProfile, createSession, destroySession } from "../auth";
import { userIdFromRequest, sessionTokenFromRequest, sessionCookieHeader, clearCookieHeader } from "../auth/middleware";
import { join } from "path";

// ── SSE hub ──────────────────────────────────────────────────────────────────
type SSEClient = { controller: ReadableStreamDefaultController; id: number };
const clients = new Map<number, SSEClient>();
let nextClientId = 1;

export function broadcast(type: string, payload: object) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [id, c] of clients) {
    try {
      c.controller.enqueue(new TextEncoder().encode(msg));
    } catch {
      clients.delete(id);
    }
  }
}

// Hook for dev-only test event injection; wired up by index.ts.
export let onTestEvent: ((body: any) => Promise<void>) | null = null;
export function setTestEventHandler(fn: (body: any) => Promise<void>) {
  onTestEvent = fn;
}

// Hook for on-demand briefing generation; wired up by index.ts.
let onBriefingRequest: (() => Promise<string>) | null = null;
export function setBriefingHandler(fn: () => Promise<string>) {
  onBriefingRequest = fn;
}
let briefingInFlight = false;
let generateInFlight = false;

// ── HTTP server ──────────────────────────────────────────────────────────────
export function startServer() {
  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
    maxRequestBodySize: 16 * 1024 * 1024, // chart screenshots
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        // SPA shell always serves; the frontend itself shows a login screen if
        // GET /api/auth/me comes back 401.
        return new Response(Bun.file(join(import.meta.dir, "public/index.html")));
      }

      if (url.pathname === "/api/auth/signup" && req.method === "POST") {
        try {
          const body = (await req.json()) as { email?: string; password?: string };
          const email = String(body.email ?? "").trim().toLowerCase();
          const password = String(body.password ?? "");
          if (!email || !email.includes("@")) return Response.json({ ok: false, error: "invalid email" }, { status: 400 });
          if (password.length < 8) return Response.json({ ok: false, error: "password must be at least 8 characters" }, { status: 400 });
          if (await findUserByEmail(email)) return Response.json({ ok: false, error: "an account with that email already exists" }, { status: 409 });
          const userId = await createUser(email, await hashPassword(password));
          const token = await createSession(userId);
          return Response.json({ ok: true, email }, { headers: { "Set-Cookie": sessionCookieHeader(token) } });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400 });
        }
      }

      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        try {
          const body = (await req.json()) as { email?: string; password?: string };
          const email = String(body.email ?? "").trim().toLowerCase();
          const password = String(body.password ?? "");
          const user = await findUserByEmail(email);
          if (!user || !(await verifyPassword(password, user.password_hash))) {
            return Response.json({ ok: false, error: "invalid email or password" }, { status: 401 });
          }
          const token = await createSession(user.id);
          return Response.json({ ok: true, email: user.email }, { headers: { "Set-Cookie": sessionCookieHeader(token) } });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400 });
        }
      }

      if (url.pathname === "/api/auth/logout" && req.method === "POST") {
        const token = sessionTokenFromRequest(req);
        if (token) await destroySession(token);
        return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookieHeader() } });
      }

      if (url.pathname === "/api/auth/me") {
        const userId = await userIdFromRequest(req);
        if (!userId) return Response.json({ ok: false }, { status: 401 });
        const user = await findUserById(userId);
        if (!user) return Response.json({ ok: false }, { status: 401 });
        return Response.json({ ok: true, userId: user.id, email: user.email });
      }

      // Everything below is per-user data — require a valid session.
      const userId = await userIdFromRequest(req);
      if (!userId) return Response.json({ ok: false, error: "not authenticated" }, { status: 401 });

      if (url.pathname === "/api/stream") {
        const id = nextClientId++;
        const stream = new ReadableStream({
          start(controller) {
            clients.set(id, { controller, id });
            controller.enqueue(new TextEncoder().encode(`event: hello\ndata: {}\n\n`));
          },
          cancel() {
            clients.delete(id);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/api/state") {
        const portfolio = currentPortfolio(userId);
        const events = await db
          .query(
            `SELECT e.*, s.action, s.conviction, s.plain_headline, s.thesis, s.invalidation, s.portfolio_impact
             FROM events e LEFT JOIN signals s ON s.event_id = e.id
             ORDER BY e.ts DESC LIMIT 100`
          )
          .all();
        const briefing = await db
          .query(`SELECT * FROM briefings ORDER BY ts DESC LIMIT 1`)
          .get();
        const broker = brokerSnapshot(userId);
        return Response.json({
          portfolio, events, briefing, marketPhase: marketPhase(), marketClock: nextMarketTransition(),
          earnings: earningsFor(portfolio.holdings.map((h) => h.ticker)),
          aiLive: await aiLive(),
          broker: broker
            ? { source: broker.source, asOf: broker.asOf, account: broker.account, openOrders: broker.openOrders }
            : null,
          health: {
            ws: { ...wsStatus, staleSec: wsStatus.lastMessageAt ? Math.round((Date.now() - wsStatus.lastMessageAt) / 1000) : null },
            breakers: [opusBreaker.status(), haikuBreaker.status()],
          },
        });
      }

      // Ranked screener results (pure quant — no AI cost to view)
      if (url.pathname === "/api/screener") {
        return Response.json({ rows: await getScreenerRows(currentPortfolio(userId)) });
      }

      // On-demand score + news for ANY ticker (search / ⌘K detail panel).
      if (url.pathname === "/api/ticker") {
        const outcome = await scoreTicker(url.searchParams.get("sym") ?? "");
        if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
        return Response.json(outcome.data);
      }

      // Autocomplete for the ⌘K search: matches ticker prefix or company-name
      // substring against the local universe (12k+ US stocks/ETFs). LIKE is
      // case-insensitive; the sanitized query strips wildcard/injection chars.
      if (url.pathname === "/api/search") {
        const q = (url.searchParams.get("q") ?? "").toUpperCase().replace(/[^A-Z0-9.\- ]/g, "").trim();
        if (!q) return Response.json({ results: [] });
        const rows = await db.query(
          // `ticker NOT LIKE '% %'` filters composite option strings ("MRVL
          // 2026-07-24 203C") out of results — the row guard, not a query guard,
          // so multi-word name search still works.
          // ILIKE (not LIKE): SQLite's LIKE is case-insensitive by default,
          // Postgres's is not — ILIKE preserves the original name-search behavior.
          `SELECT ticker, name FROM universe
           WHERE (ticker ILIKE ? || '%' OR name ILIKE '%' || ? || '%')
             AND ticker NOT LIKE '% %'
           ORDER BY
             CASE
               WHEN ticker = ? THEN 0
               WHEN ticker ILIKE ? || '%' THEN 1
               WHEN name ILIKE ? || '%' THEN 2
               ELSE 3
             END,
             market_cap DESC, length(ticker)
           LIMIT 8`
        ).all(q, q, q, q, q) as { ticker: string; name: string }[];
        return Response.json({ results: rows });
      }

      // Price / score alerts (per-user; the background evaluator fires them all
      // to the shared notification channel).
      if (url.pathname === "/api/alerts" && req.method === "GET") {
        return Response.json({ alerts: await listAlerts(userId) });
      }
      if (url.pathname === "/api/alerts" && req.method === "POST") {
        try {
          const { ticker, kind, threshold, recurring } = (await req.json().catch(() => ({}))) as
            { ticker?: string; kind?: AlertKind; threshold?: number; recurring?: boolean };
          if (!ticker || !kind) return Response.json({ error: "ticker and kind required" }, { status: 400 });
          return Response.json({ alert: await createAlert(userId, ticker, kind, Number(threshold), !!recurring) });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Bad alert" }, { status: 400 });
        }
      }
      if (url.pathname === "/api/alerts" && req.method === "DELETE") {
        await deleteAlert(userId, Number(url.searchParams.get("id")));
        return Response.json({ ok: true });
      }

      // Watchlist edits from the UI (star/unstar). Removes also suppress
      // broker/YAML-sourced entries.
      if (url.pathname === "/api/watchlist" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as { ticker?: string; action?: string };
          const action = body.action === "remove" ? "remove" : "add";
          const watchlist = await updateWatchlist(userId, String(body.ticker ?? ""), action);
          return Response.json({ ok: true, watchlist });
        } catch (err) {
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
        }
      }

      // Idea outcome scoreboard: replay past validated ideas against real
      // candles — did "strong" ratings actually win? (pure math, 1h cache)
      if (url.pathname === "/api/ideas/scoreboard") {
        try {
          return Response.json({ ok: true, ...(await ideaScoreboard(userId)) });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // F0: validator calibration — hit-rate + avg-R by rating/direction and
      // per-dimension win/loss score gaps. Shares the scoreboard's 1h replay cache.
      if (url.pathname === "/api/calibration") {
        try {
          return Response.json({ ok: true, ...(await calibration(userId)) });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // F3: portfolio concentration — deterministic ($0). Resolve each holding's
      // value/sector/beta, then let the pure engine do the grouping + warnings.
      if (url.pathname === "/api/concentration") {
        try {
          const holdings = currentPortfolio(userId).holdings.filter((h) => (h.asset_class as string) !== "crypto");
          const maxPositionPct = (await loadRiskConfigFor(userId)).max_position_pct ?? 20;
          // Beta + sector key off the underlying (options) or the ticker (equities).
          const betaFor = (key: string): number | null => {
            const row = db.query(`SELECT indicators FROM screener WHERE ticker = ?`).get(key) as any;
            if (!row) return null;
            try { return JSON.parse(row.indicators).beta ?? null; } catch { return null; }
          };
          const items: ConcHolding[] = await Promise.all(holdings.map(async (h) => {
            const key = (h.option?.underlying ?? h.ticker).toUpperCase();
            let value = 0;
            if (h.market_value != null) value = Math.abs(h.market_value);          // options / broker-priced
            else { try { const q = await cachedQuote(h.ticker); if (q?.c) value = Math.abs(h.shares * q.c); } catch {} }
            return { key, value, sector: (await universeMeta(key))?.sector ?? "Unknown", beta: h.asset_class === "option" ? null : betaFor(key) };
          }));
          return Response.json({ ok: true, ...computeConcentration(items, maxPositionPct) });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Market regime + sector rotation + per-sector setup boards
      if (url.pathname === "/api/market") {
        return Response.json({
          snapshot: await getMarketSnapshot(),
          boards: await sectorBoards(currentPortfolio(userId)),
        });
      }

      // Recent validated ideas (structured reports)
      if (url.pathname === "/api/ideas") {
        return Response.json({ ideas: await recentIdeas(userId, 20) });
      }

      // Validate one idea — long, short, or auto (user-initiated, always allowed)
      if (url.pathname === "/api/ideas/validate" && req.method === "POST") {
        try {
          const body = (await req.json()) as { ticker?: string; direction?: string; notes?: string; options?: boolean };
          const ticker = String(body.ticker ?? "").toUpperCase().trim();
          if (!ticker) return Response.json({ ok: false, error: "no ticker" }, { status: 400 });
          const direction = body.direction === "long" || body.direction === "short" ? body.direction : "auto";
          const report = await validateIdea(userId, ticker, direction, currentPortfolio(userId), {
            notes: body.notes, options: !!body.options, source: "validate",
          });
          if ("error" in report) return Response.json({ ok: false, error: report.error }, { status: 422 });
          return Response.json({ ok: true, report });
        } catch (err) {
          console.error("[server] validate failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Batch idea generation: strongest confluences across sectors, both
      // directions, validated one by one (capped — this is the expensive path).
      if (url.pathname === "/api/ideas/generate" && req.method === "POST") {
        if (generateInFlight) return Response.json({ ok: false, error: "already generating" }, { status: 429 });
        generateInFlight = true;
        try {
          const body = (await req.json().catch(() => ({}))) as { count?: number; filters?: IdeaFilters };
          const count = Math.min(Math.max(Number(body.count ?? 4), 1), 6);
          const portfolio = currentPortfolio(userId);
          const filters: IdeaFilters | undefined = body.filters
            ? {
                sectors: Array.isArray(body.filters.sectors) ? body.filters.sectors.map(String).slice(0, 20) : undefined,
                minScore: Number.isFinite(Number(body.filters.minScore)) ? Math.min(Math.max(Number(body.filters.minScore), 50), 100) : undefined,
                direction: body.filters.direction === "long" || body.filters.direction === "short" ? body.filters.direction : undefined,
                tickers: Array.isArray(body.filters.tickers) ? body.filters.tickers.map((t) => String(t).toUpperCase()).slice(0, 300) : undefined,
              }
            : undefined;
          const candidates = await pickCandidates(portfolio, count, filters);
          if (!candidates.length) {
            return Response.json({ ok: true, reports: [], note: "No setup-grade candidates match the current filters in the latest scan. That is a valid answer — don't force trades." });
          }
          const reports: IdeaReport[] = [];
          for (const c of candidates) {
            const r = await validateIdea(userId, c.ticker, c.direction, portfolio, { source: "generate" });
            if (!("error" in r)) reports.push(r);
          }
          return Response.json({ ok: true, reports });
        } catch (err) {
          console.error("[server] generate failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        } finally {
          generateInFlight = false;
        }
      }

      // Intraday analyzer: ticker and/or chart screenshot → structured plan
      if (url.pathname === "/api/intraday/analyze" && req.method === "POST") {
        try {
          const body = (await req.json()) as IntradayRequest;
          const plan = await analyzeIntraday(userId, body, currentPortfolio(userId));
          if ("error" in plan) return Response.json({ ok: false, error: plan.error }, { status: 422 });
          return Response.json({ ok: true, plan });
        } catch (err) {
          console.error("[server] intraday failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Backtest / walk-forward. Parses a described strategy (or reuses a spec
      // for free re-runs) then runs the deterministic engine — the AI never
      // computes results, only translates intent.
      if (url.pathname === "/api/backtest" && req.method === "POST") {
        try {
          const body = (await req.json()) as { ticker?: string; description?: string; spec?: StrategySpec; image?: string; walkForward?: boolean };
          const ticker = String(body.ticker ?? body.spec?.ticker ?? "").toUpperCase().trim();
          if (!ticker) return Response.json({ ok: false, error: "provide a ticker" }, { status: 400 });
          let spec = body.spec;
          if (!spec) {
            const parsed = await parseStrategy(ticker, body.description ?? "", body.image);
            if (parsed.error) return Response.json({ ok: false, error: parsed.error }, { status: 422 });
            if (parsed.clarification) return Response.json({ ok: true, clarification: parsed.clarification });
            spec = parsed.spec!;
          }
          spec.ticker = ticker;
          const candles = await fetchDailyCandles(ticker, "max", 250);
          if (!candles) return Response.json({ ok: false, error: `Not enough price history for ${ticker} (need ~1y+ of daily bars).` }, { status: 422 });
          const result = runBacktest(spec, candles);
          const stress = stressBacktest(result, candles);
          const years = (candles.timestamps.at(-1)! - candles.timestamps[0]) / (365.25 * 86400);
          let walkForwardResult = null, walkForwardError: string | null = null;
          if (body.walkForward) {
            if (years < 5) walkForwardError = `Walk-forward needs ~5y of history; ${ticker} has ${years.toFixed(1)}y. Showing the single-pass backtest only.`;
            else walkForwardResult = walkForward(spec, candles);
          }
          return Response.json({ ok: true, spec, result, stress, walkForward: walkForwardResult, walkForwardError, years: Math.round(years * 10) / 10 });
        } catch (err) {
          console.error("[server] backtest failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // In-trade management follow-up: prior plan + new screenshots + question
      if (url.pathname === "/api/intraday/followup" && req.method === "POST") {
        try {
          const body = (await req.json()) as FollowupRequest;
          const out = await manageTrade(userId, body, currentPortfolio(userId));
          if ("error" in out) return Response.json({ ok: false, error: out.error }, { status: 422 });
          return Response.json({ ok: true, answer: out.answer });
        } catch (err) {
          console.error("[server] followup failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Broker status / refresh / manual import fallback
      if (url.pathname === "/api/broker/status") {
        const s = brokerSnapshot(userId);
        return Response.json({
          snapshot: s ? { source: s.source, asOf: s.asOf, positions: s.holdings.length, watchlist: s.watchlist.length, openOrders: s.openOrders, account: s.account } : null,
          robinhoodLinked: (await getBrokerLink(userId))?.provider === "robinhood",
        });
      }
      if (url.pathname === "/api/broker/refresh" && req.method === "POST") {
        const snap = await refreshBroker(userId);
        return Response.json({ ok: true, source: snap.source, positions: snap.holdings.length });
      }
      if (url.pathname === "/api/broker/import" && req.method === "POST") {
        try {
          const payload = (await req.json()) as ImportPayload;
          await saveImport(userId, payload);
          const snap = await refreshBroker(userId);
          return Response.json({ ok: true, source: snap.source, positions: snap.holdings.length });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400 });
        }
      }
      if (url.pathname === "/api/broker/import/clear" && req.method === "POST") {
        await clearImport(userId);
        const snap = await refreshBroker(userId);
        return Response.json({ ok: true, source: snap.source });
      }

      // Trade-outcome journal: log how closed trades went; feeds AI prompts as context.
      if (url.pathname === "/api/journal/outcome" && req.method === "POST") {
        try {
          const body = (await req.json()) as any;
          const ticker = String(body.ticker ?? "").toUpperCase().trim();
          const direction = body.direction === "short" ? "short" : "long";
          const outcome = ["win", "loss", "breakeven"].includes(body.outcome) ? body.outcome : null;
          if (!ticker) return Response.json({ ok: false, error: "no ticker" }, { status: 400 });
          if (!outcome) return Response.json({ ok: false, error: "outcome must be win, loss, or breakeven" }, { status: 400 });
          const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
          const id = await logOutcome(userId, {
            ticker, direction, outcome,
            idea_id: num(body.idea_id), entry_price: num(body.entry_price), exit_price: num(body.exit_price),
            pnl_pct: num(body.pnl_pct), notes: String(body.notes ?? "").slice(0, 2000),
            closed_at: num(body.closed_at) ?? undefined,
          });
          untrackByKey(userId, ticker, direction); // journaling a trade clears its open track
          return Response.json({ ok: true, id });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400 });
        }
      }
      if (url.pathname === "/api/journal") {
        return Response.json({ outcomes: await listOutcomes(userId, 50), tracked: await listTracked(userId) });
      }
      if (url.pathname.startsWith("/api/journal/") && req.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        if (!Number.isInteger(id)) return Response.json({ ok: false, error: "bad id" }, { status: 400 });
        return Response.json({ ok: await deleteOutcome(userId, id) });
      }

      // F2b: track an idea toward a future journal entry (the manual path,
      // fallback for unlinked users). Ownership on idea_id guarded below.
      if (url.pathname === "/api/track" && req.method === "POST") {
        try {
          const body = (await req.json()) as any;
          const ticker = String(body.ticker ?? "").toUpperCase().trim();
          const direction = body.direction === "short" ? "short" : "long";
          if (!ticker) return Response.json({ ok: false, error: "no ticker" }, { status: 400 });
          const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
          let idea_id = num(body.idea_id);
          // Only accept an idea_id the caller actually owns (no cross-user linkage).
          if (idea_id != null) {
            const owns = db.query(`SELECT 1 FROM ideas WHERE id = ? AND user_id = ?`).get(idea_id, userId);
            if (!owns) idea_id = null;
          }
          const id = await trackTrade(userId, { ticker, direction, idea_id, entry_price: num(body.entry_price) });
          return Response.json({ ok: true, id });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400 });
        }
      }
      if (url.pathname === "/api/tracked") {
        return Response.json({ tracked: await listTracked(userId), keys: await trackedKeys(userId) });
      }

      // F1b: AI token usage per day (global — background pipeline spend isn't per-user).
      if (url.pathname === "/api/spend") {
        return Response.json({ days: await spendByDay(7) });
      }

      // F5: saved screener filter presets (per user, cross-device). Client owns the
      // list and POSTs the whole thing; server validates shape and caps at 8.
      if (url.pathname === "/api/filter-presets" && req.method === "GET") {
        try { return Response.json({ presets: JSON.parse(await getSettingFor(userId, "filter_presets", "[]")) }); }
        catch { return Response.json({ presets: [] }); }
      }
      if (url.pathname === "/api/filter-presets" && req.method === "POST") {
        try {
          const body = (await req.json()) as any;
          const clean = (Array.isArray(body.presets) ? body.presets : [])
            .filter((p: any) => p && typeof p.name === "string" && p.name.trim())
            .slice(0, 8)
            .map((p: any) => ({
              name: String(p.name).trim().slice(0, 40),
              customFilters: Array.isArray(p.customFilters) ? p.customFilters.slice(0, 20) : [],
              numFilters: { minScore: p.numFilters?.minScore ?? null, minCapB: p.numFilters?.minCapB ?? null },
            }));
          await setSettingFor(userId, "filter_presets", JSON.stringify(clean));
          return Response.json({ ok: true, presets: clean });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400 });
        }
      }
      if (url.pathname.startsWith("/api/tracked/") && req.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        if (!Number.isInteger(id)) return Response.json({ ok: false, error: "bad id" }, { status: 400 });
        return Response.json({ ok: await untrack(userId, id) });
      }

      // Per-user risk preferences (equity fallback, risk %, position cap, target R:R).
      if (url.pathname === "/api/risk-prefs") {
        if (req.method === "PUT" || req.method === "POST") {
          try {
            const body = (await req.json()) as Record<string, unknown>;
            const cur = await loadRiskConfigFor(userId);
            const num = (v: unknown, fallback: number) => (v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Number(v));
            const prefs = {
              // undefined = field not sent (keep current); null or "" = explicit
              // reset to the live broker figure; a number = manual override.
              account_equity: body.account_equity === undefined ? cur.account_equity
                : body.account_equity === null || body.account_equity === "" ? null
                : num(body.account_equity, 0),
              max_risk_per_trade_pct: Math.min(Math.max(num(body.max_risk_per_trade_pct, cur.max_risk_per_trade_pct), 0.1), 10),
              max_position_pct: Math.min(Math.max(num(body.max_position_pct, cur.max_position_pct), 1), 100),
              target_rr_ratio: Math.min(Math.max(num(body.target_rr_ratio, cur.target_rr_ratio), 1), 10),
            };
            await setRiskPrefs(userId, prefs);
            return Response.json({ ok: true, prefs });
          } catch (err) {
            return Response.json({ ok: false, error: String(err) }, { status: 400 });
          }
        }
        return Response.json({ prefs: await loadRiskConfigFor(userId), customized: !!(await getRiskPrefs(userId)) });
      }

      // Profile: name/phone are editable; email is the login identity and stays read-only.
      if (url.pathname === "/api/profile") {
        if (req.method === "PUT") {
          try {
            const body = (await req.json()) as Record<string, unknown>;
            const str = (v: unknown, max: number) => {
              const s = String(v ?? "").trim().slice(0, max);
              return s || null;
            };
            const fields = { full_name: str(body.full_name, 120), phone: str(body.phone, 32) };
            await updateProfile(userId, fields);
            return Response.json({ ok: true, profile: await getProfile(userId) });
          } catch (err) {
            return Response.json({ ok: false, error: String(err) }, { status: 400 });
          }
        }
        return Response.json({ ok: true, profile: await getProfile(userId) });
      }

      // Master switch for automatic AI spend (triage/analysis/scheduled briefings).
      // Global, not per-user — background monitoring is one shared pipeline (see index.ts).
      if (url.pathname === "/api/ai-live" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { on?: boolean };
        await setAiLive(!!body.on);
        console.log(`[ai] live updates ${body.on ? "ENABLED" : "PAUSED"} by user`);
        return Response.json({ ok: true, aiLive: await aiLive() });
      }

      // One-tap AI news digest for a ticker (fast model, user-initiated).
      if (url.pathname === "/api/news/summarize" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as { ticker?: string };
          const ticker = String(body.ticker ?? "").toUpperCase().trim();
          if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return Response.json({ ok: false, error: "bad ticker" }, { status: 400 });
          return Response.json({ ok: true, summary: await summarizeTickerNews(ticker) });
        } catch (err) {
          console.error("[server] news summarize failed:", err);
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        }
      }

      // Portfolio health check: deep-model pros/cons rundown with a 0-100 score.
      if (url.pathname === "/api/portfolio/score" && req.method === "POST") {
        try {
          return Response.json({ ok: true, analysis: await scorePortfolio(userId, currentPortfolio(userId)) });
        } catch (err) {
          console.error("[server] portfolio score failed:", err);
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        }
      }

      // Conversational advisor
      if (url.pathname === "/api/ask" && req.method === "POST") {
        try {
          const body = (await req.json()) as { question?: string; history?: ChatTurn[] };
          const question = String(body.question ?? "").trim();
          if (!question) return Response.json({ ok: false, error: "empty question" }, { status: 400 });
          const answer = await askAdvisor(userId, question, body.history ?? [], currentPortfolio(userId));
          return Response.json({ ok: true, answer });
        } catch (err) {
          console.error("[server] /api/ask failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Reset a tripped circuit breaker
      if (url.pathname === "/api/breaker/reset" && req.method === "POST") {
        opusBreaker.reset();
        haikuBreaker.reset();
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/quotes") {
        const portfolio = currentPortfolio(userId);
        // Same escape hatch the stock page uses: the portfolio Refresh button
        // asks for fresh=1, otherwise a click inside the 60s TTL re-renders the
        // exact same numbers and looks like nothing happened.
        const fresh = url.searchParams.get("fresh") === "1";
        const out: Record<string, any> = {};
        await Promise.all(
          allTickers(portfolio).map(async (t) => {
            try {
              out[t] = await cachedQuote(t, fresh);
            } catch {}
          })
        );
        return Response.json(out);
      }

      // Stock detail page bundle: quote + screener row + universe meta + spark
      // series + recent idea reports, in one call (no client-side waterfall).
      if (url.pathname.startsWith("/api/stock/")) {
        const ticker = decodeURIComponent(url.pathname.split("/").pop() ?? "").toUpperCase().trim();
        if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return Response.json({ ok: false, error: "bad ticker" }, { status: 400 });
        const meta = await universeMeta(ticker);
        const row = await db.query(`SELECT * FROM screener WHERE ticker = ?`).get(ticker) as any;
        const fresh = url.searchParams.get("fresh") === "1"; // stock-page Refresh bypasses the 60s quote cache
        let quote: any = null;
        try { quote = await cachedQuote(ticker, fresh); } catch {}
        let spark: { timestamps: number[]; closes: number[] } | null = null;
        let ohlc: { timestamps: number[]; opens: number[]; highs: number[]; lows: number[]; closes: number[] } | null = null;
        try {
          const c = await fetchDailyCandles(ticker, "1y", 30);
          if (c) {
            spark = { timestamps: c.timestamps.slice(-120), closes: c.closes.slice(-120) };
            if (c.opens && c.highs && c.lows) {
              ohlc = {
                timestamps: c.timestamps.slice(-120),
                opens: c.opens.slice(-120),
                highs: c.highs.slice(-120),
                lows: c.lows.slice(-120),
                closes: c.closes.slice(-120),
              };
            }
          }
        } catch {}
        // Finnhub /company-news 4xxs on ^-index symbols; skip news for those.
        let news: { headline: string; url: string; source: string; datetime: number }[] = [];
        if (!ticker.startsWith("^")) {
          try {
            const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
            const items = await fetchCompanyNews(ticker, iso(Date.now() - 7 * 86400_000), iso(Date.now()));
            news = (items ?? []).slice(0, 8).map((n: any) => ({ headline: n.headline, url: n.url, source: n.source, datetime: n.datetime }));
          } catch {}
        }
        if (!meta && !row && !quote?.c && !spark) {
          return Response.json({ ok: false, error: `No data found for "${ticker}" — check the symbol.` }, { status: 404 });
        }
        const ideaRows = await db
          .query(`SELECT ts, source, report FROM ideas WHERE user_id = ? AND ticker = ? AND source != 'intraday' ORDER BY ts DESC LIMIT 5`)
          .all(userId, ticker) as any[];
        const held = currentPortfolio(userId).holdings.find((h) => h.ticker === ticker) ?? null;
        return Response.json({
          ok: true, ticker, meta, quote, spark, ohlc, news, held,
          screener: row ? { ...row, indicators: JSON.parse(row.indicators) } : null,
          ideas: ideaRows.map((r) => ({ ...(JSON.parse(r.report)), ts: r.ts, source: r.source })),
        });
      }

      // Candle history for the stock-page timeframe switcher (1D…All). Maps the
      // timeframe to a Yahoo range/interval: intraday for 1D/5D, daily otherwise.
      if (url.pathname.startsWith("/api/candles/")) {
        const ticker = decodeURIComponent(url.pathname.split("/").pop() ?? "").toUpperCase().trim();
        if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return Response.json({ ok: false, error: "bad ticker" }, { status: 400 });
        const tf = (url.searchParams.get("tf") ?? "6M").toUpperCase();
        const intraday: Record<string, ["5m" | "15m" | "60m", string]> = { "1D": ["5m", "1d"], "1W": ["15m", "5d"] };
        const ranges: Record<string, string> = { "1M": "1mo", "3M": "3mo", "6M": "6mo", "1Y": "1y", "3Y": "5y", "5Y": "5y", ALL: "max" };
        try {
          const c = intraday[tf]
            ? await fetchIntradayBars(ticker, intraday[tf][0], intraday[tf][1])
            : await fetchDailyCandles(ticker, ranges[tf] ?? "6mo", 2);
          if (!c) return Response.json({ ok: false, error: "no data" }, { status: 404 });
          // Yahoo has no 3y range: fetch 5y and trim to the last 3 years. slice(0) is a no-op otherwise.
          let s = 0;
          if (tf === "3Y") {
            const cutoff = Date.now() / 1000 - 3 * 365 * 86400;
            s = Math.max(0, c.timestamps.findIndex((t) => t >= cutoff));
          }
          return Response.json({
            ok: true, tf,
            ohlc: { timestamps: c.timestamps.slice(s), opens: c.opens.slice(s), highs: c.highs.slice(s), lows: c.lows.slice(s), closes: c.closes.slice(s) },
          });
        } catch {
          return Response.json({ ok: false, error: "fetch failed" }, { status: 502 });
        }
      }

      // On-demand briefing (also generated automatically at 9:00 / 16:15 ET).
      if (url.pathname === "/api/briefing" && req.method === "POST") {
        if (!onBriefingRequest) return new Response("pipeline not ready", { status: 503 });
        if (briefingInFlight) return Response.json({ ok: false, error: "already generating" }, { status: 429 });
        briefingInFlight = true;
        try {
          const content = await onBriefingRequest();
          return Response.json({ ok: true, content });
        } catch (err) {
          console.error("[server] briefing failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        } finally {
          briefingInFlight = false;
        }
      }

      // Dev-only: inject a synthetic event to exercise the full pipeline.
      if (url.pathname === "/api/test-event" && req.method === "POST") {
        if (!onTestEvent) return new Response("pipeline not ready", { status: 503 });
        const body = await req.json().catch(() => ({}));
        await onTestEvent(body);
        return Response.json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
  });
  console.log(`[server] dashboard at http://localhost:${server.port}`);
  return server;
}
