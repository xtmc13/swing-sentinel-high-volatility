import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Opportunity, type TradingSettings, type VolatilityState } from "@contracts/trading";
import { applyAdverseSlippage, approveAndPriceEntry, type EntryApprovalInput } from "./execution";
import { assertAffectedRows } from "../queries/trading";
import { toPositionView, type PositionRow } from "./paper";
import type { MarketSnapshot } from "./binance";

const NOW = 1_800_000_000_000;

const settings: TradingSettings = {
  ...DEFAULT_SETTINGS,
  autoTrade: true,
  leverageMode: "FIXED",
  fixedLeverage: 20,
};

const opportunity: Opportunity = {
  id: "BTCUSDT-LONG",
  symbol: "BTCUSDT",
  side: "LONG",
  status: "READY",
  score: 90,
  regime: "多头共振",
  entry: 100,
  stop: 98,
  target: 104.4,
  stopDistancePct: 2,
  rewardRisk: 2.2,
  leverage: 20,
  marginPct: 2,
  riskPct: 0.35,
  reasons: [],
  signalCloseTime: NOW - 1000,
  stateVersion: 3,
  sourceGeneration: 0,
  atr15: 0.4,
  createdAt: new Date(NOW - 1000).toISOString(),
};

const state: VolatilityState = {
  symbol: "BTCUSDT",
  mode: "NORMAL",
  confirmationCount: 0,
  stableSince: null,
  metrics: { atrQuantile: 0.5, tickSigma: 1, spreadRatio: 1 },
  lastDataAt: NOW,
  version: 3,
};

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    source: "MAINNET",
    symbol: "BTCUSDT",
    bid: 100.04,
    ask: 100.06,
    mid: 100.05,
    markPrice: 100.05,
    spreadBps: 1.99900019990003,
    bookTime: NOW,
    markTime: NOW,
    observedAt: NOW,
    quality: { valid: true, reasons: [], bookAgeMs: 0, markAgeMs: 0, candleAgeMs: null },
    ...overrides,
  };
}

