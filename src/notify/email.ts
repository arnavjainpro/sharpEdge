// Transactional email: the one and only outbound mail path, used to prove
// someone controls an address before it becomes a login. Resend's HTTP API over
// plain fetch, no dependency, same shape as telegram.ts.
//
// Swapping providers is the transport half of this file and nothing else: every
// caller sees sendEmail() and emailEnabled(). Postmark, SendGrid and SES all
// take a POST with an API key, so the change is the URL, the auth header, and
// the field names in the body.
import { config } from "../config";

export const emailEnabled = () => !!(config.resendKey && config.emailFrom);

// Returns false rather than throwing: callers must be able to tell "the mail
// never went out" from "the mail went out", because pretending it sent leaves
// someone staring at an inbox waiting for a link that isn't coming.
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (!emailEnabled()) {
    console.error("[notify:email] not configured: set RESEND_API_KEY (see .env.example)");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        "Content-Type": "application/json",
      },
      // text is always sent alongside html: it is the fallback for plaintext
      // clients and it keeps the message out of spam filters that distrust
      // HTML-only mail.
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text, ...(html ? { html } : {}) }),
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

// ── Templates ────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Signup verification. The code is the only interpolated value and it is six
// digits from a CSPRNG, but it still goes through esc(): a template built by
// concatenation is exactly where that habit stops mattering the day someone
// parameterises it.
//
// Layout is table-based with inline styles on purpose. Outlook renders through
// Word's HTML engine: no flexbox, no grid, and <style> is dropped entirely by
// Gmail's clipped view and several webmail clients. The one <style> block holds
// only the media queries, which are a progressive enhancement: the mail is
// already readable at 320px without them because the outer table is width:100%
// with a max-width, not a fixed 600px.
export function verificationEmail(code: string): { subject: string; text: string; html: string } {
  const safe = esc(code);
  return {
    // The code goes in the subject too: most clients preview enough of it that
    // this alone saves opening the mail.
    subject: `${code} is your sharpEdge verification code`,
    text: [
      "Confirm your sharpEdge account",
      "",
      `Your verification code is: ${code}`,
      "",
      "Enter it in the sign-up form to finish creating your account.",
      "The code expires in 15 minutes and can only be used once.",
      "If you didn't sign up for sharpEdge, ignore this email: no account was created.",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm your sharpEdge account</title>
<style>
  @media only screen and (max-width: 480px) {
    .se-pad { padding: 24px 20px !important; }
    .se-h1 { font-size: 20px !important; }
    /* The code is the one thing that must never wrap or shrink out of reach. */
    .se-code { font-size: 30px !important; letter-spacing: 6px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .se-bg { background: #0f1115 !important; }
    .se-card { background: #181b21 !important; border-color: #2a2f38 !important; }
    .se-h1, .se-text { color: #e8eaed !important; }
    .se-muted { color: #9aa3ae !important; }
    .se-codebox { background: #11141a !important; border-color: #2a2f38 !important; }
    .se-code { color: #e8eaed !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background:#f4f5f7;">
  <!-- Preheader: the grey line clients show next to the subject. Hidden in the
       body itself, otherwise the first visible text would be the heading again. -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">Your verification code is ${safe}. It expires in 15 minutes.</div>
  <table class="se-bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table class="se-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; background:#ffffff; border:1px solid #e4e6eb; border-radius:12px;">
          <tr>
            <td class="se-pad" style="padding:36px 40px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <p class="se-muted" style="margin:0 0 20px; font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:#6b7280;">sharpEdge</p>
              <h1 class="se-h1" style="margin:0 0 14px; font-size:23px; line-height:1.3; font-weight:600; color:#111827;">Confirm your email address</h1>
              <p class="se-text" style="margin:0 0 24px; font-size:15px; line-height:1.6; color:#374151;">
                Enter this code in the sign-up form. Your account isn't created until you do.
              </p>
              <!-- Selectable text, not an image: it has to survive image blocking
                   (on by default in Outlook and Gmail) and be copy-pasteable. -->
              <table class="se-codebox" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa; border:1px solid #e4e6eb; border-radius:10px;">
                <tr>
                  <td align="center" style="padding:22px 12px;">
                    <span class="se-code" style="font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace; font-size:36px; font-weight:700; letter-spacing:9px; color:#111827;">${safe}</span>
                  </td>
                </tr>
              </table>
              <p class="se-muted" style="margin:26px 0 20px; font-size:13px; line-height:1.6; color:#6b7280;">
                The code expires in 15 minutes and works only once.
              </p>
              <hr style="border:none; border-top:1px solid #e4e6eb; margin:0 0 20px;">
              <p class="se-muted" style="margin:0; font-size:13px; line-height:1.6; color:#6b7280;">
                If you didn't sign up for sharpEdge, ignore this email: no account was created and no further mail will be sent. Never share this code with anyone.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}
