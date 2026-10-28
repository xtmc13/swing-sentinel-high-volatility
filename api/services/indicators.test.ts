import { describe, expect, it } from "vitest";
import { atrSeries, closedCandles, emaSeries, maxDrawdown, roundToStep } from "./indicators";
import type { Candle } from "@contracts/trading";

const candle = (close: number, closeTime: number, high = close + 1, low = close - 1): Candle => ({
  time: closeTime / 1000 - 60, closeTime, open: close, high, low, close, volume: 10,
});

describe("交易指标与时间边界", () => {
  it("常量序列的 EMA 保持不变", () => {
    expect(emaSeries([10, 10, 10, 10], 20)).toEqual([10, 10, 10, 10]);
  });

  it("ATR 纳入前收盘价造成的跳空", () => {
    const rows = [candle(100, 60_000, 101, 99), candle(110, 120_000, 111, 109)];
    expect(atrSeries(rows, 14)[1]).toBe(6.5);
  });

  it("未收盘K线不得进入信号计算", () => {
    const rows = [candle(100, Date.now() - 60_000), candle(101, Date.now() + 60_000)];
    expect(closedCandles(rows)).toHaveLength(1);
  });

  it("数量步长只向下取整", () => {
    expect(roundToStep(0.0129, 0.001)).toBeCloseTo(0.012);
    expect(roundToStep(0.0129, 0.005)).toBeCloseTo(0.01);
  });

  it("最大回撤按历史权益峰值计算", () => {
    expect(maxDrawdown([100, 120, 90, 110, 80])).toBeCloseTo(33.3333, 3);
  });
});
