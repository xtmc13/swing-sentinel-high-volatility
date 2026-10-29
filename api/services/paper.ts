import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  simulationAccounts,
  positions,
  executionOrders,
  closedTrades,
  tradingSettings,
  volatilityStates,
  fundingSettlements,
} from "@db/schema";
import {
  getOpenPositions,
  getSettings,
  addEvent,
  ensureInitialized,
  assertAffectedRows,
  settingsFromRow,
} from "../queries/trading";
import { binance, createMarketSnapshot, type MarketSnapshot } from "./binance";
import { applyAdverseSlippage, approveAndPriceEntry, type EntryRiskPosition } from "./execution";
import { alignedCorrelation, managePositionPrice } from "./risk";
import { log } from "../lib/logger";
import type {
  AccountSnapshot,
  Candle,
  Market,
  Opportunity,
  PerformanceMetrics,
  PositionView,
  Side,
  TradeView,
  TradingSettings,
  VolatilityMode,
} from "@contracts/trading";

export type PositionRow = typeof positions.$inferSelect;
export type TradeRow = typeof closedTrades.$inferSelect;

export function toPositionView(row: PositionRow, market?: Market, snapshot?: MarketSnapshot): PositionView {
  const direction = row.side === "LONG" ? 1 : -1;
  const candidate = snapshot ? snapshot.markPrice : market?.markPrice ?? market?.price;
  const sourceValid = snapshot ? snapshot.quality.valid : true;
  const valuationValid = sourceValid && Number.isFinite(candidate) && (candidate ?? 0) > 0;
  const markPrice = valuationValid ? candidate! : Number.NaN;
  const unrealizedPnl = valuationValid ? (markPrice - row.entryPrice) * row.qty * direction : Number.NaN;
  return {
    id: row.id, symbol: row.symbol, side: row.side as Side,
    qty: row.qty, initialQty: row.initialQty, entryPrice: row.entryPrice,
    markPrice, stopPrice: row.stopPrice, targetPrice: row.targetPrice,
    liquidationPrice: row.liquidationPrice, leverage: row.leverage,
    margin: row.margin, unrealizedPnl,
    unrealizedPct: valuationValid && row.margin > 0 ? unrealizedPnl / row.margin * 100 : Number.NaN,
    realizedPnl: row.realizedPnl, openedAt: row.openedAt.toISOString(),
    holdingMinutes: Math.max(0, (Date.now() - row.openedAt.getTime()) / 60000),
    rMultiple: valuationValid && row.initialRisk > 0 ? (markPrice - row.entryPrice) * direction / row.initialRisk : Number.NaN,
    valuationValid,
  };
}

export function toTradeView(row: TradeRow): TradeView {
  return {
    id: row.id, symbol: row.symbol, side: row.side as Side, qty: row.qty,
    entryPrice: row.entryPrice, exitPrice: row.exitPrice, pnl: row.pnl,
    returnPct: row.returnPct, fees: row.fees, fundingPnl: row.fundingPnl, holdingMinutes: row.holdingMinutes,
    exitReason: row.exitReason, openedAt: row.openedAt.toISOString(), closedAt: row.closedAt.toISOString(),
  };
}

async function rollUtcDayBaseline(
  account: typeof simulationAccounts.$inferSelect,
  equity: number,
  now: number,
  update: (values: { dayKey: string; dayStartEquity: number; dailyLockDay: null }) => Promise<unknown>,
) {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (account.dayKey === dayKey) {
    return { dayKey, dayStartEquity: account.dayStartEquity, dailyLockDay: account.dailyLockDay };
  }
  if (!Number.isFinite(equity)) {
    return { dayKey, dayStartEquity: account.dayStartEquity, dailyLockDay: null };
  }
  const dayStartEquity = equity;
  await update({ dayKey, dayStartEquity, dailyLockDay: null });
  return { dayKey, dayStartEquity, dailyLockDay: null };
}

