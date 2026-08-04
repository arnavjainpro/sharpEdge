// Diagnostic: dump the raw Robinhood balance fields so we can see which one
// matches the app's displayed buying power. Read-only. Run: bun scripts/rh-account.ts <email>
import { loadAuth } from "../src/broker/robinhood";
import { findUserByEmail } from "../src/auth";

const email = process.argv[2];
if (!email) { console.error("usage: bun scripts/rh-account.ts <sharpEdge account email>"); process.exit(1); }

const user = await findUserByEmail(email);
if (!user) { console.error(`no sharpEdge account for "${email}"`); process.exit(1); }

const auth = await loadAuth(user.id);
if (!auth) { console.error("robinhood not linked for that account: run `bun run link:robinhood` first"); process.exit(1); }

const headers = { Authorization: `Bearer ${auth.access_token}`, "User-Agent": "*", Accept: "*/*" };
const get = async (p: string) => (await fetch(`https://api.robinhood.com${p}`, { headers })).json();

const acc = (await get("/accounts/")).results?.[0] ?? {};
const pf = (await get("/portfolios/")).results?.[0] ?? {};

console.log("\n/accounts/ balance fields:");
for (const k of ["buying_power", "cash", "portfolio_cash", "cash_available_for_withdrawal", "cash_held_for_orders", "unsettled_funds", "uncleared_deposits", "crypto_buying_power"]) {
  if (acc[k] !== undefined) console.log(`  ${k.padEnd(30)} ${acc[k]}`);
}
if (acc.margin_balances) {
  console.log("\n/accounts/ margin_balances:");
  for (const [k, v] of Object.entries(acc.margin_balances)) {
    if (v !== null && typeof v !== "object") console.log(`  ${k.padEnd(30)} ${v}`);
  }
}
console.log("\n/portfolios/:");
for (const k of ["equity", "extended_hours_equity", "market_value", "withdrawable_amount"]) {
  if (pf[k] !== undefined) console.log(`  ${k.padEnd(30)} ${pf[k]}`);
}
console.log("\nApp currently shows: buying_power ?? portfolio_cash ?? cash");
