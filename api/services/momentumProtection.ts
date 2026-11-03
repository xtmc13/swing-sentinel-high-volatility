import type { Candle, Side } from "@contracts/trading";
import { atrSeries, closedCandles } from "./indicators";

export function momentumProtectionStop(input: {
  side: Side;
  markPrice: number;
  candles15m: Candle[];
  now: number;
}): number | null {
  if (!Number.isFinite(input.markPrice) || input.markPrice <= 0 || !Number.isFinite(input.now)) return null;
  const bars = closedCandles(input.candles15m, input.now);
  const latest = bars.at(-1);
  if (!latest || input.now - latest.closeTime > 45 * 60_000) return null;
  const atr = atrSeries(bars, 14).at(-1);
  if (atr === undefined || !Number.isFinite(atr) || atr <= 0) return null;
  const recent = bars.slice(-5);
  if (recent.length < 5) return null;
  const volatilityStop = input.markPrice + (input.side === "LONG" ? -1 : 1) * atr;
  const structureStop = input.side === "LONG"
    ? Math.min(...recent.map((bar) => bar.low)) - atr * 0.1
    : Math.max(...recent.map((bar) => bar.high)) + atr * 0.1;
  const candidate = input.side === "LONG"
    ? Math.max(volatilityStop, structureStop)
    : Math.min(volatilityStop, structureStop);
  if (!Number.isFinite(candidate) || candidate <= 0
    || (input.side === "LONG" && candidate >= input.markPrice)
    || (input.side === "SHORT" && candidate <= input.markPrice)) return null;
  return candidate;
}
