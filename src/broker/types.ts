// Broker-agnostic account model. Providers normalize into this shape so the
// rest of the system (validator sizing, advisor context, dashboard) never
// cares where the data came from.
import type { Holding } from "../config";

export interface BrokerOrder {
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  type: string;            // market | limit | stop | ...
  limit_price: number | null;
  status: string;
  submitted_at: string;
}

export interface AccountContext {
  equity: number | null;        // total account value
  cash: number | null;
  buying_power: number | null;
}

export interface BrokerSnapshot {
  source: "manual" | "import" | "robinhood";
  asOf: number;                 // unix seconds
  holdings: Holding[];
  watchlist: string[];
  openOrders: BrokerOrder[];
  account: AccountContext;
}

export interface BrokerProvider {
  name: BrokerSnapshot["source"];
  available(userId: number): boolean | Promise<boolean>;
  fetchSnapshot(userId: number): Promise<BrokerSnapshot>;
}
