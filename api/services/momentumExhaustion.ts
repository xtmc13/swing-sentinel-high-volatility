import type { Candle, Side } from "@contracts/trading";
import { atrSeries, closedCandles, macdSeries } from "./indicators";

export type MomentumTimeframe = "15m" | "1h" | "4h";
export type MomentumProtection = "NONE" | "WARN" | "TIGHTEN" | "REDUCE_CANDIDATE" | "EXIT_CANDIDATE";

export interface TimeframeExhaustion {
  timeframe: MomentumTimeframe;
  bearishScore: number;
  bullishScore: number;
  sampleCount: number;
  ready: boolean;
  reasons: string[];
}

export interface MomentumExhaustionSnapshot {
  side: Side;
  score: number;
  resonanceCount: number;
  resonant: boolean;
  protection: MomentumProtection;
  structureBreak: boolean;
  timeframes: TimeframeExhaustion[];
  reasons: string[];
}

const WEIGHTS: Record<MomentumTimeframe, number> = { "15m": 0.5, "1h": 0.3, "4h": 0.2 };
const MIN_BARS = 35;

function rsiSeries(values: number[], period = 14) {
  if (values.length < 2) return [];
  const gains = values.map((value, index) => index ? Math.max(0, value - values[index - 1]) : 0);
  const losses = values.map((value, index) => index ? Math.max(0, values[index - 1] - value) : 0);
  let avgGain = gains.slice(1, period + 1).reduce((sum, value) => sum + value, 0) / period;
  let avgLoss = losses.slice(1, period + 1).reduce((sum, value) => sum + value, 0) / period;
  const result = Array(period).fill(Number.NaN);
  for (let index = period; index < values.length; index += 1) {
    if (index > period) {
      avgGain = (avgGain * (period - 1) + gains[index]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[index]) / period;
    }
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function pivotIndices(values: number[], kind: "high" | "low", left = 2, right = 2) {
  const pivots: number[] = [];
  for (let index = Math.max(left, values.length - 45); index < values.length - right; index += 1) {
    let pivot = true;
    for (let offset = 1; offset <= left; offset += 1) {
      if (kind === "high" ? values[index] <= values[index - offset] : values[index] >= values[index - offset]) pivot = false;
    }
    for (let offset = 1; offset <= right; offset += 1) {
      if (kind === "high" ? values[index] < values[index + offset] : values[index] > values[index + offset]) pivot = false;
    }
    if (pivot) pivots.push(index);
  }
  return pivots;
}

function adxSeries(bars: Candle[], period = 14) {
  const dx = Array(bars.length).fill(Number.NaN);
  const adx = Array(bars.length).fill(Number.NaN);
  for (let index = period; index < bars.length; index += 1) {
    let trueRange = 0;
    let plus = 0;
    let minus = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      const current = bars[cursor];
      const previous = bars[cursor - 1];
      const up = current.high - previous.high;
      const down = previous.low - current.low;
      trueRange += Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
      plus += up > down && up > 0 ? up : 0;
      minus += down > up && down > 0 ? down : 0;
    }
    const plusDi = trueRange > 0 ? plus / trueRange * 100 : 0;
    const minusDi = trueRange > 0 ? minus / trueRange * 100 : 0;
    dx[index] = plusDi + minusDi > 0 ? Math.abs(plusDi - minusDi) / (plusDi + minusDi) * 100 : 0;
    if (index >= period * 2 - 1) {
      if (index === period * 2 - 1) {
        adx[index] = dx.slice(period, index + 1).reduce((sum, value) => sum + value, 0) / period;
      } else {
        adx[index] = (adx[index - 1] * (period - 1) + dx[index]) / period;
      }
    }
  }
  return adx;
}

function timeframeScore(candles: Candle[], timeframe: MomentumTimeframe): TimeframeExhaustion {
  const bars = candles;
  if (bars.length < MIN_BARS) {
    return { timeframe, bearishScore: 0, bullishScore: 0, sampleCount: bars.length, ready: false, reasons: ["已收盘K线不足"] };
  }
  const closes = bars.map((bar) => bar.close);
  const rsi = rsiSeries(closes);
  const macd = macdSeries(bars).histogram;
  const atr = atrSeries(bars, 14);\n  const adx = adxSeries(bars, 14);
  const last = bars.length - 1;
  const safe = (value: number) => Number.isFinite(value);
  if (![rsi[last], macd[last], atr[last]].every(safe) || !(atr[last] > 0)) {
    return { timeframe, bearishScore: 0, bullishScore: 0, sampleCount: bars.length, ready: false, reasons: ["指标样本无效"] };
  }

  let bearish = 0;
  let bullish = 0;
  const reasons: string[] = [];
  const highs = pivotIndices(bars.map((bar) => bar.high), "high");
  const lows = pivotIndices(bars.map((bar) => bar.low), "low");
  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);
  if (lastTwoHighs.length === 2) {
    const [a, b] = lastTwoHighs;
    if (bars[b].high > bars[a].high && rsi[b] < rsi[a] - 2) {
      bearish += 25;
      reasons.push("价格创新高但RSI未确认");
    }
  }
  if (lastTwoLows.length === 2) {
    const [a, b] = lastTwoLows;
    if (bars[b].low < bars[a].low && rsi[b] > rsi[a] + 2) {
      bullish += 25;
      reasons.push("价格创新低但RSI未确认");
    }
  }

  const recentHistogram = macd.slice(-4);
  if (recentHistogram.every(safe)) {
    if (recentHistogram.at(-1)! > 0 && recentHistogram.at(-1)! < recentHistogram.at(-2)! && recentHistogram.at(-2)! < recentHistogram.at(-3)!) {
      bearish += 20;
      reasons.push("多头MACD柱连续收缩");
    }
    if (recentHistogram.at(-1)! < 0 && recentHistogram.at(-1)! > recentHistogram.at(-2)! && recentHistogram.at(-2)! > recentHistogram.at(-3)!) {
      bullish += 20;
      reasons.push("空头MACD柱连续收缩");
    }
  }

  const roc = (period: number) => closes[last] / closes[last - period] - 1;
  const recentRoc = roc(5);
  const previousRoc = closes[last - 5] / closes[last - 10] - 1;
  if (recentRoc > 0 && previousRoc > 0 && recentRoc < previousRoc * 0.65) {
    bearish += 15;
    reasons.push("上涨速度明显衰减");
  }
  if (recentRoc < 0 && previousRoc < 0 && Math.abs(recentRoc) < Math.abs(previousRoc) * 0.65) {
    bullish += 15;
    reasons.push("下跌速度明显衰减");
  }

  const efficiency = (start: number, end: number) => {
    const path = closes.slice(start + 1, end + 1).reduce((sum, value, index, values) =>
      sum + Math.abs(value - (index ? values[index - 1] : closes[start])), 0);
    return path > 0 ? Math.abs(closes[end] - closes[start]) / path : 0;
  };
  const recentEfficiency = efficiency(last - 5, last);
  const priorEfficiency = efficiency(last - 15, last - 6);
  if (recentRoc > 0 && recentEfficiency < priorEfficiency * 0.6) {
    bearish += 15;
    reasons.push("上涨推进效率下降");
  }
  if (recentRoc < 0 && recentEfficiency < priorEfficiency * 0.6) {
    bullish += 15;
    reasons.push("下跌推进效率下降");
  }

  const averageVolume = bars.slice(-21, -1).reduce((sum, bar) => sum + bar.volume, 0) / 20;
  const volumeRatio = averageVolume > 0 ? bars[last].volume / averageVolume : 0;\n  if (safe(adx[last]) && safe(adx[last - 5]) && adx[last - 5] >= 20 && adx[last] <= adx[last - 5] - 2) {\n    if (recentRoc > 0) { bearish += 15; reasons.push("ADX趋势强度回落"); }\n    if (recentRoc < 0) { bullish += 15; reasons.push("ADX趋势强度回落"); }\n  }
  const range = bars[last].high - bars[last].low;
  if (volumeRatio >= 1.8 && range >= atr[last] * 1.2) {
    if (bars[last].close < bars[last].open) {
      bearish += 10;
      reasons.push("放量冲高回落");
    } else if (bars[last].close > bars[last].open) {
      bullish += 10;
      reasons.push("放量探底回升");
    }
  }

  return {
    timeframe,
    bearishScore: Math.min(100, bearish),
    bullishScore: Math.min(100, bullish),
    sampleCount: bars.length,
    ready: true,
    reasons,
  };
}

