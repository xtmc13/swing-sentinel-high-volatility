import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatCompact,
  formatMissedMessages,
  formatNumber,
  formatPercent,
  formatPrice,
  formatSignedNumber,
  formatTime,
} from "./format";

describe("不可用数值的固定零值展示", () => {
  it("数值格式化器使用对应精度的零，不输出 NaN 或占位符", () => {
    expect(formatNumber(Number.NaN)).toBe("0.00");
    expect(formatNumber(Number.POSITIVE_INFINITY, 0)).toBe("0");
    expect(formatSignedNumber(0, false)).toBe("0.00");
    expect(formatSignedNumber(Number.NaN, false)).toBe("0.00");
    expect(formatPrice(Number.NaN)).toBe("0.0000000");
    expect(formatPrice(0)).toBe("0.0000000");
    expect(formatCompact(Number.NaN)).toBe("0");
    expect(formatPercent(Number.NaN)).toBe("+0.00%");
    expect(formatAge(null)).toBe("0 ms");
    expect(formatMissedMessages(null)).toBe("0 条");
    expect(formatTime(null)).toBe("0");
    expect(formatTime("invalid")).toBe("0");
  });

  it("保留可用数值的展示语义", () => {
    expect(formatMissedMessages(0)).toBe("0 条");
    expect(formatMissedMessages(3)).toBe("3 条");
    expect(formatSignedNumber(0, true)).toBe("0.00");
    expect(formatSignedNumber(2, true)).toBe("+2.00");
  });
});
