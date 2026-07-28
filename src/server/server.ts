import { db, aiLive, setAiLive } from "../db";
import { config, marketPhase, nextMarketTransition } from "../config";
import { cachedQuote, wsStatus, fetchCompanyNews } from "../ingest/finnhub";
import { opusBreaker, haikuBreaker } from "../ai/breaker";
import { askAdvisor, summarizeTickerNews, scorePortfolio, extractPortfolioScore, extractPortfolioVerdict, type ChatTurn } from "../ai/advisor";
import { validateIdea, pickCandidates, recentIdeas, type IdeaReport, type IdeaFilters } from "../ai/validator";
import { universeMeta } from "../ingest/universe";
import { isFuture } from "../ingest/futures";
import { analyzeIntraday, manageTrade, type IntradayRequest, type FollowupRequest } from "../ai/intraday";
import { parseStrategy } from "../ai/strategy";
import { runBacktest, stressBacktest, walkForward, type StrategySpec } from "../engine/backtest";
import { fetchDailyCandles, fetchIntradayBars } from "../ingest/yahoo";
import { getScreenerRows, sectorBoards, getSparkTimestamps } from "../engine/screener";
import { scoreTicker } from "../engine/ticker";
import { listAlerts, createAlert, deleteAlert, type AlertKind } from "../engine/alerts";
import { getMarketSnapshot, sectorHeatmap } from "../engine/market";
import { canaryStatus, runCanaries } from "../engine/canary";
import { currentPortfolio, brokerSnapshot, refreshBroker, loadRiskConfigFor, updateWatchlist, retirePersistedSnapshot } from "../broker";
import { earningsFor, ideaScoreboard, calibration } from "../engine/insights";
import { computeConcentration, type ConcHolding } from "../engine/concentration";
import { createDrill, gradeDrill, practiceStats, resetPractice, CURRENT_COHORT, type Plan as PracticePlan } from "../engine/practice";
import { lessonViews, markComplete } from "../engine/learn";
import { LEVELS, CRITERION_LESSON } from "../content/lessons";
import { getRiskPrefs, setRiskPrefs, spendByDay, getSettingFor, setSettingFor } from "../db";
import { saveImport, clearImport, type ImportPayload } from "../broker/manual";
import { startLink, linkState, submitLinkCode, clearLinkState } from "../broker/link";
import { clearAuth } from "../broker/robinhood";
import { getBrokerLink, insertArtifact, deleteArtifact, deleteIdea, scoreHistory, historyFeed, ARTIFACT_KINDS, type HistoryCursor } from "../db";
import { allTickers, asRiskAppetite } from "../config";
import { logOutcome, listOutcomes, deleteOutcome, trackTrade, listTracked, untrack, untrackByKey, trackedKeys } from "../ai/journal";
import { hashPassword, verifyPassword, createUser, findUserByEmail, findUserById, getProfile, updateProfile, getPasswordHash, createSession, destroySession, startSignup, confirmSignup, pendingSignupExists, discardSignup, startEmailChange, confirmEmailChange, cancelEmailChange, getPendingEmail } from "../auth";
import { emailEnabled, sendEmail, verificationEmail } from "../notify/email";
import { userIdFromRequest, sessionTokenFromRequest, sessionCookieHeader, clearCookieHeader } from "../auth/middleware";
import { join } from "path";

// ── SSE hub ──────────────────────────────────────────────────────────────────
// Clients carry their userId so pushes can be addressed. Market-wide news
// (regime refresh, screener finished) still goes to everyone via broadcast();
// anything derived from a portfolio — an event's severity, a signal, a briefing
// — goes through broadcastTo so it reaches only the account it was written for.
type SSEClient = { controller: ReadableStreamDefaultController; id: number; userId: number };
const clients = new Map<number, SSEClient>();
let nextClientId = 1;

