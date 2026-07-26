// Transactional email — currently the one and only outbound mail path, used to
// prove someone controls an address before it becomes their login (SHARP-17).
// Resend's HTTP API over plain fetch, no dependency, same shape as telegram.ts.
//
// Swapping providers is this file and nothing else: every caller sees
// sendEmail() and emailEnabled(). Postmark, SendGrid and SES all take a POST
// with an API key, so the change is the URL, the auth header, and the field
// names in the body.
import { config } from "../config";

export const emailEnabled = () => !!(config.resendKey && config.emailFrom);

// Returns false rather than throwing — callers must be able to tell "the code
// never went out" from "the code went out", because pretending it sent leaves
// the user staring at a form waiting for an email that isn't coming.
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!emailEnabled()) {
    console.error("[notify:email] not configured — set RESEND_API_KEY (see .env.example)");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text }),
    });
    if (!res.ok) {
      // The body carries the actual reason (unverified domain, sandbox
      // recipient restriction, bad key) and it is worth having in the log.
      console.error("[notify:email]", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[notify:email] failed:", err);
    return false;
  }
}
