// Robinhood read-only brokerage adapter (UNOFFICIAL private API: Robinhood
// publishes no public API). Pulls equities and options positions plus
// account equity into the common BrokerSnapshot. READ-ONLY: it never places or
// cancels orders. Tokens are obtained once via linkRobinhood() below (Settings →
// Brokerage in the dashboard, or `bun run link:robinhood`) and cached in the
// settings table; the running server only refreshes them.
//
// ponytail: the auth/challenge flow follows robin_stocks and cannot be tested
//   here (no live credentials). The data-fetch paths are deterministic against
//   documented endpoint shapes. If Robinhood's login workflow rejects the
//   password grant for an account, the linker reports it and the user falls
//   back to the existing manual import. Upgrade path: SnapTrade (official
//   Robinhood read access) drops in behind this same BrokerProvider interface.
import { getBrokerLink, setBrokerLink, clearBrokerLink } from "../db";
import type { BrokerProvider, BrokerSnapshot, BrokerOrder } from "./types";
import type { Holding } from "../config";

const CLIENT_ID = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS"; // Robinhood's public iOS client id
const API = "https://api.robinhood.com";
// Mirror robin_stocks' session headers exactly. The X-Robinhood-API-Version gate
// is what rejects stale clients with "Update to the newest version of Robinhood";
// bump it here if Robinhood tightens the minimum again. Default body encoding is
// form-urlencoded (login + challenge); JSON is opted into per-request (pathfinder).
// ponytail: version pinned to a known-good robin_stocks value: the upgrade path
//   is to bump this one string, not to rework the client.
const HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "en-US,en;q=1",
  "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
  "X-Robinhood-API-Version": "1.431.4",
  Connection: "keep-alive",
  "User-Agent": "*",
};

// Robinhood's login/challenge endpoints want form-urlencoded bodies. Python's
// requests renders booleans as "True"/"False" (capitalized): match that so the
// wire bytes are identical to the working reference client.
function formEncode(body: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    p.set(k, typeof v === "boolean" ? (v ? "True" : "False") : String(v));
  }
  return p.toString();
}

export interface RhAuth {
  access_token: string;
  refresh_token: string;
  device_token: string;
  expires_at: number; // unix seconds
}

export async function loadAuth(userId: number): Promise<RhAuth | null> {
  const row = await getBrokerLink(userId);
  if (!row || row.provider !== "robinhood") return null;
  try {
    return JSON.parse(row.auth_json) as RhAuth;
  } catch {
    return null;
  }
}
export async function saveAuth(userId: number, a: RhAuth) {
  await setBrokerLink(userId, "robinhood", JSON.stringify(a));
}
export async function clearAuth(userId: number) {
  await clearBrokerLink(userId);
}

export function newDeviceToken(): string {
  return crypto.randomUUID();
}