export async function getAccountSnapshot(rows?: PositionRow[]): Promise<AccountSnapshot> {
  const [openRows, settings] = await Promise.all([rows ? Promise.resolve(rows) : getOpenPositions(), getSettings()]);
  const valued = await Promise.all(openRows.map(async (row) => {
    try {
      const snapshot = await binance.getMarketSnapshot(row.symbol);
      return {
        view: toPositionView(row, undefined, snapshot),
        issue: snapshot.quality.valid ? null : `${row.symbol}：${snapshot.quality.reasons.join("、") || "行情无效"}`,
      };
    } catch (error) {
      return { view: toPositionView(row), issue: `${row.symbol}：${error instanceof Error ? error.message : String(error)}` };
    }
  }));
  const valuationValid = valued.every((item) => item.view.valuationValid);
  const valuationIssues = valued.flatMap((item) => item.issue ? [item.issue] : []);
  const unrealizedPnl = valuationValid ? valued.reduce((sum, item) => sum + item.view.unrealizedPnl, 0) : Number.NaN;
  const usedMargin = openRows.reduce((sum, row) => sum + row.margin, 0);
  const { account, dayStartEquity, dailyLocked } = await getDb().transaction(async (tx) => {
    const locked = (await tx.select().from(simulationAccounts)
      .where(eq(simulationAccounts.id, 1)).limit(1).for("update"))[0];
    if (!locked) throw new Error("Simulation account is missing");
    const equity = valuationValid ? locked.cash + unrealizedPnl : Number.NaN;
    const baseline = await rollUtcDayBaseline(locked, equity, Date.now(), (values) =>
      tx.update(simulationAccounts).set(values).where(eq(simulationAccounts.id, 1)));
    const todayPnlPct = valuationValid && baseline.dayStartEquity > 0
      ? (equity - baseline.dayStartEquity) / baseline.dayStartEquity * 100 : Number.NaN;
    let dailyLockDay = baseline.dailyLockDay;
    if (todayPnlPct <= -settings.dailyLossLimitPct && dailyLockDay !== baseline.dayKey) {
      dailyLockDay = baseline.dayKey;
      await tx.update(simulationAccounts).set({ dailyLockDay }).where(eq(simulationAccounts.id, 1));
    }
    return { account: locked, dayStartEquity: baseline.dayStartEquity, dailyLocked: dailyLockDay === baseline.dayKey };
  });
  const equity = valuationValid ? account.cash + unrealizedPnl : Number.NaN;
  return {
    equity,
    cash: account.cash,
    availableMargin: valuationValid ? Math.max(0, equity - usedMargin) : Number.NaN,
    usedMargin,
    unrealizedPnl,
    realizedPnl: account.realizedPnl,
    todayPnl: valuationValid ? equity - dayStartEquity : Number.NaN,
    todayPnlPct: valuationValid && dayStartEquity > 0 ? (equity - dayStartEquity) / dayStartEquity * 100 : Number.NaN,
    dayStartEquity,
    valuationValid,
    valuationIssues,
    dailyLocked,
  };
}

export function calculatePerformance(trades: TradeRow[], initialEquity = 100000): PerformanceMetrics {
  if (!trades.length) return { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, maxDrawdown: 0, avgHoldingMinutes: 0, totalFees: 0 };
  const wins = trades.filter((trade) => trade.pnl > 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  let equity = Number.isFinite(initialEquity) && initialEquity > 0 ? initialEquity : 100000;
  let peak = equity;
  let drawdown = 0;
  for (const trade of [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime())) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, (peak - equity) / peak * 100);
  }
  return {
    totalTrades: trades.length, winRate: wins.length / trades.length * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    expectancy: trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length,
    maxDrawdown: drawdown,
    avgHoldingMinutes: trades.reduce((sum, trade) => sum + trade.holdingMinutes, 0) / trades.length,
    totalFees: trades.reduce((sum, trade) => sum + trade.fees, 0),
  };
}

