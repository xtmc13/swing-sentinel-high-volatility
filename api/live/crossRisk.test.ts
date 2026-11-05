import { describe, expect, it } from "vitest";
import type { BinancePositionRisk } from "./binanceSigned";
import {
  estimateCrossLiquidationBoundary,
  type CrossLiquidationCandidate,
  type CrossRiskPosition,
  type CrossRiskSnapshot,
} from "./crossRisk";

const BRACKETS = [{
  bracket: 1,
  initialLeverage: 100,
  notionalFloor: "0",
  notionalCap: "10000",
  maintMarginRatio: "0.01",
  cum: "0",
}];

function candidate(overrides: Partial<CrossLiquidationCandidate> = {}): CrossLiquidationCandidate {
  return {
    symbol: "BTCUSDT",
    side: "LONG",
    quantity: "1",
    entryPrice: "100",
    stopPrice: "91",
    tickSize: "0.01",
    brackets: BRACKETS,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CrossRiskSnapshot> = {}): CrossRiskSnapshot {
  return {
    crossWalletBalance: "10",
    crossUnrealizedPnl: "0",
    positions: [],
    multiAssets: false,
    observedAt: 1_000,
    ...overrides,
  };
}

function position(
  remote: Partial<BinancePositionRisk> & Pick<BinancePositionRisk, "symbol" | "positionAmt">,
  maintMarginRatio = "0.01",
  cumMaintenance = "0",
): CrossRiskPosition {
  return {
    remote: {
      positionSide: "BOTH",
      entryPrice: "100",
      markPrice: "100",
      liquidationPrice: "0",
      leverage: "10",
      marginType: "cross",
      ...remote,
    },
    brackets: [{ ...BRACKETS[0], maintMarginRatio, cum: cumMaintenance }],
  };
}

describe("cross portfolio liquidation boundary", () => {
  it("solves the candidate price root and rounds LONG toward earlier liquidation", () => {
    const result = estimateCrossLiquidationBoundary(snapshot(), candidate());

    expect(result).toEqual({
      ok: true,
      liquidationPrice: "90.91",
      noPositiveRoot: false,
      liquidationPriceSource: "PRETRADE_ESTIMATE",
      maintenanceBracket: 1,
    });
  });

  it("uses only cross collateral and sums both dual legs without netting maintenance", () => {
    const result = estimateCrossLiquidationBoundary(snapshot({
      crossUnrealizedPnl: "30",
      positions: [
        position({ symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "1", entryPrice: "90" }),
        position({ symbol: "ETHUSDT", positionSide: "SHORT", positionAmt: "-2", entryPrice: "110" }),
        position({
          symbol: "SOLUSDT", positionAmt: "100", entryPrice: "1", markPrice: "2", marginType: "isolated",
        }, "1"),
      ],
    }), candidate({ symbol: "ADAUSDT", entryPrice: "50", stopPrice: "14" }));

    expect(result).toMatchObject({ ok: true, liquidationPrice: "13.14" });
  });

  it("adds only candidate incremental PnL to current cross equity without double counting uPnL", () => {
    const result = estimateCrossLiquidationBoundary(snapshot({
      crossUnrealizedPnl: "10",
      positions: [position({ symbol: "ETHUSDT", positionAmt: "1", entryPrice: "90" })],
    }), candidate({ stopPrice: "82" }));

    expect(result).toMatchObject({ ok: true, liquidationPrice: "81.82" });
  });

  it("selects an existing leg bracket from its current mark notional after a transition", () => {
    const existing = position({ symbol: "ETHUSDT", positionAmt: "1", entryPrice: "100", markPrice: "200" });
    const result = estimateCrossLiquidationBoundary(snapshot({
      crossWalletBalance: "0",
      crossUnrealizedPnl: "100",
      positions: [{
        ...existing,
        brackets: [
          { ...BRACKETS[0], notionalCap: "150" },
          {
            bracket: 2, initialLeverage: 50, notionalFloor: "150", notionalCap: "1000",
            maintMarginRatio: "0.02", cum: "1.5",
          },
        ],
      } as CrossRiskPosition],
    }), candidate({ stopPrice: "3" }));

    expect(result).toMatchObject({ ok: true, liquidationPrice: "2.53" });
  });

  it("rejects a gap between entry and a discovered root instead of skipping the uncovered interval", () => {
    const result = estimateCrossLiquidationBoundary(snapshot({ crossWalletBalance: "520" }), candidate({
      quantity: "10",
      stopPrice: "49",
      brackets: [
        { ...BRACKETS[0], notionalCap: "500" },
        {
          bracket: 2, initialLeverage: 50, notionalFloor: "600", notionalCap: "5000",
          maintMarginRatio: "0.02", cum: "5",
        },
      ],
    }));

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/覆盖|gap/) });
  });

  it("re-solves in the post-fill maintenance bracket and applies its cum", () => {
    const result = estimateCrossLiquidationBoundary(snapshot({ crossWalletBalance: "520" }), candidate({
      quantity: "10",
      stopPrice: "49",
      brackets: [
        ...BRACKETS.map((bracket) => ({ ...bracket, notionalCap: "500" })),
        {
          bracket: 2,
          initialLeverage: 50,
          notionalFloor: "500",
          notionalCap: "5000",
          maintMarginRatio: "0.02",
          cum: "5",
        },
      ],
    }));

    expect(result).toMatchObject({ ok: true, liquidationPrice: "48.49", maintenanceBracket: 1 });
  });

  it("clamps candidate maintenance to zero instead of moving the root past the true boundary", () => {
    const result = estimateCrossLiquidationBoundary(snapshot({ crossWalletBalance: "60" }), candidate({
      stopPrice: "41",
      brackets: [{ ...BRACKETS[0], cum: "0.5" }],
    }));

    expect(result).toMatchObject({ ok: true, liquidationPrice: "40" });
  });

  it("rounds SHORT toward earlier liquidation and requires a strictly earlier stop on both sides", () => {
    const short = candidate({ side: "SHORT", stopPrice: "108" });
    expect(estimateCrossLiquidationBoundary(snapshot(), short)).toMatchObject({
      ok: true, liquidationPrice: "108.91",
    });
    expect(estimateCrossLiquidationBoundary(snapshot(), candidate({ stopPrice: "90.91" }))).toMatchObject({
      ok: false,
    });
    expect(estimateCrossLiquidationBoundary(snapshot(), { ...short, stopPrice: "108.91" })).toMatchObject({
      ok: false,
    });
  });

  it("rejects related pending intents instead of treating reserved margin as a portfolio simulation", () => {
    expect(estimateCrossLiquidationBoundary(snapshot({ relatedPendingIntents: 1 }), candidate())).toMatchObject({
      ok: false, reason: expect.stringMatching(/pending|待成交/),
    });
  });

  it("requires a fresh explicit collateral haircut in multi-assets mode", () => {
    const multiAsset = snapshot({
      crossWalletBalance: "20",
      multiAssets: true,
      collateral: { haircut: "0.5", observedAt: 1_000 },
    });
    expect(estimateCrossLiquidationBoundary(multiAsset, candidate())).toMatchObject({
      ok: true, liquidationPrice: "90.91",
    });
    expect(estimateCrossLiquidationBoundary({ ...multiAsset, collateral: undefined }, candidate())).toMatchObject({
      ok: false, reason: expect.stringMatching(/haircut|折算/),
    });
    expect(estimateCrossLiquidationBoundary({
      ...multiAsset, collateral: { haircut: "0.5", observedAt: 999 },
    }, candidate())).toMatchObject({ ok: false });
    expect(estimateCrossLiquidationBoundary({
      ...multiAsset, collateral: { haircut: "0.5", observedAt: 1_001 },
    }, candidate())).toMatchObject({ ok: true, liquidationPrice: "90.91" });
    expect(estimateCrossLiquidationBoundary({
      ...multiAsset, collateral: { haircut: "0.5", observedAt: 11_001 },
    }, candidate())).toMatchObject({ ok: false });
  });

  it("allows a LONG with no positive root only when its stop is valid throughout the positive range", () => {
    const noRoot = snapshot({ crossWalletBalance: "100" });
    expect(estimateCrossLiquidationBoundary(noRoot, candidate({ stopPrice: "99" }))).toEqual({
      ok: true,
      liquidationPrice: null,
      noPositiveRoot: true,
      liquidationPriceSource: "PRETRADE_ESTIMATE",
      maintenanceBracket: null,
    });
    expect(estimateCrossLiquidationBoundary(noRoot, candidate({ stopPrice: "100" }))).toMatchObject({ ok: false });
  });
});
