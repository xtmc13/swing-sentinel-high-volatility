import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/trading";
import { evaluateMomentumExhaustion } from "./momentumExhaustion";

const NOW = 1_800_000_000_000;

function series(count: number, interval: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.12 + Math.sin(index / 3) * 0.2;
    const time = NOW - (count - index) * interval;
    return {
      time: time / 1000,
      closeTime: time + interval - 1,
      open: close - 0.04,
      high: close + 0.18,
      low: close - 0.18,
      close,
      volume: 1000 + (index % 7) * 20,
    };
  });
}

describe("15m／1h／4h 动能枯竭引擎", () => {
  it("三个周期均只使用已收盘K线，并对不足样本失败关闭", () => {
    const result = evaluateMomentumExhaustion({
      side: "LONG",
      candles15m: series(34, 900_000),
      candles1h: series(80, 3_600_000),
      candles4h: series(80, 14_400_000),
      now: NOW,
    });

    expect(result.score).toBe(0);
    expect(result.resonant).toBe(false);
    expect(result.protection).toBe("NONE");
    expect(result.timeframes.map((item) => item.ready)).toEqual([false, true, true]);
  });

  it("未来未收盘K线不会改变当前衰竭评分或保护建议", () => {
    const candles15m = series(80, 900_000);
    const candles1h = series(80, 3_600_000);
    const candles4h = series(80, 14_400_000);
    const base = evaluateMomentumExhaustion({ side: "LONG", candles15m, candles1h, candles4h, now: NOW });
    const future = (bars: Candle[], interval: number) => [
      ...bars,
      { ...bars.at(-1)!, time: NOW / 1000, closeTime: NOW + interval, open: 1, high: 2, low: 0.5, close: 1, volume: 1e12 },
    ];
    const withFuture = evaluateMomentumExhaustion({
      side: "LONG",
      candles15m: future(candles15m, 900_000),
      candles1h: future(candles1h, 3_600_000),
      candles4h: future(candles4h, 14_400_000),
      now: NOW,
    });

    expect(withFuture.score).toBe(base.score);
    expect(withFuture.protection).toBe(base.protection);
    expect(withFuture.timeframes).toEqual(base.timeframes);
  });

  it("输出分数、周期确认数和保护等级均处于定义范围", () => {
    const result = evaluateMomentumExhaustion({
      side: "SHORT",
      candles15m: series(120, 900_000),
      candles1h: series(120, 3_600_000),
      candles4h: series(120, 14_400_000),
      now: NOW,
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.resonanceCount).toBeGreaterThanOrEqual(0);
    expect(result.resonanceCount).toBeLessThanOrEqual(3);
    expect(["NONE", "WARN", "TIGHTEN", "REDUCE_CANDIDATE", "EXIT_CANDIDATE"]).toContain(result.protection);
  });
});