function input(overrides: Partial<EntryApprovalInput> = {}): EntryApprovalInput {
  return {
    opportunity,
    snapshot: snapshot(),
    state,
    settings,
    equity: 100_000,
    usedMargin: 0,
    todayPnlPct: 0,
    positions: [],
    correlations: {},
    symbolMeta: { symbol: "BTCUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
    maxLeverage: 20,
    now: NOW,
    ...overrides,
  };
}

describe("实时与回测共用不利滑点方向", () => {
  it("开平仓均让成交价向不利于持仓方向移动", () => {
    expect(applyAdverseSlippage(100, "LONG", 2, "OPEN")).toBeCloseTo(100.02, 10);
    expect(applyAdverseSlippage(100, "LONG", 2, "CLOSE")).toBeCloseTo(99.98, 10);
    expect(applyAdverseSlippage(100, "SHORT", 2, "OPEN")).toBeCloseTo(99.98, 10);
    expect(applyAdverseSlippage(100, "SHORT", 2, "CLOSE")).toBeCloseTo(100.02, 10);
  });
});

describe("统一开仓审批与当前盘口定价", () => {
  it("多头按当前 ask 加不利滑点成交并重算数量、2.2R 目标、费用、保证金和初始风险", () => {
    const result = approveAndPriceEntry(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fillPrice).toBeCloseTo(100.080012, 10);
    expect(result.qty).toBe(157.752);
    expect(result.initialRisk).toBeCloseTo(2.080012, 10);
    expect(result.targetPrice).toBeCloseTo(104.6560384, 10);
    expect(result.openFee).toBeCloseTo(7.893911026512, 10);
    expect(result.margin).toBeCloseTo(789.3911026512, 10);
    expect(result.estimatedRisk).toBeLessThanOrEqual(350);
  });

  it("空头按当前 bid 减不利滑点成交并重算目标", () => {
    const shortOpportunity: Opportunity = {
      ...opportunity,
      id: "BTCUSDT-SHORT",
      side: "SHORT",
      stop: 102,
      target: 95.6,
    };
    const result = approveAndPriceEntry(input({
      opportunity: shortOpportunity,
      snapshot: snapshot({ bid: 99.94, ask: 99.96, mid: 99.95, markPrice: 99.95 }),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fillPrice).toBeCloseTo(99.920012, 10);
    expect(result.initialRisk).toBeCloseTo(2.079988, 10);
    expect(result.targetPrice).toBeCloseTo(95.3440384, 10);
  });

  it.each([
    ["过期信号", input({ opportunity: { ...opportunity, signalCloseTime: NOW - 15_001 } })],
    ["旧状态版本", input({ opportunity: { ...opportunity, stateVersion: 2 } })],
    ["EXTREME", input({ state: { ...state, mode: "EXTREME" } })],
    ["陈旧盘口", input({ snapshot: snapshot({ quality: { valid: false, reasons: ["盘口陈旧"], bookAgeMs: 5001, markAgeMs: 0, candleAgeMs: null } }) })],
    ["锁等待后盘口超时", input({ snapshot: snapshot({ bookTime: NOW - 5001, quality: { valid: true, reasons: [], bookAgeMs: 0, markAgeMs: 0, candleAgeMs: null } }) })],
    ["点差超限", input({ snapshot: snapshot({ bid: 99.9, ask: 100.1, spreadBps: 20 }) })],
    ["信号偏离", input({ snapshot: snapshot({ bid: 100.19, ask: 100.21, mid: 100.2, spreadBps: 1.999 }) })],
  ])("%s 必须拒绝开仓", (_name, rejectedInput) => {
    expect(approveAndPriceEntry(rejectedInput).ok).toBe(false);
  });

  it("信号源代际与当前执行源代际不一致必须拒绝开仓", () => {
    const rejectedInput = {
      ...input({ opportunity: { ...opportunity, sourceGeneration: 1 } }),
      currentSourceGeneration: 0,
    } as EntryApprovalInput & { currentSourceGeneration: number };

    expect(approveAndPriceEntry(rejectedInput)).toMatchObject({ ok: false, reason: "信号数据源代际陈旧" });
  });

  it("新鲜 REST 盘口不能覆盖执行准入时的监测断流", () => {
    const result = approveAndPriceEntry(input({ executionHealthy: () => false }));
    expect(result).toEqual({ ok: false, reason: "行情监测断开，禁止开仓" });
  });
});

describe("数据库结果与不可变初始风险", () => {
  it("mysql2 元组中 affectedRows=0 必须抛错", () => {
    expect(() => assertAffectedRows([{ affectedRows: 0 }, []])).toThrow(/0 rows/);
    expect(() => assertAffectedRows([{ affectedRows: 1 }, []])).not.toThrow();
  });

  it("R 倍数使用保存的 initialRisk，不从可修改目标反推", () => {
    const row: PositionRow = {
      id: crypto.randomUUID(),
      symbol: "BTCUSDT",
      side: "LONG",
      status: "OPEN",
      initialQty: 1,
      qty: 1,
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 110,
      liquidationPrice: 90,
      leverage: 20,
      margin: 5,
      fees: 0.1,
      fundingPnl: 0,
      realizedPnl: 0,
      maxFavorableR: 0,
      initialRisk: 2,
      openedAt: new Date(NOW),
      updatedAt: new Date(NOW),
      closedAt: null,
    };

    expect(toPositionView(row)).toMatchObject({ valuationValid: false });
    expect(toPositionView(row).rMultiple).toBeNaN();
    expect(toPositionView(row).unrealizedPnl).toBeNaN();
    expect(toPositionView(row, {
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      price: 101,
      markPrice: 101,
      change24h: 0,
      quoteVolume: 1_000_000_000,
      spreadBps: 1,
      fundingRate: 0,
      high24h: 102,
      low24h: 99,
      maxLeverage: 20,
      liquidityScore: 100,
      eligible: true,
      filterReason: "",
    }).rMultiple).toBe(0.5);
  });
});
