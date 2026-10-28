import {
  DEFAULT_SETTINGS,
  type Candle,
  type HistoricalFundingRate,
  type Market,
  type PortfolioBacktestResult,
  type PortfolioFundingSettlement,
  type PortfolioRiskRejection,
  type PortfolioVolatilityTransition,
  type Side,
  type TradeView,
  type TradingSettings,
  type VolatilityState,
} from "@contracts/trading";
import { getSettings } from "../queries/trading";
import { approveHistoricalEntry, type EntryRiskPosition } from "./execution";
import { persistBacktestResult } from "./backtest";
import { atrSeries, maxDrawdown } from "./indicators";
import { alignedCorrelation, managePositionPrice } from "./risk";
import { analyzeClosedCandles, type AnalyzeClosedCandlesInput } from "./strategy";
import { evaluateVolatility, type EvaluateVolatilityInput } from "./volatility";
import { binance, type SymbolMeta } from "./binance";

export type PortfolioTimeframe = "5m" | "15m";
export type PortfolioCandles = Record<"4h" | "1h" | "15m" | "5m", Candle[]>;
export type HistoricalVolatilitySample = Omit<EvaluateVolatilityInput, "symbol" | "settings"> & { time: number };

export interface PortfolioSymbolData {
  symbol: string;
  market: Market;
  meta: SymbolMeta;
  candles: PortfolioCandles;
  volatility: HistoricalVolatilitySample[];
  funding: HistoricalFundingRate[];
}

export interface PortfolioBacktestDependencies {
  data?: Record<string, PortfolioSymbolData>;
  settings?: TradingSettings;
  initialEquity?: number;
  analyze?: (input: AnalyzeClosedCandlesInput) => ReturnType<typeof analyzeClosedCandles>;
  evaluate?: typeof evaluateVolatility;
  persist?: boolean;
  now?: () => number;
}

interface HistoricalPosition {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  liquidationPrice: number;
  leverage: number;
  margin: number;
  openFee: number;
  initialRisk: number;
  maxFavorableR: number;
  trailing: boolean;
  fundingPnl: number;
  openedAt: number;
  barsHeld: number;
}

const INTERVAL_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 } as const;

function direction(side: Side) {
  return side === "LONG" ? 1 : -1;
}

function dayKey(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}

function validateCandles(symbol: string, timeframe: string, candles: Candle[]) {
  const interval = INTERVAL_MS[timeframe as keyof typeof INTERVAL_MS];
  for (let index = 0; index < candles.length; index += 1) {
    const bar = candles[index];
    const values = [bar.time, bar.closeTime, bar.open, bar.high, bar.low, bar.close, bar.volume];
    if (!values.every(Number.isFinite) || bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0
      || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)
      || bar.closeTime !== bar.time * 1000 + interval - 1) {
      throw new Error(`${symbol} ${timeframe} K线无效，回测失败关闭`);
    }
    if (index > 0 && bar.time * 1000 - candles[index - 1].time * 1000 !== interval) {
      throw new Error(`${symbol} ${timeframe} K线缺口，回测失败关闭`);
    }
  }
}

function latestClosed(candles: Candle[], now: number) {
  let index = -1;
  for (let current = 0; current < candles.length; current += 1) {
    if (candles[current].closeTime > now) break;
    index = current;
  }
  return index;
}

function historicalMarket(data: PortfolioSymbolData, settings: TradingSettings, now: number): Market {
  const fiveMinute = data.candles["5m"];
  const index = latestClosed(fiveMinute, now);
  const last = fiveMinute[index];
  if (!last) return { ...data.market, eligible: false, filterReason: "缺少已收盘5M行情" };
  const dayStart = now - 86_400_000;
  const dayBars = fiveMinute.slice(0, index + 1).filter((bar) => bar.closeTime > dayStart);
  const quoteVolume = dayBars.reduce((sum, bar) => sum + bar.volume * bar.close, 0);
  const first = dayBars[0] ?? last;
  const change24h = first.close > 0 ? (last.close / first.close - 1) * 100 : 0;
  const spreadBps = settings.maxSpreadBps / 2;
  const volumeScore = Math.min(100, Math.log10(Math.max(1, quoteVolume)) / 10 * 100);
  const spreadScore = Math.max(0, 100 - spreadBps * 20);
  const eligible = quoteVolume >= settings.minQuoteVolume && spreadBps <= settings.maxSpreadBps;
  return {
    ...data.market,
    price: last.close,
    markPrice: last.close,
    change24h,
    quoteVolume,
    spreadBps,
    fundingRate: 0,
    high24h: Math.max(...dayBars.map((bar) => bar.high)),
    low24h: Math.min(...dayBars.map((bar) => bar.low)),
    liquidityScore: Math.round((volumeScore * 0.7 + spreadScore * 0.3) * 10) / 10,
    eligible,
    filterReason: eligible ? "历史行情合格" : "历史流动性或假设点差不合格",
  };
}