export interface PaperMarket {
  readonly sourceGeneration: number;
  getMarketSnapshot(symbol: string): Promise<MarketSnapshot>;
  getSymbolMeta(symbol: string): ReturnType<typeof binance.getSymbolMeta>;
  getMarkets(settings: TradingSettings): Promise<Market[]>;
  getCandles(symbol: string, interval: string, limit?: number): Promise<Candle[]>;
  getFundingRates?(symbol: string, startTime: number, endTime: number): ReturnType<typeof binance.getFundingRates>;
}

export interface PaperServiceDependencies {
  getDb?: typeof getDb;
  market?: PaperMarket;
  now?: () => number;
  beforeCloseUpdate?: (positionId: string) => Promise<void>;
  beforeVolatilityStateLock?: (symbol: string) => Promise<void>;
}

function revalidateSnapshot(snapshot: MarketSnapshot, settings: TradingSettings, now: number) {
  const current = createMarketSnapshot({
    source: snapshot.source,
    symbol: snapshot.symbol,
    bid: snapshot.bid,
    ask: snapshot.ask,
    markPrice: snapshot.markPrice,
    bookTime: snapshot.bookTime,
    markTime: snapshot.markTime,
  }, now, settings.bookStaleSeconds * 1000, settings.candleStaleSeconds * 1000);
  if (snapshot.quality.valid) return current;
  return {
    ...current,
    quality: {
      ...current.quality,
      valid: false,
      reasons: [...snapshot.quality.reasons, ...current.quality.reasons],
    },
  };
}

