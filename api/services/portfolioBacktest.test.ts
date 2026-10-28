import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Candle, type Market, type Opportunity, type Side, type TradingSettings } from "@contracts/trading";
import type { AnalyzeClosedCandlesInput } from "./strategy";
import {
  runPortfolioBacktest,
  type PortfolioSymbolData,
} from "./portfolioBacktest";

const START = Date.UTC(2026, 0, 1);
const INTERVAL = 300_000;

function candle(index: number, open: number, high: number, low: number, close: number, interval = INTERVAL): Candle {
  const time = START + index * interval;
  return { time: time / 1000, closeTime: time + interval - 1, open, high, low, close, volume: 1_000_000 };
}

function candles(rows: [number, number, number, number][], interval = INTERVAL) {
  return rows.map((row, index) => candle(index, ...row, interval));
}

function trendingCandles(closes: number[]) {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    return candle(index, open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close, 900_000);
  });
}

function settings(overrides: Partial<TradingSettings> = {}): TradingSettings {
  return {
    ...DEFAULT_SETTINGS,
    riskPerTradePct: 1,
    marginPerTradePct: 10,
    totalMarginCapPct: 100,
    leverageMode: "FIXED",
    fixedLeverage: 10,
    takerFeeBps: 0,
    slippageBps: 0,
    minQuoteVolume: 0,
    atrBaselineMinSamples: 3,
    spreadBaselineMinSamples: 2,
    correlationWindow: 4,
    ...overrides,
  };
}

function normalVolatility(closeTime: number): PortfolioSymbolData["volatility"][number] {
  return {
    time: closeTime,
    quality: { valid: true, reasons: [], bookAgeMs: 0, markAgeMs: 0, candleAgeMs: 0 },
    currentAtr: 1,
    atrBaseline: [0.5, 1, 1.5],
    currentTickReturn: 0,
    tickReturnBaseline: [-0.001, 0.001],
    currentSpreadBps: 1,
    spreadBaselineBps: [1, 1],
  };
}

function market(symbol: string, maxLeverage: number): Market {
  return {
    symbol,
    baseAsset: symbol.replace("USDT", ""),
    price: 100,
    markPrice: 100,
    change24h: 0,
    quoteVolume: 100_000_000,
    spreadBps: 1,
    fundingRate: 0,
    high24h: 110,
    low24h: 90,
    maxLeverage,
    liquidityScore: 100,
    eligible: true,
    filterReason: "测试",
  };
}

function data(
  symbol: string,
  primary: Candle[],
  timeframe: "5m" | "15m" = "5m",
  options: Partial<PortfolioSymbolData> = {},
): PortfolioSymbolData {
  return {
    symbol,
    market: market(symbol, 10),
    meta: { symbol, tickSize: 0.01, stepSize: 0, minQty: 0, minNotional: 0 },
    candles: {
      "4h": [],
      "1h": [],
      "15m": timeframe === "15m" ? primary : [],
      "5m": primary,
    },
    volatility: primary.map((bar) => normalVolatility(bar.closeTime)),
    funding: [],
    ...options,
  };
}

type Signal = { side: Side; stop?: number; atr15?: number };

function analyzeWith(signals: Record<string, Record<number, Signal>>) {
  return (input: AnalyzeClosedCandlesInput): Opportunity => {
    const signal = signals[input.market.symbol]?.[input.now];
    const side = signal?.side ?? "LONG";
    const entry = input.market.markPrice;
    return {
      id: `${input.market.symbol}-${side}`,
      symbol: input.market.symbol,
      side,
      status: signal ? "READY" : "BLOCKED",
      score: signal ? 100 : 0,
      regime: "测试",
      entry,
      stop: signal?.stop ?? entry - (side === "LONG" ? 5 : -5),
      target: 0,
      stopDistancePct: 5,
      rewardRisk: 2.2,
      leverage: 10,
      marginPct: 10,
      riskPct: 1,
      reasons: [],
      signalCloseTime: input.now,
      stateVersion: input.stateVersion,
      sourceGeneration: input.sourceGeneration ?? 0,
      atr15: signal?.atr15 ?? 1,
      createdAt: new Date(input.now).toISOString(),
    };
  };
}

