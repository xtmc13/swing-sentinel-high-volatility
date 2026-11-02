import { describe, expect, it, vi } from "vitest";
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
    const orders = {
      listRecentOrders: async () => [order],
      listActiveProtectionOrders: async () => [],
    };

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
      protectionOrders: [],
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
      reconciliationSummary: { openIssues: 1, severeIssues: 1, lastDetectedAt: 1_800_000_000_100 },
    });
  });

  it("bounds recent/reconciliation reads and queries active protection independently", async () => {
    const protection = { ...order, type: "STOP_MARKET" as const, status: "NEW" as const, reduceOnly: true };
    const listRecentOrders = vi.fn(async () => []);
    const listActiveProtectionOrders = vi.fn(async () => [protection]);
    const reconciliation = new InMemoryReconciliationStore();
    const listIssues = vi.spyOn(reconciliation, "listIssues");
    const listUnsettledIntents = vi.spyOn(reconciliation, "listUnsettledIntents");

    const result = await readLiveOperations({ listRecentOrders, listActiveProtectionOrders }, reconciliation);

    expect(listRecentOrders).toHaveBeenCalledWith(60);
    expect(listActiveProtectionOrders).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith(100);
    expect(listUnsettledIntents).toHaveBeenCalledWith(100);
    expect(result.orders).toEqual([]);
    expect(result.protectionOrders[0]).toMatchObject({ type: "STOP_MARKET", status: "NEW", reduceOnly: true });
  });

  it("authoritative summary sees a newer unresolved CRITICAL beyond the 100-row display page", async () => {
    const reconciliation = new InMemoryReconciliationStore();
    for (let index = 0; index < 101; index += 1) {
      await reconciliation.recordIssue({
        category: "USER_DATA_EVENT", severity: "INFO", symbol: null,
        expectedValue: null, actualValue: null, message: `old-info-${index}`,
        detectedAt: 1_800_000_000_000 + index,
      });
    }
    await reconciliation.recordIssue({
      category: "UNPROTECTED_POSITION", severity: "CRITICAL", symbol: "BTCUSDT",
      expectedValue: null, actualValue: null, message: "new-critical",
      detectedAt: 1_800_000_000_101,
    });
    const orders = { listRecentOrders: async () => [], listActiveProtectionOrders: async () => [] };

    const result = await readLiveOperations(orders, reconciliation);
    expect(result.reconciliationIssues).toHaveLength(100);
    expect(result.reconciliationIssues.some((issue) => issue.severity === "CRITICAL")).toBe(false);
    expect(result.reconciliationSummary).toEqual({
      openIssues: 102,
      severeIssues: 1,
      lastDetectedAt: 1_800_000_000_101,
    });
  });
});