function emptyVolatility(symbol: string): EvaluateVolatilityInput {
  return {
    symbol,
    settings: DEFAULT_SETTINGS,
    quality: { valid: false, reasons: ["历史波动数据缺口"], bookAgeMs: null, markAgeMs: null, candleAgeMs: null },
    currentAtr: Number.NaN,
    atrBaseline: [],
    currentTickReturn: Number.NaN,
    tickReturnBaseline: [],
    currentSpreadBps: Number.NaN,
    spreadBaselineBps: [],
  };
}

async function loadPortfolioData(
  symbols: string[],
  timeframe: PortfolioTimeframe,
  bars: number,
  settings: TradingSettings,
  now: number,
): Promise<Record<string, PortfolioSymbolData>> {
  const interval = INTERVAL_MS[timeframe];
  const endTime = Math.floor(now / interval) * interval - 1;
  const firstOpen = endTime - bars * interval + 1;
  const rangeMs = bars * interval;
  const markets = await binance.getMarkets(settings);
  const entries = await Promise.all(symbols.map(async (symbol) => {
    const market = markets.find((item) => item.symbol === symbol);
    if (!market) throw new Error(`${symbol} 不在当前模拟合约元数据中`);
    const count = (unit: keyof typeof INTERVAL_MS, lookback: number) => Math.ceil(rangeMs / INTERVAL_MS[unit]) + lookback;
    const [meta, fiveMinute, oneMinute, fifteenMinute, oneHour, fourHour, funding] = await Promise.all([
      binance.getSymbolMeta(symbol),
      binance.getHistoricalCandles(symbol, "5m", count("5m", settings.atrBaselineMinSamples), endTime),
      binance.getHistoricalCandles(symbol, "1m", count("1m", 122), endTime),
      timeframe === "15m"
        ? binance.getHistoricalCandles(symbol, "15m", bars, endTime)
        : binance.getHistoricalCandles(symbol, "15m", count("15m", Math.max(60, settings.correlationWindow + 1)), endTime),
      binance.getHistoricalCandles(symbol, "1h", count("1h", 200), endTime),
      binance.getHistoricalCandles(symbol, "4h", count("4h", 200), endTime),
      binance.getFundingRates(symbol, firstOpen, endTime),
    ]);
    validateCandles(symbol, "1m", oneMinute);
    validateCandles(symbol, "5m", fiveMinute);
    validateCandles(symbol, "15m", fifteenMinute);
    validateCandles(symbol, "1h", oneHour);
    validateCandles(symbol, "4h", fourHour);
    const primary = timeframe === "5m" ? fiveMinute.slice(-bars) : fifteenMinute;
    const atr = atrSeries(fiveMinute);
    const returns = oneMinute.map((bar, index) => index === 0 ? Number.NaN : bar.close / oneMinute[index - 1].close - 1);
    const assumedSpread = settings.maxSpreadBps / 2;
    const volatility = primary.map((bar): HistoricalVolatilitySample => {
      const atrIndex = latestClosed(fiveMinute, bar.closeTime);
      const tickIndex = latestClosed(oneMinute, bar.closeTime);
      const valid = atrIndex >= 0 && tickIndex >= 0
        && Number.isFinite(atr[atrIndex]) && Number.isFinite(returns[tickIndex]);
      return {
        time: bar.closeTime,
        quality: {
          valid,
          reasons: valid ? [] : ["历史ATR或1M数据缺口"],
          bookAgeMs: 0,
          markAgeMs: 0,
          candleAgeMs: 0,
        },
        currentAtr: atr[atrIndex] ?? Number.NaN,
        atrBaseline: atr.slice(Math.max(0, atrIndex + 1 - settings.atrBaselineMinSamples), atrIndex + 1),
        currentTickReturn: returns[tickIndex] ?? Number.NaN,
        tickReturnBaseline: returns.slice(Math.max(1, tickIndex - 121), tickIndex).filter(Number.isFinite),
        currentSpreadBps: assumedSpread,
        spreadBaselineBps: Array.from({ length: Math.max(120, settings.spreadBaselineMinSamples) }, () => assumedSpread),
      };
    });
    const item: PortfolioSymbolData = {
      symbol,
      market,
      meta,
      candles: {
        "4h": fourHour,
        "1h": oneHour,
        "15m": fifteenMinute,
        "5m": fiveMinute,
      },
      volatility,
      funding,
    };
    return [symbol, item] as const;
  }));
  return Object.fromEntries(entries);
}

