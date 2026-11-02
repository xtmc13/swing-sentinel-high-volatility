import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type Candle,
  type Market,
  type TradingSettings,
  type VolatilityState,
} from "@contracts/trading";
import {
  evaluateMomentumCandidate,
  evaluateMomentumExit,
  isLoopbackRemoteAddress,
  type MomentumAcceptanceContext,
  type MomentumCandidate,
} from "./momentum";

const NOW = 1_800_000_000_000;
const HASH = "a".repeat(64);

function candles(count: number, intervalMs: number, direction: 1 | -1, end = NOW): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + direction * index * 0.02;
    const time = end - (count - index) * intervalMs;
    return {
      time,
      closeTime: time + intervalMs - 1,
      open: close - direction * 0.02,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 100,
    };
  });
}

function flatBreakoutCandles(): Candle[] {
  return [
    { time: NOW - 120_000, closeTime: NOW - 60_001, open: 99.9, high: 100, low: 99.8, close: 99.9, volume: 10 },
    { time: NOW - 60_000, closeTime: NOW - 1, open: 99.9, high: 100, low: 99.8, close: 99.9, volume: 10 },
  ];
}

function candidate(overrides: Record<string, unknown> = {}): MomentumCandidate {
  const frame = {
    symbol: "BTCUSDT",
    event_time: NOW - 20,
    received_time: NOW - 10,
    sequence: 2,
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
  return {
    candidate_id: "BTCUSDT:4:2:LONG",
    symbol: "BTCUSDT",
    side: "LONG",
    reference_price: 100.02,
    created_time: NOW - 10,
    expires_at: NOW + 740,
    frame,
    ...overrides,
  } as MomentumCandidate;
}

function context(overrides: Partial<MomentumAcceptanceContext> = {}): MomentumAcceptanceContext {
  const market: Market = {
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    price: 100.02,
    markPrice: 100.02,
    change24h: 1,
    quoteVolume: 100_000_000,
    spreadBps: 1,
    fundingRate: 0,
    high24h: 110,
    low24h: 90,
    maxLeverage: 20,
    liquidityScore: 90,
    eligible: true,
    filterReason: "",
  };
  const state: VolatilityState = {
    symbol: "BTCUSDT",
    mode: "NORMAL",
    confirmationCount: 0,
    stableSince: null,
    metrics: { atrQuantile: 0.8, tickSigma: 1, spreadRatio: 1 },
    lastDataAt: NOW,
    version: 7,
  };
  return {
    market,
    state,
    sourceGeneration: 3,
    candles4h: candles(200, 4 * 60 * 60_000, 1),
    candles1h: candles(200, 60 * 60_000, 1),
    candles15m: candles(60, 15 * 60_000, 1),
    candles1m: flatBreakoutCandles(),
    volatilityP80: 0.01,
    ...overrides,
  };
}

function settings(overrides: Partial<TradingSettings> = {}): TradingSettings {
  return {
    ...DEFAULT_SETTINGS,
    autoTrade: true,
    momentumEnabled: true,
    strategyMode: "MOMENTUM",
    ...overrides,
  };
}

describe("momentum candidate acceptance", () => {
  it("keeps momentum disabled by default", () => {
    const result = evaluateMomentumCandidate({ candidate: candidate(), context: context(), settings: DEFAULT_SETTINGS, now: NOW });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("关闭") });
  });

  it("accepts an early long breakout with an IOC limit inside both chase caps", () => {
    const result = evaluateMomentumCandidate({ candidate: candidate(), context: context(), settings: settings(), now: NOW });
    expect(result).toMatchObject({
      ok: true,
      opportunity: {
        strategyType: "MOMENTUM",
        side: "LONG",
        status: "READY",
        entry: 100.02,
        triggerPrice: 100.02,
        limitPrice: 100.04,
        sourceGeneration: 3,
        stateVersion: 7,
      },
    });
  });

  it("expires a late candidate beyond the 4 bps chase cap", () => {
    const late = candidate({ reference_price: 100.05, frame: { ...candidate().frame, mark_price: 100.05, microprice: 100.05 } });
    const result = evaluateMomentumCandidate({ candidate: late, context: context(), settings: settings(), now: NOW });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("追价") });
  });

  it("expires a candidate beyond the 0.10 ATR cap even inside the bps cap", () => {
    const smallAtr = candles(60, 15 * 60_000, 1).map((bar, index) => ({
      ...bar,
      high: bar.close + 0.075,
      low: bar.close - (index === 59 ? 0.2 : 0.075),
    }));
    const late = candidate({ reference_price: 100.025, frame: { ...candidate().frame, mark_price: 100.025, microprice: 100.025 } });
    const result = evaluateMomentumCandidate({
      candidate: late,
      context: context({ candles15m: smallAtr }),
      settings: settings(),
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("ATR") });
  });

  it("rejects a candidate that has not cleared the prior 120 second barrier plus 1 bps", () => {
    const early = candidate({ reference_price: 100.005, frame: { ...candidate().frame, mark_price: 100.005, microprice: 100.005 } });
    const result = evaluateMomentumCandidate({ candidate: early, context: context(), settings: settings(), now: NOW });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("突破") });
  });

  it("mirrors breakout, flow, depth, and chase rules for shorts", () => {
    const short = candidate({
      candidate_id: "BTCUSDT:4:2:SHORT",
      side: "SHORT",
      reference_price: 99.78,
      frame: {
        ...candidate().frame,
        mark_price: 99.78,
        microprice: 99.78,
        depth_imbalance: -0.2,
        aggressive_buy_volume: 1,
        aggressive_sell_volume: 3,
        short_return: -0.001,
      },
    });
    const result = evaluateMomentumCandidate({
      candidate: short,
      context: context({
        candles4h: candles(200, 4 * 60 * 60_000, -1),
        candles1h: candles(200, 60 * 60_000, -1),
        candles15m: candles(60, 15 * 60_000, -1),
      }),
      settings: settings(),
      now: NOW,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result).toMatchObject({ ok: true, opportunity: { side: "SHORT", entry: 99.78, limitPrice: 99.76008 } });
  });

  it("accepts one-sided aggressive flow and rejects a genuinely interrupted rolling window", () => {
    const oneSided = candidate({ frame: { ...candidate().frame, aggressive_sell_volume: 0 } });
    expect(evaluateMomentumCandidate({ candidate: oneSided, context: context(), settings: settings(), now: NOW }))
      .toMatchObject({ ok: true });

    const staleCandles = flatBreakoutCandles().map((bar) => ({
      ...bar,
      time: bar.time - 120_000,
      closeTime: bar.closeTime - 120_000,
    }));
    expect(evaluateMomentumCandidate({
      candidate: candidate(), context: context({ candles1m: staleCandles }), settings: settings(), now: NOW,
    })).toMatchObject({ ok: false, reason: expect.stringContaining("断流") });
  });

  it("rejects incoherent reference prices and spreads beyond current execution settings", () => {
    const mismatch = candidate({ reference_price: 100.03 });
    expect(evaluateMomentumCandidate({ candidate: mismatch, context: context(), settings: settings(), now: NOW }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("价格") });

    const wide = candidate({ frame: { ...candidate().frame, spread_bps: 4 } });
    expect(evaluateMomentumCandidate({ candidate: wide, context: context(), settings: settings(), now: NOW }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("点差") });
  });

  it("fails closed on stale feature data and refuses new EXTREME risk", () => {
    const stale = evaluateMomentumCandidate({
      candidate: candidate({ frame: { ...candidate().frame, quality: "STALE" } }),
      context: context(), settings: settings(), now: NOW,
    });
    expect(stale).toMatchObject({ ok: false });

    const expired = evaluateMomentumCandidate({ candidate: candidate(), context: context(), settings: settings(), now: NOW + 741 });
    expect(expired).toMatchObject({ ok: false, reason: expect.stringContaining("过期") });

    const current = context();
    current.state.mode = "EXTREME";
    const extreme = evaluateMomentumCandidate({ candidate: candidate(), context: current, settings: settings(), now: NOW });
    expect(extreme).toMatchObject({ ok: false, reason: expect.stringContaining("EXTREME") });
  });
});

