import { asc } from "drizzle-orm";
import { liveLedgerEntries } from "@db/schema";
import type {
  BinanceIncome,
  BinanceUserTrade,
  IncomeParams,
  LiveOrderGateway,
  UserTradesParams,
} from "./binanceSigned";
import { decimal, type DecimalString } from "./decimal";
import type { LiveDatabase } from "./livePersistence";

export interface IncomeClient {
  income(params?: IncomeParams): Promise<BinanceIncome[]>;
}

export interface UserTradesClient {
  userTrades(params: UserTradesParams): Promise<BinanceUserTrade[]>;
}

export function withFullUserTradePagination(gateway: LiveOrderGateway, limit = 1_000): LiveOrderGateway {
  return {
    placeOrder: (request) => gateway.placeOrder(request),
    cancelOrder: (request) => gateway.cancelOrder(request),
    queryOrder: (request) => gateway.queryOrder(request),
    userTrades: (params) => fetchAllUserTrades(gateway, params, limit),
  };
}

export interface LiveLedgerEntry {
  id: string;
  exchangeTransactionId: string;
  symbol: string | null;
  asset: string;
  entryType: string;
  amount: DecimalString;
  occurredAt: number;
}

export type NewLiveLedgerEntry = Omit<LiveLedgerEntry, "id">;

export interface LiveAccountingStore {
  recordLedgerEntry(entry: NewLiveLedgerEntry): Promise<boolean>;
  listLedgerEntries(): Promise<LiveLedgerEntry[]>;
}

export class InMemoryAccountingStore implements LiveAccountingStore {
  private readonly entries = new Map<string, LiveLedgerEntry>();

  async recordLedgerEntry(entry: NewLiveLedgerEntry): Promise<boolean> {
    if (this.entries.has(entry.exchangeTransactionId)) return false;
    this.entries.set(entry.exchangeTransactionId, { ...entry, id: crypto.randomUUID() });
    return true;
  }

  async listLedgerEntries(): Promise<LiveLedgerEntry[]> {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }
}

function duplicateEntry(error: unknown): boolean {
  const cause = (error as { cause?: unknown })?.cause;
  return (error as { code?: unknown })?.code === "ER_DUP_ENTRY"
    || (cause !== undefined && duplicateEntry(cause));
}

export class DrizzleAccountingStore implements LiveAccountingStore {
  constructor(private readonly db: LiveDatabase) {}

  async recordLedgerEntry(entry: NewLiveLedgerEntry): Promise<boolean> {
    try {
      await this.db.insert(liveLedgerEntries).values({
        id: crypto.randomUUID(),
        exchangeTransactionId: entry.exchangeTransactionId,
        symbol: entry.symbol,
        asset: entry.asset,
        entryType: entry.entryType,
        amount: decimal(entry.amount),
        occurredAt: new Date(entry.occurredAt),
      });
      return true;
    } catch (error) {
      if (duplicateEntry(error)) return false;
      throw error;
    }
  }

  async listLedgerEntries(): Promise<LiveLedgerEntry[]> {
    const rows = await this.db.select().from(liveLedgerEntries)
      .orderBy(asc(liveLedgerEntries.occurredAt), asc(liveLedgerEntries.id));
    return rows.map((row) => ({
      id: row.id,
      exchangeTransactionId: row.exchangeTransactionId,
      symbol: row.symbol,
      asset: row.asset,
      entryType: row.entryType,
      amount: row.amount,
      occurredAt: row.occurredAt.getTime(),
    }));
  }
}

function pageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Accounting page limit must be an integer from 1 to 1000");
  }
  return value;
}

