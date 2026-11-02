import { describe, expect, it } from "vitest";
import type { BinanceIncome, BinanceUserTrade, UserTradesParams } from "./binanceSigned";
import {
  fetchAllIncome,
  fetchAllUserTrades,
  InMemoryAccountingStore,
  LiveAccountingSynchronizer,
  syncIncome,
  syncUserTrades,
} from "./accounting";

function trade(id: number, overrides: Partial<BinanceUserTrade> = {}): BinanceUserTrade {
  return {
    symbol: "BTCUSDT",
    id,
    orderId: 900,
    side: "BUY",
    price: "100.123456789012345678",
    qty: "1.25",
    realizedPnl: "0",
    commission: "0.050061728394506172839",
    commissionAsset: "USDT",
    time: 1_000 + id,
    buyer: true,
    maker: false,
    ...overrides,
  };
}

function income(tranId: number, time: number, amount = "1.5"): BinanceIncome {
  return {
    symbol: "BTCUSDT",
    incomeType: "FUNDING_FEE",
    income: amount,
    asset: "USDT",
    time,
    tranId,
  };
}

describe("live accounting pagination", () => {
  it("pages userTrades by exchange trade ID without dropping the boundary", async () => {
    const fromIds: Array<number | undefined> = [];
    const trades = await fetchAllUserTrades({
      userTrades: async ({ fromId, limit }) => {
        fromIds.push(fromId);
        expect(limit).toBe(2);
        const start = fromId ?? 10;
        return start >= 14 ? [] : [trade(start), trade(start + 1)].filter((item) => item.id < 14);
      },
    }, { symbol: "BTCUSDT" }, 2);

    expect(trades.map((item) => item.id)).toEqual([10, 11, 12, 13]);
    expect(fromIds).toEqual([undefined, 12, 14]);
  });

  it("walks userTrades full history in bounded time windows", async () => {
    const day = 24 * 60 * 60 * 1_000;
    const windows: Array<[number | undefined, number | undefined]> = [];

    await fetchAllUserTrades({
      userTrades: async ({ startTime, endTime }) => {
        windows.push([startTime, endTime]);
        return [];
      },
    }, { symbol: "BTCUSDT", startTime: 0, endTime: 8 * day }, 2);

    expect(windows).toEqual([[0, 7 * day - 1], [7 * day, 8 * day]]);
  });

  it("rejects a repeating userTrades page instead of looping forever", async () => {
    await expect(fetchAllUserTrades({
      userTrades: async () => [trade(10), trade(11)],
    }, { symbol: "BTCUSDT" }, 2)).rejects.toThrow("advance");
  });

  it("pages income by inclusive time and removes overlapping transaction IDs", async () => {
    const startTimes: Array<number | undefined> = [];
    const records = await fetchAllIncome({
      income: async ({ startTime, limit } = {}) => {
        startTimes.push(startTime);
        expect(limit).toBe(2);
        if (startTime === 100) return [income(1, 100), income(2, 200)];
        if (startTime === 200) return [income(2, 200), income(3, 300)];
        return [income(3, 300)];
      },
    }, { startTime: 100, endTime: 1_000 }, 2);

    expect(records.map((item) => item.tranId)).toEqual([1, 2, 3]);
    expect(startTimes).toEqual([100, 200, 300]);
  });

  it("walks the complete income history in bounded time windows", async () => {
    const day = 24 * 60 * 60 * 1_000;
    const windows: Array<[number | undefined, number | undefined]> = [];

    await fetchAllIncome({
      income: async ({ startTime, endTime } = {}) => {
        windows.push([startTime, endTime]);
        return [];
      },
    }, { startTime: 0, endTime: 8 * day }, 2);

    expect(windows).toEqual([[0, 7 * day - 1], [7 * day, 8 * day]]);
  });

  it("rejects a repeating mixed-timestamp income page without cursor progress", async () => {
    let calls = 0;
    await expect(fetchAllIncome({
      income: async () => {
        calls += 1;
        if (calls > 2) throw new Error("stuck");
        return [income(1, 100), income(2, 200)];
      },
    }, { startTime: 100, endTime: 1_000 }, 2)).rejects.toThrow("Cannot advance");
  });

  it("fails closed instead of skipping income records sharing a full-page timestamp", async () => {
    await expect(fetchAllIncome({
      income: async () => [income(1, 200), income(2, 200)],
    }, {}, 2)).rejects.toThrow("same timestamp");
  });
});

