import { describe, expect, it } from "vitest";
import type { Candle } from "@contracts/trading";
import { momentumProtectionStop } from "./momentumProtection";

const NOW = 1_800_000_000_000;

function candles(count = 35): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const time = NOW - (count - index) * 900_000;
    return {
      time: time / 1000,
      closeTime: time + 900_000 - 1,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 100,
    };
  });
}

describe("动能衰竭收紧候选价", () => {
  it("LONG 使用标记价减 ATR 与五根结构缓冲中更严格的值", () => {
    expect(momentumProtectionStop({ side: "LONG", markPrice: 105, candles15m: candles(), now: NOW })).toBe(104);
  });

  it("SHORT 使用标记价加 ATR 与五根结构缓冲中更严格的值", () => {
    expect(momentumProtectionStop({ side: "SHORT", markPrice: 95, candles15m: candles(), now: NOW })).toBe(96);
  });

  it("缺少有效标记价、ATR或新鲜已收盘数据时拒绝计算", () => {
    expect(momentumProtectionStop({ side: "LONG", markPrice: 0, candles15m: candles(), now: NOW })).toBeNull();
    expect(momentumProtectionStop({ side: "LONG", markPrice: 105, candles15m: [], now: NOW })).toBeNull();
    expect(momentumProtectionStop({ side: "LONG", markPrice: 105, candles15m: candles(), now: NOW + 46 * 60_000 })).toBeNull();
  });
});
