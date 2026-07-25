// Manual providers: portfolio.yaml (always available) and one-shot JSON
// imports (POST /api/broker/import or the dashboard's Import panel — the
// universal fallback for brokers without an API link: export/paste positions).
import { loadPortfolio, loadRiskConfig } from "../config";
import { getSettingFor, setSettingFor } from "../db";
import type { BrokerProvider, BrokerSnapshot, BrokerOrder } from "./types";

export const yamlProvider: BrokerProvider = {
  name: "manual",
  available: () => true, // shared fallback, same portfolio.yaml for every user
  async fetchSnapshot(): Promise<BrokerSnapshot> {
    const p = loadPortfolio();
    const risk = loadRiskConfig();
    return {
      source: "manual",
      asOf: Math.floor(Date.now() / 1000),
      holdings: p.holdings,
      watchlist: p.watchlist,
      openOrders: [],
      account: { equity: risk.account_equity, cash: null, buying_power: null },
    };
  },
};

// Normalized import payload — tolerant of common broker-export field names.
// Options positions carry asset_class + market_value (and option legs their
// contract details) so non-equity holdings survive a manual import. Crypto
// is not supported — a JSON import naming it fails loudly (below) rather
// than importing a position that would then render nowhere in the UI.
export interface ImportPayload {
  positions?: {
    ticker?: string; symbol?: string;
    shares?: number; quantity?: number; qty?: number; // contracts for options (negative = short)
    cost_basis?: number; avg_price?: number; average_buy_price?: number;
    asset_class?: "equity" | "option" | "crypto";
    market_value?: number;
    option?: { type: "call" | "put"; strike: number; expiry: string; underlying: string };
  }[];
  watchlist?: string[];
  orders?: Partial<BrokerOrder & { symbol: string }>[];
  account?: { equity?: number; cash?: number; buying_power?: number };
}

export async function saveImport(userId: number, payload: ImportPayload): Promise<BrokerSnapshot> {
  const cryptoTickers = (payload.positions ?? [])
    .filter((p) => p.asset_class === "crypto")
    .map((p) => String(p.ticker ?? p.symbol ?? "?").toUpperCase());
  if (cryptoTickers.length) {
    throw new Error(`Crypto isn't supported (this is an equity/options tool) — remove ${cryptoTickers.join(", ")} from the import.`);
  }
  const holdings = (payload.positions ?? [])
    .map((p) => ({
      ticker: String(p.ticker ?? p.symbol ?? "").toUpperCase().trim(),
      shares: Number(p.shares ?? p.quantity ?? p.qty ?? 0),
      cost_basis: Number(p.cost_basis ?? p.avg_price ?? p.average_buy_price ?? 0),
      ...(p.asset_class === "option" ? { asset_class: "option" as const } : {}),
      ...(p.market_value != null ? { market_value: Number(p.market_value) } : {}),
      ...(p.option ? { option: p.option } : {}),
    }))
    .filter((h) => h.ticker && h.shares !== 0);
  if (!holdings.length && !(payload.watchlist ?? []).length) {
    throw new Error("import contained no positions or watchlist symbols");
  }
  const snapshot: BrokerSnapshot = {
    source: "import",
    asOf: Math.floor(Date.now() / 1000),
    holdings,
    watchlist: (payload.watchlist ?? []).map((t) => String(t).toUpperCase().trim()).filter(Boolean),
    openOrders: (payload.orders ?? []).map((o) => ({
      ticker: String(o.ticker ?? o.symbol ?? "").toUpperCase(),
      side: o.side === "sell" ? "sell" : "buy",
      qty: Number(o.qty ?? 0),
      type: String(o.type ?? "unknown"),
      limit_price: o.limit_price != null ? Number(o.limit_price) : null,
      status: String(o.status ?? "open"),
      submitted_at: String(o.submitted_at ?? new Date().toISOString()),
    })),
    account: {
      equity: payload.account?.equity != null ? Number(payload.account.equity) : null,
      cash: payload.account?.cash != null ? Number(payload.account.cash) : null,
      buying_power: payload.account?.buying_power != null ? Number(payload.account.buying_power) : null,
    },
  };
  await setSettingFor(userId, "broker_import", JSON.stringify(snapshot));
  return snapshot;
}

export async function clearImport(userId: number) {
  await setSettingFor(userId, "broker_import", "");
}

export const importProvider: BrokerProvider = {
  name: "import",
  available: async (userId: number) => !!(await getSettingFor(userId, "broker_import", "")),
  async fetchSnapshot(userId: number): Promise<BrokerSnapshot> {
    return JSON.parse(await getSettingFor(userId, "broker_import", "{}")) as BrokerSnapshot;
  },
};
