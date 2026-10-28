import { describe, expect, it } from "vitest";
import { correlation, managePositionPrice, portfolioRisk, sizePosition } from "./risk";
import * as risk from "./risk";
import type { Candle } from "@contracts/trading";

const NOW = 1_800_000_000_000;

function sizeInput(overrides: Record<string, unknown> = {}) {
  return {
    equity: 10_000,
    side: "LONG" as const,
    entryPrice: 102,
    stopPrice: 97,
    leverage: 10,
    mode: "NORMAL" as const,
    riskPerTradePct: 0.35,
    highVolatilityRiskMultiplier: 0.5,
    marginPerTradePct: 10,
    totalMarginCapPct: 50,
    usedMargin: 0,
    takerFeeBps: 5,
    slippageBps: 2,
    stepSize: 0,
    minQty: 0,
    minNotional: 0,
    signalCloseTime: NOW - 1000,
    signalStateVersion: 3,
    currentStateVersion: 3,
    now: NOW,
    maxSignalAgeSeconds: 15,
    ...overrides,
  };
}

function portfolioInput(candidateRisk = 40, correlations: Record<string, number | null> = { AAA: 0.8 }) {
  return {
    equity: 10_000,
    positions: [{
      symbol: "AAA",
      side: "LONG" as const,
      qty: 1,
      entryPrice: 100,
      markPrice: 100,
      stopPrice: 95,
    }],
    candidate: { symbol: "BBB", side: "LONG" as const, risk: candidateRisk, correlations },
    takerFeeBps: 5,
    slippageBps: 2,
    portfolioStopRiskPct: 1,
    correlatedDirectionRiskPct: 0.5,
    correlationThreshold: 0.8,
  };
}

