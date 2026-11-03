import { describe, expect, it, vi } from "vitest";
import { liveControls, liveFills, liveIntents, liveOrders, livePositions, tradingSettings } from "@db/schema";
import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import type { LiveDatabase } from "./livePersistence";

const openedAt = new Date(1_793_600_000_000);
const positionRow = {
  id: "intent-1",
  symbol: "BTCUSDT",
  side: "LONG",
  status: "OPEN",
  initialQuantity: "2",
  quantity: "2",
  entryPrice: "100",
  markPrice: "101",
  liquidationPrice: "50",
  isolatedWallet: "40",
  leverage: "5",
  maintenanceBracket: 1,
  maintMarginRatio: "0.01",
  cumMaintenance: "0",
  openedAt,
  updatedAt: openedAt,
  closedAt: null,
};

describe("durable live position recovery", () => {
  it("restores the protection stop from the persisted intent rather than zero", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => table === livePositions ? [positionRow] : [{ stopPrice: "99" }],
          }),
        }),
      }),
    } as unknown as LiveDatabase;
    const store = new DrizzleLiveOrderStore(db);

    expect(await store.getPosition("intent-1")).toMatchObject({ stopPrice: "99", initialStopPrice: null });
  });

  it("uses the same persisted stop when listing open positions", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => table === livePositions
          ? { where: async () => [positionRow] }
          : { where: () => ({ limit: async () => [{ stopPrice: "99" }] }) },
      }),
    } as unknown as LiveDatabase;
    const store = new DrizzleLiveOrderStore(db);

    expect(await store.listOpenPositions()).toMatchObject([{ stopPrice: "99" }]);
  });

  it("locks and rejects final admission when current controls are disarmed", async () => {
    const orderRow = {
      id: "order-1", intentId: "intent-1", clientOrderId: "client-1", exchangeOrderId: null,
      symbol: "BTCUSDT", side: "LONG", type: "LIMIT", status: "PENDING_SEND", price: "100",
      maxEntryPrice: "100", originalQuantity: "2", reduceOnly: false, createdAt: openedAt,
    };
    const locked: unknown[] = [];
    const rowsFor = (table: unknown): unknown[] => {
      if (table === liveOrders) return [orderRow];
      if (table === liveFills) return [];
      if (table === tradingSettings) return [{ executionMode: "LIVE_MAINNET", autoTrade: true }];
      if (table === liveControls) return [{ armed: false, generation: 7 }];
      if (table === liveIntents) return [{ status: "PENDING_SEND", manualCanary: true }];
      throw new Error("unexpected table");
    };
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows = rowsFor(table);
            return Object.assign(Promise.resolve(rows), {
              limit: () => ({ for: async () => { locked.push(table); return rows; } }),
              for: async () => { locked.push(table); return rows; },
            });
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: { status?: string }) => ({
          where: async () => {
            if (table === liveOrders && values.status) orderRow.status = values.status;
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    };
    const db = {
      transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as LiveDatabase;
    const store = new DrizzleLiveOrderStore(db);
    const currentAuthorization = vi.fn(async () => {
      expect(locked).toHaveLength(0);
    });

    await expect(store.admitOrder("client-1", 7, currentAuthorization)).resolves.toMatchObject({ status: "CANCEL" });
    expect(locked).toEqual(expect.arrayContaining([liveOrders, tradingSettings, liveControls, liveIntents]));
  });

  it("rechecks intent expiry against database time at final transport admission", async () => {
    const orderRow = {
      id: "order-1", intentId: "intent-1", clientOrderId: "client-1", exchangeOrderId: null,
      symbol: "BTCUSDT", side: "LONG", type: "LIMIT", status: "SUBMITTING", price: "100",
      maxEntryPrice: "100", originalQuantity: "2", reduceOnly: false, createdAt: openedAt,
    };
    const rowsFor = (table: unknown): unknown[] => {
      if (table === liveOrders) return [orderRow];
      if (table === liveFills) return [];
      if (table === tradingSettings) return [{ executionMode: "LIVE_MAINNET", autoTrade: true }];
      if (table === liveControls) return [{ armed: true, generation: 7 }];
      if (table === liveIntents) return [{ status: "SUBMITTING", manualCanary: true, expiresAt: new Date(1_000) }];
      throw new Error("unexpected table");
    };
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows = rowsFor(table);
            return Object.assign(Promise.resolve(rows), {
              limit: () => ({ for: async () => rows }),
              for: async () => rows,
            });
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: { status?: string }) => ({
          where: async () => {
            if (table === liveOrders && values.status) orderRow.status = values.status;
            return [{ affectedRows: 1 }];
          },
        }),
      }),
      execute: async () => [[{ db_now_ms: "2000" }]],
    };
    const db = {
      transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as LiveDatabase;
    const store = new DrizzleLiveOrderStore(db);

    await expect(store.admitOrder("client-1", 7, async () => undefined)).resolves.toMatchObject({ status: "CANCEL" });
  });
});
