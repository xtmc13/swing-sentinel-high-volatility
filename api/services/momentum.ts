import { z } from "zod";
import type {
  Candle,
  Market,
  Opportunity,
  TradingSettings,
  VolatilityState,
} from "@contracts/trading";
import { atrSeries, closedCandles, emaSeries } from "./indicators";

const finite = z.number().finite();
const positive = finite.positive();
const nonNegative = finite.nonnegative();

export const momentumFeatureFrameSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{1,20}$/),
  event_time: z.number().int().nonnegative(),
  received_time: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  generation: z.number().int().positive(),
  quality: z.enum(["GOOD", "STALE", "ONE_SIDED", "CROSSED", "INSUFFICIENT_HISTORY", "HISTORY_OVERFLOW"]),
  config_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  mark_price: positive.nullable(),
  microprice: positive.nullable(),
  spread_bps: nonNegative.nullable(),
  depth_imbalance: finite.min(-1).max(1).nullable(),
  aggressive_buy_volume: nonNegative,
  aggressive_sell_volume: nonNegative,
  short_return: finite.nullable(),
  burst_z: finite.nullable(),
  realized_volatility: nonNegative.nullable(),
}).strict();

export const momentumCandidateSchema = z.object({
  candidate_id: z.string().min(1).max(128),
  symbol: z.string().regex(/^[A-Z0-9]{1,20}$/),
  side: z.enum(["LONG", "SHORT"]),
  reference_price: positive,
  created_time: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  frame: momentumFeatureFrameSchema,
}).strict();

export type MomentumFeatureFrame = z.infer<typeof momentumFeatureFrameSchema>;
export type MomentumCandidate = z.infer<typeof momentumCandidateSchema>;

export interface MomentumAcceptanceContext {
  market: Market;
  state: VolatilityState;
  sourceGeneration: number;
  candles4h: Candle[];
  candles1h: Candle[];
  candles15m: Candle[];
  candles1m: Candle[];
  volatilityP80: number;
}

export interface MomentumConfig {
  rollingWindowMs: number;
  breakoutBufferBps: number;
  maxChaseBps: number;
  maxChaseAtr: number;
  minDepthImbalance: number;
  minAggressiveRatio: number;
  minBurstZ: number;
  signalTtlMs: number;
  maxReplacements: number;
  noFollowExitMs: number;
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized === "::1") return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? normalized;
  const parts = ipv4.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part)
    && Number(part) >= 0 && Number(part) <= 255) && parts[0] === "127";
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  rollingWindowMs: 120_000,
  breakoutBufferBps: 1,
  maxChaseBps: 4,
  maxChaseAtr: 0.1,
  minDepthImbalance: 0.15,
  minAggressiveRatio: 1.5,
  minBurstZ: 2,
  signalTtlMs: 750,
  maxReplacements: 1,
  noFollowExitMs: 120_000,
};

export type MomentumEvaluation =
  | { ok: true; opportunity: Opportunity }
  | { ok: false; reason: string };

export interface EvaluateMomentumCandidateInput {
  candidate: MomentumCandidate;
  context: MomentumAcceptanceContext;
  settings: TradingSettings;
  now: number;
  config?: MomentumConfig;
}

function reject(reason: string): MomentumEvaluation {
  return { ok: false, reason };
}

function directionalRatio(sameSide: number, oppositeSide: number) {
  return oppositeSide === 0 ? sameSide > 0 ? Number.POSITIVE_INFINITY : 0 : sameSide / oppositeSide;
}

export interface MomentumExitInput {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  price: number;
  breakoutPrice: number;
  openedAt: number;
  now: number;
  frame: MomentumFeatureFrame | null;
  config?: MomentumConfig;
}

export function evaluateMomentumExit(input: MomentumExitInput): string | null {
  const config = input.config ?? DEFAULT_MOMENTUM_CONFIG;
  const direction = input.side === "LONG" ? 1 : -1;
  if (![input.entryPrice, input.price, input.breakoutPrice, input.openedAt, input.now].every(Number.isFinite)
    || input.entryPrice <= 0 || input.price <= 0 || input.breakoutPrice <= 0) return null;
  if (input.now - input.openedAt >= config.noFollowExitMs
    && (input.price - input.entryPrice) * direction <= 0) return "120 秒无跟随退出";
  if (!input.frame) return null;
  const parsed = momentumFeatureFrameSchema.safeParse(input.frame);
  if (!parsed.success) return null;
  const frame = parsed.data;
  if (frame.symbol !== input.symbol || frame.quality !== "GOOD"
    || frame.received_time < frame.event_time || input.now < frame.event_time
    || input.now - frame.event_time > config.signalTtlMs
    || input.now - frame.received_time > config.signalTtlMs) return null;
  if ((input.price - input.breakoutPrice) * direction > 0) return null;
  const sameSide = input.side === "LONG" ? frame.aggressive_buy_volume : frame.aggressive_sell_volume;
  const opposite = input.side === "LONG" ? frame.aggressive_sell_volume : frame.aggressive_buy_volume;
  const reversed = sameSide === 0 ? opposite > 0 : opposite / sameSide >= config.minAggressiveRatio;
  return reversed ? "跌回突破位且流向反转" : null;
}

