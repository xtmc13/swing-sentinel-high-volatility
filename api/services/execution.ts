import type { Opportunity, Side, TradingSettings, VolatilityState } from "@contracts/trading";
import { createMarketSnapshot, type MarketSnapshot, type SymbolMeta } from "./binance";
import { portfolioRisk, sizePosition, type RiskPosition } from "./risk";

export interface EntryRiskPosition extends RiskPosition {
  margin: number;
}

export interface EntryApprovalInput {
  opportunity: Opportunity;
  snapshot: MarketSnapshot;
  state: VolatilityState;
  settings: TradingSettings;
  equity: number;
  usedMargin: number;
  todayPnlPct: number;
  positions: EntryRiskPosition[];
  correlations: Record<string, number | null>;
  symbolMeta: SymbolMeta;
  maxLeverage: number;
  now: number;
  currentSourceGeneration?: number;
  executionHealthy?: () => boolean;
}

export type EntryApproval =
  | { ok: false; reason: string }
  | {
      ok: true;
      fillPrice: number;
      qty: number;
      targetPrice: number;
      margin: number;
      openFee: number;
      initialRisk: number;
      liquidationPrice: number;
      leverage: number;
      estimatedRisk: number;
    };

export function liquidationPrice(entry: number, side: Side, leverage: number) {
  const maintenanceMarginRate = 0.005;
  return side === "LONG"
    ? entry * (1 - 1 / leverage + maintenanceMarginRate)
    : entry * (1 + 1 / leverage - maintenanceMarginRate);
}

export interface PricedEntryApprovalInput extends Omit<EntryApprovalInput, "snapshot"> {
  currentPrice: number;
  fillPrice: number;
  snapshotQualityValid?: boolean;
  snapshotQualityReasons?: string[];
}

