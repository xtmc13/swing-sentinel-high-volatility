import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type MarketQuality,
  type TradingSettings,
  type VolatilityState,
} from "@contracts/trading";
import { evaluateVolatility } from "./volatility";

const NOW = 1_800_000_000_000;
const quality: MarketQuality = { valid: true, reasons: [], bookAgeMs: 10, markAgeMs: 10, candleAgeMs: 10 };

function settings(overrides: Partial<TradingSettings> = {}): TradingSettings {
  return {
    ...DEFAULT_SETTINGS,
    atrBaselineMinSamples: 100,
    spreadBaselineMinSamples: 3,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "TESTUSDT",
    settings: settings(),
    quality,
    currentAtr: 50,
    atrBaseline: Array.from({ length: 100 }, (_, index) => index + 1),
    currentTickReturn: 0,
    tickReturnBaseline: [-0.0001, 0, 0.0001],
    currentSpreadBps: 1,
    spreadBaselineBps: [1, 1, 1],
    ...overrides,
  };
}

function previous(overrides: Partial<VolatilityState> = {}): VolatilityState {
  return {
    symbol: "TESTUSDT",
    mode: "NORMAL",
    confirmationCount: 0,
    stableSince: null,
    metrics: { atrQuantile: 0.5, tickSigma: 0, spreadRatio: 1 },
    lastDataAt: NOW - 1000,
    version: 4,
    ...overrides,
  };
}

describe("三态波动判定与状态迁移", () => {
  it("ATR 或点差基线不足时禁止按 NORMAL 开仓", () => {
    const defaults = settings({ atrBaselineMinSamples: 2016, spreadBaselineMinSamples: 120 });
    const shortAtr = evaluateVolatility(input({ settings: defaults, atrBaseline: Array(2015).fill(1) }), null, NOW);
    const shortSpread = evaluateVolatility(input({ settings: defaults, spreadBaselineBps: Array(119).fill(1) }), null, NOW);

    expect(shortAtr.mode).toBe("EXTREME");
    expect(shortAtr.reasons).toContain("ATR基线样本不足");
    expect(shortSpread.mode).toBe("EXTREME");
    expect(shortSpread.reasons).toContain("点差基线样本不足");
  });

  it("ATR 达到 90 分位进入 HIGH，达到 99 分位立即 EXTREME", () => {
    const high = evaluateVolatility(input({ currentAtr: 90 }), previous({ confirmationCount: 1 }), NOW);
    const extreme = evaluateVolatility(input({ currentAtr: 99 }), previous(), NOW);

    expect(high.mode).toBe("HIGH");
    expect(high.metrics.atrQuantile).toBe(0.9);
    expect(extreme.mode).toBe("EXTREME");
    expect(extreme.metrics.atrQuantile).toBe(0.99);
    expect(extreme.confirmationCount).toBe(0);
  });

  it("1M 跳动在 3σ 进入 HIGH、5σ 立即 EXTREME，并使用最小波动下限", () => {
    const zeroVariance = { tickReturnBaseline: [0, 0, 0] };
    const below = evaluateVolatility(input({ ...zeroVariance, currentTickReturn: 0.00029 }), previous({ confirmationCount: 1 }), NOW);
    const high = evaluateVolatility(input({ ...zeroVariance, currentTickReturn: 0.0003 }), previous({ confirmationCount: 1 }), NOW);
    const extreme = evaluateVolatility(input({ ...zeroVariance, currentTickReturn: 0.0005 }), previous(), NOW);

    expect(below.mode).toBe("NORMAL");
    expect(below.metrics.tickSigma).toBeCloseTo(2.9);
    expect(high.mode).toBe("HIGH");
    expect(high.metrics.tickSigma).toBeCloseTo(3, 12);
    expect(extreme.mode).toBe("EXTREME");
    expect(extreme.metrics.tickSigma).toBeCloseTo(5, 12);
  });

  it("点差达近期中位数两倍进入 HIGH，超过硬上限立即 EXTREME", () => {
    const high = evaluateVolatility(input({ currentSpreadBps: 2 }), previous({ confirmationCount: 1 }), NOW);
    const extreme = evaluateVolatility(input({ currentSpreadBps: 3.01, spreadBaselineBps: [3, 3, 3] }), previous(), NOW);

    expect(high.mode).toBe("HIGH");
    expect(high.metrics.spreadRatio).toBe(2);
    expect(extreme.mode).toBe("EXTREME");
  });

  it("HIGH 需要连续两次确认且期间NORMAL会清零计数", () => {
    const first = evaluateVolatility(input({ currentAtr: 90 }), previous(), NOW);
    const reset = evaluateVolatility(input(), previous({ confirmationCount: first.confirmationCount }), NOW + 1000);
    const confirmed = evaluateVolatility(input({ currentAtr: 90 }), previous({ confirmationCount: 1 }), NOW + 2000);

    expect(first.mode).toBe("NORMAL");
    expect(first.confirmationCount).toBe(1);
    expect(reset.confirmationCount).toBe(0);
    expect(confirmed.mode).toBe("HIGH");
    expect(confirmed.version).toBe(5);
  });

  it("保护状态连续稳定 180 秒才恢复，短暂好转和反复 HIGH 不提前恢复", () => {
    const protectedState = previous({ mode: "EXTREME", version: 8 });
    const recovering = evaluateVolatility(input(), protectedState, NOW);
    const interrupted = evaluateVolatility(input({ currentAtr: 90 }), recovering, NOW + 60_000);
    const restarted = evaluateVolatility(input(), interrupted, NOW + 90_000);
    const tooEarly = evaluateVolatility(input(), restarted, NOW + 269_999);
    const recovered = evaluateVolatility(input(), tooEarly, NOW + 270_000);

    expect(recovering.mode).toBe("EXTREME");
    expect(recovering.stableSince).toBe(NOW);
    expect(interrupted.stableSince).toBeNull();
    expect(restarted.stableSince).toBe(NOW + 90_000);
    expect(tooEarly.mode).toBe("EXTREME");
    expect(recovered.mode).toBe("NORMAL");
    expect(recovered.version).toBe(9);
    expect(recovered.stableSince).toBeNull();
  });

  it("行情质量失效立即 EXTREME，无需等待确认", () => {
    const result = evaluateVolatility(input({ quality: { ...quality, valid: false, reasons: ["盘口陈旧"] } }), previous(), NOW);

    expect(result.mode).toBe("EXTREME");
    expect(result.reasons).toContain("盘口陈旧");
  });
});
