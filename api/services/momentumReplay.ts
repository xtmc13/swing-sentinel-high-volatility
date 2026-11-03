import { createHash } from "node:crypto";
import type { Opportunity, TradingSettings } from "@contracts/trading";
import {
  DEFAULT_MOMENTUM_CONFIG,
  evaluateMomentumCandidate,
  momentumFeatureFrameSchema,
  qualifiedMomentumSide,
  type MomentumAcceptanceContext,
  type MomentumCandidate,
  type MomentumConfig,
  type MomentumFeatureFrame,
} from "./momentum";

export interface ReplayTrade {
  type: "trade";
  eventTime: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
}

export interface ReplayMark {
  type: "mark";
  eventTime: number;
  price: number;
}

export interface ReplayOrderBook {
  type: "order_book";
  eventTime: number;
  receivedTime: number;
  sequence: number;
  generation: number;
  markPrice?: number;
  bid: { price: number; quantity: number };
  ask: { price: number; quantity: number };
}

export type MomentumReplayEvent =
  | ReplayTrade
  | ReplayMark
  | ReplayOrderBook
  | { type: "feature_frame"; frame: MomentumFeatureFrame };

export interface MomentumReplayResult {
  accepted: Opportunity[];
  rejected: { time: number; reason: string }[];
  frames: MomentumFeatureFrame[];
  dataGaps: string[];
  assumptions: string[];
}

export interface MomentumReplayInput {
  events: MomentumReplayEvent[];
  context: MomentumAcceptanceContext;
  settings: TradingSettings;
  config?: MomentumConfig;
}

interface TimedTrade {
  eventTime: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
}

interface TimedMark {
  eventTime: number;
  price: number;
}

class ReplayFeatureEngine {
  private trades: TimedTrade[] = [];
  private marks: TimedMark[] = [];
  private overflow = false;

  constructor(private readonly config: MomentumConfig, private readonly configHash: string) {}

  pushTrade(trade: ReplayTrade) {
    if (this.trades.length >= 50_000) {
      this.overflow = true;
      return;
    }
    this.trades.push({ ...trade });
  }

  pushMark(mark: ReplayMark) {
    if (this.marks.length >= 2_000) this.overflow = true;
    else this.marks.push({ eventTime: mark.eventTime, price: mark.price });
  }

  build(book: ReplayOrderBook): MomentumFeatureFrame {
    const cutoff = book.eventTime - this.config.rollingWindowMs;
    this.trades = this.trades.filter((trade) => trade.eventTime >= cutoff);
    this.marks = this.marks.filter((mark) => mark.eventTime >= cutoff);
    const validBook = [book.bid.price, book.bid.quantity, book.ask.price, book.ask.quantity]
      .every(Number.isFinite) && book.bid.price > 0 && book.ask.price > 0
      && book.bid.quantity > 0 && book.ask.quantity > 0;
    const quantitySum = book.bid.quantity + book.ask.quantity;
    const mid = (book.bid.price + book.ask.price) / 2;
    const microprice = validBook
      ? (book.ask.price * book.bid.quantity + book.bid.price * book.ask.quantity) / quantitySum
      : null;
    const spread = validBook && mid > 0 ? (book.ask.price - book.bid.price) / mid * 10_000 : null;
    const imbalance = validBook ? (book.bid.quantity - book.ask.quantity) / quantitySum : null;
    const flowCutoff = book.eventTime - this.config.flowWindowMs;
    const returnCutoff = book.eventTime - this.config.returnWindowMs;
    let buy = 0;
    let sell = 0;
    for (const trade of this.trades) {
      if (trade.eventTime < flowCutoff || trade.eventTime > book.eventTime) continue;
      if (trade.isBuyerMaker) sell += trade.quantity;
      else buy += trade.quantity;
    }
    const marks = this.marks.filter((mark) => mark.eventTime >= returnCutoff && mark.eventTime <= book.eventTime);
    const shortReturn = marks.length >= 2 && marks[0].price > 0
      ? marks.at(-1)!.price / marks[0].price - 1
      : null;
    const returns = marks.slice(1).map((mark, index) => Math.log(mark.price / marks[index].price));
    const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
    const volatility = returns.length
      ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length)
      : null;
    const buckets = new Map<number, number>();
    for (const trade of this.trades) {
      const bucket = Math.floor(trade.eventTime / 1_000);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + trade.quantity);
    }
    const currentBucket = Math.floor(book.eventTime / 1_000);
    const current = buckets.get(currentBucket) ?? 0;
    const baseline = [...buckets].filter(([bucket]) => bucket < currentBucket).map(([, value]) => value);
    const baselineMean = baseline.length ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length : 0;
    const deviation = baseline.length
      ? Math.sqrt(baseline.reduce((sum, value) => sum + (value - baselineMean) ** 2, 0) / baseline.length)
      : 0;
    const burst = !baseline.length ? current
      : deviation > Number.EPSILON ? (current - baselineMean) / deviation
        : baselineMean > Number.EPSILON ? (current - baselineMean) / baselineMean : current;
    const stale = book.receivedTime < book.eventTime || book.receivedTime - book.eventTime > this.config.signalTtlMs;
    const quality = this.overflow ? "HISTORY_OVERFLOW"
      : stale ? "STALE"
        : !validBook ? "ONE_SIDED"
          : book.bid.price >= book.ask.price ? "CROSSED"
            : marks.length < 3 || shortReturn === null || volatility === null ? "INSUFFICIENT_HISTORY" : "GOOD";
    return {
      symbol: "",
      event_time: book.eventTime,
      received_time: book.receivedTime,
      sequence: book.sequence,
      generation: book.generation,
      quality,
      config_hash: this.configHash,
      mark_price: marks.at(-1)?.price ?? null,
      microprice,
      spread_bps: spread,
      depth_imbalance: imbalance,
      aggressive_buy_volume: buy,
      aggressive_sell_volume: sell,
      short_return: shortReturn,
      burst_z: burst,
      realized_volatility: volatility,
    };
  }
}