async function run(input: {
  data: Record<string, PortfolioSymbolData>;
  timeframe?: "5m" | "15m";
  bars?: number;
  signals?: Record<string, Record<number, Signal>>;
  settings?: TradingSettings;
  initialEquity?: number;
}) {
  return runPortfolioBacktest(Object.keys(input.data), input.timeframe ?? "5m", input.bars ?? 300, {
    data: input.data,
    settings: input.settings ?? settings(),
    initialEquity: input.initialEquity ?? 1000,
    analyze: analyzeWith(input.signals ?? {}),
    persist: false,
    now: () => START + 10_000_000,
  });
}

describe("多标的同步组合回测事件语义", () => {
  it("信号在下一根开盘成交并保留旧回测字段与逐币交易", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 103, 99, 102], [102, 103, 101, 102]]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.tradesBySymbol.BTCUSDT).toHaveLength(1);
    expect(result.tradesBySymbol.BTCUSDT[0]).toMatchObject({ entryPrice: 100, exitPrice: 102, exitReason: "回测结束退出" });
    expect(result.tradesBySymbol.BTCUSDT[0].openedAt).toBe(new Date(bars[1].time * 1000).toISOString());
    expect(result).toMatchObject({ symbol: "PORTFOLIO", symbols: ["BTCUSDT"], initialEquity: 1000, finalEquity: 1004, totalTrades: 1 });
    expect(result.transitions).toHaveLength(0);
    expect(result.equityCurve.every((point) => point.time >= START / 1000 && point.time < START / 1000 + 3600)).toBe(true);
  });

  it("同一根同时触及止损和目标时止损保守优先", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 113, 94, 106], [106, 107, 105, 106]]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ exitPrice: 95, exitReason: "结构止损" });
  });

  it("收盘确认的移动止损只从下一根开始生效", async () => {
    const bars = candles([
      [100, 101, 99, 100],
      [100, 107, 99, 106],
      [106, 107, 99, 105],
      [105, 106, 104, 105],
    ]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ exitPrice: 100, exitReason: "保本／移动止损" });
    expect(result.trades[0].closedAt).toBe(new Date(bars[2].time * 1000).toISOString());
  });

  it("盘中达到 1R 但收盘回落时仍在收盘确认并在下一根生效", async () => {
    const bars = candles([
      [100, 101, 99, 100],
      [100, 106, 99, 100.5],
      [100.5, 101, 99, 100],
      [100, 101, 99, 100],
    ]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ exitPrice: 100, exitReason: "保本／移动止损" });
    expect(result.trades[0].closedAt).toBe(new Date(bars[2].time * 1000).toISOString());
  });

  it("跳空穿越强平与止损时按可实现的更差开盘价强平", async () => {
    const bars = candles([
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [89, 90, 88, 89],
      [89, 90, 88, 89],
    ]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG", stop: 91 } } },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ exitPrice: 89, exitReason: "强平保护模拟" });
  });

  it("期末退出与入场都计不利滑点", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 102, 99, 101], [110, 111, 109, 110]]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      settings: settings({ slippageBps: 100, riskPerTradePct: 100, portfolioStopRiskPct: 100 }),
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG", stop: 93 } } },
    });

    const trade = result.trades[0];
    expect(trade.entryPrice).toBeCloseTo(101, 10);
    expect(trade.exitPrice).toBeCloseTo(108.9, 10);
    expect(trade.pnl).toBeCloseTo(trade.qty * 7.9, 10);
    expect(result.finalEquity).toBeCloseTo(1000 + trade.pnl, 10);
  });

  it("最大回撤纳入未平仓盘中不利低价", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 101, 90, 100], [100, 101, 99, 100]]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      settings: settings({ riskPerTradePct: 100, marginPerTradePct: 20, fixedLeverage: 1, portfolioStopRiskPct: 100 }),
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG", stop: 80 } } },
    });

    expect(result.trades[0].qty).toBeCloseTo(2, 10);
    expect(result.maxDrawdown).toBeCloseTo(2, 10);
  });

  it("历史资金费按持仓方向和事件时标记价结算", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    const symbol = data("BTCUSDT", bars, "5m", {
      funding: [{ symbol: "BTCUSDT", fundingTime: bars[2].time * 1000, fundingRate: 0.01 }],
    });
    const result = await run({
      data: { BTCUSDT: symbol },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]).toMatchObject({ symbol: "BTCUSDT", rate: 0.01, notional: 200, amount: -2 });
    expect(result.totalFunding).toBe(-2);
    expect(result.trades[0].pnl).toBe(-2);
    expect(result.finalEquity).toBe(998);
  });

  it("在资金费结算时刻刚开仓的持仓不追溯收取资金费", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    const symbol = data("BTCUSDT", bars, "5m", {
      funding: [{ symbol: "BTCUSDT", fundingTime: bars[1].time * 1000, fundingRate: 0.01 }],
    });
    const result = await run({
      data: { BTCUSDT: symbol },
      settings: settings({ takerFeeBps: 0, slippageBps: 0 }),
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.funding).toHaveLength(0);
    expect(result.totalFunding).toBe(0);
    expect(result.trades[0].pnl).toBeCloseTo(0, 8);
    expect(result.finalEquity).toBeCloseTo(1000, 8);
  });

  it("任一标的主时间轴缺口都失败关闭而不补未来数据", async () => {
    const btc = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    const eth = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    eth.splice(1, 1);

    await expect(run({ data: { BTCUSDT: data("BTCUSDT", btc), ETHUSDT: data("ETHUSDT", eth) } }))
      .rejects.toThrow(/ETHUSDT.*缺口/);
  });

  it("多标的共享权益且组合止损风险不得超过 1%", async () => {
    const closes = [100, 101, 100, 101, 100, 101, 100];
    const btc = trendingCandles(closes);
    const eth = trendingCandles([100, 101, 100, 99, 100, 101, 100]);
    const signalTime = btc[5].closeTime;
    const result = await run({
      timeframe: "15m",
      data: { BTCUSDT: data("BTCUSDT", btc, "15m"), ETHUSDT: data("ETHUSDT", eth, "15m") },
      signals: { BTCUSDT: { [signalTime]: { side: "LONG" } }, ETHUSDT: { [signalTime]: { side: "LONG" } } },
    });

    expect(result.tradesBySymbol.BTCUSDT).toHaveLength(1);
    expect(result.tradesBySymbol.ETHUSDT ?? []).toHaveLength(0);
    expect(result.riskRejections.some((item) => item.symbol === "ETHUSDT" && item.reason.includes("组合止损风险超过1%上限"))).toBe(true);
    expect(result.initialEquity).toBe(1000);
    expect(result.finalEquity).toBeLessThan(1000);
  });

  it("同方向高相关敞口共享 0.5% 上限", async () => {
    const btc = trendingCandles([100, 101, 100, 101, 100, 101, 100]);
    const eth = trendingCandles([100, 101, 100, 101, 100, 101, 100]);
    const signalTime = btc[5].closeTime;
    const result = await run({
      timeframe: "15m",
      data: { BTCUSDT: data("BTCUSDT", btc, "15m"), ETHUSDT: data("ETHUSDT", eth, "15m") },
      settings: settings({ portfolioStopRiskPct: 100 }),
      signals: { BTCUSDT: { [signalTime]: { side: "LONG" } }, ETHUSDT: { [signalTime]: { side: "LONG" } } },
    });

    expect(result.tradesBySymbol.BTCUSDT).toHaveLength(1);
    expect(result.tradesBySymbol.ETHUSDT ?? []).toHaveLength(0);
    expect(result.riskRejections.some((item) => item.symbol === "ETHUSDT" && item.reason.includes("高相关同方向风险超过0.5%上限"))).toBe(true);
  });

  it("共享日损触发后退出已有持仓并拒绝后续开仓", async () => {
    const bars = candles([
      [100, 101, 99, 100],
      [100, 101, 96, 97],
      [97, 98, 96, 97],
      [97, 98, 96, 97],
      [97, 98, 96, 97],
    ]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars), ETHUSDT: data("ETHUSDT", bars) },
      settings: settings({ riskPerTradePct: 5, portfolioStopRiskPct: 100, correlatedDirectionRiskPct: 100 }),
      signals: {
        BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } },
        ETHUSDT: { [bars[2].closeTime]: { side: "LONG" } },
      },
    });

    expect(result.dailyLossLocks).toHaveLength(1);
    expect(result.tradesBySymbol.BTCUSDT[0].exitReason).toBe("日损熔断退出");
    expect(result.tradesBySymbol.ETHUSDT ?? []).toHaveLength(0);
    expect(result.riskRejections.some((item) => item.symbol === "ETHUSDT" && item.reason.includes("当日亏损熔断"))).toBe(true);
  });

  it("EXTREME 立即禁止下一根新开仓并返回状态迁移", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    const symbol = data("BTCUSDT", bars);
    symbol.volatility[0] = { ...symbol.volatility[0], currentAtr: 100 };
    const result = await run({
      data: { BTCUSDT: symbol },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.trades).toHaveLength(0);
    expect(result.riskRejections.some((item) => item.reason.includes("EXTREME禁止新增风险"))).toBe(true);
    expect(result.transitions).toContainEqual(expect.objectContaining({ symbol: "BTCUSDT", from: "NORMAL", to: "EXTREME", version: 1 }));
  });

  it("多标的盘中不利价格共同计入组合回撤", async () => {
    const btc = trendingCandles([100, 101, 100, 101, 100, 101, 100]);
    const eth = trendingCandles([100, 101, 100, 101, 100, 101, 100]);
    for (const series of [btc, eth]) {
      series[6] = { ...series[6], high: 101, low: 90, close: 100 };
    }
    const signalTime = btc[5].closeTime;
    const result = await run({
      timeframe: "15m",
      data: { BTCUSDT: data("BTCUSDT", btc, "15m"), ETHUSDT: data("ETHUSDT", eth, "15m") },
      settings: settings({ riskPerTradePct: 100, portfolioStopRiskPct: 100, correlatedDirectionRiskPct: 100, marginPerTradePct: 20, fixedLeverage: 1 }),
      signals: {
        BTCUSDT: { [signalTime]: { side: "LONG", stop: 80 } },
        ETHUSDT: { [signalTime]: { side: "LONG", stop: 80 } },
      },
    });

    expect(result.trades).toHaveLength(2);
    expect(result.maxDrawdown).toBeCloseTo(4.356435643564, 10);
  });

  it("资金费时间戳的开盘毫秒抖动归一到该根K线结算", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    const symbol = data("BTCUSDT", bars, "5m", {
      funding: [{ symbol: "BTCUSDT", fundingTime: bars[1].time * 1000 + 2, fundingRate: 0.01 }],
    });
    const result = await run({
      data: { BTCUSDT: symbol },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]).toMatchObject({ time: bars[1].time * 1000, rate: 0.01, amount: -2 });
    expect(result.finalEquity).toBe(998);
  });

  it("无法对齐到K线开盘的历史资金费事件失败关闭", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    const symbol = data("BTCUSDT", bars, "5m", {
      funding: [{ symbol: "BTCUSDT", fundingTime: bars[1].time * 1000 + 60_000, fundingRate: 0.01 }],
    });

    await expect(run({ data: { BTCUSDT: symbol } })).rejects.toThrow(/资金费.*对齐/);
  });
});

