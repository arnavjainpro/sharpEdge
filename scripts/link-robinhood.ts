// One-time interactive Robinhood login. Obtains OAuth tokens and stores them in
// the settings table so the running server can refresh them non-interactively.
// Run: `bun run link:robinhood`  (read-only access — sharpEdge never trades).
//
// ponytail: MFA/device-approval flow is best-effort and cannot be tested here.
//   If Robinhood rejects the password grant for your account, use the dashboard's
//   manual position import instead.
import { requestToken, toAuth, saveAuth, loadAuth, newDeviceToken, clearAuth, validateSheriff } from "../src/broker/robinhood";
import { findUserByEmail } from "../src/auth";

const CLIENT_ID = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS";

function ask(q: string): string {
  const a = prompt(q);
  if (a == null) { console.log("\nAborted."); process.exit(1); }
  return a.trim();
}

// Which sharpEdge account (sign up in the dashboard first) this link belongs to.
const mpEmail = ask("sharpEdge account email (sign up in the dashboard first if you haven't): ");
const mpUser = await findUserByEmail(mpEmail);
if (!mpUser) {
  console.error(`\n✗ No sharpEdge account for "${mpEmail}". Sign up at the dashboard first, then re-run this.`);
  process.exit(1);
}
const userId = mpUser.id;

if (process.argv.includes("--clear")) {
  await clearAuth(userId);
  console.log(`Robinhood tokens cleared for ${mpEmail}.`);
  process.exit(0);
}

console.log("Robinhood link (read-only). Your password is sent only to Robinhood; tokens are stored locally.\n");
const username = ask("Robinhood email/username: ");
const password = ask("Password: ");
const deviceToken = (await loadAuth(userId))?.device_token ?? newDeviceToken();

const base = {
  client_id: CLIENT_ID,
  grant_type: "password",
  scope: "internal",
  username,
  password,
  device_token: deviceToken,
  expires_in: 86400,
  try_passkeys: false,
  token_request_path: "/login",
  create_read_only_secondary_token: true,
};

async function attempt(extra: Record<string, unknown>) {
  return requestToken({ ...base, ...extra });
}

let { status, json } = await attempt({});

// Legacy MFA code path (SMS/TOTP) — some accounts still use this.
if (json?.mfa_required) {
  const code = ask(`Enter the ${json.mfa_type ?? "MFA"} code: `);
  ({ status, json } = await attempt({ mfa_code: code }));
}

// Modern device-approval workflow (Sheriff): complete the challenge, then retry.
if (json?.verification_workflow?.id) {
  try {
    await validateSheriff(deviceToken, json.verification_workflow.id, ask);
  } catch (e) {
    console.error(`\n✗ Device approval failed: ${e}`);
    console.error("Fall back to the dashboard's manual position import.");
    process.exit(1);
  }
  ({ status, json } = await attempt({})); // token is issued once the device is approved
}

if (json?.access_token) {
  await saveAuth(userId, toAuth(json, deviceToken));
  console.log("\n✓ Linked. Restart the server (or hit Refresh in the dashboard) to pull positions.");
} else {
  console.error(`\n✗ Login failed (status ${status}): ${JSON.stringify(json).slice(0, 300)}`);
  console.error("Fall back to the dashboard's manual position import.");
  process.exit(1);
}
