import type { Market, Opportunity, TradingSettings } from "@contracts/trading";
import { binance } from "./binance";
import { analyzeClosedCandles } from "./strategy";

export async function analyzeMarket(
  market: Market,
  settings: TradingSettings,
  context: { now?: number; stateVersion?: number; sourceGeneration?: number } = {},
): Promise<Opportunity> {
  const [candles4h, candles1h, candles15m, candles5m] = await Promise.all([
    binance.getCandles(market.symbol, "4h", 220),
    binance.getCandles(market.symbol, "1h", 220),
    binance.getCandles(market.symbol, "15m", 220),
    binance.getCandles(market.symbol, "5m", 220),
  ]);
  return analyzeClosedCandles({
    market,
    settings,
    candles4h,
    candles1h,
    candles15m,
    candles5m,
    now: context.now ?? Date.now(),
    stateVersion: context.stateVersion ?? 0,
    sourceGeneration: context.sourceGeneration ?? 0,
  });
}
