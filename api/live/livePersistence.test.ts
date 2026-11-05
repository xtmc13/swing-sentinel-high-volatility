import { describe, expect, it } from "vitest";
import { liveControls, liveIntents, tradingSettings, volatilityStates } from "@db/schema";
import {
  createLiveIntent,
  type CreateLiveIntentInput,
  type LiveDatabase,
  type LiveFinalGateResult,
} from "./livePersistence";

function input(overrides: Partial<CreateLiveIntentInput> = {}): CreateLiveIntentInput {
  return {
    id: crypto.randomUUID(),
    signalId: crypto.randomUUID(),
    symbol: "BTCUSDT",
    side: "LONG",
    positionSide: "LONG",
    entrySemantics: "ENTRY",
    accountModeFingerprint: "0".repeat(64),
    quantity: "40",
    limitPrice: "100",
    tickSize: "0.01",
    stopPrice: "99",
    liquidationPrice: "50",
    leverage: 5,
    notional: "4000",
    reservedMargin: "800",
    reservedRisk: "60",
    expiresAt: new Date(Date.now() + 60_000),
    workerId: "worker-a",
    leaseDurationMs: 5_000,
    ...overrides,
  };
}

function approval(
  value: CreateLiveIntentInput,
  overrides: Record<string, unknown> = {},
): Extract<LiveFinalGateResult, { approved: true }> {
  return {
    approved: true,
    signalId: value.signalId,
    quantity: value.quantity,
    notional: value.notional,
    reservedMargin: value.reservedMargin,
    reservedRisk: value.reservedRisk,
    effectiveLeverage: value.leverage,
    marginType: "ISOLATED",
    maintenanceBracket: 1,
    maintMarginRatio: "0.01",
    cumMaintenance: "0",
    notionalCap: "50000",
    notionalFloor: "0",
    initialLeverage: 150,
    liquidationPriceSource: "PRETRADE_ESTIMATE",
    validUntil: value.expiresAt,
    ...overrides,
  } as Extract<LiveFinalGateResult, { approved: true }>;
}

function database() {
  let inserted: Record<string, unknown> | undefined;
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          for: async () => table === tradingSettings
            ? [{ executionMode: "LIVE_MAINNET", autoTrade: true, highVolatilityRiskMultiplier: 0.5 }]
            : table === liveControls ? [{ armed: true, generation: 0 }]
              : table === volatilityStates ? [{ mode: "NORMAL" }] : [],
        }),
      }),
    }),
    execute: async () => [[{ db_now_ms: Date.now() }]],
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table !== liveIntents) throw new Error("unexpected insert");
        inserted = values;
      },
    }),
  };
  const db = {
    transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as LiveDatabase;
  return { db, inserted: () => inserted };
}

describe("live final-gate approval persistence", () => {
  it("accepts a legal 150x approval and persists its effective leverage and bracket", async () => {
    const store = database();
    const value = input({
      leverage: 150,
      reservedMargin: "26.666666666666666666666666666666",
    });

    const result = await createLiveIntent(store.db, value, {
      assertCurrentAdmission: async () => undefined,
      finalGate: async () => approval(value, { maintenanceBracket: 2, maintMarginRatio: "0.005" }),
    });

    expect(result).toMatchObject({ ok: true });
    expect(store.inserted()).toMatchObject({
      leverage: 150,
      effectiveLeverage: 150,
      maintenanceBracket: 2,
      maintMarginRatio: "0.005",
      cumMaintenance: "0",
      notionalCap: "50000",
      notionalFloor: "0",
      initialLeverage: 150,
      compatibilityFrozen: false,
    });
  });

  it("uses final effectiveLeverage instead of the stale prepare value for margin consistency", async () => {
    const store = database();
    const value = input({ leverage: 20 });

    const result = await createLiveIntent(store.db, value, {
      assertCurrentAdmission: async () => undefined,
      finalGate: async () => approval(value, {
        effectiveLeverage: 150,
        reservedMargin: "26.666666666666666666666666666666",
      }),
    });

    expect(result).toMatchObject({ ok: true });
    expect(store.inserted()).toMatchObject({ leverage: 150, effectiveLeverage: 150 });
  });

  it("rejects an approval whose margin and effectiveLeverage disagree", async () => {
    const store = database();
    const value = input();

    const result = await createLiveIntent(store.db, value, {
      assertCurrentAdmission: async () => undefined,
      finalGate: async () => approval(value, { effectiveLeverage: 4 }),
    });

    expect(result).toMatchObject({ ok: false });
    expect(store.inserted()).toBeUndefined();
  });

  it("rejects incomplete or invalid bracket metadata before insertion", async () => {
    const store = database();
    const value = input();

    const result = await createLiveIntent(store.db, value, {
      assertCurrentAdmission: async () => undefined,
      finalGate: async () => approval(value, { maintenanceBracket: 0 }),
    });

    expect(result).toMatchObject({ ok: false });
    expect(store.inserted()).toBeUndefined();
  });
});
