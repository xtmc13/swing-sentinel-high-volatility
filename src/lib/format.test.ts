import { describe, expect, it } from "vitest";
import { formatMissedMessages } from "./format";

describe("WebSocket 丢包指标展示", () => {
  it("不可用时显示 N/A 而不是测量值 0", () => {
    expect(formatMissedMessages(null)).toBe("N/A");
    expect(formatMissedMessages(null)).not.toBe("0 条");
  });

  it("保留未来可用计数和当前其他数值指标的展示语义", () => {
    expect(formatMissedMessages(0)).toBe("0 条");
    expect(formatMissedMessages(3)).toBe("3 条");
  });
});