function approvePricedEntry(input: PricedEntryApprovalInput, snapshot?: MarketSnapshot): EntryApproval {
  const { opportunity, state, settings } = input;
  if (!settings.autoTrade) return { ok: false, reason: "自动交易已暂停" };
  if (input.todayPnlPct <= -settings.dailyLossLimitPct) return { ok: false, reason: "当日亏损熔断已触发" };
  if (input.positions.length >= settings.maxPositions) return { ok: false, reason: "持仓数量达到上限" };
  if (input.positions.some((position) => position.symbol === opportunity.symbol)) {
    return { ok: false, reason: "同一合约已有持仓" };
  }
  if (opportunity.status !== "READY") return { ok: false, reason: "机会尚未满足进场条件" };
  if (input.currentSourceGeneration !== undefined && opportunity.sourceGeneration !== input.currentSourceGeneration) {
    return { ok: false, reason: "信号数据源代际陈旧" };
  }
  if (state.symbol !== opportunity.symbol) return { ok: false, reason: "波动状态与合约不匹配" };
  if (snapshot && (input.snapshotQualityValid === false || !snapshot.quality.valid)) {
    const reasons = [...(input.snapshotQualityReasons ?? []), ...snapshot.quality.reasons];
    return { ok: false, reason: `盘口质量不合格：${reasons.join("、")}` };
  }
  if (snapshot && (!Number.isFinite(snapshot.spreadBps) || snapshot.spreadBps > settings.maxSpreadBps)) {
    return { ok: false, reason: "盘口点差超过开仓上限" };
  }
  if (!Number.isFinite(opportunity.atr15) || !(opportunity.atr15! > 0)) {
    return { ok: false, reason: "信号 ATR15 无效" };
  }
  const deviation = Math.abs(input.currentPrice - opportunity.entry) / opportunity.entry;
  const maxDeviation = Math.max(0.001, 0.25 * opportunity.atr15! / opportunity.entry);
  if (!Number.isFinite(deviation) || deviation > maxDeviation) {
    return { ok: false, reason: "当前价格偏离信号入场价" };
  }

  const leverage = settings.leverageMode === "FIXED"
    ? Math.min(settings.fixedLeverage, input.maxLeverage)
    : input.maxLeverage;
  const sized = sizePosition({
    equity: input.equity,
    side: opportunity.side,
    entryPrice: input.fillPrice,
    stopPrice: opportunity.stop,
    leverage,
    mode: state.mode,
    riskPerTradePct: settings.riskPerTradePct,
    highVolatilityRiskMultiplier: settings.highVolatilityRiskMultiplier,
    marginPerTradePct: settings.marginPerTradePct,
    totalMarginCapPct: settings.totalMarginCapPct,
    usedMargin: input.usedMargin,
    takerFeeBps: settings.takerFeeBps,
    slippageBps: settings.slippageBps,
    stepSize: input.symbolMeta.stepSize,
    minQty: input.symbolMeta.minQty,
    minNotional: input.symbolMeta.minNotional,
    signalCloseTime: opportunity.signalCloseTime,
    signalStateVersion: opportunity.stateVersion,
    currentStateVersion: state.version,
    now: input.now,
    maxSignalAgeSeconds: settings.maxSignalAgeSeconds,
  });
  if (!sized.ok) return sized;

  const approved = portfolioRisk({
    equity: input.equity,
    positions: input.positions,
    candidate: {
      symbol: opportunity.symbol,
      side: opportunity.side,
      risk: sized.estimatedRisk,
      correlations: input.correlations,
    },
    takerFeeBps: settings.takerFeeBps,
    slippageBps: settings.slippageBps,
    portfolioStopRiskPct: settings.portfolioStopRiskPct,
    correlatedDirectionRiskPct: settings.correlatedDirectionRiskPct,
    correlationThreshold: settings.correlationThreshold,
  });
  if (!approved.approved) return { ok: false, reason: approved.reasons.join("；") };

  const estimatedLiquidation = liquidationPrice(input.fillPrice, opportunity.side, leverage);
  const liquidationBuffer = input.fillPrice * 0.0015;
  const liquidationSafe = opportunity.side === "LONG"
    ? opportunity.stop > estimatedLiquidation + liquidationBuffer
    : opportunity.stop < estimatedLiquidation - liquidationBuffer;
  if (!liquidationSafe) return { ok: false, reason: `${leverage}× 下强平缓冲不足，拒绝开仓` };
  if (input.executionHealthy && !input.executionHealthy()) {
    return { ok: false, reason: "行情监测断开，禁止开仓" };
  }

  return {
    ok: true,
    fillPrice: input.fillPrice,
    qty: sized.qty,
    targetPrice: sized.targetPrice,
    margin: sized.margin,
    openFee: sized.qty * input.fillPrice * settings.takerFeeBps / 10_000,
    initialRisk: sized.stopDistance,
    liquidationPrice: estimatedLiquidation,
    leverage,
    estimatedRisk: sized.estimatedRisk,
  };
}

export function approveHistoricalEntry(input: PricedEntryApprovalInput): EntryApproval {
  if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0
    || !Number.isFinite(input.fillPrice) || input.fillPrice <= 0) {
    return { ok: false, reason: "历史成交价格无效" };
  }
  return approvePricedEntry({ ...input, settings: { ...input.settings, autoTrade: true } });
}

export function approveAndPriceEntry(input: EntryApprovalInput): EntryApproval {
  const snapshot = createMarketSnapshot({
    source: input.snapshot.source,
    symbol: input.snapshot.symbol,
    bid: input.snapshot.bid,
    ask: input.snapshot.ask,
    markPrice: input.snapshot.markPrice,
    bookTime: input.snapshot.bookTime,
    markTime: input.snapshot.markTime,
  }, input.now, input.settings.bookStaleSeconds * 1000, input.settings.candleStaleSeconds * 1000);
  return approvePricedEntry({
    ...input,
    currentPrice: snapshot.mid,
    fillPrice: input.opportunity.side === "LONG" ? snapshot.ask : snapshot.bid,
    snapshotQualityValid: input.snapshot.quality.valid,
    snapshotQualityReasons: input.snapshot.quality.reasons,
  }, snapshot);
}