describe("momentum fast exits", () => {
  const base = {
    symbol: "BTCUSDT",
    side: "LONG" as const,
    entryPrice: 100.02,
    price: 100.02,
    breakoutPrice: 100,
    openedAt: NOW - 120_000,
    now: NOW,
    frame: null,
  };

  it("exits after 120 seconds without directional follow-through", () => {
    expect(evaluateMomentumExit(base)).toBe("120 秒无跟随退出");
    expect(evaluateMomentumExit({ ...base, openedAt: NOW - 119_999 })).toBeNull();
    expect(evaluateMomentumExit({ ...base, price: 100.03 })).toBeNull();
  });

  it("exits a failed breakout only when aggressive flow has reversed", () => {
    const reversed = {
      ...candidate().frame,
      aggressive_buy_volume: 1,
      aggressive_sell_volume: 3,
    };
    expect(evaluateMomentumExit({ ...base, openedAt: NOW, price: 99.99, frame: reversed }))
      .toBe("跌回突破位且流向反转");
    expect(evaluateMomentumExit({ ...base, openedAt: NOW, price: 99.99, frame: candidate().frame })).toBeNull();
    expect(evaluateMomentumExit({ ...base, openedAt: NOW, price: 100.01, frame: reversed })).toBeNull();
  });

  it("mirrors failed-breakout exits for shorts and ignores stale frames", () => {
    const reversed = {
      ...candidate().frame,
      aggressive_buy_volume: 3,
      aggressive_sell_volume: 1,
    };
    const short = { ...base, side: "SHORT" as const, openedAt: NOW, price: 100.01 };
    expect(evaluateMomentumExit({ ...short, frame: reversed })).toBe("跌回突破位且流向反转");
    expect(evaluateMomentumExit({ ...short, frame: { ...reversed, quality: "STALE" as const } })).toBeNull();
  });
});

describe("internal momentum ingress", () => {
  it("accepts only literal loopback peer addresses", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("127.255.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
    expect(isLoopbackRemoteAddress("localhost")).toBe(false);
    expect(isLoopbackRemoteAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackRemoteAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackRemoteAddress("::ffff:10.0.0.1")).toBe(false);
  });
});