describe("仓位、组合风险与持仓管理", () => {
  it("按实际成交价止损距离和双边费用滑点计算数量", () => {
    const result = sizePosition(sizeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopDistance).toBe(5);
    expect(result.riskBudget).toBe(35);
    expect(result.qty).toBeCloseTo(35 / (5 + 199 * 0.0007), 10);
    expect(result.estimatedRisk).toBeCloseTo(35, 10);
    expect(result.targetPrice).toBeCloseTo(113);

    const historicalFill = sizePosition(sizeInput({ entrySlippageIncluded: true }));
    expect(historicalFill.ok).toBe(true);
    if (historicalFill.ok) {
      expect(historicalFill.qty).toBeCloseTo(35 / (5 + 199 * 0.0005 + 97 * 0.0002), 10);
    }
  });

  it("HIGH 风险预算减半，EXTREME 不开新仓", () => {
    const high = sizePosition(sizeInput({ mode: "HIGH" }));
    const configured = sizePosition(sizeInput({ mode: "HIGH", highVolatilityRiskMultiplier: 0.25 }));
    const extreme = sizePosition(sizeInput({ mode: "EXTREME" }));

    expect(high.ok).toBe(true);
    if (high.ok) expect(high.riskBudget).toBe(17.5);
    expect(configured.ok).toBe(true);
    if (configured.ok) expect(configured.riskBudget).toBe(8.75);
    expect(extreme).toMatchObject({ ok: false, reason: "EXTREME禁止新增风险" });
  });

  it("旧状态版本和过期信号被拒绝", () => {
    expect(sizePosition(sizeInput({ currentStateVersion: 4 }))).toMatchObject({ ok: false, reason: "信号状态版本陈旧" });
    expect(sizePosition(sizeInput({ signalCloseTime: NOW - 15_001 }))).toMatchObject({ ok: false, reason: "信号已过期" });
  });

  it.each([
    ["NaN权益", { equity: Number.NaN }],
    ["NaN持仓数量", { positions: [{ ...portfolioInput().positions[0], qty: Number.NaN }] }],
    ["负持仓数量", { positions: [{ ...portfolioInput().positions[0], qty: -1 }] }],
    ["NaN持仓价格", { positions: [{ ...portfolioInput().positions[0], markPrice: Number.NaN }] }],
    ["NaN组合风险设置", { portfolioStopRiskPct: Number.NaN }],
  ])("%s 必须失败关闭", (_name, overrides) => {
    const result = portfolioRisk({ ...portfolioInput(), ...overrides });

    expect(result.approved).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("组合当前止损风险与候选风险合计不得超过权益 1%", () => {
    const accepted = portfolioRisk(portfolioInput(40, { AAA: 0 }));
    const rejected = portfolioRisk(portfolioInput(95, { AAA: 0 }));

    expect(accepted.positions[0].risk).toBeCloseTo(5.0665, 10);
    expect(accepted.approved).toBe(true);
    expect(accepted.totalRisk).toBeCloseTo(45.0665, 10);
    expect(rejected.approved).toBe(false);
    expect(rejected.reasons).toContain("组合止损风险超过1%上限");
  });

  it("同方向且相关性绝对值达 0.8 的风险合计不得超过权益 0.5%", () => {
    const accepted = portfolioRisk(portfolioInput(40));
    const rejected = portfolioRisk(portfolioInput(46));
    const opposite: Parameters<typeof portfolioRisk>[0] = portfolioInput(60, { AAA: -1 });
    opposite.candidate!.side = "SHORT";

    expect(accepted.approved).toBe(true);
    expect(accepted.correlatedRisk).toBeCloseTo(45.0665, 10);
    expect(rejected.approved).toBe(false);
    expect(rejected.reasons).toContain("高相关同方向风险超过0.5%上限");
    expect(portfolioRisk(opposite).approved).toBe(true);
  });

  it("已有持仓时相关样本不足暂停新增，首仓无需相关样本", () => {
    const insufficient = portfolioRisk(portfolioInput(10, { AAA: null }));
    const first = portfolioRisk({ ...portfolioInput(40, {}), positions: [] });

    expect(insufficient.approved).toBe(false);
    expect(insufficient.reasons).toContain("相关收益样本不足");
    expect(first.approved).toBe(true);
  });

  it("止损达到或越过保本后组合风险贡献为零", () => {
    const long = portfolioRisk({ ...portfolioInput(), candidate: undefined, positions: [{ ...portfolioInput().positions[0], stopPrice: 100 }] });
    const short = portfolioRisk({
      ...portfolioInput(),
      candidate: undefined,
      positions: [{ symbol: "SHORT", side: "SHORT" as const, qty: 2, entryPrice: 100, markPrice: 100, stopPrice: 99 }],
    });

    expect(long.totalRisk).toBe(0);
    expect(long.positions[0].risk).toBe(0);
    expect(short.totalRisk).toBe(0);
  });

  it("相关性需要 60 个收益样本并只使用最近窗口", () => {
    const ascending = [1];
    const descending = [1];
    for (let index = 0; index < 60; index += 1) {
      const returned = (index % 5 + 1) / 1000;
      ascending.push(ascending.at(-1)! * (1 + returned));
      descending.push(descending.at(-1)! * (1 - returned));
    }

    expect(correlation(ascending.slice(1), descending.slice(1))).toBeNull();
    expect(correlation(ascending, descending)).toBeCloseTo(-1, 10);
    expect(correlation([999, ...ascending], [-999, ...descending])).toBeCloseTo(-1, 10);
    expect(correlation(ascending, descending, 20)).toBeCloseTo(-1, 10);
  });

  it("实时相关性按 closeTime 对齐完整 60 收益窗口，缺口和未收盘样本失败关闭", () => {
    const alignedCorrelation = (risk as unknown as {
      alignedCorrelation?: (a: Candle[], b: Candle[], now: number, window?: number) => number | null;
    }).alignedCorrelation;
    expect(alignedCorrelation).toBeTypeOf("function");
    if (!alignedCorrelation) return;
    const make = (direction: 1 | -1): Candle[] => {
      let close = 100;
      return Array.from({ length: 61 }, (_, index) => {
        if (index > 0) close *= 1 + direction * (index % 5 + 1) / 1000;
        const time = NOW - (61 - index) * 900_000;
        return { time: time / 1000, closeTime: time + 899_999, open: close, high: close, low: close, close, volume: 1 };
      });
    };
    const a = make(1);
    const b = make(-1);

    expect(alignedCorrelation(a, b, NOW)).toBeCloseTo(-1, 10);
    expect(alignedCorrelation(a.slice(1), b.slice(1), NOW)).toBeNull();
    expect(alignedCorrelation(a, b.filter((_, index) => index !== 30), NOW)).toBeNull();
    expect(alignedCorrelation(a, b.map((bar, index) => index === 60 ? { ...bar, closeTime: NOW + 1 } : bar), NOW)).toBeNull();
  });

  it("HIGH 或 EXTREME 不强制平仓，价格触发止损仍正常退出", () => {
    const position = {
      side: "LONG" as const,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 111,
      liquidationPrice: 80,
      price: 101,
      initialRisk: 5,
      maxFavorableR: 0.2,
      dailyLossLocked: false,
      timedOut: false,
    };

    expect(managePositionPrice({ ...position, mode: "HIGH" })).toMatchObject({ action: "HOLD" });
    expect(managePositionPrice({ ...position, mode: "EXTREME" })).toMatchObject({ action: "HOLD" });
    expect(managePositionPrice({ ...position, mode: "EXTREME", price: 95 })).toMatchObject({ action: "CLOSE", reason: "结构止损" });
  });
});