function push(c: SSEClient, msg: string) {
  try {
    c.controller.enqueue(new TextEncoder().encode(msg));
  } catch {
    clients.delete(c.id);
  }
}

export function broadcast(type: string, payload: object) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of [...clients.values()]) push(c, msg);
}

export function broadcastTo(userId: number, type: string, payload: object) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of [...clients.values()]) if (c.userId === userId) push(c, msg);
}

// Hook for dev-only test event injection; wired up by index.ts.
export let onTestEvent: ((body: any) => Promise<void>) | null = null;
export function setTestEventHandler(fn: (body: any) => Promise<void>) {
  onTestEvent = fn;
}

// Hook for on-demand briefing generation; wired up by index.ts. Takes the
// requesting user so the briefing is written against THEIR portfolio.
let onBriefingRequest: ((userId: number) => Promise<string>) | null = null;
export function setBriefingHandler(fn: (userId: number) => Promise<string>) {
  onBriefingRequest = fn;
}
// Per-user: two accounts asking for a briefing at once are two separate jobs,
// and a global flag made the second one 429 on the first one's work.
const briefingInFlight = new Set<number>();
let generateInFlight = false;
// Per-user, unlike generateInFlight: portfolio scoring is a per-account action.
const scoreInFlight = new Set<number>();