const ACCOUNTING_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export async function fetchAllUserTrades(
  client: UserTradesClient,
  params: UserTradesParams,
  limit = 1_000,
): Promise<BinanceUserTrade[]> {
  pageLimit(limit);
  const records: BinanceUserTrade[] = [];
  const seen = new Set<string>();
  const bounded = params.startTime !== undefined && params.endTime !== undefined;
  const finalEnd = params.endTime;
  let windowStart = params.startTime;
  let windowEnd = bounded && windowStart !== undefined && finalEnd !== undefined
    ? Math.min(windowStart + ACCOUNTING_HISTORY_WINDOW_MS - 1, finalEnd)
    : finalEnd;
  while (true) {
    let fromId = params.fromId;
    while (true) {
      const page = await client.userTrades({ ...params, startTime: windowStart, endTime: windowEnd, fromId, limit });
      for (const record of page) {
        if (!Number.isSafeInteger(record.id) || record.id < 0) throw new Error("Invalid exchange trade ID");
        const key = `${record.symbol}:${record.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          records.push(record);
        }
      }
      if (page.length < limit) break;
      const lastId = page[page.length - 1]?.id;
      if (!Number.isSafeInteger(lastId) || lastId >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Cannot advance userTrades pagination");
      }
      const nextFromId = lastId + 1;
      if (fromId !== undefined && nextFromId <= fromId) throw new Error("Cannot advance userTrades pagination");
      fromId = nextFromId;
    }
    if (!bounded || windowEnd === undefined || finalEnd === undefined || windowEnd >= finalEnd) return records;
    windowStart = windowEnd + 1;
    windowEnd = Math.min(windowStart + ACCOUNTING_HISTORY_WINDOW_MS - 1, finalEnd);
  }
}

export async function fetchAllIncome(
  client: IncomeClient,
  params: IncomeParams = {},
  limit = 1_000,
): Promise<BinanceIncome[]> {
  pageLimit(limit);
  const records: BinanceIncome[] = [];
  const seen = new Set<string>();
  const bounded = params.startTime !== undefined && params.endTime !== undefined;
  const finalEnd = params.endTime;
  let windowStart = params.startTime;
  let windowEnd = bounded && windowStart !== undefined && finalEnd !== undefined
    ? Math.min(windowStart + ACCOUNTING_HISTORY_WINDOW_MS - 1, finalEnd)
    : finalEnd;
  while (true) {
    let cursor = windowStart;
    while (true) {
      const page = await client.income({ ...params, startTime: cursor, endTime: windowEnd, limit });
      for (const record of page) {
        if (!Number.isSafeInteger(record.time) || record.time < 0 || !Number.isSafeInteger(record.tranId)) {
          throw new Error("Invalid income pagination record");
        }
        const key = String(record.tranId);
        if (!seen.has(key)) {
          seen.add(key);
          records.push(record);
        }
      }
      if (page.length < limit) break;
      const lastTime = page[page.length - 1]?.time;
      if (!Number.isSafeInteger(lastTime)) throw new Error("Cannot advance income pagination");
      if (page.every((record) => record.time === lastTime)) {
        throw new Error("Cannot paginate a full income page with the same timestamp");
      }
      if (cursor !== undefined && lastTime <= cursor) throw new Error("Cannot advance income pagination");
      cursor = lastTime;
    }
    if (!bounded || windowEnd === undefined || finalEnd === undefined || windowEnd >= finalEnd) return records;
    windowStart = windowEnd + 1;
    windowEnd = Math.min(windowStart + ACCOUNTING_HISTORY_WINDOW_MS - 1, finalEnd);
  }
}

export async function syncIncome(
  client: IncomeClient,
  store: LiveAccountingStore,
  params: IncomeParams = {},
  limit = 1_000,
): Promise<{ fetched: number; inserted: number }> {
  const records = await fetchAllIncome(client, params, limit);
  let inserted = 0;
  for (const record of records) {
    if (["COMMISSION", "REALIZED_PNL"].includes(record.incomeType) && record.tradeId?.trim()) continue;
    if (await store.recordLedgerEntry({
      exchangeTransactionId: String(record.tranId),
      symbol: record.symbol || null,
      asset: record.asset,
      entryType: record.incomeType,
      amount: decimal(record.income),
      occurredAt: record.time,
    })) inserted += 1;
  }
  return { fetched: records.length, inserted };
}

export async function syncUserTrades(
  client: UserTradesClient,
  store: LiveAccountingStore,
  params: UserTradesParams,
  limit = 1_000,
): Promise<{ fetched: number; inserted: number }> {
  const records = await fetchAllUserTrades(client, params, limit);
  let inserted = 0;
  for (const record of records) {
    const entries: NewLiveLedgerEntry[] = [
      {
        exchangeTransactionId: `${record.symbol}:${record.id}:COMMISSION`,
        symbol: record.symbol,
        asset: record.commissionAsset,
        entryType: "COMMISSION",
        amount: decimal(record.commission),
        occurredAt: record.time,
      },
      {
        exchangeTransactionId: `${record.symbol}:${record.id}:REALIZED_PNL`,
        symbol: record.symbol,
        asset: "USDT",
        entryType: "REALIZED_PNL",
        amount: decimal(record.realizedPnl),
        occurredAt: record.time,
      },
    ];
    for (const entry of entries) {
      if (await store.recordLedgerEntry(entry)) inserted += 1;
    }
  }
  return { fetched: records.length, inserted };
}

export interface LiveAccountingSynchronizerOptions {
  client: IncomeClient & UserTradesClient;
  store: LiveAccountingStore;
  incomeParams: IncomeParams;
  symbols: string[];
  limit?: number;
}

export class LiveAccountingSynchronizer {
  constructor(private readonly options: LiveAccountingSynchronizerOptions) {}

  async synchronize(): Promise<void> {
    const { client, store, incomeParams, symbols, limit } = this.options;
    await syncIncome(client, store, incomeParams, limit);
    for (const symbol of new Set(symbols)) {
      await syncUserTrades(client, store, {
        symbol,
        startTime: incomeParams.startTime,
        endTime: incomeParams.endTime,
      }, limit);
    }
  }
}
