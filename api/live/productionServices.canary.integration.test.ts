import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "@db/schema";
import { DEFAULT_SETTINGS, type Opportunity } from "@contracts/trading";
import type { BinanceSignedClient, PlaceOrderRequest } from "./binanceSigned";
import { createBinanceProductionLiveServices } from "./productionServices";
import type { LiveDatabase } from "./livePersistence";
import type { UserDataSocket } from "./userDataStream";

const testDatabaseUrl = process.env.TASK3_TEST_DATABASE_URL;
const describeDatabase = testDatabaseUrl ? describe : describe.skip;
if (testDatabaseUrl && new URL(testDatabaseUrl).pathname !== "/swing_sentinel_task3_test") {
  throw new Error("Canary integration tests require the dedicated swing_sentinel_task3_test database");
}
const db = testDatabaseUrl ? drizzle(testDatabaseUrl, { mode: "planetscale", schema }) : null;
const NOW = 1_800_000_000_000;

class FakeSocket implements UserDataSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() { this.onclose?.(); }
}

function opportunity(id: string, signalId: string): Opportunity {
  return {
    id, signalId, strategyType: "SWING", symbol: "BTCUSDT", side: "LONG", status: "READY",
    score: 1, regime: "NORMAL", entry: 100, stop: 99, target: 102.2, stopDistancePct: 1,
    rewardRisk: 2.2, leverage: 2, marginPct: 2, riskPct: 0.35, reasons: [],
    signalCloseTime: NOW, signalTime: NOW, expiryTime: NOW + 60_000,
    triggerPrice: 100, limitPrice: 100, stateVersion: 0, sourceGeneration: 1,
    detectorVersion: "test", configVersion: "test", createdAt: new Date(NOW).toISOString(),
  };
}

beforeAll(async () => {
  if (!db) return;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../db/migrations", import.meta.url)) });
});

beforeEach(async () => {
  if (!db) return;
  await db.delete(schema.liveFills);
  await db.delete(schema.liveOrders);
  await db.delete(schema.livePositions);
  await db.delete(schema.liveIntents);
  await db.delete(schema.liveAccountSnapshots);
  await db.delete(schema.liveLedgerEntries);
  await db.delete(schema.liveDailyRisk);
  await db.delete(schema.reconciliationIssues);
  const settings = {
    ...DEFAULT_SETTINGS,
    executionMode: "LIVE_MAINNET" as const,
    leverageMode: "FIXED" as const,
    fixedLeverage: 2,
    autoTrade: true,
  };
  await db.insert(schema.tradingSettings).values({ ...settings, id: 1 })
    .onDuplicateKeyUpdate({ set: settings });
  await db.insert(schema.liveControls).values({ id: 1, armed: true, emergencyGeneration: 0 })
    .onDuplicateKeyUpdate({ set: { armed: true, emergencyGeneration: 0 } });
  await db.insert(schema.volatilityStates).values({ symbol: "BTCUSDT", mode: "NORMAL", lastDataAt: NOW })
    .onDuplicateKeyUpdate({ set: { mode: "NORMAL", lastDataAt: NOW } });
});

afterAll(async () => {
  if (db) await db.$client.end();
});

describeDatabase("production canary sizing", () => {
  it("submits exactly the exchange-safe minimum instead of the normal risk quantity", async () => {
    if (!db) throw new Error("database required");
    const placed: PlaceOrderRequest[] = [];
    const socket = new FakeSocket();
    const client = {
      account: async () => ({ assets: [{
        asset: "USDT", walletBalance: "1000", availableBalance: "1000", crossWalletBalance: "1000",
      }] }),
      positionRisk: async () => [{
        symbol: "BTCUSDT", positionAmt: "0", entryPrice: "0", markPrice: "100",
        liquidationPrice: "0", leverage: "2", marginType: "isolated", isolatedWallet: "0",
      }],
      positionSide: async () => ({ dualSidePosition: false }),
      multiAssetsMargin: async () => ({ multiAssetsMargin: false }),
      openOrders: async () => [],
      leverageBracket: async () => [{ symbol: "BTCUSDT", brackets: [{
        bracket: 1, initialLeverage: 10, notionalCap: "50000", notionalFloor: "0",
        maintMarginRatio: "0.01", cum: "0",
      }] }],
      exchangeInfo: async () => ({ symbols: [{
        symbol: "BTCUSDT", pair: "BTCUSDT", contractType: "PERPETUAL", status: "TRADING",
        baseAsset: "BTC", quoteAsset: "USDT", marginAsset: "USDT", filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.01" },
          { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
        ],
      }] }),
      income: async () => [],
      userTrades: async () => [],
      createListenKey: async () => ({ listenKey: "fake" }),
      keepAliveListenKey: async () => ({}),
      closeListenKey: async () => ({}),
      syncServerTime: async () => undefined,
      queryOrder: async () => null,
      cancelOrder: async () => { throw new Error("not used"); },
      placeOrder: async (request: PlaceOrderRequest) => {
        placed.push(request);
        return {
          symbol: request.symbol, orderId: 100 + placed.length,
          clientOrderId: request.newClientOrderId ?? "order", price: request.price ?? "0",
          origQty: request.quantity, executedQty: "0", status: "NEW",
          side: request.side, type: request.type, reduceOnly: request.reduceOnly,
        };
      },
    } as unknown as BinanceSignedClient;
    const services = createBinanceProductionLiveServices({
      env: {
        LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake",
        BINANCE_MAINNET_API_SECRET: "fake", BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: db as LiveDatabase,
      getSettings: async () => ({
        ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", leverageMode: "FIXED", fixedLeverage: 2,
      }),
      client,
      socketFactory: () => socket,
      now: () => NOW,
      reconciliationIntervalMs: 60_000,
    });
    await services.start();
    await expect(services.preflight()).resolves.toMatchObject({ ready: true, reasons: [] });
    try {
      const normal = await services.adapter.open(opportunity(crypto.randomUUID(), "normal-risk-size"));
      expect(normal).toMatchObject({ ok: true });
      expect(placed[0]?.quantity).toBe("0.400000000000000000000000000000");

      await db.delete(schema.liveFills);
      await db.delete(schema.liveOrders);
      await db.delete(schema.livePositions);
      await db.delete(schema.liveIntents);
      await db.update(schema.tradingSettings).set({ autoTrade: false });

      const canary = await services.adapter.open(
        opportunity(crypto.randomUUID(), "manual-minimum-size"), undefined, { manualCanary: true },
      );
      expect(canary).toMatchObject({ ok: true });
      expect(placed[1]?.quantity).toBe("0.050000000000000000000000000000");
      expect(placed[1]?.quantity).not.toBe(placed[0]?.quantity);

      await db.delete(schema.liveFills);
      await db.delete(schema.liveOrders);
      await db.delete(schema.livePositions);
      await db.delete(schema.liveIntents);
      await db.update(schema.tradingSettings).set({ marginPerTradePct: 0.1 });
      const rejected = await services.adapter.open(
        opportunity(crypto.randomUUID(), "manual-minimum-over-risk"), undefined, { manualCanary: true },
      );
      expect(rejected).toMatchObject({ ok: false });
      expect(placed).toHaveLength(2);
    } finally {
      await services.stop();
    }
  });
});
