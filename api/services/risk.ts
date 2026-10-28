import type { Candle, Side, VolatilityMode } from "@contracts/trading";

export interface SizePositionInput {
  equity: number;
  side: Side;
  entryPrice: number;
  stopPrice: number;
  leverage: number;
  mode: VolatilityMode;
  riskPerTradePct: number;
  highVolatilityRiskMultiplier: number;
  marginPerTradePct: number;
  totalMarginCapPct: number;
  usedMargin: number;
  takerFeeBps: number;
  slippageBps: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  signalCloseTime: number;
  signalStateVersion: number;
  currentStateVersion: number;
  now: number;
  maxSignalAgeSeconds: number;
}

export type PositionSize =
  | { ok: false; reason: string }
  | {
      ok: true;
      qty: number;
      riskBudget: number;
      estimatedRisk: number;
      stopDistance: number;
      targetPrice: number;
      margin: number;
    };

export function sizePosition(input: SizePositionInput): PositionSize {
  if (input.signalStateVersion !== input.currentStateVersion) return { ok: false, reason: "信号状态版本陈旧" };
  if (input.signalCloseTime > input.now || input.now - input.signalCloseTime > input.maxSignalAgeSeconds * 1000) {
    return { ok: false, reason: "信号已过期" };
  }
  if (input.mode === "EXTREME") return { ok: false, reason: "EXTREME禁止新增风险" };
  const numbers = [
    input.equity, input.entryPrice, input.stopPrice, input.leverage,
    input.riskPerTradePct, input.highVolatilityRiskMultiplier, input.marginPerTradePct, input.totalMarginCapPct,
    input.usedMargin, input.takerFeeBps, input.slippageBps,
  ];
  if (!numbers.every(Number.isFinite) || input.equity <= 0 || input.entryPrice <= 0 || input.leverage <= 0) {
    return { ok: false, reason: "仓位输入无效" };
  }
  const direction = input.side === "LONG" ? 1 : -1;
  const stopDistance = (input.entryPrice - input.stopPrice) * direction;
  if (!(stopDistance > 0)) return { ok: false, reason: "止损方向或距离无效" };

  const multiplier = input.mode === "HIGH" ? input.highVolatilityRiskMultiplier : 1;
  const riskBudget = input.equity * input.riskPerTradePct / 100 * multiplier;
  const twoSidedCostPerUnit = (input.entryPrice + input.stopPrice)
    * (input.takerFeeBps + input.slippageBps) / 10_000;
  const riskPerUnit = stopDistance + twoSidedCostPerUnit;
  const qtyByRisk = riskBudget / riskPerUnit;
  const qtyByMargin = input.equity * input.marginPerTradePct / 100 * input.leverage / input.entryPrice;
  const remainingMargin = Math.max(0, input.equity * input.totalMarginCapPct / 100 - input.usedMargin);
  const qtyByTotalMargin = remainingMargin * input.leverage / input.entryPrice;
  const rawQty = Math.min(qtyByRisk, qtyByMargin, qtyByTotalMargin);
  const qty = input.stepSize > 0
    ? Math.floor(rawQty / input.stepSize + 1e-10) * input.stepSize
    : rawQty;
  if (!Number.isFinite(qty) || qty <= 0 || qty < input.minQty || qty * input.entryPrice < input.minNotional) {
    return { ok: false, reason: "风险预算下数量低于最小下单单位或数量无效" };
  }
  return {
    ok: true,
    qty,
    riskBudget,
    estimatedRisk: qty * riskPerUnit,
    stopDistance,
    targetPrice: input.entryPrice + direction * stopDistance * 2.2,
    margin: qty * input.entryPrice / input.leverage,
  };
}

export interface RiskPosition {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  markPrice: number;
  stopPrice: number;
}

export interface PortfolioRiskInput {
  equity: number;
  positions: RiskPosition[];
  candidate?: {
    symbol: string;
    side: Side;
    risk: number;
    correlations: Record<string, number | null>;
  };
  takerFeeBps: number;
  slippageBps: number;
  portfolioStopRiskPct: number;
  correlatedDirectionRiskPct: number;
  correlationThreshold: number;
}