class ReplayCandidateDetector {
  private generation = 0;
  private sequence = 0;
  private lastEventTime: number | null = null;
  private streak = 0;
  private streakSide: "LONG" | "SHORT" | null = null;
  private configHash: string | null = null;

  constructor(private readonly config: MomentumConfig, private readonly gaps: string[]) {}

  observe(frame: MomentumFeatureFrame): MomentumCandidate | null {
    if (frame.generation < this.generation) return null;
    if (this.lastEventTime !== null && frame.event_time - this.lastEventTime > this.config.signalTtlMs) {
      this.streak = 0;
      this.gaps.push(`${frame.symbol}: feature gap ${frame.event_time - this.lastEventTime}ms at ${frame.event_time}`);
    }
    this.lastEventTime = frame.event_time;
    if (frame.generation !== this.generation || frame.config_hash !== this.configHash) {
      this.generation = frame.generation;
      this.configHash = frame.config_hash;
      this.sequence = 0;
      this.streak = 0;
    }
    if (frame.sequence <= this.sequence) return null;
    this.sequence = frame.sequence;
    const side = qualifiedMomentumSide(frame, this.config);
    if (!side) {
      this.streak = 0;
      this.streakSide = null;
      return null;
    }
    this.streak = this.streakSide === side ? this.streak + 1 : 1;
    this.streakSide = side;
    if (this.streak < 2) return null;
    this.streak = 0;
    this.streakSide = null;
    return {
      candidate_id: `${frame.symbol}:${frame.generation}:${frame.sequence}:${side}`,
      symbol: frame.symbol,
      side,
      reference_price: frame.mark_price ?? frame.microprice ?? 0,
      created_time: frame.received_time,
      expires_at: frame.received_time + this.config.signalTtlMs,
      frame,
    };
  }
}

function eventTime(event: MomentumReplayEvent) {
  return event.type === "feature_frame" ? event.frame.event_time : event.eventTime;
}

function validFiniteEvent(event: MomentumReplayEvent) {
  if (event.type === "feature_frame") return momentumFeatureFrameSchema.safeParse(event.frame).success;
  if (event.type === "trade") {
    return [event.eventTime, event.price, event.quantity].every(Number.isFinite)
      && event.eventTime >= 0 && event.price > 0 && event.quantity > 0;
  }
  if (event.type === "mark") {
    return [event.eventTime, event.price].every(Number.isFinite) && event.eventTime >= 0 && event.price > 0;
  }
  return [event.eventTime, event.receivedTime, event.bid.price, event.bid.quantity, event.ask.price, event.ask.quantity]
    .every(Number.isFinite) && event.eventTime >= 0 && event.sequence > 0 && event.generation > 0;
}

function eventKindRank(event: MomentumReplayEvent): number {
  return event.type === "feature_frame" ? 2 : event.type === "order_book" ? 1 : 0;
}

export function replayMomentum(input: MomentumReplayInput): MomentumReplayResult {
  const config = input.config ?? DEFAULT_MOMENTUM_CONFIG;
  const configHash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const features = new ReplayFeatureEngine(config, configHash);
  const detector = new ReplayCandidateDetector(config, []);
  const gaps = (detector as unknown as { gaps: string[] }).gaps;
  const frames: MomentumFeatureFrame[] = [];
  const accepted: Opportunity[] = [];
  const rejected: { time: number; reason: string }[] = [];
  const ordered = input.events.map((event, index) => ({ event, index }))
    .sort((left, right) => eventTime(left.event) - eventTime(right.event)
      || eventKindRank(left.event) - eventKindRank(right.event)
      || left.index - right.index);
  for (const { event } of ordered) {
    if (!validFiniteEvent(event)) {
      rejected.push({ time: eventTime(event), reason: "replay 事件无效" });
      detector.observe({
        symbol: input.context.market.symbol,
        event_time: eventTime(event), received_time: eventTime(event), sequence: 0, generation: 1,
        quality: "STALE", config_hash: configHash, mark_price: null, microprice: null, spread_bps: null,
        depth_imbalance: null, aggressive_buy_volume: 0, aggressive_sell_volume: 0, short_return: null,
        burst_z: null, realized_volatility: null,
      });
      continue;
    }
    if (event.type === "trade") {
      features.pushTrade(event);
      continue;
    }
    if (event.type === "mark") {
      features.pushMark(event);
      continue;
    }
    const frame = event.type === "order_book"
      ? { ...features.build(event), symbol: input.context.market.symbol }
      : event.frame;
    if (frame.symbol !== input.context.market.symbol) {
      rejected.push({ time: frame.event_time, reason: "replay 合约与上下文不匹配" });
      continue;
    }
    frames.push(frame);
    const candidate = detector.observe(frame);
    if (!candidate) continue;
    const evaluation = evaluateMomentumCandidate({
      candidate,
      context: input.context,
      settings: input.settings,
      now: frame.received_time,
      config,
    });
    if (evaluation.ok) accepted.push(evaluation.opportunity);
    else rejected.push({ time: frame.received_time, reason: evaluation.reason });
  }
  return {
    accepted,
    rejected,
    frames,
    dataGaps: gaps,
    assumptions: [
      "按 trade、order-book、feature-frame 原始时间戳排序并重放；不使用 5m K 线重建微结构。",
      "Replay 结果不代表 5m 回测一致性，也不证明成交、费用或盈利能力。",
    ],
  };
}
