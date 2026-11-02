import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import { tradingSettings } from "@db/schema";
import { settingsFromRow } from "./trading";

function row(overrides: Partial<typeof tradingSettings.$inferSelect> = {}): typeof tradingSettings.$inferSelect {
  return {
    ...DEFAULT_SETTINGS,
    id: 1,
    updatedAt: new Date(1_800_000_000_000),
    ...overrides,
  };
}

describe("交易设置持久化契约", () => {
  it("完整行保留执行与策略配置", () => {
    expect(settingsFromRow(row({
      executionMode: "LIVE_MAINNET",
      strategyMode: "BOTH",
      momentumEnabled: true,
    }))).toEqual({
      ...DEFAULT_SETTINGS,
      executionMode: "LIVE_MAINNET",
      strategyMode: "BOTH",
      momentumEnabled: true,
    });
  });

  it("旧行或非法执行值失败关闭到 PAPER/SWING/momentum off", () => {
    const legacy = row({
      executionMode: undefined as never,
      strategyMode: "unexpected",
      momentumEnabled: undefined as never,
    });

    expect(settingsFromRow(legacy)).toMatchObject({
      executionMode: "PAPER",
      strategyMode: "SWING",
      momentumEnabled: false,
    });
  });
});
