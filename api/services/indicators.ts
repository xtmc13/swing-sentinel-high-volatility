import type { Candle } from "@contracts/trading";

export function closedCandles(candles: Candle[], now = Date.now()) {
  return candles.filter((candle) => candle.closeTime <= now);
}

export function emaSeries(values: number[], period: number) {
  if (!values.length) return [] as number[];
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i++) output.push(values[i] * alpha + output[i - 1] * (1 - alpha));
  return output;
}

export function atrSeries(candles: Candle[], period = 14) {
  if (!candles.length) return [] as number[];
  const ranges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previous = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
  });
  const output = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    output.push(i < period ? (output[i - 1] * i + ranges[i]) / (i + 1) : (output[i - 1] * (period - 1) + ranges[i]) / period);
  }
  return output;
}

export function macdSeries(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const dif = closes.map((_, index) => fast[index] - slow[index]);
  const dea = emaSeries(dif, 9);
  const histogram = dif.map((value, index) => (value - dea[index]) * 2);
  return { dif, dea, histogram };
}

export function roundToStep(value: number, step: number) {
  if (!(step > 0)) return value;
  return Math.floor(value / step + 1e-10) * step;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function maxDrawdown(values: number[]) {
  let peak = values[0] ?? 0;
  let max = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) max = Math.max(max, (peak - value) / peak * 100);
  }
  return max;
}
