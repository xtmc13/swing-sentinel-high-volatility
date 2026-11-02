import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import { paperExecutionModeAllowed } from "./paper";

describe("paper 执行模式锁内复核", () => {
  it("只有 PAPER 可以提交 paper open", () => {
    expect(paperExecutionModeAllowed({ ...DEFAULT_SETTINGS, executionMode: "PAPER" })).toBe(true);
    expect(paperExecutionModeAllowed({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" })).toBe(false);
  });
});
