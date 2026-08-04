// One-time interactive Robinhood login from the terminal. The dashboard's
// Settings → Brokerage panel does the same thing in the UI: both call
// linkRobinhood(), this one just prompts for codes on the console.
// Run: `bun run link:robinhood`  (read-only access: sharpEdge never trades).
import { linkRobinhood, clearAuth } from "../src/broker/robinhood";
import { findUserByEmail } from "../src/auth";

function ask(q: string): string {
  const a = prompt(q.endsWith(": ") ? q : `${q}: `);
  if (a == null) { console.log("\nAborted."); process.exit(1); }
  return a.trim();
}

// Which sharpEdge account (sign up in the dashboard first) this link belongs to.
const mpEmail = ask("sharpEdge account email (sign up in the dashboard first if you haven't)");
const mpUser = await findUserByEmail(mpEmail);
if (!mpUser) {
  console.error(`\n✗ No sharpEdge account for "${mpEmail}". Sign up at the dashboard first, then re-run this.`);
  process.exit(1);
}

if (process.argv.includes("--clear")) {
  await clearAuth(mpUser.id);
  console.log(`Robinhood tokens cleared for ${mpEmail}.`);
  process.exit(0);
}

console.log("Robinhood link (read-only). Your password is sent only to Robinhood; tokens are stored locally.\n");
const username = ask("Robinhood email/username");
const password = ask("Password");

try {
  await linkRobinhood(mpUser.id, username, password, ask);
  console.log("\n✓ Linked. Restart the server (or hit Refresh in the dashboard) to pull positions.");
} catch (e) {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  console.error("Fall back to the dashboard's manual position import.");
  process.exit(1);
}