export function evaluateMomentumExhaustion(input: {
  side: Side;
  candles15m: Candle[];
  candles1h: Candle[];
  candles4h: Candle[];
  now: number;
}): MomentumExhaustionSnapshot {
  const timeframes: TimeframeExhaustion[] = [
    timeframeScore(closedCandles(input.candles15m, input.now), "15m"),
    timeframeScore(closedCandles(input.candles1h, input.now), "1h"),
    timeframeScore(closedCandles(input.candles4h, input.now), "4h"),
  ];
  const ready = timeframes.every((item) => item.ready);
  const scoreFor = (item: TimeframeExhaustion) => input.side === "LONG" ? item.bearishScore : item.bullishScore;
  const score = ready
    ? Math.round(timeframes.reduce((sum, item) => sum + scoreFor(item) * WEIGHTS[item.timeframe], 0))
    : 0;
  const resonanceCount = timeframes.filter((item) => item.ready && scoreFor(item) >= 50).length;
  const resonant = ready && resonanceCount >= 2;
  const recent = closedCandles(input.candles15m, input.now);
  const recentClose = recent.at(-1)?.close;
  const prior = recent.slice(-6, -1);
  const structureBreak = recent.length >= 6 && (input.side === "LONG"
    ? recentClose! < Math.min(...prior.map((bar) => bar.low))
    : recentClose! > Math.max(...prior.map((bar) => bar.high)));
  let protection: MomentumProtection = "NONE";
  if (ready && score >= 30) protection = "WARN";
  if (ready && score >= 50 && resonant) protection = "TIGHTEN";
  if (ready && score >= 70 && resonant) protection = "REDUCE_CANDIDATE";
  if (ready && score >= 70 && resonant && structureBreak) protection = "EXIT_CANDIDATE";
  const reasons = ready
    ? [...new Set(timeframes.flatMap((item) => item.reasons))]
    : ["15m／1h／4h 数据未全部满足最小样本，暂不输出共振结论"];
  return { side: input.side, score, resonanceCount, resonant, protection, structureBreak, timeframes, reasons };
}