describe("Task 6 评审回归：现金费用、SHORT 与跨日日损", () => {
  it("开仓和平仓手续费都进入交易与组合现金账本", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 103, 99, 102], [102, 103, 101, 102]]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      settings: settings({ riskPerTradePct: 100, portfolioStopRiskPct: 100, marginPerTradePct: 20, fixedLeverage: 1, takerFeeBps: 10 }),
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } } },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].qty).toBeCloseTo(2, 10);
    expect(result.trades[0].fees).toBeCloseTo(0.404, 10);
    expect(result.trades[0].pnl).toBeCloseTo(3.596, 10);
    expect(result.totalFees).toBeCloseTo(0.404, 10);
    expect(result.finalEquity).toBeCloseTo(1003.596, 10);
  });

  it("23:55 触发的日损锁在 00:00 先强制退出再允许新日开仓", async () => {
    const bars = candles([
      [100, 101, 99, 100],
      [100, 101, 96, 97],
      [97, 98, 96, 97],
      [97, 98, 96, 97],
    ]).map((bar) => ({ ...bar, time: bar.time + 85_800, closeTime: bar.closeTime + 85_800_000 }));
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars), ETHUSDT: data("ETHUSDT", bars) },
      settings: settings({ riskPerTradePct: 5, portfolioStopRiskPct: 100, correlatedDirectionRiskPct: 100 }),
      signals: {
        BTCUSDT: { [bars[0].closeTime]: { side: "LONG" } },
        ETHUSDT: { [bars[1].closeTime]: { side: "LONG" } },
      },
    });

    expect(result.tradesBySymbol.BTCUSDT).toHaveLength(1);
    expect(result.tradesBySymbol.BTCUSDT[0]).toMatchObject({ exitPrice: 97, exitReason: "日损熔断退出" });
    expect(result.tradesBySymbol.BTCUSDT[0].closedAt).toBe(new Date(bars[2].time * 1000).toISOString());
    expect(result.tradesBySymbol.ETHUSDT).toHaveLength(1);
    expect(result.tradesBySymbol.ETHUSDT[0].openedAt).toBe(new Date(bars[2].time * 1000).toISOString());
  });

  it("SHORT 在负资金费率下支付资金费并计入现金", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100]]);
    const symbol = data("BTCUSDT", bars, "5m", {
      funding: [{ symbol: "BTCUSDT", fundingTime: bars[1].time * 1000, fundingRate: -0.01 }],
    });
    const result = await run({
      data: { BTCUSDT: symbol },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "SHORT" } } },
    });

    expect(result.funding[0]).toMatchObject({ rate: -0.01, notional: 200, amount: -2 });
    expect(result.totalFunding).toBe(-2);
    expect(result.trades[0]).toMatchObject({ side: "SHORT", pnl: -2 });
    expect(result.finalEquity).toBe(998);
  });

  it("SHORT 向上跳空穿越强平与止损时按更差开盘价强平", async () => {
    const bars = candles([
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [111, 112, 110, 111],
      [111, 112, 110, 111],
    ]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "SHORT" } } },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ side: "SHORT", exitPrice: 111, exitReason: "强平保护模拟" });
  });

  it("SHORT 向上跳空穿越止损但未强平时按开盘价止损", async () => {
    const bars = candles([
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [106, 107, 105, 106],
      [106, 107, 105, 106],
    ]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "SHORT" } } },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ side: "SHORT", exitPrice: 106, exitReason: "结构止损" });
  });

  it("SHORT 同根触及止损和目标时仍先按止损保守结算", async () => {
    const bars = candles([[100, 101, 99, 100], [100, 106, 88, 100], [100, 101, 99, 100]]);
    const result = await run({
      data: { BTCUSDT: data("BTCUSDT", bars) },
      signals: { BTCUSDT: { [bars[0].closeTime]: { side: "SHORT" } } },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ side: "SHORT", exitPrice: 105, exitReason: "结构止损" });
  });
});
