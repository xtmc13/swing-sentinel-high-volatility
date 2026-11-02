import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Candle, type Market, type VolatilityState } from "@contracts/trading";
import type { MomentumAcceptanceContext, MomentumFeatureFrame } from "./momentum";
import { replayMomentum, type MomentumReplayEvent } from "./momentumReplay";

const NOW = 1_800_000_000_000;
const HASH = "a".repeat(64);

function candles(count: number, intervalMs: number, end = NOW - 1_000): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.02;
    const time = end - (count - index) * intervalMs;
    return { time, closeTime: time + intervalMs - 1, open: close - 0.02, high: close + 0.5, low: close - 0.5, close, volume: 100 };
  });
}

function context(): MomentumAcceptanceContext {
  const market: Market = {
    symbol: "BTCUSDT", baseAsset: "BTC", price: 100.02, markPrice: 100.02, change24h: 1,
    quoteVolume: 100_000_000, spreadBps: 1, fundingRate: 0, high24h: 110, low24h: 90,
    maxLeverage: 20, liquidityScore: 90, eligible: true, filterReason: "",
  };
  const state: VolatilityState = {
    symbol: "BTCUSDT", mode: "NORMAL", confirmationCount: 0, stableSince: null,
    metrics: { atrQuantile: 0.8, tickSigma: 1, spreadRatio: 1 }, lastDataAt: NOW, version: 7,
  };
  return {
    market,
    state,
    sourceGeneration: 3,
    candles4h: candles(200, 4 * 60 * 60_000),
    candles1h: candles(200, 60 * 60_000),
    candles15m: candles(60, 15 * 60_000),
    candles1m: [
      { time: NOW - 120_000, closeTime: NOW - 60_001, open: 99.9, high: 100, low: 99.8, close: 99.9, volume: 10 },
      { time: NOW - 60_000, closeTime: NOW - 1, open: 99.9, high: 100, low: 99.8, close: 99.9, volume: 10 },
    ],
    volatilityP80: 0.01,
  };
}

function frame(sequence: number, eventTime: number): MomentumFeatureFrame {
  return {
    symbol: "BTCUSDT",
    event_time: eventTime,
    received_time: eventTime + 10,
    sequence,
    generation: 4,
    quality: "GOOD",
    config_hash: HASH,
    mark_price: 100.02,
    microprice: 100.02,
    spread_bps: 1,
    depth_imbalance: 0.2,
    aggressive_buy_volume: 3,
    aggressive_sell_volume: 1,
    short_return: 0.001,
    burst_z: 2.5,
    realized_volatility: 0.02,
  };
}

const settings = { ...DEFAULT_SETTINGS, autoTrade: true, momentumEnabled: true, strategyMode: "MOMENTUM" as const };

describe("timestamped momentum replay", () => {
  it("requires two consecutive feature frames and suppresses duplicate sequence candidates", () => {
    const events: MomentumReplayEvent[] = [
      { type: "feature_frame", frame: frame(1, NOW - 100) },
      { type: "feature_frame", frame: frame(2, NOW - 20) },
      { type: "feature_frame", frame: frame(2, NOW - 20) },
    ];
    const result = replayMomentum({ events, context: context(), settings });
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ signalId: expect.stringContaining("BTCUSDT:4:2:LONG"), entry: 100.02 });
    expect(result.dataGaps).toEqual([]);
  });

  it("requires consecutive frames to confirm the same side", () => {
    const shortFrame = {
      ...frame(2, NOW - 20),
      depth_imbalance: -0.2,
      aggressive_buy_volume: 1,
      aggressive_sell_volume: 3,
      short_return: -0.001,
    };
    const result = replayMomentum({
      events: [
        { type: "feature_frame", frame: frame(1, NOW - 100) },
        { type: "feature_frame", frame: shortFrame },
        { type: "feature_frame", frame: frame(3, NOW - 10) },
      ],
      context: context(),
      settings,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("ignores older generations without breaking the current generation confirmation", () => {
    const result = replayMomentum({
      events: [
        { type: "feature_frame", frame: frame(1, NOW - 100) },
        { type: "feature_frame", frame: { ...frame(1, NOW - 50), generation: 3 } },
        { type: "feature_frame", frame: frame(2, NOW - 20) },
      ],
      context: context(),
      settings,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ signalId: expect.stringContaining("BTCUSDT:4:2:LONG") });
  });

  it("matches Rust by resetting confirmation for a fully nonqualifying GOOD frame", () => {
    const result = replayMomentum({
      events: [
        { type: "feature_frame", frame: { ...frame(1, NOW - 100), depth_imbalance: 0.1 } },
        { type: "feature_frame", frame: frame(2, NOW - 20) },
      ],
      context: context(),
      settings,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("uses the Rust ten-second flow window", () => {
    const result = replayMomentum({
      events: [
        { type: "trade", eventTime: NOW - 6_000, price: 100, quantity: 3, isBuyerMaker: false },
        {
          type: "order_book", eventTime: NOW - 6_000, receivedTime: NOW - 5_990, sequence: 1, generation: 4,
          markPrice: 100, bid: { price: 99.99, quantity: 3 }, ask: { price: 100.01, quantity: 1 },
        },
        {
          type: "order_book", eventTime: NOW, receivedTime: NOW + 10, sequence: 2, generation: 4,
          markPrice: 100.02, bid: { price: 100.01, quantity: 3 }, ask: { price: 100.03, quantity: 1 },
        },
      ],
      context: context(),
      settings,
    });

    expect(result.frames[1]).toMatchObject({ aggressive_buy_volume: 3, aggressive_sell_volume: 0 });
  });

  it("resets confirmation after a feature-stream gap instead of accepting stale continuation", () => {
    const result = replayMomentum({
      events: [
        { type: "feature_frame", frame: frame(1, NOW - 5_000) },
        { type: "feature_frame", frame: frame(2, NOW - 4_000) },
        { type: "feature_frame", frame: frame(3, NOW - 20) },
      ],
      context: context(),
      settings,
    });
    expect(result.accepted).toEqual([]);
    expect(result.dataGaps).toHaveLength(2);
  });

  it("builds feature frames from timestamped trades and order books without using 5m candles", () => {
    const result = replayMomentum({
      events: [
        { type: "trade", eventTime: NOW - 1_000, price: 100, quantity: 2, isBuyerMaker: false },
        { type: "trade", eventTime: NOW - 1_000, price: 100, quantity: 1, isBuyerMaker: true },
        {
          type: "order_book", eventTime: NOW - 1_000, receivedTime: NOW - 990, sequence: 1, generation: 4,
          markPrice: 100, bid: { price: 99.99, quantity: 3 }, ask: { price: 100.01, quantity: 1 },
        },
        { type: "trade", eventTime: NOW - 20, price: 100.02, quantity: 4, isBuyerMaker: false },
        {
          type: "order_book", eventTime: NOW - 20, receivedTime: NOW - 10, sequence: 2, generation: 4,
          markPrice: 100.02, bid: { price: 100.01, quantity: 3 }, ask: { price: 100.03, quantity: 1 },
        },
      ],
      context: { ...context(), volatilityP80: 0 },
      settings,
    });
    expect(result.frames).toHaveLength(2);
    expect(result.frames[1]).toMatchObject({
      event_time: NOW - 20,
      received_time: NOW - 10,
      sequence: 2,
      generation: 4,
      microprice: 100.025,
      depth_imbalance: 0.5,
      aggressive_buy_volume: 6,
      aggressive_sell_volume: 1,
      quality: "GOOD",
    });
    expect(result.assumptions.join(" ")).toContain("不代表 5m");
  });
});