describe("live accounting persistence", () => {
  it("stores exact income strings and de-duplicates repeated transaction IDs", async () => {
    const store = new InMemoryAccountingStore();
    const client = {
      income: async () => [income(99, 200, "-0.000000000000000000000000000001")],
    };

    expect((await syncIncome(client, store)).inserted).toBe(1);
    expect((await syncIncome(client, store)).inserted).toBe(0);
    const entries = await store.listLedgerEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      exchangeTransactionId: "99",
      entryType: "FUNDING_FEE",
      amount: "-0.000000000000000000000000000001",
      asset: "USDT",
    });
  });

  it("persists actual trade commission and realized PnL under trade-ID keys", async () => {
    const store = new InMemoryAccountingStore();
    const client = {
      userTrades: async () => [trade(42, {
        realizedPnl: "-12.345678901234567890123456789",
        commission: "0.000000000000000000000000000001",
      })],
    };

    expect((await syncUserTrades(client, store, { symbol: "BTCUSDT" })).inserted).toBe(2);
    expect((await syncUserTrades(client, store, { symbol: "BTCUSDT" })).inserted).toBe(0);
    const entries = await store.listLedgerEntries();
    expect(entries.map(({ exchangeTransactionId, entryType, amount }) => ({
      exchangeTransactionId,
      entryType,
      amount,
    }))).toEqual([
      {
        exchangeTransactionId: "BTCUSDT:42:COMMISSION",
        entryType: "COMMISSION",
        amount: "0.000000000000000000000000000001",
      },
      {
        exchangeTransactionId: "BTCUSDT:42:REALIZED_PNL",
        entryType: "REALIZED_PNL",
        amount: "-12.345678901234567890123456789",
      },
    ]);
  });

  it("uses userTrades as authoritative for trade-linked income commission and PnL", async () => {
    const store = new InMemoryAccountingStore();
    const incomeClient = {
      income: async () => [
        income(99, 200),
        { ...income(10, 201), incomeType: "COMMISSION", tradeId: "42" },
        { ...income(11, 202), incomeType: "REALIZED_PNL", tradeId: "42" },
      ],
    };
    const tradeClient = { userTrades: async () => [trade(42)] };

    expect((await syncIncome(incomeClient, store)).inserted).toBe(1);
    await syncUserTrades(tradeClient, store, { symbol: "BTCUSDT" });

    expect((await store.listLedgerEntries()).map((entry) => entry.exchangeTransactionId)).toEqual([
      "99",
      "BTCUSDT:42:COMMISSION",
      "BTCUSDT:42:REALIZED_PNL",
    ]);
  });
});

describe("startup accounting synchronizer", () => {
  it("synchronizes income and every configured symbol with the full history window", async () => {
    const calls: string[] = [];
    const client = {
      income: async (params = {}) => {
        calls.push(`income:${JSON.stringify(params)}`);
        return [];
      },
      userTrades: async ({ symbol, startTime, endTime }: UserTradesParams) => {
        calls.push(`trades:${symbol}:${startTime}:${endTime}`);
        return [];
      },
    };
    const synchronizer = new LiveAccountingSynchronizer({
      client,
      store: new InMemoryAccountingStore(),
      incomeParams: { startTime: 0, endTime: 1_000 },
      symbols: ["BTCUSDT", "ETHUSDT"],
    });

    await synchronizer.synchronize();

    expect(calls[0]).toContain("income");
    expect(calls[0]).toContain("startTime");
    expect(calls.slice(1)).toEqual(["trades:BTCUSDT:0:1000", "trades:ETHUSDT:0:1000"]);
  });
});
