import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type Opportunity,
  type VolatilityState,
} from "@contracts/trading";
import { createMarketSnapshot } from "./binance";
import {
  approveAndPriceEntry,
  approveHistoricalEntry,
  applyAdverseSlippage,
} from "./execution";

const NOW = 1_800_000_000_000;

const opportunity: Opportunity = {
  id: "BTCUSDT-test",
  symbol: "BTCUSDT",
  side: "LONG",
  status: "READY",
  score: 90,
  regime: "多头共振",
  entry: 100,
  stop: 99,
  target: 102.2,
  stopDistancePct: 1,
  rewardRisk: 2.2,
  leverage: 20,
  marginPct: 2,
  riskPct: 0.35,
  reasons: ["执行层回归测试"],
  signalCloseTime: NOW - 1_000,
  stateVersion: 1,
  sourceGeneration: 0,
  atr15: 1,
  createdAt: new Date(NOW - 1_000).toISOString(),
};

const state: VolatilityState = {
  symbol: "BTCUSDT",
  mode: "NORMAL",
  confirmationCount: 0,
  stableSince: null,
  metrics: { atrQuantile: 0.5, tickSigma: 1, spreadRatio: 1 },
  lastDataAt: NOW,
  version: 1,
};

const settings = { ...DEFAULT_SETTINGS, autoTrade: true };

const symbolMeta = {
  symbol: "BTCUSDT",
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
};

const common = {
  opportunity,
  state,
  settings,
  equity: 100_000,
  usedMargin: 0,
  todayPnlPct: 0,
  positions: [],
  correlations: {},
  symbolMeta,
  maxLeverage: 20,
  now: NOW,
};

function expectedRisk(entry: number) {
  const stopDistance = entry - opportunity.stop;
  const twoSidedFees = (entry + opportunity.stop) * settings.takerFeeBps / 10_000;
  const exitSlippage = opportunity.stop * settings.slippageBps / 10_000;
  return stopDistance + twoSidedFees + exitSlippage;
}

describe("入场执行与仓位成本边界", () => {
  it("实时盘口成交价已包含开仓滑点，仓位预算不重复预留开仓滑点", () => {
    const snapshot = createMarketSnapshot({
      source: "MAINNET",
      symbol: "BTCUSDT",
      bid: 99.99,
      ask: 100.01,
      markPrice: 100,
      bookTime: NOW,
      markTime: NOW,
    }, NOW);

    const result = approveAndPriceEntry({ ...common, snapshot });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fillPrice).toBeCloseTo(applyAdverseSlippage(100.01, "LONG", settings.slippageBps, "OPEN"), 10);
    expect(result.estimatedRisk).toBeCloseTo(result.qty * expectedRisk(result.fillPrice), 8);
    expect(result.estimatedRisk).toBeLessThanOrEqual(100_000 * settings.riskPerTradePct / 100);
  });

  it("历史开仓成交价已包含开仓滑点，使用相同的仅计退出滑点规则", () => {
    const fillPrice = applyAdverseSlippage(100, "LONG", settings.slippageBps, "OPEN");
    const result = approveHistoricalEntry({
      ...common,
      currentPrice: 100,
      fillPrice,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fillPrice).toBeCloseTo(fillPrice, 10);
    expect(result.estimatedRisk).toBeCloseTo(result.qty * expectedRisk(fillPrice), 8);
    expect(result.estimatedRisk).toBeLessThanOrEqual(100_000 * settings.riskPerTradePct / 100);
  });
});
