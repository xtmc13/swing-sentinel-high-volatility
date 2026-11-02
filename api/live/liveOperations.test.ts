import { describe, expect, it } from "vitest";
import { InMemoryReconciliationStore } from "./reconciliation";
import type { LiveOrderStore } from "./orderStateMachine";
import { readLiveOperations } from "./liveOperations";

const order: Awaited<ReturnType<LiveOrderStore["listOrders"]>>[number] = {
  id: "order-1",
  intentId: "intent-1",
  clientOrderId: "client-1",
  exchangeOrderId: "9001",
  symbol: "BTCUSDT",
  side: "LONG",
  type: "LIMIT",
  status: "PARTIALLY_FILLED",
  price: "100",
  stopPrice: null,
  originalQuantity: "2",
  executedQuantity: "0.5",
  averagePrice: "99.5",
  commission: "0.025",
  reduceOnly: false,
  createdAt: 1_800_000_000_000,
};

describe("live dashboard operations", () => {
  it("returns persisted real order fill state and outstanding reconciliation data", async () => {
    const reconciliation = new InMemoryReconciliationStore([
      { id: "intent-1", symbol: "BTCUSDT", status: "SUBMITTING" },
    ]);
    await reconciliation.recordIssue({
      category: "UNPROTECTED_POSITION",
      severity: "CRITICAL",
      symbol: "BTCUSDT",
      expectedValue: null,
      actualValue: null,
      message: "缺少止损",
      detectedAt: 1_800_000_000_100,
    });
    const orders = { listOrders: async () => [order] };

    await expect(readLiveOperations(orders, reconciliation)).resolves.toEqual({
      orders: [{
        id: "order-1",
        intentId: "intent-1",
        clientOrderId: "client-1",
        exchangeOrderId: "9001",
        symbol: "BTCUSDT",
        side: "LONG",
        type: "LIMIT",
        status: "PARTIALLY_FILLED",
        price: "100",
        originalQuantity: "2",
        executedQuantity: "0.5",
        averagePrice: "99.5",
        commission: "0.025",
        reduceOnly: false,
        createdAt: new Date(1_800_000_000_000).toISOString(),
      }],
      unsettledIntents: [{ id: "intent-1", symbol: "BTCUSDT", status: "SUBMITTING" }],
      reconciliationIssues: [{
        id: expect.any(String),
        category: "UNPROTECTED_POSITION",
        severity: "CRITICAL",
        status: "OPEN",
        symbol: "BTCUSDT",
        message: "缺少止损",
        detectedAt: new Date(1_800_000_000_100).toISOString(),
      }],
    });
  });
});
