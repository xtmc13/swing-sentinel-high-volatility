import { describe, expect, it } from "vitest";
import { calculateLivePositionRisk, type LiveRiskInput } from "./liveRisk";

function input(overrides: Partial<LiveRiskInput> = {}): LiveRiskInput {
  return {
    side: "LONG",
    walletBalance: "10000",
    availableBalance: "10000",
    entryPrice: "100",
    stopPrice: "99",
    liquidationPrice: "50",
    actualLeverage: "5",
    leverageMode: "FIXED",
    fixedLeverage: 5,
    riskPerTradePct: 1,
    mode: "NORMAL",
    highVolatilityRiskMultiplier: 0.5,
    marginPerTradePct: 10,
    totalMarginCapPct: 20,
    takerFeeBps: 0,
    slippageBps: 0,
    stepSize: "0.001",
    minQuantity: "0.001",
    minNotional: "5",
    brackets: [{
      bracket: 1,
      initialLeverage: 10,
      notionalCap: "50000",
      notionalFloor: "0",
      maintMarginRatio: "0.01",
      cum: "0",
    }],
    pendingIntents: [],
    existingPositionMargin: "0",
    existingExposure: "0",
    ...overrides,
  };
}

describe("主网精确风险与预留", () => {
  it("拒绝 SYMBOL_MAX 和未明确固定的低杠杆", () => {
    expect(calculateLivePositionRisk(input({ leverageMode: "SYMBOL_MAX" }))).toMatchObject({ ok: false });
    expect(calculateLivePositionRisk(input({ fixedLeverage: 21 }))).toMatchObject({ ok: false });
    expect(calculateLivePositionRisk(input({ actualLeverage: "10" }))).toMatchObject({ ok: false });
  });

  it("按实际命中的币安维持保证金档位计算而不是使用模拟固定费率", () => {
    const result = calculateLivePositionRisk(input({
      walletBalance: "100000",
      availableBalance: "100000",
      marginPerTradePct: 20,
      totalMarginCapPct: 30,
      brackets: [
        {
          bracket: 1,
          initialLeverage: 10,
          notionalCap: "50000",
          notionalFloor: "0",
          maintMarginRatio: "0.01",
          cum: "0",
        },
        {
          bracket: 2,
          initialLeverage: 5,
          notionalCap: "100000",
          notionalFloor: "50000",
          maintMarginRatio: "0.02",
          cum: "50",
        },
      ],
    }));

    expect(result).toMatchObject({
      ok: true,
      quantity: "1000",
      notional: "100000",
      initialMargin: "20000",
      maintenanceMargin: "1950",
      bracket: 2,
    });
  });

  it("从风险和保证金预算中扣除其他待成交意图的预留", () => {
    const result = calculateLivePositionRisk(input({
      pendingIntents: [{ margin: "800", risk: "60" }],
    }));

    expect(result).toMatchObject({
      ok: true,
      quantity: "40",
      reservedMargin: "800",
      reservedRisk: "60",
    });
  });

  it("数量按 step 精确向下取整并用十进制字符串计算名义价值和保证金", () => {
    const result = calculateLivePositionRisk(input({
      walletBalance: "100",
      availableBalance: "100",
      stopPrice: "99.19",
      marginPerTradePct: 50,
      totalMarginCapPct: 100,
    }));

    expect(result).toMatchObject({
      ok: true,
      quantity: "1.234",
      notional: "123.4",
      initialMargin: "24.68",
    });
  });

  it("费用率先转十进制再相加，不把 double 求和误差带入账本", () => {
    const result = calculateLivePositionRisk(input({
      takerFeeBps: 0.1,
      slippageBps: 0.2,
      marginPerTradePct: 50,
      totalMarginCapPct: 100,
    }));

    expect(result).toMatchObject({ ok: true, quantity: "99.406", estimatedRisk: "99.99945382" });
  });

  it("总保证金 cap 同时扣除签名实际持仓 margin 和待单预留", () => {
    const result = calculateLivePositionRisk(input({
      existingPositionMargin: "1300",
      pendingIntents: [{ margin: "800", risk: "0" }],
    }));

    expect(result).toMatchObject({ ok: false });
  });

  it("维持保证金档位按已有 exposure 加候选名义价值选择", () => {
    const result = calculateLivePositionRisk(input({
      walletBalance: "100000",
      availableBalance: "100000",
      marginPerTradePct: 8,
      totalMarginCapPct: 30,
      existingPositionMargin: "12000",
      existingExposure: "60000",
      brackets: [
        { bracket: 1, initialLeverage: 10, notionalCap: "50000", notionalFloor: "0", maintMarginRatio: "0.01", cum: "0" },
        { bracket: 2, initialLeverage: 5, notionalCap: "100000", notionalFloor: "50000", maintMarginRatio: "0.02", cum: "50" },
      ],
    }));

    expect(result).toMatchObject({
      ok: true,
      quantity: "400",
      notional: "40000",
      totalExposure: "100000",
      maintenanceMargin: "1950",
      bracket: 2,
    });
  });

  it("HIGH 使用配置的减半风险，NORMAL 保持不变且 EXTREME 拒绝", () => {
    const budget = { marginPerTradePct: 100, totalMarginCapPct: 100 };
    const normal = calculateLivePositionRisk(input(budget));
    const high = calculateLivePositionRisk(input({ ...budget, mode: "HIGH" }));

    expect(normal).toMatchObject({ ok: true, quantity: "100" });
    expect(high).toMatchObject({ ok: true, quantity: "50", estimatedRisk: "50" });
    expect(calculateLivePositionRisk(input({ ...budget, mode: "EXTREME" }))).toMatchObject({ ok: false });
  });

  it("止损没有位于真实强平价之前时失败关闭", () => {
    expect(calculateLivePositionRisk(input({ liquidationPrice: "99.5" }))).toMatchObject({ ok: false });
    expect(calculateLivePositionRisk(input({
      side: "SHORT",
      stopPrice: "101",
      liquidationPrice: "100.5",
    }))).toMatchObject({ ok: false });
  });
});