export function evaluateMomentumCandidate(input: EvaluateMomentumCandidateInput): MomentumEvaluation {
  const parsed = momentumCandidateSchema.safeParse(input.candidate);
  if (!parsed.success) return reject("动量候选格式无效");
  const candidate = parsed.data;
  const { context, settings, now } = input;
  const config = input.config ?? DEFAULT_MOMENTUM_CONFIG;
  const direction = candidate.side === "LONG" ? 1 : -1;
  if (!settings.momentumEnabled || settings.strategyMode === "SWING") return reject("动量模式已关闭");
  if (!Number.isFinite(now) || candidate.created_time !== candidate.frame.received_time
    || candidate.expires_at <= candidate.created_time
    || candidate.expires_at - candidate.created_time > config.signalTtlMs
    || now < candidate.frame.event_time || now > candidate.expires_at) return reject("动量信号已过期");
  if (candidate.frame.received_time < candidate.frame.event_time
    || now - candidate.frame.event_time > config.signalTtlMs
    || now - candidate.frame.received_time > config.signalTtlMs) return reject("动量特征数据断流或陈旧");
  if (candidate.symbol !== candidate.frame.symbol || context.market.symbol !== candidate.symbol
    || context.state.symbol !== candidate.symbol) return reject("动量候选合约不匹配");
  if (candidate.frame.quality !== "GOOD") return reject("动量特征质量不合格");
  if (context.state.mode === "EXTREME") return reject("EXTREME禁止新增风险");
  if (!context.market.eligible) return reject("合约不具备开仓资格");

  const frame = candidate.frame;
  const required = [frame.mark_price, frame.microprice, frame.spread_bps, frame.depth_imbalance,
    frame.short_return, frame.burst_z, frame.realized_volatility];
  if (required.some((value) => value === null)) return reject("动量特征不完整");
  if (candidate.reference_price !== frame.mark_price) return reject("候选参考价格与特征标记价格不一致");
  if (frame.spread_bps! > settings.maxSpreadBps) return reject("动量特征点差超过开仓上限");
  const depth = frame.depth_imbalance!;
  const sameSideFlow = candidate.side === "LONG" ? frame.aggressive_buy_volume : frame.aggressive_sell_volume;
  const oppositeFlow = candidate.side === "LONG" ? frame.aggressive_sell_volume : frame.aggressive_buy_volume;
  if (depth * direction < config.minDepthImbalance
    || !directionalRatio(sameSideFlow, oppositeFlow)
    || directionalRatio(sameSideFlow, oppositeFlow) < config.minAggressiveRatio
    || frame.burst_z! < config.minBurstZ
    || frame.short_return! * direction <= 0) return reject("深度、主动量、burst 或短期方向未确认");
  if (!Number.isFinite(context.volatilityP80) || context.volatilityP80 < 0
    || frame.realized_volatility! < context.volatilityP80) return reject("波动未达到 P80 确认阈值");

  const c4h = closedCandles(context.candles4h, now);
  const c1h = closedCandles(context.candles1h, now);
  const c15m = closedCandles(context.candles15m, now);
  const c1m = closedCandles(context.candles1m, now);
  if (c4h.length < 200 || c1h.length < 200 || c15m.length < 60 || c1m.length < 1) {
    return reject("高周期或滚动窗口数据不足");
  }
  const e4h50 = emaSeries(c4h.map((bar) => bar.close), 50).at(-1)!;
  const e4h200 = emaSeries(c4h.map((bar) => bar.close), 200).at(-1)!;
  const e1h50 = emaSeries(c1h.map((bar) => bar.close), 50).at(-1)!;
  const e1h200 = emaSeries(c1h.map((bar) => bar.close), 200).at(-1)!;
  const price1h = c1h.at(-1)!.close;
  const aligned = candidate.side === "LONG"
    ? c4h.at(-1)!.close > e4h50 && e4h50 > e4h200 && price1h > e1h50 && e1h50 > e1h200
    : c4h.at(-1)!.close < e4h50 && e4h50 < e4h200 && price1h < e1h50 && e1h50 < e1h200;
  if (!aligned) return reject("4H／1H 方向不一致");

  const close15 = c15m.map((bar) => bar.close);
  const ema1520 = emaSeries(close15, 20).at(-1)!;
  const ema1550 = emaSeries(close15, 50).at(-1)!;
  const atr15 = atrSeries(c15m, 14).at(-1)!;
  const last15 = c15m.at(-1)!;
  const structured = Number.isFinite(atr15) && atr15 > 0 && (candidate.side === "LONG"
    ? last15.close > ema1550 && last15.low <= ema1520 + atr15 * 0.45
    : last15.close < ema1550 && last15.high >= ema1520 - atr15 * 0.45);
  if (!structured) return reject("15M 结构不一致");

  const rolling = c1m.filter((bar) => bar.closeTime > now - config.rollingWindowMs);
  if (!rolling.length || now - rolling.at(-1)!.closeTime > 60_000 + config.signalTtlMs) {
    return reject("滚动突破窗口断流");
  }
  const breakoutLevel = candidate.side === "LONG"
    ? Math.max(...rolling.map((bar) => bar.high))
    : Math.min(...rolling.map((bar) => bar.low));
  const breakoutTrigger = breakoutLevel * (1 + direction * config.breakoutBufferBps / 10_000);
  if ((candidate.reference_price - breakoutTrigger) * direction < 0) return reject("尚未突破前序滚动阻力／支撑与 buffer");

  const bpsLimit = breakoutLevel * (1 + direction * config.maxChaseBps / 10_000);
  const atrLimit = breakoutLevel + direction * atr15 * config.maxChaseAtr;
  const limitPrice = candidate.side === "LONG" ? Math.min(bpsLimit, atrLimit) : Math.max(bpsLimit, atrLimit);
  if ((candidate.reference_price - limitPrice) * direction > 1e-12) {
    const cap = (candidate.reference_price - bpsLimit) * direction > 1e-12 ? "4bps 追价" : "0.10 ATR 追价";
    return reject(`${cap}上限已超过，信号过期`);
  }

  const structureBars = c15m.slice(-12);
  const structuralStop = candidate.side === "LONG"
    ? Math.min(...structureBars.map((bar) => bar.low)) - atr15 * 0.1
    : Math.max(...structureBars.map((bar) => bar.high)) + atr15 * 0.1;
  let stop = candidate.side === "LONG"
    ? Math.max(structuralStop, candidate.reference_price - atr15 * 1.6)
    : Math.min(structuralStop, candidate.reference_price + atr15 * 1.6);
  if (candidate.side === "LONG" && stop >= candidate.reference_price) stop = candidate.reference_price - atr15 * 1.2;
  if (candidate.side === "SHORT" && stop <= candidate.reference_price) stop = candidate.reference_price + atr15 * 1.2;
  const stopDistance = (candidate.reference_price - stop) * direction;
  if (!(stopDistance > 0) || !Number.isFinite(stopDistance)) return reject("真实触发价止损重算无效");
  const target = candidate.reference_price + direction * stopDistance * 2.2;

  return {
    ok: true,
    opportunity: {
      id: candidate.candidate_id,
      signalId: `MOMENTUM:${candidate.candidate_id}:${context.sourceGeneration}:${candidate.frame.config_hash}`,
      strategyType: "MOMENTUM",
      symbol: candidate.symbol,
      side: candidate.side,
      status: "READY",
      score: 100,
      regime: "早期放量突破",
      entry: candidate.reference_price,
      stop,
      target,
      stopDistancePct: stopDistance / candidate.reference_price * 100,
      rewardRisk: 2.2,
      leverage: settings.leverageMode === "FIXED"
        ? Math.min(settings.fixedLeverage, context.market.maxLeverage)
        : context.market.maxLeverage,
      marginPct: settings.marginPerTradePct,
      riskPct: settings.riskPerTradePct,
      reasons: ["4H／1H 方向与 15M 结构一致", "120 秒突破、深度、主动量、burst 与 P80 波动确认"],
      signalCloseTime: candidate.created_time,
      signalTime: candidate.created_time,
      expiryTime: candidate.expires_at,
      triggerPrice: candidate.reference_price,
      limitPrice: Number(limitPrice.toFixed(12)),
      breakoutPrice: breakoutLevel,
      stateVersion: context.state.version,
      sourceGeneration: context.sourceGeneration,
      detectorVersion: "rust-public-momentum-v1",
      configVersion: candidate.frame.config_hash,
      atr15,
      createdAt: new Date(candidate.created_time).toISOString(),
    },
  };
}