export async function runPortfolioBacktest(
  symbols: string[],
  timeframe: PortfolioTimeframe,
  bars: number,
  dependencies: PortfolioBacktestDependencies = {},
): Promise<PortfolioBacktestResult> {
  if (!Array.isArray(symbols) || symbols.length === 0 || new Set(symbols).size !== symbols.length) {
    throw new Error("组合回测需要不重复的合约列表");
  }
  if (!Number.isInteger(bars) || bars < 2) throw new Error("组合回测K线数量无效");
  const settings = dependencies.settings ?? await getSettings();
  const initialEquity = dependencies.initialEquity ?? 100_000;
  if (!Number.isFinite(initialEquity) || initialEquity <= 0) throw new Error("组合回测初始权益无效");
  const now = dependencies.now ?? Date.now;
  const data = dependencies.data ?? await loadPortfolioData(symbols, timeframe, bars, settings, now());
  const primary = symbols.map((symbol) => {
    const item = data[symbol];
    if (!item) throw new Error(`${symbol} 缺少历史数据，回测失败关闭`);
    const series = item.candles[timeframe];
    if (series.length < 2) throw new Error(`${symbol} ${timeframe} K线不足，回测失败关闭`);
    validateCandles(symbol, timeframe, series);
    return series;
  });
  const timeline = primary[0];
  for (let index = 1; index < primary.length; index += 1) {
    for (let bar = 0; bar < timeline.length; bar += 1) {
      if (primary[index][bar]?.time !== timeline[bar].time) {
        throw new Error(`${symbols[index]} ${timeframe} K线缺口或时间轴不一致，回测失败关闭`);
      }
    }
    if (primary[index].length !== timeline.length) {
      throw new Error(`${symbols[index]} ${timeframe} K线缺口或时间轴不一致，回测失败关闭`);
    }
  }
  const timelineOpens = new Set(timeline.map((bar) => bar.time * 1000));
  const fundingBySymbol = new Map<string, HistoricalFundingRate[]>();
  for (const symbol of symbols) {
    const events: HistoricalFundingRate[] = [];
    for (const event of data[symbol].funding) {
      if (event.fundingTime < timeline[0].time * 1000 || event.fundingTime > timeline.at(-1)!.closeTime) {
        events.push(event);
        continue;
      }
      const openTime = Math.floor(event.fundingTime / INTERVAL_MS[timeframe]) * INTERVAL_MS[timeframe];
      if (event.fundingTime - openTime > 1000 || !timelineOpens.has(openTime)) {
        throw new Error(`${symbol} 历史资金费事件无法与K线开盘对齐，回测失败关闭`);
      }
      events.push({ ...event, fundingTime: openTime });
    }
    fundingBySymbol.set(symbol, events);
  }

  const analyze = dependencies.analyze ?? analyzeClosedCandles;
  const evaluate = dependencies.evaluate ?? evaluateVolatility;
  let cash = initialEquity;
  let totalFees = 0;
  let totalFunding = 0;
  let dailyLossLocked = false;
  let currentDay = dayKey(timeline[0].time * 1000);
  let dayStartEquity = initialEquity;
  const positions = new Map<string, HistoricalPosition>();
  const states = new Map<string, VolatilityState>();
  const pending = new Map<string, ReturnType<typeof analyzeClosedCandles>>();
  const trades: TradeView[] = [];
  const tradesBySymbol: Record<string, TradeView[]> = {};
  const funding: PortfolioFundingSettlement[] = [];
  const riskRejections: PortfolioRiskRejection[] = [];
  const transitions: PortfolioVolatilityTransition[] = [];
  const dailyLossLocks: PortfolioBacktestResult["dailyLossLocks"] = [];
  const curve: { time: number; equity: number }[] = [{ time: timeline[0].time, equity: initialEquity }];
  const timeoutBars = Math.max(1, Math.round(72 * 3_600_000 / INTERVAL_MS[timeframe]));

  const equityAt = (price: (position: HistoricalPosition) => number) => cash + [...positions.values()]
    .reduce((sum, position) => sum + (price(position) - position.entryPrice) * position.qty * direction(position.side), 0);

  const closePosition = (position: HistoricalPosition, rawExit: number, time: number, reason: string) => {
    const exit = rawExit * (1 - direction(position.side) * settings.slippageBps / 10_000);
    const closeFee = position.qty * exit * settings.takerFeeBps / 10_000;
    const gross = (exit - position.entryPrice) * position.qty * direction(position.side);
    cash += gross - closeFee;
    totalFees += closeFee;
    const pnl = gross - position.openFee - closeFee + position.fundingPnl;
    const trade: TradeView = {
      id: crypto.randomUUID(),
      symbol: position.symbol,
      side: position.side,
      qty: position.qty,
      entryPrice: position.entryPrice,
      exitPrice: exit,
      pnl,
      returnPct: position.margin > 0 ? pnl / position.margin * 100 : 0,
      fees: position.openFee + closeFee,
      holdingMinutes: (time - position.openedAt) / 60_000,
      exitReason: reason,
      openedAt: new Date(position.openedAt).toISOString(),
      closedAt: new Date(time).toISOString(),
    };
    trades.push(trade);
    (tradesBySymbol[position.symbol] ??= []).push(trade);
    positions.delete(position.symbol);
  };

  for (let index = 0; index < timeline.length; index += 1) {
    const openTime = timeline[index].time * 1000;
    const closeTime = timeline[index].closeTime;
    const currentBars = new Map(symbols.map((symbol, symbolIndex) => [symbol, primary[symbolIndex][index]]));
    const newDay = dayKey(openTime) !== currentDay;
    if (newDay) {
      currentDay = dayKey(openTime);
      dayStartEquity = equityAt((position) => currentBars.get(position.symbol)!.open);
    }

    if (dailyLossLocked) {
      for (const position of [...positions.values()]) {
        closePosition(position, currentBars.get(position.symbol)!.open, openTime, "日损熔断退出");
      }
    }
    if (newDay) dailyLossLocked = false;

    for (const symbol of symbols) {
      const opportunity = pending.get(symbol);
      if (!opportunity) continue;
      pending.delete(symbol);
      const bar = currentBars.get(symbol)!;
      const state = states.get(symbol);
      if (!state) {
        riskRejections.push({ time: openTime, symbol, reason: "缺少历史波动状态" });
        continue;
      }
      const riskPositions: EntryRiskPosition[] = [...positions.values()].map((position) => ({
        symbol: position.symbol,
        side: position.side,
        qty: position.qty,
        entryPrice: position.entryPrice,
        markPrice: currentBars.get(position.symbol)!.open,
        stopPrice: position.stopPrice,
        margin: position.margin,
      }));
      const equity = equityAt((position) => currentBars.get(position.symbol)!.open);
      const usedMargin = [...positions.values()].reduce((sum, position) => sum + position.margin, 0);
      const correlations: Record<string, number | null> = {};
      for (const position of positions.values()) {
        correlations[position.symbol] = alignedCorrelation(
          data[symbol].candles["15m"],
          data[position.symbol].candles["15m"],
          openTime,
          settings.correlationWindow,
        );
      }
      const approved = approveHistoricalEntry({
        opportunity,
        state,
        settings,
        equity,
        usedMargin,
        todayPnlPct: dayStartEquity > 0 ? (equity - dayStartEquity) / dayStartEquity * 100 : -100,
        positions: riskPositions,
        correlations,
        symbolMeta: data[symbol].meta,
        maxLeverage: data[symbol].market.maxLeverage,
        now: openTime,
        currentPrice: bar.open,
        fillPrice: bar.open * (1 + direction(opportunity.side) * settings.slippageBps / 10_000),
      });
      if (!approved.ok) {
        riskRejections.push({ time: openTime, symbol, reason: approved.reason });
        continue;
      }
      cash -= approved.openFee;
      totalFees += approved.openFee;
      positions.set(symbol, {
        symbol,
        side: opportunity.side,
        qty: approved.qty,
        entryPrice: approved.fillPrice,
        stopPrice: opportunity.stop,
        targetPrice: approved.targetPrice,
        liquidationPrice: approved.liquidationPrice,
        leverage: approved.leverage,
        margin: approved.margin,
        openFee: approved.openFee,
        initialRisk: approved.initialRisk,
        maxFavorableR: 0,
        trailing: false,
        fundingPnl: 0,
        openedAt: openTime,
        barsHeld: 0,
      });
    }

    for (const symbol of symbols) {
      const position = positions.get(symbol);
      if (!position) continue;
      const bar = currentBars.get(symbol)!;
      for (const event of fundingBySymbol.get(symbol)!) {
        if (event.fundingTime !== openTime) continue;
        if (!Number.isFinite(event.fundingRate)) throw new Error(`${symbol} 历史资金费率无效`);
        const notional = position.qty * bar.open;
        const amount = -direction(position.side) * notional * event.fundingRate;
        cash += amount;
        position.fundingPnl += amount;
        totalFunding += amount;
        funding.push({ time: openTime, symbol, rate: event.fundingRate, notional, amount });
      }
    }

    let adverseAdjustment = 0;
    for (const symbol of symbols) {
      const position = positions.get(symbol);
      if (!position) continue;
      const bar = currentBars.get(symbol)!;
      const dir = direction(position.side);
      position.barsHeld += 1;
      const managementInput = {
        side: position.side,
        entryPrice: position.entryPrice,
        stopPrice: position.stopPrice,
        targetPrice: position.targetPrice,
        liquidationPrice: position.liquidationPrice,
        initialRisk: position.initialRisk,
        maxFavorableR: position.maxFavorableR,
        mode: states.get(symbol)?.mode ?? "EXTREME" as const,
        dailyLossLocked: false,
        timedOut: false,
        takerFeeBps: settings.takerFeeBps,
        slippageBps: settings.slippageBps,
      };
      const atOpen = managePositionPrice({ ...managementInput, price: bar.open });
      if (atOpen.action === "CLOSE") {
        let rawExit = bar.open;
        if (atOpen.reason === "强平保护模拟") rawExit = position.side === "LONG" ? Math.min(bar.open, position.liquidationPrice) : Math.max(bar.open, position.liquidationPrice);
        else if (atOpen.reason === "2.2R 波段目标") rawExit = position.side === "LONG" ? Math.max(bar.open, position.targetPrice) : Math.min(bar.open, position.targetPrice);
        else rawExit = position.side === "LONG" ? Math.min(bar.open, position.stopPrice) : Math.max(bar.open, position.stopPrice);
        closePosition(position, rawExit, openTime, atOpen.reason ?? "结构止损");
        continue;
      }

      const adversePrice = position.side === "LONG" ? bar.low : bar.high;
      const adverse = managePositionPrice({ ...managementInput, price: adversePrice });
      if (adverse.action === "CLOSE") {
        const liquidation = adverse.reason === "强平保护模拟";
        const rawExit = liquidation ? position.liquidationPrice : position.stopPrice;
        const reason = position.trailing && !liquidation ? "保本／移动止损" : adverse.reason!;
        closePosition(position, rawExit, openTime, reason);
        continue;
      }

      const favorablePrice = position.side === "LONG" ? bar.high : bar.low;
      const favorable = managePositionPrice({ ...managementInput, price: favorablePrice });
      if (favorable.action === "CLOSE") {
        const cashBefore = cash;
        const adversePnl = (adversePrice - position.entryPrice) * position.qty * dir;
        closePosition(position, position.targetPrice, openTime, favorable.reason ?? "2.2R 波段目标");
        adverseAdjustment += adversePnl - (cash - cashBefore);
        continue;
      }

      const atClose = managePositionPrice({
        ...managementInput,
        price: bar.close,
        timedOut: position.barsHeld >= timeoutBars,
      });
      if (atClose.action === "CLOSE") {
        const cashBefore = cash;
        const adversePnl = (adversePrice - position.entryPrice) * position.qty * dir;
        closePosition(position, bar.close, closeTime, atClose.reason ?? "72 小时波段超时退出");
        adverseAdjustment += adversePnl - (cash - cashBefore);
        continue;
      }
      if (favorable.stopPrice !== position.stopPrice) position.trailing = true;
      position.stopPrice = favorable.stopPrice;
      position.maxFavorableR = favorable.maxFavorableR;
      adverseAdjustment += (adversePrice - position.entryPrice) * position.qty * dir;
    }

    curve.push({ time: timeline[index].time, equity: cash + adverseAdjustment });
    const closeEquity = equityAt((position) => currentBars.get(position.symbol)!.close);
    curve.push({ time: closeTime / 1000, equity: closeEquity });
    const todayPnlPct = dayStartEquity > 0 ? (closeEquity - dayStartEquity) / dayStartEquity * 100 : -100;
    if (!dailyLossLocked && todayPnlPct <= -settings.dailyLossLimitPct) {
      dailyLossLocked = true;
      dailyLossLocks.push({ time: closeTime, day: currentDay, equity: closeEquity, dayStartEquity });
    }

    for (const symbol of symbols) {
      const item = data[symbol];
      const sample = item.volatility.find((entry) => entry.time === closeTime);
      const evaluationInput: EvaluateVolatilityInput = sample
        ? { ...sample, symbol, settings }
        : { ...emptyVolatility(symbol), settings };
      const previous = states.get(symbol) ?? null;
      const state = evaluate(evaluationInput, previous, closeTime);
      states.set(symbol, state);
      if ((previous && (state.mode !== previous.mode || state.version !== previous.version))
        || (!previous && state.mode !== "NORMAL")) {
        transitions.push({
          time: closeTime,
          symbol,
          from: previous?.mode ?? "NORMAL",
          to: state.mode,
          version: state.version,
          reasons: state.reasons,
        });
      }
      if (index === timeline.length - 1 || positions.has(symbol)) continue;
      const opportunity = analyze({
        market: historicalMarket(item, settings, closeTime),
        settings,
        candles4h: item.candles["4h"],
        candles1h: item.candles["1h"],
        candles15m: item.candles["15m"],
        candles5m: item.candles["5m"],
        now: closeTime,
        stateVersion: state.version,
      });
      if (opportunity.status === "READY") pending.set(symbol, opportunity);
    }
  }

  const last = timeline.at(-1)!;
  for (const position of [...positions.values()]) {
    closePosition(position, primary[symbols.indexOf(position.symbol)].at(-1)!.close, last.closeTime, "回测结束退出");
  }
  curve.push({ time: last.closeTime / 1000, equity: cash });

  const wins = trades.filter((trade) => trade.pnl > 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const result: PortfolioBacktestResult = {
    id: crypto.randomUUID(),
    symbol: "PORTFOLIO",
    symbols: [...symbols],
    timeframe,
    bars: timeline.length,
    initialEquity,
    finalEquity: cash,
    netPnl: cash - initialEquity,
    returnPct: (cash - initialEquity) / initialEquity * 100,
    maxDrawdown: maxDrawdown(curve.map((point) => point.equity)),
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    totalTrades: trades.length,
    totalFees,
    assumptions: [
      `数据源：${binance.sourceLabel}已收盘历史K线与历史资金费率`,
      "统一时间轴；信号收盘后于下一根开盘成交；同时刻按输入合约顺序串行审批共享组合风险",
      `吃单费 ${settings.takerFeeBps} bps；开平仓双边均计 ${settings.slippageBps} bps 不利滑点`,
      "同一根高低价路径未知时按强平、止损、目标保守排序；移动止损收盘确认后下一根生效",
      `历史盘口不可得，点差仅以配置硬上限的一半（${settings.maxSpreadBps / 2} bps）作显式摩擦与三态假设，不重建历史盘口`,
      "强平使用统一维持保证金近似；资金费按对齐事件开盘标记价近似；不代表真实账户结算或未来收益",
    ],
    equityCurve: curve,
    trades,
    createdAt: new Date(now()).toISOString(),
    tradesBySymbol,
    funding,
    totalFunding,
    riskRejections,
    transitions,
    dailyLossLocks,
    dataGaps: [],
  };
  if (dependencies.persist !== false) await persistBacktestResult(result);
  return result;
}