// ── HTTP server ──────────────────────────────────────────────────────────────
export function startServer() {
  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
    maxRequestBodySize: 16 * 1024 * 1024, // chart screenshots
    async fetch(req) {
      const url = new URL(req.url);

      // Public marketing page. The app itself lives at /app.
      if (url.pathname === "/") {
        return new Response(Bun.file(join(import.meta.dir, "public/landing.html")));
      }

      // SPA shell always serves; the frontend itself shows a login screen if
      // GET /api/auth/me comes back 401. /index.html stays wired to the app so
      // pre-existing bookmarks don't land on the marketing page.
      if (url.pathname === "/app" || url.pathname === "/app/" || url.pathname === "/index.html") {
        return new Response(Bun.file(join(import.meta.dir, "public/index.html")));
      }

      // Static brand assets (logo, favicon). Whitelisted by basename rather than
      // joined from user input — no path segment from the URL reaches the disk,
      // so "/assets/../../.env" can't escape the directory.
      if (url.pathname.startsWith("/assets/")) {
        const name = url.pathname.slice("/assets/".length);
        const ALLOWED = new Set([
          "logo-mark.png", "logo-sidebar.png", "logo-sidebar-dark.png",
          "logo-lockup.png", "logo-lockup-dark.png", "favicon.png",
          // landing page screenshots
          "shot-hero.png", "shot-ideas.png", "shot-analyze.png", "shot-stock.png",
          "shot-backtest.png", "shot-activity.png", "shot-learn.png", "shot-practice.png",
        ]);
        if (!ALLOWED.has(name)) return new Response("not found", { status: 404 });
        const file = Bun.file(join(import.meta.dir, "public/assets", name));
        // An allowlisted-but-missing file (a screenshot not captured yet) is a 404,
        // not the 500 that streaming a nonexistent Bun.file would throw.
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file, {
          headers: { "Cache-Control": "public, max-age=86400" },
        });
      }

      if (url.pathname === "/api/auth/signup" && req.method === "POST") {
        try {
          const body = (await req.json()) as { email?: string; password?: string };
          const email = String(body.email ?? "").trim().toLowerCase();
          const password = String(body.password ?? "");
          if (!email || !email.includes("@")) return Response.json({ ok: false, error: "invalid email" }, { status: 400 });
          if (password.length < 8) return Response.json({ ok: false, error: "password must be at least 8 characters" }, { status: 400 });
          // Gate before the existence check, so a rejected address can't be used to
          // probe which emails already have accounts.
          if (config.signupAllowlist.length && !config.signupAllowlist.includes(email)) {
            return Response.json({ ok: false, error: "this instance is invite-only — ask the owner to add your email" }, { status: 403 });
          }
          if (await findUserByEmail(email)) return Response.json({ ok: false, error: "an account with that email already exists" }, { status: 409 });
          const passwordHash = await hashPassword(password);

          // No mail transport means there is no way to verify anything, so
          // signup behaves as it did before this feature rather than bricking
          // the app — every other optional key here disables one feature.
          if (!emailEnabled()) {
            const userId = await createUser(email, passwordHash);
            const token = await createSession(userId);
            return Response.json({ ok: true, email }, { headers: { "Set-Cookie": sessionCookieHeader(token) } });
          }

          const code = await startSignup(email, passwordHash);
          const mail = verificationEmail(code);
          if (!(await sendEmail(email, mail.subject, mail.text, mail.html))) {
            await discardSignup(email); // don't strand a signup nobody can confirm
            return Response.json({ ok: false, error: "could not send the verification email — try again shortly" }, { status: 502 });
          }
          return Response.json({ ok: true, pending: true, email });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400 });
        }
      }

      // Finishes a staged signup. Unauthenticated by definition — it sits above
      // the session gate because it is what creates the account and the session.
      if (url.pathname === "/api/auth/confirm-signup" && req.method === "POST") {
        try {
          const body = (await req.json()) as { email?: string; code?: string };
          const email = String(body.email ?? "").trim().toLowerCase();
          const result = await confirmSignup(email, String(body.code ?? ""));
          // 400 for a wrong code, not 401: nothing here is authenticated yet, and
          // the client distinguishes on `restart`, not on the status.
          if (!result.ok) return Response.json({ ok: false, error: result.error, restart: result.restart }, { status: 400 });
          const session = await createSession(result.userId);
          return Response.json({ ok: true, email }, { headers: { "Set-Cookie": sessionCookieHeader(session) } });
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
          // A staged signup isn't an account yet, so the lookup misses and the
          // generic answer leaves you stuck with no way forward. Naming the
          // situation is a mild account-enumeration leak — the wrong trade on a
          // public service, the right one on a personal tool where being unable
          // to get in is the worse bug.
          if (!user && (await pendingSignupExists(email))) {
            return Response.json({ ok: false, error: "check your email for the verification code and enter it to finish creating this account" }, { status: 403 });
          }
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
            clients.set(id, { controller, id, userId });
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
        // Per-account view of a shared event log. The event row is global market
        // fact; the severity/rationale shown is THIS user's triage, and the
        // attached signal is THIS user's analysis. COALESCE falls back to the
        // global column for events recorded before the fan-out existed, so
        // history doesn't go blank.
        const events = await db
          .query(
            `SELECT e.id, e.ts, e.ticker, e.kind, e.title, e.detail,
                    COALESCE(t.severity, e.severity) AS severity,
                    COALESCE(t.rationale, e.triage_rationale) AS triage_rationale,
                    s.action, s.conviction, s.plain_headline, s.thesis, s.invalidation, s.portfolio_impact
             FROM events e
             LEFT JOIN event_triage t ON t.event_id = e.id AND t.user_id = ?
             LEFT JOIN signals s ON s.event_id = e.id AND s.user_id = ?
             WHERE e.user_id IS NULL OR e.user_id = ?
             ORDER BY e.ts DESC LIMIT 100`
          )
          .all(userId, userId, userId);
        const briefing = await db
          .query(`SELECT * FROM briefings WHERE user_id = ? ORDER BY ts DESC LIMIT 1`)
          .get(userId);
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
            // Empty until the first probe runs a minute after boot.
            canaries: canaryStatus(),
          },
        });
      }

      // Ranked screener results (pure quant — no AI cost to view)
      if (url.pathname === "/api/screener") {
        // sparkTs is sent once, not per row: this endpoint returns the whole
        // screener table and the dashboard re-polls it every 10 minutes.
        return Response.json({
          rows: await getScreenerRows(currentPortfolio(userId)),
          sparkTs: await getSparkTimestamps(),
        });
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
             -- Futures have market_cap 0, so without this they'd rank last and
             -- get cut by LIMIT; surface a matching future at the top of its tier.
             (sector = 'Futures') DESC,
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

      // ── Learn: 12 lessons, each wired to a number the app already computes
      // or a criterion the Practice drill grades. Deterministic, no AI.
      if (url.pathname === "/api/lessons") {
        try {
          return Response.json({ ok: true, levels: LEVELS, criterionLesson: CRITERION_LESSON, lessons: await lessonViews(userId) });
        } catch (err) {
          console.error("[learn] load failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/lessons/complete" && req.method === "POST") {
        try {
          const body = (await req.json()) as { id?: string; done?: boolean };
          const id = String(body.id ?? "");
          if (!id) return Response.json({ ok: false, error: "missing lesson id" }, { status: 400 });
          return Response.json({ ok: true, done: await markComplete(userId, id, body.done !== false) });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // ── Practice: blind replay drills. Deterministic ($0, no AI) — the grade
      // is arithmetic over real bars, so it is instant and reproducible.
      //
      // The anti-cheat lives here, not in the client: /new returns bars only up
      // to the as-of point, with no ticker and no timestamps. The ticker and the
      // future are first revealed by /submit, after the plan is committed.
      if (url.pathname === "/api/practice/new" && req.method === "POST") {
        try {
          const drill = await createDrill(userId);
          if ("error" in drill) return Response.json({ ok: false, error: drill.error }, { status: 503 });
          return Response.json({ ok: true, ...drill });
        } catch (err) {
          console.error("[practice] new failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/practice/submit" && req.method === "POST") {
        try {
          const body = (await req.json()) as { id?: number; direction?: string; entry?: number; stop?: number; target?: number };
          const id = Number(body.id);
          if (!Number.isFinite(id)) return Response.json({ ok: false, error: "missing drill id" }, { status: 400 });
          const dir = String(body.direction ?? "");
          if (dir !== "long" && dir !== "short" && dir !== "no_trade") {
            return Response.json({ ok: false, error: "direction must be long, short, or no_trade" }, { status: 400 });
          }
          const plan: PracticePlan = { direction: dir, entry: body.entry, stop: body.stop, target: body.target };
          const prefs = await getRiskPrefs(userId);
          const grade = await gradeDrill(userId, id, plan, prefs?.target_rr_ratio ?? 2);
          if ("error" in grade) return Response.json({ ok: false, error: grade.error }, { status: 422 });

          // Mirror into the history feed. Best-effort: a drill is already graded
          // and stored in its own table by this point, so a feed write that
          // fails must not turn a successful attempt into an error.
          const rTxt = grade.rMultiple != null ? `${grade.rMultiple >= 0 ? "+" : ""}${grade.rMultiple.toFixed(1)}R · ` : "";
          try {
            await insertArtifact({
              userId, kind: "practice", ticker: grade.ticker, score: grade.process.score,
              summary: `${grade.ticker} ${grade.plan.direction.replace("_", " ")} · ${rTxt}process ${grade.process.score}`,
              payload: JSON.stringify({ outcome: grade.outcome, rMultiple: grade.rMultiple, process: grade.process, plan: grade.plan }),
            });
          } catch (err) { console.error("[practice] artifact write failed:", err); }

          return Response.json({ ok: true, ...grade });
        } catch (err) {
          console.error("[practice] submit failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/practice/stats") {
        try {
          // The cohort travels with the numbers: "avg R" only means something
          // next to the kind of drill that produced it.
          return Response.json({ ok: true, ...(await practiceStats(userId)), cohort: CURRENT_COHORT });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Archive the practice record: moves a per-user marker forward so stats
      // start fresh. Deliberately not a DELETE — nothing the trader did is
      // destroyed, which is why a plain confirmation is proportionate.
      if (url.pathname === "/api/practice/reset" && req.method === "POST") {
        try {
          const { archived } = await resetPractice(userId);
          return Response.json({ ok: true, archived });
        } catch (err) {
          console.error("[practice] reset failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // F3: portfolio concentration — deterministic ($0). Resolve each holding's
      // value/sector/beta, then let the pure engine do the grouping + warnings.
      // Options are excluded: this reads as stock exposure, not a mixed
      // premium/notional blend that misrepresents how concentrated the book is.
      if (url.pathname === "/api/concentration") {
        try {
          const holdings = currentPortfolio(userId).holdings.filter((h) => (h.asset_class ?? "equity") === "equity");
          const maxPositionPct = (await loadRiskConfigFor(userId)).max_position_pct ?? 20;
          const betaFor = (key: string): number | null => {
            const row = db.query(`SELECT indicators FROM screener WHERE ticker = ?`).get(key) as any;
            if (!row) return null;
            try { return JSON.parse(row.indicators).beta ?? null; } catch { return null; }
          };
          const items: ConcHolding[] = await Promise.all(holdings.map(async (h) => {
            const key = h.ticker.toUpperCase();
            let value = 0;
            try { const q = await cachedQuote(h.ticker); if (q?.c) value = Math.abs(h.shares * q.c); } catch {}
            return { key, value, sector: (await universeMeta(key))?.sector ?? "Unknown", beta: betaFor(key) };
          }));
          return Response.json({ ok: true, ...computeConcentration(items, maxPositionPct) });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // Market regime + sector rotation + per-sector setup boards + the
      // trailing-weeks rotation heatmap (empty until sector_history fills in).
      if (url.pathname === "/api/market") {
        return Response.json({
          snapshot: await getMarketSnapshot(),
          boards: await sectorBoards(currentPortfolio(userId)),
          heatmap: await sectorHeatmap(12),
        });
      }

      // Recent validated ideas (structured reports)
      if (url.pathname === "/api/ideas") {
        return Response.json({ ideas: await recentIdeas(userId, 20, { includeIntraday: true }) });
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
          // Persist the spec + headline metrics, not the full result blob: a
          // backtest is deterministic from spec + candles and re-runs for free
          // (parseStrategy is skipped when spec is supplied), so the payload
          // only needs enough to re-run and to render the row if the re-run
          // fails. walkForward is NOT part of spec, so store it separately or
          // it silently vanishes on reopen.
          const m: any = result?.metrics ?? {};
          await insertArtifact({
            userId, kind: "backtest", ticker,
            summary: [
              m.totalReturnPct != null ? `${m.totalReturnPct >= 0 ? "+" : ""}${Number(m.totalReturnPct).toFixed(1)}%` : null,
              m.sharpe != null ? `${Number(m.sharpe).toFixed(2)} Sharpe` : null,
              m.trades != null ? `${m.trades} trades` : null,
            ].filter(Boolean).join(" · ") || null,
            payload: JSON.stringify({ spec, metrics: m, walkForward: !!body.walkForward, years: Math.round(years * 10) / 10 }),
          });
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

      // Robinhood link, driven from Settings → Brokerage. Login runs in the
      // background (device approval can take minutes) and the UI polls /status,
      // POSTing /code when Robinhood asks for a verification code.
      if (url.pathname === "/api/broker/link" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
        const username = String(body.username ?? "").trim();
        const password = String(body.password ?? "");
        if (!username || !password) return Response.json({ ok: false, error: "username and password required" }, { status: 400 });
        startLink(userId, username, password);
        return Response.json({ ok: true, ...linkState(userId) });
      }
      if (url.pathname === "/api/broker/link/status") {
        const st = linkState(userId);
        // A finished link is reported exactly once: pull the fresh positions,
        // then drop the pending state. Leaving it set would re-refresh (a live
        // Robinhood pull) and re-toast on every later visit to Settings.
        if (st?.state === "linked") {
          try { await refreshBroker(userId); } catch { /* still report linked; the next refresh retries */ }
          clearLinkState(userId);
        }
        return Response.json({ ok: true, status: st, linked: (await getBrokerLink(userId))?.provider === "robinhood" });
      }
      if (url.pathname === "/api/broker/link/code" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { code?: string };
        const accepted = submitLinkCode(userId, String(body.code ?? "").trim());
        return Response.json({ ok: accepted, error: accepted ? undefined : "no code was being asked for" }, { status: accepted ? 200 : 409 });
      }
      if (url.pathname === "/api/broker/unlink" && req.method === "POST") {
        await clearAuth(userId);
        clearLinkState(userId);
        // Drop the durable copy too — otherwise a later failed refresh would
        // restore positions from the account just disconnected.
        await retirePersistedSnapshot(userId);
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
              risk_appetite: body.risk_appetite === undefined ? cur.risk_appetite : asRiskAppetite(body.risk_appetite),
            };
            await setRiskPrefs(userId, prefs);
            return Response.json({ ok: true, prefs });
          } catch (err) {
            return Response.json({ ok: false, error: String(err) }, { status: 400 });
          }
        }
        return Response.json({ prefs: await loadRiskConfigFor(userId), customized: !!(await getRiskPrefs(userId)) });
      }

      // Profile: name/phone edit freely. Email is the sign-in identity, so a
      // change to it needs two independent proofs: the current password (gated
      // here) and a mailed code (staged here, applied by /confirm-email below).
      // A new address is never written to users.email in this route — see
      // startEmailChange's comment for why an unconfirmed one can't be allowed
      // to become the login.
      if (url.pathname === "/api/profile") {
        if (req.method === "PUT") {
          try {
            const body = (await req.json()) as Record<string, unknown>;
            const str = (v: unknown, max: number) => {
              const s = String(v ?? "").trim().slice(0, max);
              return s || null;
            };
            const fields = { full_name: str(body.full_name, 120), phone: str(body.phone, 32) };
            const current = await getProfile(userId);
            const email = String(body.email ?? "").trim().toLowerCase().slice(0, 254);
            if (email && email !== current?.email) {
              if (!emailEnabled()) {
                return Response.json({ ok: false, error: "email changes need a mail provider — set RESEND_API_KEY (see .env.example)" }, { status: 503 });
              }
              if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
                return Response.json({ ok: false, error: "that doesn't look like an email address" }, { status: 400 });
              }
              const hash = await getPasswordHash(userId);
              if (!hash || !(await verifyPassword(String(body.password ?? ""), hash))) {
                return Response.json({ ok: false, error: "current password is wrong" }, { status: 403 });
              }
              // Advisory only — the binding check is the UNIQUE index at
              // confirm time, since the address could be claimed by someone
              // else during the 15-minute window this code is live.
              if (await findUserByEmail(email)) {
                return Response.json({ ok: false, error: "an account with that email already exists" }, { status: 409 });
              }
              const code = await startEmailChange(userId, email);
              const mail = verificationEmail(code);
              if (!(await sendEmail(email, mail.subject, mail.text, mail.html))) {
                await cancelEmailChange(userId); // don't leave a change staged that can never be confirmed
                return Response.json({ ok: false, error: "could not send the verification email — try again shortly" }, { status: 502 });
              }
              await updateProfile(userId, fields);
              return Response.json({ ok: true, profile: await getProfile(userId), pendingEmail: email });
            }
            await updateProfile(userId, fields);
            return Response.json({ ok: true, profile: await getProfile(userId), pendingEmail: await getPendingEmail(userId) });
          } catch (err) {
            return Response.json({ ok: false, error: String(err) }, { status: 400 });
          }
        }
        // pendingEmail keeps the "enter your code" box on screen across a
        // reload; emailChangeAvailable === false means no mail provider is
        // configured, so the field goes read-only rather than offering a
        // change that will just 503.
        return Response.json({ ok: true, profile: await getProfile(userId), pendingEmail: await getPendingEmail(userId), emailChangeAvailable: emailEnabled() });
      }

      // Second half of an email change: the code proves the new inbox is real.
      if (url.pathname === "/api/profile/confirm-email" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { code?: string; cancel?: boolean };
        if (body.cancel) {
          await cancelEmailChange(userId);
          return Response.json({ ok: true, cancelled: true });
        }
        const res = await confirmEmailChange(userId, String(body.code ?? ""));
        return res.ok
          ? Response.json({ ok: true, email: res.email })
          : Response.json({ ok: false, error: res.error, restart: res.restart }, { status: 400 });
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
          if (!isFuture(ticker) && !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return Response.json({ ok: false, error: "bad ticker" }, { status: 400 });
          return Response.json({ ok: true, summary: await summarizeTickerNews(ticker) });
        } catch (err) {
          console.error("[server] news summarize failed:", err);
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        }
      }

      // Portfolio health check: deep-model pros/cons rundown with a 0-100 score.
      // Guarded per-user like /api/ideas/generate: this is a slow deep-model call,
      // so a double-click used to mean two Opus charges and two duplicate rows.
      if (url.pathname === "/api/portfolio/score" && req.method === "POST") {
        if (scoreInFlight.has(userId)) return Response.json({ ok: false, error: "already scoring" }, { status: 429 });
        scoreInFlight.add(userId);
        try {
          const analysis = await scorePortfolio(userId, currentPortfolio(userId));
          const score = extractPortfolioScore(analysis);
          await insertArtifact({
            userId, kind: "portfolio_score", score,
            summary: extractPortfolioVerdict(analysis),
            payload: JSON.stringify({ analysis }),
          });
          return Response.json({ ok: true, analysis, score });
        } catch (err) {
          console.error("[server] portfolio score failed:", err);
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        } finally {
          scoreInFlight.delete(userId);
        }
      }

      // Portfolio score trend for the sparkline in the portfolio hero.
      if (url.pathname === "/api/portfolio/score-history") {
        return Response.json({ scores: await scoreHistory(userId, 30) });
      }

      // Merged history feed: ideas + intraday analyses + saved artifacts.
      if (url.pathname === "/api/history") {
        try {
          // Clamp/allowlist everything: an unvalidated Number("abc") -> NaN
          // reaches LIMIT $n and 500s the query.
          const rawLimit = Number(url.searchParams.get("limit") ?? 30);
          const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 30;
          const ALLOWED = new Set(["idea", "intraday", ...ARTIFACT_KINDS]);
          const kindsRaw = (url.searchParams.get("kind") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
          const bad = kindsRaw.find((k) => !ALLOWED.has(k));
          if (bad) return Response.json({ ok: false, error: `unknown kind "${bad}"` }, { status: 400 });
          const kinds = kindsRaw.length ? kindsRaw : null;

          // Opaque cursor "ts.src.id" — a row-wise key, not a bare timestamp,
          // so same-second rows page correctly (generate writes several at once).
          let cursor: HistoryCursor | null = null;
          const before = url.searchParams.get("before");
          if (before) {
            const [ts, src, id] = before.split(".");
            if (!Number.isFinite(Number(ts)) || (src !== "i" && src !== "a") || !Number.isFinite(Number(id))) {
              return Response.json({ ok: false, error: "bad cursor" }, { status: 400 });
            }
            cursor = { ts: Number(ts), src, id: Number(id) };
          }

          const rows = await historyFeed(userId, limit, cursor, kinds);
          const items = rows.map((r) => {
            let payload: any = null;
            try { payload = JSON.parse(r.payload); } catch {} // poison row -> render the summary, not a 500
            return {
              cursor: `${r.ts}.${r.src}.${r.id}`,
              id: r.id, ts: r.ts, kind: r.kind, ticker: r.ticker,
              direction: r.direction, rating: r.rating, score: r.score, summary: r.summary,
              src: r.src,          // which table the id belongs to — DELETE needs it
              deletable: true,
              payload,
            };
          });
          return Response.json({ ok: true, items, more: items.length === limit });
        } catch (err) {
          console.error("[server] history failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      // The feed spans two tables with independent id sequences, so the row's
      // `src` ('i' = ideas/intraday, 'a' = artifacts) has to come back with the
      // id. Defaults to 'a' — the only source that was deletable before.
      if (url.pathname.startsWith("/api/history/") && req.method === "DELETE") {
        const id = Number(url.pathname.split("/").pop());
        if (!Number.isInteger(id)) return Response.json({ ok: false, error: "bad id" }, { status: 400 });
        const src = url.searchParams.get("src") ?? "a";
        if (src !== "i" && src !== "a") return Response.json({ ok: false, error: "bad src" }, { status: 400 });
        return Response.json({ ok: src === "i" ? await deleteIdea(userId, id) : await deleteArtifact(userId, id) });
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

      // Re-probe the data feeds on demand — the timer is 30 minutes, which is
      // too long to sit through when you're watching a feed come back.
      if (url.pathname === "/api/canary/check" && req.method === "POST") {
        return Response.json({ ok: true, canaries: await runCanaries() });
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
        if (!isFuture(ticker) && !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return Response.json({ ok: false, error: "bad ticker" }, { status: 400 });
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
        // Futures (and any symbol Finnhub can't quote) fall back to the last daily
        // candle so the detail page shows a real price instead of $0.
        if ((!quote || !quote.c) && spark && spark.closes.length) {
          const closes = spark.closes;
          const last = closes.at(-1)!;
          const prev = closes.length > 1 ? closes.at(-2)! : last;
          quote = { c: last, d: last - prev, dp: prev ? ((last - prev) / prev) * 100 : 0, h: last, l: last, o: prev, pc: prev };
        }
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
        // Intraday plans included: History links here, and excluding them meant
        // the analysis you clicked through to wasn't on the page.
        const ideaRows = await db
          .query(`SELECT id, ts, source, ticker, direction, rating, report FROM ideas WHERE user_id = ? AND ticker = ? ORDER BY ts DESC LIMIT 5`)
          .all(userId, ticker) as any[];
        const held = currentPortfolio(userId).holdings.find((h) => h.ticker === ticker) ?? null;
        return Response.json({
          ok: true, ticker, meta, quote, spark, ohlc, news, held,
          screener: row ? { ...row, indicators: JSON.parse(row.indicators) } : null,
          ideas: ideaRows.flatMap((r) => {
            try {
              // `id` rides along so the card's ✕ can delete the stored row, not
              // just the DOM node — dismissing here used to leave it in history.
              return [{ ...JSON.parse(r.report), id: r.id, ticker: r.ticker, direction: r.direction, rating: r.rating, ts: r.ts, source: r.source }];
            } catch { return []; }
          }),
        });
      }

      // Candle history for the stock-page timeframe switcher (1D…All). Maps the
      // timeframe to a Yahoo range/interval: intraday for 1D/5D, daily otherwise.
      if (url.pathname.startsWith("/api/candles/")) {
        const ticker = decodeURIComponent(url.pathname.split("/").pop() ?? "").toUpperCase().trim();
        if (!isFuture(ticker) && !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return Response.json({ ok: false, error: "bad ticker" }, { status: 400 });
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
        if (briefingInFlight.has(userId)) return Response.json({ ok: false, error: "already generating" }, { status: 429 });
        briefingInFlight.add(userId);
        try {
          const content = await onBriefingRequest(userId);
          return Response.json({ ok: true, content });
        } catch (err) {
          console.error("[server] briefing failed:", err);
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        } finally {
          briefingInFlight.delete(userId);
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
