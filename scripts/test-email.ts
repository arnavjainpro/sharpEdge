// Diagnostic: send one real email so you can confirm RESEND_API_KEY / EMAIL_FROM
// work before relying on them for a sign-in change. Run: bun run test:email <to>
//
// The app path gives you "couldn't send the confirmation email — check the
// server log"; this prints the provider's actual complaint straight away
// (unverified domain, sandbox recipient restriction, bad key).
import { config } from "../src/config";
import { sendEmail, emailEnabled } from "../src/notify/email";

const to = process.argv[2];
if (!to) { console.error("usage: bun run test:email <recipient@example.com>"); process.exit(1); }

if (!emailEnabled()) {
  console.error("RESEND_API_KEY is not set — copy it from https://resend.com/api-keys into .env");
  process.exit(1);
}

console.log(`sending from ${config.emailFrom} to ${to} …`);
const ok = await sendEmail(to, "sharpEdge test email", "If you're reading this, email delivery works.");
if (ok) {
  console.log("sent. If it doesn't arrive, check spam, then the Resend dashboard's Logs tab.");
} else {
  console.error(
    "\nfailed — the provider's response is logged above. Most common causes:\n" +
    `  • sending from onboarding@resend.dev, which only delivers to your own Resend signup address\n` +
    "    → verify a domain at https://resend.com/domains and set EMAIL_FROM to an address on it\n" +
    "  • the API key was revoked or copied with whitespace"
  );
  process.exit(1);
}
