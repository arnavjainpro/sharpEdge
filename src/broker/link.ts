// Pending Robinhood logins started from the dashboard (Settings → Brokerage).
// Robinhood's login helper asks for a verification code inline, but in the web
// flow that code arrives minutes later in its own HTTP request — so the login
// runs in the background and parks here until the user submits it.
//
// linkRobinhood is imported dynamically so this module's static graph stays
// free of the db/network layer (keeps the state-machine test DB-free).
//
// ponytail: in-memory, one per user — a server restart mid-link just means
//   starting over. Persisting a half-finished login isn't worth a table.
import type { Ask } from "./robinhood";

export interface LinkState {
  state: "working" | "need_code" | "linked" | "error";
  message: string;
  submit?: (code: string) => void; // set only while state === "need_code"
}

const pending = new Map<number, LinkState>();
const CODE_WAIT_MS = 5 * 60_000;

export function linkState(userId: number): Omit<LinkState, "submit"> | null {
  const p = pending.get(userId);
  return p ? { state: p.state, message: p.message } : null;
}

export function submitLinkCode(userId: number, code: string): boolean {
  const p = pending.get(userId);
  if (p?.state !== "need_code" || !p.submit) return false;
  p.submit(code);
  return true;
}

export function clearLinkState(userId: number): void {
  pending.delete(userId);
}

// The web's `ask`: parks the flow in "need_code" until submitLinkCode calls
// p.submit, which resolves this promise with the code the user typed.
export function codeAsk(p: LinkState): Ask {
  return (q) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for the verification code")), CODE_WAIT_MS);
      p.state = "need_code";
      p.message = q;
      p.submit = (code) => {
        clearTimeout(timer);
        p.state = "working";
        p.message = "Verifying…";
        p.submit = undefined;
        resolve(code);
      };
    });
}

// Kicks the login off in the background and returns immediately — device
// approval can take minutes, far longer than one HTTP request should hold.
export function startLink(userId: number, username: string, password: string): void {
  // Ignore a double submit: replacing a live entry orphans the first flow's code
  // prompt, since submitLinkCode only ever resolves the newest one — that login
  // would then hang until its timeout with no way to answer it.
  const inFlight = pending.get(userId);
  if (inFlight?.state === "working" || inFlight?.state === "need_code") return;

  // The app-approval challenge sends a push and then waits silently, so say so
  // up front rather than leaving the user staring at a spinner for two minutes.
  const p: LinkState = { state: "working", message: "Signing in… if Robinhood sends a push, approve the login in your app." };
  pending.set(userId, p);

  import("./robinhood")
    .then(({ linkRobinhood }) => linkRobinhood(userId, username, password, codeAsk(p)))
    .then(() => {
      p.state = "linked";
      p.message = "Linked. Pulling your positions…";
    })
    .catch((err) => {
      p.state = "error";
      p.message = String(err?.message ?? err);
    })
    .finally(() => { p.submit = undefined; });
}
