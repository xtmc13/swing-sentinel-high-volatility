import { describe, expect, it, vi } from "vitest";
import type { VolatilityState } from "@contracts/trading";

const writes = vi.hoisted(() => ({
  values: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock("./connection", () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        writes.values.push(values);
        return {
          onDuplicateKeyUpdate: async ({ set }: { set: Record<string, unknown> }) => {
            writes.updates.push(set);
          },
        };
      },
    }),
  }),
}));

import { saveVolatilityState } from "./volatility";

describe("volatility persistence with unavailable metrics", () => {
  it("writes zero for non-finite metrics and timestamps", async () => {
    const state: VolatilityState = {
      symbol: "BTCUSDT",
      mode: "EXTREME",
      confirmationCount: 0,
      stableSince: null,
      metrics: {
        atrQuantile: Number.NaN,
        tickSigma: Number.POSITIVE_INFINITY,
        spreadRatio: Number.NaN,
      },
      lastDataAt: Number.NaN,
      version: 1,
    };

    await saveVolatilityState(state);

    expect(writes.values).toEqual([{
      symbol: "BTCUSDT",
      mode: "EXTREME",
      confirmationCount: 0,
      stableSince: null,
      atrQuantile: 0,
      tickSigma: 0,
      spreadRatio: 0,
      lastDataAt: 0,
      version: 1,
    }]);
    expect(writes.updates).toEqual([{
      mode: "EXTREME",
      confirmationCount: 0,
      stableSince: null,
      atrQuantile: 0,
      tickSigma: 0,
      spreadRatio: 0,
      lastDataAt: 0,
      version: 1,
    }]);
  });
});
