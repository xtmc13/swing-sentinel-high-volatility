import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Opportunity } from "@contracts/trading";

const settings = {
  ...DEFAULT_SETTINGS,
  autoTrade: true,
  momentumEnabled: true,
  strategyMode: "MOMENTUM" as const,
};

vi.mock("../queries/trading", () => ({
  ensureInitialized: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => settings),
  getOpenPositions: vi.fn(),
  addEvent: vi.fn(async () => undefined),
  assertAffectedRows: vi.fn(),
  settingsFromRow: vi.fn(),
}));

import { createPaperService } from "./paper";

function signal(): Opportunity {
  return {
    id: "momentum-1",
    signalId: "MOMENTUM:persisted-1",
    strategyType: "MOMENTUM",
    symbol: "BTCUSDT",
    side: "LONG",
    status: "READY",
    score: 100,
    regime: "早期放量突破",
    entry: 100,
    stop: 99,
    target: 102.2,
    stopDistancePct: 1,
    rewardRisk: 2.2,
    leverage: 5,
    marginPct: 2,
    riskPct: 0.35,
    reasons: [],
    signalCloseTime: 1,
    signalTime: 1,
    expiryTime: 9_999_999_999_999,
    triggerPrice: 100,
    limitPrice: 100,
    breakoutPrice: 99.9,
    stateVersion: 1,
    sourceGeneration: 1,
    detectorVersion: "test",
    configVersion: "test",
    atr15: 1,
    createdAt: new Date(1).toISOString(),
  };
}

describe("paper signal durability", () => {
  it("rejects an existing momentum signal across service instances before market or order work", async () => {
    const persisted = [{ id: "already-open", signalId: "MOMENTUM:persisted-1" }];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => persisted,
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
          }),
        }),
      }),
    };
    const market = {
      sourceGeneration: 1,
      getMarketSnapshot: vi.fn(),
      getSymbolMeta: vi.fn(),
      getMarkets: vi.fn(),
      getCandles: vi.fn(),
    };
    const first = createPaperService({ getDb: () => db as never, market: market as never });
    const restarted = createPaperService({ getDb: () => db as never, market: market as never });

    await expect(first.openPaperPosition(signal())).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("已执行") });
    await expect(restarted.openPaperPosition(signal())).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("已执行") });
    expect(market.getMarketSnapshot).not.toHaveBeenCalled();
    expect(market.getMarkets).not.toHaveBeenCalled();
  });
});
