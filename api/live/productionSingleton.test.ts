import { describe, expect, it, vi } from "vitest";
import { executionIntents, executionOrders, liveIntents, liveOrders } from "@db/schema";
import type { ProductionLiveRuntimeOptions } from "./productionRuntime";

const mocks = vi.hoisted(() => ({
  options: null as unknown,
  rows: new Map<unknown, { status: string }[]>(),
  paperCounts: vi.fn(),
}));

vi.mock("./productionRuntime", () => ({
  createProductionLiveRuntime: (options: ProductionLiveRuntimeOptions) => {
    mocks.options = options;
    return {
      getLiveAdapter: vi.fn(), runLivePreflight: vi.fn(), stop: vi.fn(),
      privateWs: { health: vi.fn() }, reconciliation: { health: vi.fn() },
    };
  },
}));

vi.mock("../queries/trading", async (importOriginal) => ({
  ...await importOriginal<typeof import("../queries/trading")>(),
  getSettings: vi.fn(),
  getOutstandingOrderCounts: mocks.paperCounts,
}));

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => {
        if (table === executionIntents || table === executionOrders) throw new Error("paper table queried");
        return { where: async () => mocks.rows.get(table) ?? [] };
      },
    }),
  }),
}));

import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import "./productionSingleton";

describe("production outstanding live risk", () => {
  it("ignores paper-only intents and orders", async () => {
    mocks.rows.clear();
    mocks.rows.set(liveIntents, []);
    mocks.rows.set(liveOrders, []);
    mocks.paperCounts.mockResolvedValue({ pendingIntents: 1, unfinishedOrders: 1 });
    vi.spyOn(DrizzleLiveOrderStore.prototype, "listOpenPositions").mockResolvedValue([]);
    const options = mocks.options as ProductionLiveRuntimeOptions;

    await expect(options.hasOutstandingLiveRisk()).resolves.toBe(false);
  });

  it("detects a live pending intent without relying on paper counts", async () => {
    mocks.rows.clear();
    mocks.rows.set(liveIntents, [{ status: "PENDING_SEND" }]);
    mocks.rows.set(liveOrders, []);
    mocks.paperCounts.mockResolvedValue({ pendingIntents: 0, unfinishedOrders: 0 });
    vi.spyOn(DrizzleLiveOrderStore.prototype, "listOpenPositions").mockResolvedValue([]);
    const options = mocks.options as ProductionLiveRuntimeOptions;

    await expect(options.hasOutstandingLiveRisk()).resolves.toBe(true);
  });
});
