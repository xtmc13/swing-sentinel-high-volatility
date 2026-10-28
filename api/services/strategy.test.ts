import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Candle, type Market } from "@contracts/trading";
import { analyzeClosedCandles } from "./strategy";

const NOW = 1_800_000_000_000;

function market(): Market {
  return {
    symbol: "TESTUSDT",
    baseAsset: "TEST",
    price: 108.41,
    markPrice: 108.41,
    change24h: 2,
    quoteVolume: 100_000_000,
    spreadBps: 1,
    fundingRate: 0,
    high24h: 110,
    low24h: 100,
    maxLeverage: 20,
    liquidityScore: 90,
    eligible: true,
    filterReason: "流动性合格",
  };
}

function candle(close: number, closeTime: number, high = close + 0.01, low = close - 0.01): Candle {
  return { time: closeTime / 1000 - 300, closeTime, open: close - 0.01, high, low, close, volume: 100 };
}

function series(count: number, start: number, step: number, endCloseTime: number, intervalMs = 300_000): Candle[] {
  return Array.from({ length: count }, (_, index) =>
    candle(start + index * step, endCloseTime - (count - 1 - index) * intervalMs),
  );
}

function validCandles() {
  const candles4h = series(220, 100, 0.1, NOW - 1_440_000, 14_400_000);
  const candles1h = series(220, 100, 0.1, NOW - 3_600_000, 3_600_000);
  const candles15m = series(60, 100, 0.25, NOW - 900_000, 900_000);
  const last15 = candles15m.at(-1)!;
  candles15m[candles15m.length - 1] = candle(last15.close, last15.closeTime, last15.close + 0.2, last15.close - 3);
  const candles5m = Array.from({ length: 30 }, (_, index) =>
    candle(100 + index * index * 0.01, NOW - 300_000 - (29 - index) * 300_000),
  );
  return { candles4h, candles1h, candles15m, candles5m };
}

function input() {
  return {
    market: market(),
    settings: { ...DEFAULT_SETTINGS },
    ...validCandles(),
    now: NOW,
    stateVersion: 7,
  };
}

describe("已收盘 K 线正式信号", () => {
  it("样本只有计入未收盘 K 线才足够时仍失败关闭", () => {
    const fixtures = input();
    fixtures.candles4h = fixtures.candles4h.slice(1);
    fixtures.candles5m = fixtures.candles5m.slice(1);
    const result = analyzeClosedCandles(fixtures);
    fixtures.candles4h.push(candle(999, NOW + 14_400_000));
    fixtures.candles5m.push(candle(999, NOW + 300_000));

    const blocked = analyzeClosedCandles(fixtures);

    expect(result.status).toBe("BLOCKED");
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.reasons).toContain("已收盘K线不足，禁止前瞻判断");
  });

  it("已收盘 5M 突破可形成 READY，并携带信号收盘时间和状态版本", () => {
    const result = analyzeClosedCandles(input());

    expect(result.status).toBe("READY");
    expect(result.side).toBe("LONG");
    expect(result.signalCloseTime).toBe(NOW - 300_000);
    expect(result.stateVersion).toBe(7);
    expect(result.createdAt).toBe(new Date(NOW).toISOString());
  });

  it("未收盘 5M 的反向剧烈价格不参与正式入场判断", () => {
    const fixtures = input();
    const closedResult = analyzeClosedCandles(fixtures);
    fixtures.candles5m.push(candle(1, NOW + 300_000, 1_000, 0.5));

    const result = analyzeClosedCandles(fixtures);

    expect(result.status).toBe("READY");
    expect(result.signalCloseTime).toBe(closedResult.signalCloseTime);
    expect(result.entry).toBe(closedResult.entry);
  });
});
