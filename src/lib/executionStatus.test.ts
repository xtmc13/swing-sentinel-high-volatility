import { describe, expect, it } from "vitest";
import { executionEngineActive } from "./executionStatus";

describe("execution engine activity", () => {
  it("uses autoTrade for paper but all current gates for live", () => {
    expect(executionEngineActive(
      { executionMode: "PAPER", autoTrade: true },
      { canSubmit: false },
    )).toBe(true);
    expect(executionEngineActive(
      { executionMode: "LIVE_MAINNET", autoTrade: true },
      { canSubmit: false },
    )).toBe(false);
    expect(executionEngineActive(
      { executionMode: "LIVE_MAINNET", autoTrade: true },
      { canSubmit: true },
    )).toBe(true);
    expect(executionEngineActive(
      { executionMode: "LIVE_MAINNET", autoTrade: false },
      { canSubmit: true },
    )).toBe(false);
  });
});