// Low-level token request (form-urlencoded): used by the linker and refresh.
export async function requestToken(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}/oauth2/token/`, {
    method: "POST",
    headers: HEADERS,
    body: formEncode(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ── device-approval (Sheriff) workflow ───────────────────────────────────────
// Pre-auth POST/GET helpers (no bearer token yet). Pathfinder endpoints want
// JSON (asJson); the challenge-respond endpoint wants form-urlencoded.
async function pfPost(url: string, body: Record<string, unknown>, asJson: boolean): Promise<any> {
  const headers = asJson ? { ...HEADERS, "Content-Type": "application/json" } : HEADERS;
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: asJson ? JSON.stringify(body) : formEncode(body),
    signal: AbortSignal.timeout(30_000),
  });
  return r.json().catch(() => ({}));
}
async function pfGet(url: string): Promise<any> {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  return r.json().catch(() => ({}));
}

// Complete Robinhood's modern device-approval workflow (robin_stocks-style).
// `ask` prompts for an SMS/email code when required; app-approval ("prompt")
// polls until the user taps Approve in the Robinhood app. Throws on failure so
// the linker can report it and fall back to manual import.
export async function validateSheriff(deviceToken: string, workflowId: string, ask: (q: string) => string | Promise<string>): Promise<void> {
  const machine = await pfPost(`${API}/pathfinder/user_machine/`, { device_id: deviceToken, flow: "suv", input: { workflow_id: workflowId } }, true);
  const machineId = machine?.id;
  if (!machineId) throw new Error(`no machine id from pathfinder (${JSON.stringify(machine).slice(0, 200)})`);
  const inquiriesUrl = `${API}/pathfinder/inquiries/${machineId}/user_view/`;

  // Poll until the challenge surfaces, then satisfy it (app tap, or SMS/email code).
  const deadline = Date.now() + 120_000;
  let satisfied = false;
  while (Date.now() < deadline && !satisfied) {
    await Bun.sleep(5_000);
    const resp = await pfGet(inquiriesUrl);
    const challenge = resp?.context?.sheriff_challenge;
    if (!challenge) continue;
    const { id: challengeId, type, status } = challenge;

    if (type === "prompt") {
      console.log("→ Approve the login in your Robinhood app (push notification). Waiting…");
      const statusUrl = `${API}/push/${challengeId}/get_prompts_status/`;
      while (Date.now() < deadline) {
        await Bun.sleep(5_000);
        const s = await pfGet(statusUrl);
        if (s?.challenge_status === "validated") { satisfied = true; break; }
      }
    } else if (status === "validated") {
      satisfied = true;
    } else if ((type === "sms" || type === "email") && status === "issued") {
      const code = await ask(`Enter the ${type} verification code Robinhood sent`);
      const r = await pfPost(`${API}/challenge/${challengeId}/respond/`, { response: code }, false);
      if (r?.status === "validated") satisfied = true;
    } else {
      throw new Error(`unsupported challenge type "${type}" (status ${status})`);
    }
  }
  if (!satisfied) throw new Error("device verification not completed in time");

  // Finalize: advance the workflow until Robinhood reports approval. Like
  // robin_stocks, stop retrying after a bounded window and let the caller's
  // token re-attempt be the real proof of success.
  const finalizeDeadline = Date.now() + 120_000;
  while (Date.now() < finalizeDeadline) {
    const resp = await pfPost(inquiriesUrl, { sequence: 0, user_input: { status: "continue" } }, true);
    if (resp?.type_context?.result === "workflow_status_approved") return;
    if (resp?.verification_workflow?.workflow_status === "workflow_status_approved") return;
    await Bun.sleep(5_000);
  }
}

// Full login: password grant → optional MFA code → optional device approval →
// tokens saved. Shared by the CLI linker and the dashboard's Settings panel;
// they differ only in where `ask` gets the verification code from. Throws with a
// user-facing message on failure so both can fall back to the manual import.
export type Ask = (q: string) => string | Promise<string>;

export async function linkRobinhood(userId: number, username: string, password: string, ask: Ask): Promise<void> {
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

  let { status, json } = await requestToken(base);

  // Legacy MFA code path (SMS/TOTP): some accounts still use this.
  if (json?.mfa_required) {
    const code = await ask(`Enter the ${json.mfa_type ?? "MFA"} code`);
    ({ status, json } = await requestToken({ ...base, mfa_code: code }));
  }

  // Modern device-approval workflow (Sheriff): complete the challenge, then retry.
  if (json?.verification_workflow?.id) {
    await validateSheriff(deviceToken, json.verification_workflow.id, ask);
    ({ status, json } = await requestToken(base)); // token is issued once the device is approved
  }

  if (!json?.access_token) {
    throw new Error(`login failed (status ${status}): ${JSON.stringify(json).slice(0, 200)}`);
  }
  await saveAuth(userId, toAuth(json, deviceToken));
}

export function toAuth(json: any, deviceToken: string): RhAuth {
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    device_token: deviceToken,
    expires_at: Math.floor(Date.now() / 1000) + (json.expires_in ?? 86400) - 120,
  };
}

async function refreshAccess(userId: number, a: RhAuth): Promise<RhAuth> {
  const { status, json } = await requestToken({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: a.refresh_token,
    scope: "internal",
    device_token: a.device_token,
    expires_in: 86400,
  });
  if (status !== 200 || !json.access_token) throw new Error(`robinhood token refresh failed (${status})`);
  const next = { ...toAuth(json, a.device_token), refresh_token: json.refresh_token ?? a.refresh_token };
  await saveAuth(userId, next);
  return next;
}

// ── authenticated GETs + pagination ─────────────────────────────────────────
// authHeader is passed explicitly (not a module global) since multiple users'
// requests can be in flight concurrently, each with their own bearer token.
async function rhGet(url: string, authHeader: string): Promise<any> {
  const res = await fetch(url, { headers: { ...HEADERS, Authorization: authHeader }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) throw Object.assign(new Error("robinhood 401"), { code: 401 });
  if (!res.ok) throw new Error(`robinhood GET ${url} → ${res.status}`);
  return res.json();
}
async function rhList(url: string, authHeader: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = url;
  while (next) {
    const page = await rhGet(next, authHeader);
    out.push(...(page.results ?? []));
    next = page.next ?? null;
  }
  return out;
}

// Instrument-URL → symbol, cached (positions reference instruments by URL -
// this mapping is Robinhood-global public metadata, safe to share across users).
const symbolCache = new Map<string, string>();
async function instrumentSymbol(url: string, authHeader: string): Promise<string> {
  if (symbolCache.has(url)) return symbolCache.get(url)!;
  const sym = String((await rhGet(url, authHeader)).symbol ?? "").toUpperCase();
  symbolCache.set(url, sym);
  return sym;
}

async function pullSnapshot(authHeader: string): Promise<BrokerSnapshot> {
  const holdings: Holding[] = [];

  // Equities: priced by the app's existing quote feed, so no market_value here.
  const positions = await rhList(`${API}/positions/?nonzero=true`, authHeader);
  for (const p of positions) {
    const qty = Number(p.quantity);
    if (!qty) continue;
    holdings.push({
      ticker: await instrumentSymbol(p.instrument, authHeader),
      shares: qty,
      cost_basis: Number(p.average_buy_price) || 0,
      asset_class: "equity",
    });
  }

  // Options: carry their own market value (can't be quoted by ticker).
  // Isolated try/catch: an options-endpoint failure must not sink the whole
  // snapshot (which would silently fall back to YAML and hide everything).
  // nonzero=True matches robin_stocks' exact wire format: RH's Django filter
  // parses the Python-style capitalized boolean, and lowercase "true" has been
  // seen to return zero rows.
  try {
    const optPositions = await rhList(`${API}/options/positions/?nonzero=True`, authHeader);
    for (const op of optPositions) {
      const qty = Number(op.quantity);
      if (!qty) continue;
      const inst = await rhGet(op.option, authHeader);
      const sign = op.type === "short" ? -1 : 1;
      let mark = Number(op.average_price) / 100 || 0; // fallback to basis
      try {
        const md = await rhGet(`${API}/marketdata/options/?instruments=${encodeURIComponent(op.option)}`, authHeader);
        const px = Number(md.results?.[0]?.adjusted_mark_price);
        if (px) mark = px;
      } catch {}
      holdings.push({
        ticker: `${op.chain_symbol} ${inst.expiration_date} ${Number(inst.strike_price).toFixed(0)}${inst.type === "call" ? "C" : "P"}`,
        shares: qty * sign,
        cost_basis: Number(op.average_price) / 100 || 0, // per-share premium paid
        asset_class: "option",
        market_value: sign * qty * mark * 100,
        option: {
          type: inst.type === "call" ? "call" : "put",
          strike: Number(inst.strike_price),
          expiry: String(inst.expiration_date),
          underlying: String(op.chain_symbol).toUpperCase(),
        },
      });
    }
  } catch (err) {
    console.error("[robinhood] options positions fetch failed (equities still shown):", err);
  }

  // Crypto is deliberately not pulled: this is an equity/options research tool,
  // and crypto rows only cluttered the portfolio and the monitoring ticker set.

  // Account equity + open orders.
  let account = { equity: null as number | null, cash: null as number | null, buying_power: null as number | null };
  try {
    const portfolios = await rhList(`${API}/portfolios/`, authHeader);
    const acc = (await rhList(`${API}/accounts/`, authHeader))[0] ?? {};
    const pf = portfolios[0] ?? {};
    // `|| null` would turn a legitimate $0 (fully invested) into "unknown" and
    // silently drop the row from the UI and the AI prompt: coerce explicitly.
    const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    // The top-level `buying_power` is the START-OF-DAY figure: it's literally
    // equal to margin_balances.start_of_day_overnight_buying_power and goes
    // stale the moment you trade, so it reads high all day. The live number is
    // margin_balances.overnight_buying_power. Cash accounts return no
    // margin_balances at all, hence the fallback.
    const mb = acc.margin_balances ?? {};
    account = {
      equity: num(pf.extended_hours_equity ?? pf.equity),
      cash: num(acc.portfolio_cash ?? acc.cash),
      buying_power: num(mb.overnight_buying_power ?? acc.buying_power),
    };
  } catch {}

  const openOrders: BrokerOrder[] = [];
  try {
    const OPEN = new Set(["queued", "confirmed", "partially_filled", "unconfirmed", "pending"]);
    const orders = await rhList(`${API}/orders/`, authHeader);
    for (const o of orders.slice(0, 100)) {
      if (!OPEN.has(String(o.state))) continue;
      openOrders.push({
        ticker: await instrumentSymbol(o.instrument, authHeader),
        side: o.side === "sell" ? "sell" : "buy",
        qty: Number(o.quantity) || 0,
        type: String(o.type ?? "market"),
        limit_price: o.price != null ? Number(o.price) : null,
        status: String(o.state),
        submitted_at: String(o.created_at ?? new Date().toISOString()),
      });
    }
  } catch {}

  const byClass = holdings.reduce((m, h) => (m[h.asset_class ?? "equity"] = (m[h.asset_class ?? "equity"] ?? 0) + 1, m), {} as Record<string, number>);
  console.log(`[robinhood] positions: ${byClass.equity ?? 0} equities, ${byClass.option ?? 0} options`);

  return {
    source: "robinhood",
    asOf: Math.floor(Date.now() / 1000),
    holdings,
    watchlist: [],
    openOrders,
    account,
  };
}

export const robinhoodProvider: BrokerProvider = {
  name: "robinhood",
  available: async (userId: number) => !!(await loadAuth(userId)),
  async fetchSnapshot(userId: number): Promise<BrokerSnapshot> {
    let a = await loadAuth(userId);
    if (!a) throw new Error("robinhood not linked");
    if (Date.now() / 1000 >= a.expires_at) a = await refreshAccess(userId, a);
    let authHeader = `Bearer ${a.access_token}`;
    try {
      return await pullSnapshot(authHeader);
    } catch (e: any) {
      // One re-auth attempt on 401, then let the provider loop fall through.
      if (e?.code === 401) {
        a = await refreshAccess(userId, (await loadAuth(userId))!);
        authHeader = `Bearer ${a.access_token}`;
        return await pullSnapshot(authHeader);
      }
      throw e;
    }
  },
};
