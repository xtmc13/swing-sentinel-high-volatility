import { getDb } from "../queries/connection";
import { backtestRuns } from "@db/schema";
import { getSettings } from "../queries/trading";
import { binance } from "./binance";
import { atrSeries, closedCandles, emaSeries, macdSeries, maxDrawdown, roundToStep } from "./indicators";
import type { BacktestResult, Candle, Side, TradeView } from "@contracts/trading";

function latestIndexBefore(candles: Candle[], timestampMs: number, start: number) {
  let index = Math.min(start, candles.length - 1);
  while (index > 0 && candles[index].closeTime > timestampMs) index--;
  while (index + 1 < candles.length && candles[index + 1].closeTime <= timestampMs) index++;
  return index;
}

export async function persistBacktestResult(result: BacktestResult) {
  await getDb().insert(backtestRuns).values({
    id: result.id,
    symbol: result.symbol,
    timeframe: result.timeframe,
    bars: result.bars,
    resultJson: JSON.stringify(result),
  });
}

export async function runHistoricalBacktest(symbol: string, timeframe: "5m" | "15m", bars: number): Promise<BacktestResult> {
  const settings = await getSettings();
  const [rawCandles, raw1h, raw4h, markets, meta] = await Promise.all([
    binance.getCandles(symbol, timeframe, bars),
    binance.getCandles(symbol, "1h", 300),
    binance.getCandles(symbol, "4h", 220),
    binance.getMarkets(settings),
    binance.getSymbolMeta(symbol),
  ]);
  const candles = closedCandles(rawCandles);
  const c1h = closedCandles(raw1h);
  const c4h = closedCandles(raw4h);
  if (candles.length < 120 || c1h.length < 200 || c4h.length < 200) throw new Error("有效历史K线不足，无法回测");
  const market = markets.find((item) => item.symbol === symbol);
  if (!market) throw new Error("当前合约不在可交易列表");
  const leverage = settings.leverageMode === "FIXED" ? Math.min(settings.fixedLeverage, market.maxLeverage) : market.maxLeverage;
  const closes = candles.map((c) => c.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const atr = atrSeries(candles, 14);
  const macd = macdSeries(candles);
  const ema1h50 = emaSeries(c1h.map((c) => c.close), 50);
  const ema1h200 = emaSeries(c1h.map((c) => c.close), 200);
  const ema4h50 = emaSeries(c4h.map((c) => c.close), 50);
  const ema4h200 = emaSeries(c4h.map((c) => c.close), 200);
  let equity = 100000;
  let openFee = 0;
  let totalFees = 0;
  let position: null | {
    side: Side; qty: number; entry: number; stop: number; target: number;
    margin: number; openedAt: number; barsHeld: number; initialRisk: number; moved: boolean;
  } = null;
  const trades: TradeView[] = [];
  const curve: { time: number; equity: number }[] = [];
  let i1h = 0;
  let i4h = 0;
  // A swing setup should be allowed to develop over days, not forced out after 3 hours.
  const timeoutBars = Math.max(1, Math.round((72 * 60) / (timeframe === "5m" ? 5 : 15)));

  const closePosition = (exit: number, timeMs: number, reason: string) => {
    if (!position) return;
    const direction = position.side === "LONG" ? 1 : -1;
    const closeFee = position.qty * exit * settings.takerFeeBps / 10000;
    const gross = (exit - position.entry) * position.qty * direction;
    equity += gross - closeFee;
    totalFees += closeFee;
    const pnl = gross - openFee - closeFee;
    trades.push({
      id: crypto.randomUUID(), symbol, side: position.side, qty: position.qty,
      entryPrice: position.entry, exitPrice: exit, pnl,
      returnPct: position.margin > 0 ? pnl / position.margin * 100 : 0,
      fees: openFee + closeFee, holdingMinutes: (timeMs - position.openedAt) / 60000,
      exitReason: reason, openedAt: new Date(position.openedAt).toISOString(), closedAt: new Date(timeMs).toISOString(),
    });
    position = null;
  };

  for (let i = 60; i < candles.length; i++) {
    const candle = candles[i];
    i1h = latestIndexBefore(c1h, candle.time * 1000, i1h);
    i4h = latestIndexBefore(c4h, candle.time * 1000, i4h);
    if (position) {
      position.barsHeld++;
      const direction = position.side === "LONG" ? 1 : -1;
      const rHigh = (candle.high - position.entry) * direction / position.initialRisk;
      if (!position.moved && rHigh >= 1) {
        position.stop = position.entry + direction * position.entry * (settings.takerFeeBps * 2 + settings.slippageBps) / 10000;
        position.moved = true;
      }
      const stopTouched = position.side === "LONG" ? candle.low <= position.stop : candle.high >= position.stop;
      const targetTouched = position.side === "LONG" ? candle.high >= position.target : candle.low <= position.target;
      if (stopTouched) {
        const gapExit = position.side === "LONG" ? Math.min(candle.open, position.stop) : Math.max(candle.open, position.stop);
        closePosition(gapExit * (1 - direction * settings.slippageBps / 10000), candle.time * 1000, position.moved ? "保本／移动止损" : "结构止损");
      } else if (targetTouched) {
        const gapExit = position.side === "LONG" ? Math.max(candle.open, position.target) : Math.min(candle.open, position.target);
        closePosition(gapExit * (1 - direction * settings.slippageBps / 10000), candle.time * 1000, "2.2R 波段目标");
      } else if (position.barsHeld >= timeoutBars) {
        closePosition(candle.close * (1 - direction * settings.slippageBps / 10000), candle.time * 1000, "时间退出");
      }
    }

    if (!position && i < candles.length - 1 && i1h >= 199 && i4h >= 199) {
      const long1h = c1h[i1h].close > ema1h50[i1h] && ema1h50[i1h] > ema1h200[i1h];
      const short1h = c1h[i1h].close < ema1h50[i1h] && ema1h50[i1h] < ema1h200[i1h];
      const long4h = c4h[i4h].close > ema4h50[i4h] && ema4h50[i4h] > ema4h200[i4h];
      const short4h = c4h[i4h].close < ema4h50[i4h] && ema4h50[i4h] < ema4h200[i4h];
      const side: Side | null = long1h && long4h ? "LONG" : short1h && short4h ? "SHORT" : null;
      if (side) {
        const direction = side === "LONG" ? 1 : -1;
        const previous = candles.slice(Math.max(0, i - 3), i);
        const trigger = side === "LONG"
          ? candle.close > Math.max(...previous.map((c) => c.high)) && macd.histogram[i] > 0 && macd.histogram[i] > macd.histogram[i - 1]
          : candle.close < Math.min(...previous.map((c) => c.low)) && macd.histogram[i] < 0 && macd.histogram[i] < macd.histogram[i - 1];
        const setup = side === "LONG"
          ? candle.close > ema50[i] && candle.low <= ema20[i] + atr[i] * 0.45
          : candle.close < ema50[i] && candle.high >= ema20[i] - atr[i] * 0.45;
        if (trigger && setup) {
          const next = candles[i + 1];
          const entry = next.open * (1 + direction * settings.slippageBps / 10000);
          const structure = candles.slice(Math.max(0, i - 11), i + 1);
          const structural = side === "LONG"
            ? Math.min(...structure.map((c) => c.low)) - atr[i] * 0.1
            : Math.max(...structure.map((c) => c.high)) + atr[i] * 0.1;
          let stop = side === "LONG" ? Math.max(structural, entry - atr[i] * 1.6) : Math.min(structural, entry + atr[i] * 1.6);
          if (side === "LONG" && stop >= entry) stop = entry - atr[i] * 1.2;
          if (side === "SHORT" && stop <= entry) stop = entry + atr[i] * 1.2;
          const initialRisk = Math.abs(entry - stop);
          const liq = side === "LONG" ? entry * (1 - 1 / leverage + 0.005) : entry * (1 + 1 / leverage - 0.005);
          const liquidationSafe = side === "LONG" ? stop > liq + entry * 0.0015 : stop < liq - entry * 0.0015;
          const riskPerUnit = initialRisk + (entry + stop) * settings.takerFeeBps / 10000 + stop * settings.slippageBps / 10000;
          let qty = roundToStep(Math.min(
            equity * settings.riskPerTradePct / 100 / riskPerUnit,
            equity * settings.marginPerTradePct / 100 * leverage / entry,
          ), meta.stepSize);
          qty = Number(qty.toFixed(8));
          if (liquidationSafe && qty >= meta.minQty && qty * entry >= meta.minNotional && initialRisk / entry > 0.0008) {
            openFee = qty * entry * settings.takerFeeBps / 10000;
            totalFees += openFee;
            equity -= openFee;
            position = {
              side, qty, entry, stop, target: entry + direction * initialRisk * 2.2,
              margin: qty * entry / leverage, openedAt: next.time * 1000,
              barsHeld: 0, initialRisk, moved: false,
            };
          }
        }
      }
    }
    const unrealized = position && position.openedAt <= candle.time * 1000 ? (candle.close - position.entry) * position.qty * (position.side === "LONG" ? 1 : -1) : 0;
    curve.push({ time: candle.time, equity: equity + unrealized });
  }
  if (position) {
    const last = candles.at(-1)!;
    closePosition(last.close, last.time * 1000, "回测结束退出");
    curve.push({ time: last.time, equity });
  }
  const wins = trades.filter((trade) => trade.pnl > 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const result: BacktestResult = {
    id: crypto.randomUUID(), symbol, timeframe, bars: candles.length,
    initialEquity: 100000, finalEquity: equity, netPnl: equity - 100000,
    returnPct: (equity - 100000) / 1000,
    maxDrawdown: maxDrawdown(curve.map((point) => point.equity)),
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    totalTrades: trades.length, totalFees,
    assumptions: [
      `数据源：${binance.sourceLabel}`, "下一根K线开盘成交；同一根K线同时触及止盈止损时先算止损",
      `模拟吃单费 ${settings.takerFeeBps} bps、单边滑点 ${settings.slippageBps} bps`,
      "单标的单仓；不计资金费率、真实盘口冲击和延迟；模拟强平缓冲采用统一维持保证金近似",
      "回测用于检验系统逻辑，不代表未来收益",
    ],
    equityCurve: curve.filter((_, index) => index % Math.max(1, Math.floor(curve.length / 240)) === 0),
    trades: trades.slice(-40).reverse(), createdAt: new Date().toISOString(),
  };
  await persistBacktestResult(result);
  return result;
}
