import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/trading";
import { classifyMomentumProtection, evaluateMomentumExhaustion } from "./momentumExhaustion";

const NOW = 1_800_000_000_000;

function series(count: number, interval: number, decelerating = false): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = decelerating
      ? 100 + 20 * (1 - Math.exp(-index / 5))
      : 100 + index * 0.12 + Math.sin(index / 3) * 0.2;
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

  it("多头仓位使用空头衰竭评分，空头仓位使用多头衰竭评分", () => {
    const candles = {
      candles15m: series(120, 900_000, true),
      candles1h: series(120, 3_600_000, true),
      candles4h: series(120, 14_400_000, true),
    };
    const long = evaluateMomentumExhaustion({ side: "LONG", ...candles, now: NOW });
    const short = evaluateMomentumExhaustion({ side: "SHORT", ...candles, now: NOW });

    expect(long.score).toBe(15);
    expect(short.score).toBe(20);
  });

  it("按30/50/70阈值和共振等级分类，EXIT优先级最高", () => {
    expect(classifyMomentumProtection(29, 0, false, true)).toBe("NONE");
    expect(classifyMomentumProtection(30, 0, false, true)).toBe("WARN");
    expect(classifyMomentumProtection(50, 1, false, true)).toBe("WARN");
    expect(classifyMomentumProtection(50, 2, false, true)).toBe("TIGHTEN");
    expect(classifyMomentumProtection(70, 2, false, true)).toBe("REDUCE_CANDIDATE");
    expect(classifyMomentumProtection(70, 2, true, true)).toBe("EXIT_CANDIDATE");
    expect(classifyMomentumProtection(100, 3, true, false)).toBe("NONE");
  });

  it.each([
    ["乱序", (bars: Candle[]) => [bars[1], bars[0], ...bars.slice(2)]],
    ["重复", (bars: Candle[]) => [bars[0], bars[0], ...bars.slice(1)]],
    ["缺口", (bars: Candle[]) => bars.filter((_bar, index) => index !== 10)],
    ["非法OHLC", (bars: Candle[]) => bars.map((bar, index) => index === 20 ? { ...bar, high: bar.low - 1 } : bar)],
  ])("15m %s 数据失败关闭，不产生保护动作", (_name, corrupt) => {
    const result = evaluateMomentumExhaustion({
      side: "LONG",
      candles15m: corrupt(series(80, 900_000)),
      candles1h: series(80, 3_600_000),
      candles4h: series(80, 14_400_000),
      now: NOW,
    });

    expect(result.score).toBe(0);
    expect(result.protection).toBe("NONE");
    expect(result.timeframes[0]?.ready).toBe(false);
  });

  it.each([
    ["15m", 46 * 60_000],
    ["1h", 181 * 60_000],
    ["4h", 541 * 60_000],
  ])("%s 最新收盘数据陈旧时失败关闭", (timeframe, age) => {
    const candles = {
      candles15m: series(80, 900_000),
      candles1h: series(80, 3_600_000),
      candles4h: series(80, 14_400_000),
    };
    const key = `candles${timeframe}` as keyof typeof candles;
    const last = candles[key].at(-1)!;
    candles[key][candles[key].length - 1] = { ...last, time: last.time - age / 1000, closeTime: last.closeTime - age };
    for (let index = 0; index < candles[key].length - 1; index += 1) {
      candles[key][index] = { ...candles[key][index], closeTime: candles[key][index + 1].time * 1000 - 1 };
    }

    const result = evaluateMomentumExhaustion({ side: "LONG", ...candles, now: NOW });

    expect(result.protection).toBe("NONE");
    expect(result.score).toBe(0);
  });
});