export function createPaperService(dependencies: PaperServiceDependencies = {}) {
  const dbFor = dependencies.getDb ?? getDb;
  const market = dependencies.market ?? binance;
  const now = dependencies.now ?? Date.now;

  async function reportEvent(level: "INFO" | "WARN" | "ERROR" | "SUCCESS", category: string, message: string, symbol?: string) {
    try {
      await addEvent(level, category, message, symbol);
    } catch (error) {
      log.error("system event write failed after execution", {
        category,
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fundingCheckedAt = new Map<string, number>();

  async function settlePositionFunding(row: PositionRow, snapshot: MarketSnapshot) {
    if (!market.getFundingRates || !snapshot.quality.valid) return;
    const lastCheck = fundingCheckedAt.get(row.id) ?? 0;
    if (now() - lastCheck < 60_000) return;
    const db = dbFor();
    const events = await market.getFundingRates(row.symbol, row.openedAt.getTime(), now());
    for (const event of events) {
      if (event.fundingTime < row.openedAt.getTime() || event.fundingTime > now()) continue;
      if (!Number.isFinite(event.fundingRate) || !Number.isFinite(event.fundingTime)) throw new Error(`${row.symbol} 资金费历史数据无效`);
      const settled = await db.transaction(async (tx) => {
        await tx.select().from(simulationAccounts).where(eq(simulationAccounts.id, 1)).limit(1).for("update");
        const current = (await tx.select().from(positions).where(eq(positions.id, row.id)).limit(1))[0];
        if (!current || current.status !== "OPEN") return false;
        const existing = await tx.select().from(fundingSettlements).where(and(
          eq(fundingSettlements.positionId, row.id),
          eq(fundingSettlements.fundingTime, event.fundingTime),
        )).limit(1);
        if (existing.length) return false;
        const direction = current.side === "LONG" ? 1 : -1;
        const notional = current.qty * snapshot.markPrice;
        const amount = -direction * notional * event.fundingRate;
        if (!Number.isFinite(notional) || !Number.isFinite(amount)) throw new Error(`${row.symbol} 资金费结算金额无效`);
        await tx.insert(fundingSettlements).values({ id: crypto.randomUUID(), positionId: current.id, symbol: current.symbol, fundingTime: event.fundingTime, rate: event.fundingRate, notional, amount });
        await tx.update(positions).set({ fundingPnl: sql`${positions.fundingPnl} + ${amount}` })
          .where(and(eq(positions.id, current.id), eq(positions.status, "OPEN")));
        await tx.update(simulationAccounts).set({
          cash: sql`${simulationAccounts.cash} + ${amount}`,
          realizedPnl: sql`${simulationAccounts.realizedPnl} + ${amount}`,
        }).where(eq(simulationAccounts.id, 1));
        return true;
      });
      if (settled) await reportEvent("INFO", "资金费结算", `${row.symbol} 按当前标记价近似结算资金费`, row.symbol);
    }
    fundingCheckedAt.set(row.id, now());
  }

  async function openPaperPosition(opportunity: Opportunity, executionHealthy?: () => boolean) {
    await ensureInitialized();
    const db = dbFor();
    const maxAttempts = (await getSettings()).maxPositions + 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const preflightSettings = await getSettings();
      if (!preflightSettings.autoTrade) return { ok: false as const, reason: "自动交易已暂停" };
      const preflightRows = await db.select().from(positions).where(eq(positions.status, "OPEN"));
      const symbols = [...new Set([opportunity.symbol, ...preflightRows.map((row) => row.symbol)])];
      const snapshots = new Map(await Promise.all(symbols.map(async (symbol) => {
        const current = await market.getMarketSnapshot(symbol);
        return [symbol, current] as const;
      })));
      const [markets, meta] = await Promise.all([
        market.getMarkets(preflightSettings),
        market.getSymbolMeta(opportunity.symbol),
      ]);
      const currentMarket = markets.find((item) => item.symbol === opportunity.symbol);
      if (!currentMarket) return { ok: false as const, reason: "行情不可用" };
      const correlations: Record<string, number | null> = {};
      if (preflightRows.length > 0) {
        const candleMap = new Map(await Promise.all(symbols.map(async (symbol) => {
          const candles = await market.getCandles(symbol, "15m", preflightSettings.correlationWindow + 2);
          return [symbol, candles] as const;
        })));
        const candidateCandles = candleMap.get(opportunity.symbol) ?? [];
        for (const row of preflightRows) {
          correlations[row.symbol] = alignedCorrelation(
            candidateCandles,
            candleMap.get(row.symbol) ?? [],
            now(),
            preflightSettings.correlationWindow,
          );
        }
      }

      const result = await db.transaction(async (tx) => {
        const account = (await tx.select().from(simulationAccounts)
          .where(eq(simulationAccounts.id, 1)).limit(1).for("update"))[0];
        if (!account) throw new Error("Simulation account is missing");
        const settingsRow = (await tx.select().from(tradingSettings).where(eq(tradingSettings.id, 1)).limit(1))[0];
        if (!settingsRow) throw new Error("Trading settings are missing");
        const settings = settingsFromRow(settingsRow);
        const openRows = await tx.select().from(positions).where(eq(positions.status, "OPEN"));
        if (settings.correlationWindow !== preflightSettings.correlationWindow
          || (openRows.length > 0 && preflightRows.length === 0)
          || openRows.some((row) => !snapshots.has(row.symbol))) {
          return { retry: true as const };
        }
        const currentSnapshots = new Map([...snapshots].map(([symbol, snapshot]) => [
          symbol,
          revalidateSnapshot(snapshot, settings, now()),
        ] as const));
        if ([...currentSnapshots.values()].some((snapshot) => !snapshot.quality.valid)) {
          return { retry: true as const };
        }
        await dependencies.beforeVolatilityStateLock?.(opportunity.symbol);
        const stateRow = (await tx.select().from(volatilityStates)
          .where(eq(volatilityStates.symbol, opportunity.symbol)).limit(1).for("update"))[0];
        if (!stateRow) return { ok: false as const, reason: "缺少当前波动状态，禁止开仓" };
        const riskPositions: EntryRiskPosition[] = openRows.map((row) => ({
          symbol: row.symbol,
          side: row.side as Side,
          qty: row.qty,
          entryPrice: row.entryPrice,
          markPrice: currentSnapshots.get(row.symbol)!.markPrice,
          stopPrice: row.stopPrice,
          margin: row.margin,
        }));
        const unrealizedPnl = riskPositions.reduce((sum, row) => {
          const direction = row.side === "LONG" ? 1 : -1;
          return sum + (row.markPrice - row.entryPrice) * row.qty * direction;
        }, 0);
        const usedMargin = openRows.reduce((sum, row) => sum + row.margin, 0);
        const equity = account.cash + unrealizedPnl;
        const baseline = await rollUtcDayBaseline(account, equity, now(), (values) =>
          tx.update(simulationAccounts).set(values).where(eq(simulationAccounts.id, 1)));
        const dayStartEquity = baseline.dayStartEquity;
        const todayPnlPct = dayStartEquity > 0 ? (equity - dayStartEquity) / dayStartEquity * 100 : 0;
        let dailyLockDay = baseline.dailyLockDay;
        if (todayPnlPct <= -settings.dailyLossLimitPct && dailyLockDay !== baseline.dayKey) {
          dailyLockDay = baseline.dayKey;
          await tx.update(simulationAccounts).set({ dailyLockDay }).where(eq(simulationAccounts.id, 1));
        }
        const approved = approveAndPriceEntry({
          opportunity,
          snapshot: currentSnapshots.get(opportunity.symbol)!,
          state: {
            symbol: stateRow.symbol,
            mode: stateRow.mode === "HIGH" || stateRow.mode === "EXTREME" ? stateRow.mode : "NORMAL",
            confirmationCount: stateRow.confirmationCount,
            stableSince: stateRow.stableSince,
            metrics: { atrQuantile: stateRow.atrQuantile, tickSigma: stateRow.tickSigma, spreadRatio: stateRow.spreadRatio },
            lastDataAt: stateRow.lastDataAt,
            version: stateRow.version,
          },
          settings,
          equity,
          usedMargin,
          todayPnlPct,
          dailyLossLocked: dailyLockDay === baseline.dayKey,
          positions: riskPositions,
          correlations,
          symbolMeta: meta,
          maxLeverage: currentMarket.maxLeverage,
          now: now(),
          currentSourceGeneration: market.sourceGeneration,
          executionHealthy,
        });
        if (!approved.ok) return approved;

        const positionId = crypto.randomUUID();
        await tx.insert(positions).values({
          id: positionId,
          symbol: opportunity.symbol,
          side: opportunity.side,
          initialQty: approved.qty,
          qty: approved.qty,
          entryPrice: approved.fillPrice,
          stopPrice: opportunity.stop,
          targetPrice: approved.targetPrice,
          liquidationPrice: approved.liquidationPrice,
          leverage: approved.leverage,
          margin: approved.margin,
          fees: approved.openFee,
          initialRisk: approved.initialRisk,
        });
        await tx.insert(executionOrders).values({
          id: crypto.randomUUID(),
          positionId,
          symbol: opportunity.symbol,
          side: opportunity.side,
          purpose: "OPEN",
          qty: approved.qty,
          price: approved.fillPrice,
          fee: approved.openFee,
        });
        await tx.update(simulationAccounts).set({
          cash: sql`${simulationAccounts.cash} - ${approved.openFee}`,
          realizedPnl: sql`${simulationAccounts.realizedPnl} - ${approved.openFee}`,
        }).where(eq(simulationAccounts.id, 1));
        return { ok: true as const, positionId, reason: "模拟开仓成交" };
      });
      if ("retry" in result) continue;
      if (result.ok) {
        await reportEvent("SUCCESS", "模拟成交", `${opportunity.side === "LONG" ? "做多" : "做空"} ${opportunity.symbol}，${result.reason}`, opportunity.symbol);
      }
      return result;
    }
    return { ok: false as const, reason: "持仓或行情持续变化，请重新提交开仓信号" };
  }

  async function closePaperPosition(positionId: string, reason = "人工平仓") {
    await ensureInitialized();
    const db = dbFor();
    const preflightRow = (await db.select().from(positions).where(eq(positions.id, positionId)).limit(1))[0];
    if (!preflightRow || preflightRow.status !== "OPEN") {
      return { ok: false as const, reason: "持仓不存在或已关闭", unsettled: false as const, alreadyClosed: true as const, pnl: undefined };
    }
    const snapshot = await market.getMarketSnapshot(preflightRow.symbol);
    const result = await db.transaction(async (tx) => {
      const account = (await tx.select().from(simulationAccounts)
        .where(eq(simulationAccounts.id, 1)).limit(1).for("update"))[0];
      if (!account) throw new Error("Simulation account is missing");
      const settingsRow = (await tx.select().from(tradingSettings).where(eq(tradingSettings.id, 1)).limit(1))[0];
      if (!settingsRow) throw new Error("Trading settings are missing");
      const settings = settingsFromRow(settingsRow);
      const row = (await tx.select().from(positions).where(eq(positions.id, positionId)).limit(1))[0];
      if (!row || row.status !== "OPEN") {
        return { ok: false as const, reason: "持仓不存在或已关闭", unsettled: false as const, alreadyClosed: true as const, pnl: undefined };
      }
      const current = revalidateSnapshot(snapshot, settings, now());
      if (!current.quality.valid) {
        return { ok: false as const, reason: `无法取得新鲜平仓价格：${current.quality.reasons.join("、")}`, unsettled: true as const, alreadyClosed: false as const };
      }
      const side = row.side as Side;
      const direction = side === "LONG" ? 1 : -1;
      const rawExit = side === "LONG" ? current.bid : current.ask;
      const exitPrice = applyAdverseSlippage(rawExit, side, settings.slippageBps, "CLOSE");
      const grossPnl = (exitPrice - row.entryPrice) * row.qty * direction;
      const closeFee = row.qty * exitPrice * settings.takerFeeBps / 10_000;
      const netPnl = grossPnl - row.fees - closeFee + row.fundingPnl;
      const holdingMinutes = Math.max(0, (now() - row.openedAt.getTime()) / 60_000);
      const closedAt = new Date(now());
      await dependencies.beforeCloseUpdate?.(row.id);
      const updated = await tx.update(positions).set({ status: "CLOSED", closedAt, realizedPnl: netPnl })
        .where(and(eq(positions.id, row.id), eq(positions.status, "OPEN")));
      assertAffectedRows(updated);
      await tx.insert(executionOrders).values({
        id: crypto.randomUUID(),
        positionId: row.id,
        symbol: row.symbol,
        side,
        purpose: "CLOSE",
        qty: row.qty,
        price: exitPrice,
        fee: closeFee,
      });
      await tx.insert(closedTrades).values({
        id: crypto.randomUUID(),
        symbol: row.symbol,
        side,
        qty: row.qty,
        entryPrice: row.entryPrice,
        exitPrice,
        pnl: netPnl,
        returnPct: row.margin > 0 ? netPnl / row.margin * 100 : 0,
        fees: row.fees + closeFee,
        fundingPnl: row.fundingPnl,
        holdingMinutes,
        exitReason: reason,
        openedAt: row.openedAt,
        closedAt,
      });
      await tx.update(simulationAccounts).set({
        cash: sql`${simulationAccounts.cash} + ${grossPnl - closeFee}`,
        realizedPnl: sql`${simulationAccounts.realizedPnl} + ${grossPnl - closeFee}`,
      }).where(eq(simulationAccounts.id, 1));
      return { ok: true as const, reason, pnl: netPnl, unsettled: false as const, alreadyClosed: false as const };
    });
    if (result.ok) {
      await reportEvent(result.pnl >= 0 ? "SUCCESS" : "WARN", "持仓退出", `${reason}，净盈亏 ${result.pnl.toFixed(2)} USDT`);
    } else if (result.unsettled) {
      await reportEvent("WARN", "平仓延后", `${reason}：${result.reason}；持仓保持 OPEN 并等待重试`);
    }
    return result;
  }

  async function manageOpenPositions() {
    const settings = await getSettings();
    const db = dbFor();
    const rows = await db.select().from(positions).where(eq(positions.status, "OPEN"));
    const snapshots = new Map(await Promise.all(rows.map(async (row) => [row.symbol, await market.getMarketSnapshot(row.symbol)] as const)));
    for (const row of rows) {
      const snapshot = snapshots.get(row.symbol);
      if (!snapshot?.quality.valid) continue;
      try {
        await settlePositionFunding(row, snapshot);
      } catch (error) {
        log.error("funding settlement failed", { symbol: row.symbol, error: String(error) });
      }
    }
    const valuationValid = rows.every((row) => snapshots.get(row.symbol)?.quality.valid);
    const unrealizedPnl = valuationValid ? rows.reduce((sum, row) => {
      const snapshot = snapshots.get(row.symbol)!;
      return sum + (snapshot.markPrice - row.entryPrice) * row.qty * (row.side === "LONG" ? 1 : -1);
    }, 0) : Number.NaN;
    const dailyBaseline = await db.transaction(async (tx) => {
      const account = (await tx.select().from(simulationAccounts)
        .where(eq(simulationAccounts.id, 1)).limit(1).for("update"))[0];
      if (!account) return null;
      const equity = valuationValid ? account.cash + unrealizedPnl : Number.NaN;
      const baseline = await rollUtcDayBaseline(account, equity, now(), (values) =>
        tx.update(simulationAccounts).set(values).where(eq(simulationAccounts.id, 1)));
      const todayPnlPct = valuationValid && baseline.dayStartEquity > 0
        ? (equity - baseline.dayStartEquity) / baseline.dayStartEquity * 100 : Number.NaN;
      let dailyLockDay = baseline.dailyLockDay;
      if (todayPnlPct <= -settings.dailyLossLimitPct && dailyLockDay !== baseline.dayKey) {
        dailyLockDay = baseline.dayKey;
        await tx.update(simulationAccounts).set({ dailyLockDay }).where(eq(simulationAccounts.id, 1));
      }
      return { dailyLocked: dailyLockDay === baseline.dayKey };
    });
    if (!dailyBaseline) return;
    const dailyLocked = dailyBaseline.dailyLocked;
    for (const row of rows) {
      const snapshot = snapshots.get(row.symbol);
      if (!snapshot?.quality.valid) continue;
      const state = (await db.select().from(volatilityStates).where(eq(volatilityStates.symbol, row.symbol)).limit(1))[0];
      const mode: VolatilityMode = state?.mode === "HIGH" || state?.mode === "EXTREME" ? state.mode : "NORMAL";
      const managed = managePositionPrice({
        side: row.side as Side,
        entryPrice: row.entryPrice,
        stopPrice: row.stopPrice,
        targetPrice: row.targetPrice,
        liquidationPrice: row.liquidationPrice,
        price: snapshot.markPrice,
        initialRisk: row.initialRisk,
        maxFavorableR: row.maxFavorableR,
        mode,
        dailyLossLocked: dailyLocked,
        timedOut: now() - row.openedAt.getTime() > 72 * 60 * 60_000,
        takerFeeBps: settings.takerFeeBps,
        slippageBps: settings.slippageBps,
      });
      if (managed.stopPrice !== row.stopPrice || managed.maxFavorableR !== row.maxFavorableR) {
        await db.update(positions).set({ stopPrice: managed.stopPrice, maxFavorableR: managed.maxFavorableR })
          .where(and(eq(positions.id, row.id), eq(positions.status, "OPEN")));
      }
      if (managed.action === "CLOSE" && managed.reason) await closePaperPosition(row.id, managed.reason);
    }
  }

  async function resetPaperSimulation() {
    await ensureInitialized();
    const db = dbFor();
    const rows = await db.transaction(async (tx) => {
      await tx.select().from(simulationAccounts).where(eq(simulationAccounts.id, 1)).limit(1).for("update");
      await tx.update(tradingSettings).set({ autoTrade: false }).where(eq(tradingSettings.id, 1));
      return tx.select().from(positions).where(eq(positions.status, "OPEN"));
    });
    const settled: string[] = [];
    const unsettled: { positionId: string; symbol: string; reason: string }[] = [];
    for (const row of rows) {
      try {
        const result = await closePaperPosition(row.id, "模拟账户重置");
        if (result.ok || result.alreadyClosed) settled.push(row.id);
        else unsettled.push({ positionId: row.id, symbol: row.symbol, reason: result.reason });
      } catch (error) {
        unsettled.push({ positionId: row.id, symbol: row.symbol, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!unsettled.length) {
      const remaining = await db.transaction(async (tx) => {
        await tx.select().from(simulationAccounts).where(eq(simulationAccounts.id, 1)).limit(1).for("update");
        const openRows = await tx.select().from(positions).where(eq(positions.status, "OPEN"));
        if (openRows.length) return openRows;
        await tx.update(simulationAccounts).set({
          cash: 100_000,
          realizedPnl: 0,
          dayStartEquity: 100_000,
          dayKey: new Date(now()).toISOString().slice(0, 10),
          dailyLockDay: null,
        }).where(eq(simulationAccounts.id, 1));
        return [];
      });
      for (const row of remaining) {
        unsettled.push({ positionId: row.id, symbol: row.symbol, reason: "最终锁内检查发现持仓仍未结算" });
      }
    }
    const ok = unsettled.length === 0;
    await reportEvent(ok ? "WARN" : "ERROR", "账户", ok
      ? "模拟账户已重置为 100,000 USDT；历史订单与复盘记录保留"
      : `模拟账户重置中止；未结算 ${unsettled.length} 笔，现金保持不变`);
    return { ok, paused: true, settled, unsettled };
  }

  async function emergencyStop() {
    const db = dbFor();
    const rows = await db.transaction(async (tx) => {
      await tx.select().from(simulationAccounts).where(eq(simulationAccounts.id, 1)).limit(1).for("update");
      await tx.update(tradingSettings).set({ autoTrade: false }).where(eq(tradingSettings.id, 1));
      return tx.select().from(positions).where(eq(positions.status, "OPEN"));
    });
    const settled: string[] = [];
    const unsettled: { positionId: string; symbol: string; reason: string }[] = [];
    for (const row of rows) {
      try {
        const result = await closePaperPosition(row.id, "人工紧急停止");
        if (result.ok || result.alreadyClosed) settled.push(row.id);
        else unsettled.push({ positionId: row.id, symbol: row.symbol, reason: result.reason });
      } catch (error) {
        unsettled.push({ positionId: row.id, symbol: row.symbol, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    await reportEvent("WARN", "熔断", `自动交易已暂停；已结算 ${settled.length} 笔，未结算 ${unsettled.length} 笔`);
    return { ok: unsettled.length === 0, paused: true, settled, unsettled };
  }

  return { openPaperPosition, closePaperPosition, manageOpenPositions, emergencyStop, resetPaperSimulation };
}

const defaultService = createPaperService();

export const openPaperPosition = defaultService.openPaperPosition;
export const closePaperPosition = defaultService.closePaperPosition;
export const manageOpenPositions = defaultService.manageOpenPositions;
export const emergencyStop = defaultService.emergencyStop;
export const resetPaperSimulation = defaultService.resetPaperSimulation;
