import type { Candle, Market, Opportunity, Side, TradingSettings } from "@contracts/trading";
import { atrSeries, closedCandles, emaSeries, macdSeries } from "./indicators";

export interface AnalyzeClosedCandlesInput {
  market: Market;
  settings: TradingSettings;
  candles4h: Candle[];
  candles1h: Candle[];
  candles15m: Candle[];
  candles5m: Candle[];
  now: number;
  stateVersion: number;
  sourceGeneration?: number;
}

export function analyzeClosedCandles(input: AnalyzeClosedCandlesInput): Opportunity {
  const { market, settings, now } = input;
  const c4h = closedCandles(input.candles4h, now);
  const c1h = closedCandles(input.candles1h, now);
  const c15m = closedCandles(input.candles15m, now);
  const c5m = closedCandles(input.candles5m, now);
  const signalCloseTime = c5m.at(-1)?.closeTime ?? 0;
  const fallback: Side = market.change24h >= 0 ? "LONG" : "SHORT";
  if (c4h.length < 200 || c1h.length < 200 || c15m.length < 60 || c5m.length < 30) {
    return {
      id: `${market.symbol}-${fallback}`, symbol: market.symbol, side: fallback,
      status: "BLOCKED", score: 0, regime: "数据不足", entry: market.price,
      stop: 0, target: 0, stopDistancePct: 0, rewardRisk: 0,
      leverage: market.maxLeverage, marginPct: settings.marginPerTradePct,
      riskPct: settings.riskPerTradePct, reasons: ["已收盘K线不足，禁止前瞻判断"],
      signalCloseTime, stateVersion: input.stateVersion, sourceGeneration: input.sourceGeneration ?? 0, createdAt: new Date(now).toISOString(),
    };
  }

  const e4h50 = emaSeries(c4h.map((c) => c.close), 50).at(-1)!;
  const e4h200 = emaSeries(c4h.map((c) => c.close), 200).at(-1)!;
  const e1h50 = emaSeries(c1h.map((c) => c.close), 50).at(-1)!;
  const e1h200Series = emaSeries(c1h.map((c) => c.close), 200);
  const e1h200 = e1h200Series.at(-1)!;
  const price1h = c1h.at(-1)!.close;
  const long4h = c4h.at(-1)!.close > e4h50 && e4h50 > e4h200;
  const short4h = c4h.at(-1)!.close < e4h50 && e4h50 < e4h200;
  const long1h = price1h > e1h50 && e1h50 > e1h200;
  const short1h = price1h < e1h50 && e1h50 < e1h200;
  const alignedLong = long4h && long1h;
  const alignedShort = short4h && short1h;
  const side: Side = alignedLong || (!alignedShort && e1h50 >= e1h200) ? "LONG" : "SHORT";
  const direction = side === "LONG" ? 1 : -1;
  const aligned = alignedLong || alignedShort;

  const close15 = c15m.map((c) => c.close);
  const ema15_20 = emaSeries(close15, 20).at(-1)!;
  const ema15_50 = emaSeries(close15, 50).at(-1)!;
  const atr15 = atrSeries(c15m, 14).at(-1)!;
  const last15 = c15m.at(-1)!;
  const setup = side === "LONG"
    ? last15.close > ema15_50 && last15.low <= ema15_20 + atr15 * 0.45
    : last15.close < ema15_50 && last15.high >= ema15_20 - atr15 * 0.45;

  const macd5 = macdSeries(c5m);
  const last5 = c5m.at(-1)!;
  const previous5 = c5m.at(-2)!;
  const previousBars = c5m.slice(-5, -1);
  const histogram = macd5.histogram.at(-1)!;
  const previousHistogram = macd5.histogram.at(-2)!;
  const trigger = side === "LONG"
    ? last5.close > Math.max(...previousBars.map((c) => c.high)) && histogram > previousHistogram && histogram > 0
    : last5.close < Math.min(...previousBars.map((c) => c.low)) && histogram < previousHistogram && histogram < 0;

  const entry = market.markPrice > 0 ? market.markPrice : last5.close;
  const structureBars = c15m.slice(-12);
  const structuralStop = side === "LONG"
    ? Math.min(...structureBars.map((c) => c.low)) - atr15 * 0.1
    : Math.max(...structureBars.map((c) => c.high)) + atr15 * 0.1;
  let stop = side === "LONG"
    ? Math.max(structuralStop, entry - atr15 * 1.6)
    : Math.min(structuralStop, entry + atr15 * 1.6);
  if (side === "LONG" && stop >= entry) stop = entry - atr15 * 1.2;
  if (side === "SHORT" && stop <= entry) stop = entry + atr15 * 1.2;
  const stopDistance = Math.abs(entry - stop);
  const stopDistancePct = entry > 0 ? stopDistance / entry * 100 : 0;
  const target = entry + direction * stopDistance * 2.2;
  const volatilityPct = entry > 0 ? atr15 / entry * 100 : 0;
  const momentumAligned = side === "LONG" ? histogram > 0 : histogram < 0;
  const regime = volatilityPct > 3.5 ? "高波动" : aligned ? (side === "LONG" ? "多头共振" : "空头共振") : "周期冲突";
  const reasons = [
    aligned ? "4H／1H 方向共振" : "大周期未共振",
    setup ? "15M 回调结构有效" : "等待 15M 回调结构",
    trigger ? "5M 突破与动能确认" : "等待 5M 触发",
  ];
  let status: Opportunity["status"] = "READY";
  const pricesValid = [entry, stop, target, atr15, histogram, previousHistogram].every(Number.isFinite)
    && entry > 0 && stopDistance > 0 && atr15 > 0;
  const bracketValid = side === "LONG" ? stop < entry && target > entry : stop > entry && target < entry;
  if (!pricesValid || !bracketValid || !market.eligible || volatilityPct > 3.5 || stopDistancePct < 0.08 || stopDistancePct > 4) {
    status = "BLOCKED";
  } else if (!aligned || !setup || !trigger) {
    status = "WAIT";
  }
  const score = Math.round(
    (aligned ? 35 : 0) + (setup ? 20 : 0) + (trigger ? 20 : 0)
    + market.liquidityScore * 0.15 + (momentumAligned ? 10 : Math.max(0, 5 - Math.abs(previous5.close - last5.close))),
  );
  return {
    id: `${market.symbol}-${side}`, symbol: market.symbol, side, status, score,
    regime, entry, stop, target, stopDistancePct, rewardRisk: 2.2,
    leverage: settings.leverageMode === "FIXED" ? Math.min(settings.fixedLeverage, market.maxLeverage) : market.maxLeverage,
    marginPct: settings.marginPerTradePct, riskPct: settings.riskPerTradePct,
    reasons, signalCloseTime, stateVersion: input.stateVersion, sourceGeneration: input.sourceGeneration ?? 0, atr15, createdAt: new Date(now).toISOString(),
  };
}