export interface PortfolioRiskResult {
  approved: boolean;
  reasons: string[];
  positions: { symbol: string; risk: number; breakeven: boolean }[];
  totalRisk: number;
  totalRiskPct: number;
  totalLimit: number;
  remainingTotalRisk: number;
  correlatedRisk: number;
  correlatedLimit: number;
  remainingCorrelatedRisk: number;
}

export function portfolioRisk(input: PortfolioRiskInput): PortfolioRiskResult {
  const reasons: string[] = [];
  if (!Number.isFinite(input.equity) || input.equity <= 0) reasons.push("权益必须为正有限数");
  const settings = [
    input.takerFeeBps, input.slippageBps, input.portfolioStopRiskPct,
    input.correlatedDirectionRiskPct, input.correlationThreshold,
  ];
  if (!settings.every(Number.isFinite)
    || input.takerFeeBps < 0 || input.slippageBps < 0
    || input.portfolioStopRiskPct < 0 || input.correlatedDirectionRiskPct < 0
    || input.correlationThreshold < 0 || input.correlationThreshold > 1) {
    reasons.push("组合风险设置无效");
  }

  const positions = input.positions.map((position) => {
    const values = [position.qty, position.entryPrice, position.markPrice, position.stopPrice];
    if (!values.every(Number.isFinite) || position.qty <= 0
      || position.entryPrice <= 0 || position.markPrice <= 0 || position.stopPrice <= 0) {
      reasons.push(`${position.symbol}持仓数量或价格无效`);
    }
    const direction = position.side === "LONG" ? 1 : -1;
    const breakeven = position.side === "LONG"
      ? position.stopPrice >= position.entryPrice
      : position.stopPrice <= position.entryPrice;
    if (breakeven) return { symbol: position.symbol, risk: 0, breakeven };
    const adverseDistance = Math.max(0, (position.markPrice - position.stopPrice) * direction);
    const exitCost = position.stopPrice * (input.takerFeeBps + input.slippageBps) / 10_000;
    const risk = Math.max(0, position.qty * (adverseDistance + exitCost));
    if (!Number.isFinite(risk)) reasons.push(`${position.symbol}持仓风险贡献无效`);
    return { symbol: position.symbol, risk: Number.isFinite(risk) ? risk : 0, breakeven };
  });
  const currentRisk = positions.reduce((sum, position) => sum + position.risk, 0);
  const candidateRisk = input.candidate?.risk ?? 0;
  const totalRisk = currentRisk + candidateRisk;
  const totalLimit = input.equity * input.portfolioStopRiskPct / 100;
  const correlatedLimit = input.equity * input.correlatedDirectionRiskPct / 100;
  if (!Number.isFinite(candidateRisk) || candidateRisk < 0) reasons.push("候选风险无效");

  let correlatedRisk = 0;
  if (input.candidate && input.positions.length > 0) {
    const correlations = input.positions.map((position) => input.candidate!.correlations[position.symbol]);
    if (correlations.some((value) => value === null || value === undefined || !Number.isFinite(value))) {
      reasons.push("相关收益样本不足");
    }
    const correlatedPositions = input.positions.filter((position, index) => {
      const value = correlations[index];
      return position.side === input.candidate!.side && value !== null && value !== undefined
        && Math.abs(value) >= input.correlationThreshold;
    });
    if (correlatedPositions.length > 0) {
      correlatedRisk = candidateRisk + correlatedPositions.reduce((sum, position) => {
        const index = input.positions.indexOf(position);
        return sum + positions[index].risk;
      }, 0);
    }
  }

  if (totalRisk > totalLimit) reasons.push(`组合止损风险超过${input.portfolioStopRiskPct}%上限`);
  if (correlatedRisk > correlatedLimit) reasons.push(`高相关同方向风险超过${input.correlatedDirectionRiskPct}%上限`);
  return {
    approved: reasons.length === 0,
    reasons,
    positions,
    totalRisk,
    totalRiskPct: input.equity > 0 ? totalRisk / input.equity * 100 : Number.POSITIVE_INFINITY,
    totalLimit,
    remainingTotalRisk: Math.max(0, totalLimit - totalRisk),
    correlatedRisk,
    correlatedLimit,
    remainingCorrelatedRisk: Math.max(0, correlatedLimit - correlatedRisk),
  };
}

