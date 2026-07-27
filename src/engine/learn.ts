// Learn: resolves the reader's own numbers so a lesson can teach a concept
// against their actual portfolio rather than a worked example.
//
// Everything here is deterministic and cheap. Facts come from tables the app has
// already populated (risk_prefs, screener, practice_attempts) plus the in-memory
// broker snapshot, so opening a lesson costs no market-data fetch and no AI call.
// Any fact that cannot be resolved comes back null, and the lesson drops that
// callout rather than printing a placeholder.

import { db, getRiskPrefs, getSettingFor, setSettingFor } from "../db";
import { currentPortfolio } from "../broker";
import { universeMeta } from "../ingest/universe";
import { computeConcentration, type ConcHolding } from "./concentration";
import { cachedQuote } from "../ingest/finnhub";
import { LESSONS, LESSON_BY_ID, type Facts, type Lesson } from "../content/lessons";

const DONE_KEY = "lessons_done";

export async function completedLessons(userId: number): Promise<string[]> {
  const raw = await getSettingFor(userId, DONE_KEY, "[]");
  try {
    const v = JSON.parse(raw);
    // Ignore ids that no longer exist so a renamed lesson can't wedge progress.
    return Array.isArray(v) ? v.filter((id) => typeof id === "string" && LESSON_BY_ID.has(id)) : [];
  } catch { return []; }
}

export async function markComplete(userId: number, lessonId: string, done: boolean): Promise<string[]> {
  if (!LESSON_BY_ID.has(lessonId)) return await completedLessons(userId);
  const set = new Set(await completedLessons(userId));
  done ? set.add(lessonId) : set.delete(lessonId);
  const next = [...set];
  await setSettingFor(userId, DONE_KEY, JSON.stringify(next));
  return next;
}

export async function gatherFacts(userId: number): Promise<Facts> {
  const prefs = await getRiskPrefs(userId);
  const holdings = currentPortfolio(userId).holdings.filter((h) => (h.asset_class ?? "equity") === "equity");

  const facts: Facts = {
    equity: prefs?.account_equity ?? null,
    riskPct: prefs?.max_risk_per_trade_pct ?? 1,
    positions: holdings.length,
    topSector: null, topSectorPct: null, beta: null,
    atrTicker: null, atrPct: null, atrPrice: null,
    avgR: null, avgProcess: null, drills: 0,
  };

  // Sector split + beta. Same construction the /api/concentration route uses, so
  // the lesson quotes the identical number the Portfolio tab shows.
  if (holdings.length) {
    try {
      const items: ConcHolding[] = await Promise.all(holdings.map(async (h) => {
        const key = h.ticker.toUpperCase();
        let value = 0;
        try { const q = await cachedQuote(h.ticker); if (q?.c) value = Math.abs(h.shares * q.c); } catch { }
        const row = await db.query(`SELECT indicators FROM screener WHERE ticker = ?`).get(key) as any;
        let beta: number | null = null;
        try { beta = row ? JSON.parse(row.indicators).beta ?? null : null; } catch { }
        return { key, value, sector: (await universeMeta(key))?.sector ?? "Unknown", beta };
      }));
      const conc = computeConcentration(items, prefs?.max_position_pct ?? 20);
      if (conc.sectors.length) {
        facts.topSector = conc.sectors[0].sector;
        facts.topSectorPct = conc.sectors[0].pct;
      }
      facts.beta = conc.portfolioBeta;
    } catch { /* leave the sector facts null; the callout drops itself */ }
  }

  // A holding we can quote real volatility for, straight off the screener row —
  // no candle fetch, so a lesson never waits on Yahoo.
  for (const h of holdings) {
    const key = h.ticker.toUpperCase();
    const row = await db.query(`SELECT indicators FROM screener WHERE ticker = ?`).get(key) as any;
    if (!row) continue;
    try {
      const ind = JSON.parse(row.indicators);
      if (typeof ind.atrPct === "number" && typeof ind.price === "number") {
        facts.atrTicker = key; facts.atrPct = ind.atrPct; facts.atrPrice = ind.price;
        break;
      }
    } catch { }
  }

  try {
    const p = await db.query(
      `SELECT count(*)::int AS n,
              avg(r_multiple) FILTER (WHERE outcome IN ('win','loss')) AS avg_r,
              avg(process_score) AS avg_p
       FROM practice_attempts WHERE user_id = ? AND status = 'graded'`
    ).get(userId) as any;
    facts.drills = p?.n ?? 0;
    facts.avgR = p?.avg_r != null ? Number(p.avg_r) : null;
    facts.avgProcess = p?.avg_p != null ? Number(p.avg_p) : null;
  } catch { }

  return facts;
}

export interface LessonView extends Omit<Lesson, "live" | "body"> {
  body: string;
  liveNote: string | null;
  done: boolean;
}

/** Every lesson, resolved against this reader's data and progress. */
export async function lessonViews(userId: number): Promise<LessonView[]> {
  const [facts, done] = await Promise.all([gatherFacts(userId), completedLessons(userId)]);
  const doneSet = new Set(done);
  return LESSONS.map(({ live, ...rest }) => {
    let liveNote: string | null = null;
    // A broken fact hook must not take down the whole curriculum.
    try { liveNote = live ? live(facts) : null; } catch { liveNote = null; }
    return { ...rest, liveNote, done: doneSet.has(rest.id) };
  });
}
