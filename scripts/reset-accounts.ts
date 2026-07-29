// Delete every user account and everything owned by one, so the app can be set
// up again from a clean signup. Run: bun run scripts/reset-accounts.ts --yes
//
// IRREVERSIBLE. What goes:
//   users, sessions, risk_prefs, broker_links (a linked Robinhood must be
//   re-linked from scratch, device auth and all), per-user settings, alerts,
//   ideas, artifacts, trade_outcomes, tracked_trades, broker_positions,
//   signals, briefings, event_triage, saved chat threads and their messages,
//   and the handful of owned events.
//
// What survives, because none of it belongs to an account:
//   events (public market facts), screener, universe, bars, sector_history,
//   market_snapshot, ai_spend, global settings (user_id = 0), config/*.yaml.
//
// Deletion order follows the foreign keys child-first. Postgres would refuse
// rather than corrupt anything if this were wrong, but a failed run halfway
// through is still a mess, so the whole thing is one transaction.
import { db } from "../src/db";

const confirmed = process.argv.includes("--yes");

const users = await db.query(`SELECT id, email FROM users ORDER BY id`).all<{ id: number; email: string }>();
if (!users.length) {
  console.log("No accounts exist — nothing to reset.");
  process.exit(0);
}

// Counted before the delete so the summary reports what actually went.
const OWNED = [
  "sessions", "risk_prefs", "broker_links", "alerts", "artifacts",
  "trade_outcomes", "tracked_trades", "broker_positions",
  "signals", "briefings", "event_triage", "chat_messages", "chat_threads",
] as const;

console.log("Accounts to delete:");
for (const u of users) console.log(`  ${String(u.id).padStart(3)}  ${u.email}`);

const counts: Record<string, number> = {};
for (const t of OWNED) {
  counts[t] = ((await db.query(`SELECT count(*)::int n FROM ${t}`).get()) as { n: number }).n;
}
counts["settings (per-user)"] = ((await db.query(`SELECT count(*)::int n FROM settings WHERE user_id <> 0`).get()) as { n: number }).n;
counts["ideas"] = ((await db.query(`SELECT count(*)::int n FROM ideas`).get()) as { n: number }).n;
counts["events (owned)"] = ((await db.query(`SELECT count(*)::int n FROM events WHERE user_id IS NOT NULL`).get()) as { n: number }).n;

console.log("\nRows that will be deleted:");
for (const [t, n] of Object.entries(counts)) if (n) console.log(`  ${t.padEnd(22)} ${n}`);

const keptEvents = ((await db.query(`SELECT count(*)::int n FROM events WHERE user_id IS NULL`).get()) as { n: number }).n;
const keptSettings = ((await db.query(`SELECT count(*)::int n FROM settings WHERE user_id = 0`).get()) as { n: number }).n;
console.log(`\nKept: ${keptEvents} public events, ${keptSettings} global settings, plus screener/universe/bars/sector_history.`);

if (!confirmed) {
  console.log("\nDry run — nothing deleted. Re-run with --yes to actually do it.");
  process.exit(0);
}

await db.transaction(async () => {
  // Children of ideas first: both carry an idea_id with no ON DELETE rule.
  await db.query(`UPDATE trade_outcomes SET idea_id = NULL`).run();
  await db.query(`UPDATE tracked_trades SET idea_id = NULL`).run();
  // Children of events.
  await db.query(`DELETE FROM event_triage`).run();
  await db.query(`DELETE FROM signals`).run();
  // Everything else owned by a user.
  // chat_messages before chat_threads: both carry ON DELETE CASCADE, so the
  // FK would resolve either way, but this script reports what it deleted and
  // the counts only line up if it deletes them itself.
  for (const t of ["sessions", "risk_prefs", "broker_links", "alerts", "artifacts",
                   "trade_outcomes", "tracked_trades", "broker_positions", "briefings", "ideas",
                   "chat_messages", "chat_threads"]) {
    await db.query(`DELETE FROM ${t}`).run();
  }
  // Per-user settings only — user_id 0 is the global namespace (ai_live etc).
  await db.query(`DELETE FROM settings WHERE user_id <> 0`).run();
  // The few events that belong to one account rather than the market.
  await db.query(`DELETE FROM events WHERE user_id IS NOT NULL`).run();
  await db.query(`DELETE FROM users`).run();
})();

const left = ((await db.query(`SELECT count(*)::int n FROM users`).get()) as { n: number }).n;
console.log(`\nDone. users table now holds ${left} row(s).`);
console.log("Next: restart the app and sign up. The first account inherits config/portfolio.yaml,");
console.log("and a Robinhood link has to be redone from Settings → Brokerage.");
process.exit(0);
