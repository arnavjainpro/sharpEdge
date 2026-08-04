// One-off: delete the throwaway @example.invalid accounts left behind by a /qa
// signup and the freemium paywall verification. Scoped by exact email prefix so
// it can never touch a real account. Dry run by default; --yes to execute.
import { db } from "../src/db";

const PREFIXES = ["qa-test-", "paywall-test-"];
const confirmed = process.argv.includes("--yes");

const like = PREFIXES.map(() => `email LIKE ?`).join(" OR ");
const args = PREFIXES.map((p) => `${p}%@example.invalid`);
const users = await db
  .query(`SELECT id, email FROM users WHERE (${like})`)
  .all<{ id: number; email: string }>(...args);

if (!users.length) {
  console.log("No throwaway accounts match. Nothing to do.");
  process.exit(0);
}

console.log(`Throwaway accounts to delete (${users.length}):`);
for (const u of users) console.log(`  ${String(u.id).padStart(4)}  ${u.email}`);

// Guard: every match must be an @example.invalid with a known throwaway prefix.
const safe = users.every(
  (u) => u.email.endsWith("@example.invalid") && PREFIXES.some((p) => u.email.startsWith(p)),
);
if (!safe) {
  console.error("Refusing: a match is not a recognised throwaway address.");
  process.exit(1);
}

if (!confirmed) {
  console.log("\nDry run: nothing deleted. Re-run with --yes to actually do it.");
  process.exit(0);
}

const ids = users.map((u) => u.id);
const ph = ids.map(() => "?").join(",");

await db.transaction(async () => {
  // Children of the user's events first (no cascade on these).
  await db.query(`DELETE FROM event_triage WHERE user_id IN (${ph})`).run(...ids);
  await db.query(`DELETE FROM signals WHERE user_id IN (${ph})`).run(...ids);
  // tracked_trades / trade_outcomes carry an idea_id into `ideas`; deleting them
  // (they're owned by the user) removes that reference before we drop `ideas`.
  for (const t of [
    "sessions", "risk_prefs", "broker_links", "alerts", "artifacts",
    "trade_outcomes", "tracked_trades", "broker_positions", "briefings", "ideas",
    "usage_counters", "billing_interest", "pending_signups",
  ]) {
    // pending_signups keys on email, everything else on user_id.
    if (t === "pending_signups") {
      await db.query(`DELETE FROM pending_signups WHERE (${like})`).run(...args);
    } else {
      await db.query(`DELETE FROM ${t} WHERE user_id IN (${ph})`).run(...ids);
    }
  }
  await db.query(`DELETE FROM settings WHERE user_id IN (${ph})`).run(...ids);
  await db.query(`DELETE FROM events WHERE user_id IN (${ph})`).run(...ids);
  await db.query(`DELETE FROM users WHERE id IN (${ph})`).run(...ids);
})();

console.log(`\nDone. Deleted ${users.length} throwaway account(s).`);
process.exit(0);