export function correlation(a: number[], b: number[], window = 60): number | null {
  if (!Number.isInteger(window) || window < 2 || a.length !== b.length || a.length < window + 1) return null;
  const pricesA = a.slice(-(window + 1));
  const pricesB = b.slice(-(window + 1));
  const returnsA: number[] = [];
  const returnsB: number[] = [];
  for (let index = 1; index < pricesA.length; index += 1) {
    if (!(pricesA[index - 1] !== 0) || !(pricesB[index - 1] !== 0)) return null;
    const returnA = pricesA[index] / pricesA[index - 1] - 1;
    const returnB = pricesB[index] / pricesB[index - 1] - 1;
    if (!Number.isFinite(returnA) || !Number.isFinite(returnB)) return null;
    returnsA.push(returnA);
    returnsB.push(returnB);
  }
  const meanA = returnsA.reduce((sum, value) => sum + value, 0) / window;
  const meanB = returnsB.reduce((sum, value) => sum + value, 0) / window;
  let numerator = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < window; index += 1) {
    const deltaA = returnsA[index] - meanA;
    const deltaB = returnsB[index] - meanB;
    numerator += deltaA * deltaB;
    varianceA += deltaA ** 2;
    varianceB += deltaB ** 2;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 0 ? numerator / denominator : null;
}

export function alignedCorrelation(a: Candle[], b: Candle[], now: number, window = 60): number | null {
  if (!Number.isInteger(window) || window < 2 || !Number.isFinite(now)) return null;
  const closedA = a.filter((bar) => bar.closeTime <= now).sort((left, right) => left.closeTime - right.closeTime);
  const selected = closedA.slice(-(window + 1));
  if (selected.length !== window + 1) return null;
  const closedB = b.filter((bar) => bar.closeTime <= now);
  const bByTime = new Map<number, Candle>();
  for (const bar of closedB) {
    if (bByTime.has(bar.closeTime)) return null;
    bByTime.set(bar.closeTime, bar);
  }
  const left: number[] = [];
  const right: number[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const bar = selected[index];
    if (index > 0 && bar.closeTime - selected[index - 1].closeTime !== 900_000) return null;
    const other = bByTime.get(bar.closeTime);
    if (!other) return null;
    left.push(bar.close);
    right.push(other.close);
  }
  return correlation(left, right, window);
}

export interface ManagePositionPriceInput {
  side: Side;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  liquidationPrice: number;
  price: number;
  initialRisk: number;
  maxFavorableR: number;
  mode: VolatilityMode;
  dailyLossLocked: boolean;
  timedOut: boolean;
  takerFeeBps?: number;
  slippageBps?: number;
}

export interface PositionManagement {
  action: "HOLD" | "CLOSE";
  reason: string | null;
  stopPrice: number;
  maxFavorableR: number;
}

export function managePositionPrice(input: ManagePositionPriceInput): PositionManagement {
  const direction = input.side === "LONG" ? 1 : -1;
  const r = input.initialRisk > 0 ? (input.price - input.entryPrice) * direction / input.initialRisk : 0;
  const maxFavorableR = Math.max(input.maxFavorableR, r);
  let stopPrice = input.stopPrice;
  if (r >= 1) {
    const feesBuffer = input.entryPrice * ((input.takerFeeBps ?? 0) * 2 + (input.slippageBps ?? 0)) / 10_000;
    const candidate = r >= 1.5
      ? input.entryPrice + direction * input.initialRisk * 0.9
      : input.entryPrice + direction * feesBuffer;
    const improves = input.side === "LONG" ? candidate > stopPrice : candidate < stopPrice;
    if (improves) stopPrice = candidate;
  }

  const liquidationHit = input.side === "LONG" ? input.price <= input.liquidationPrice : input.price >= input.liquidationPrice;
  const stopHit = input.side === "LONG" ? input.price <= stopPrice : input.price >= stopPrice;
  const targetHit = input.side === "LONG" ? input.price >= input.targetPrice : input.price <= input.targetPrice;
  let reason: string | null = null;
  if (input.dailyLossLocked) reason = "日损熔断退出";
  else if (liquidationHit) reason = "强平保护模拟";
  else if (stopHit) reason = r >= 1 ? "保本／移动止损" : "结构止损";
  else if (targetHit) reason = "2.2R 波段目标";
  else if (input.timedOut) reason = "72 小时波段超时退出";
  return { action: reason ? "CLOSE" : "HOLD", reason, stopPrice, maxFavorableR };
}
