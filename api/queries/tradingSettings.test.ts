import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type PositionView } from "@contracts/trading";
import { tradingSettings } from "@db/schema";
import { settingsInput } from "../tradingRouter";
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

  it("ACCOUNT_CONFIGURED 通过 RPC 校验且序列化不丢失", () => {
    expect(settingsInput.parse({ ...DEFAULT_SETTINGS, leverageMode: "ACCOUNT_CONFIGURED" }).leverageMode)
      .toBe("ACCOUNT_CONFIGURED");
    expect(settingsFromRow(row({ leverageMode: "ACCOUNT_CONFIGURED" })).leverageMode)
      .toBe("ACCOUNT_CONFIGURED");
  });

  it("PAPER 新默认值显式保留 SYMBOL_MAX", () => {
    expect(DEFAULT_SETTINGS.executionMode).toBe("PAPER");
    expect(DEFAULT_SETTINGS.leverageMode).toBe("SYMBOL_MAX");
  });

  it("PositionView 暴露完整持仓兼容状态", () => {
    const state: Pick<PositionView,
      "entrySemantics" | "maintenanceBracket" | "maintMarginRatio" | "cumMaintenance"
      | "accountModeFingerprint" | "compatibilityFrozen"> = {
      entrySemantics: "ENTRY",
      maintenanceBracket: 2,
      maintMarginRatio: "0.02",
      cumMaintenance: "10",
      accountModeFingerprint: "0123456789abcdef",
      compatibilityFrozen: false,
    };

    expect(state).toEqual({
      entrySemantics: "ENTRY",
      maintenanceBracket: 2,
      maintMarginRatio: "0.02",
      cumMaintenance: "10",
      accountModeFingerprint: "0123456789abcdef",
      compatibilityFrozen: false,
    });
  });
});
