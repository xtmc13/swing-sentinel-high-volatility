import { describe, expect, it } from "vitest";
import { liveSubmissionPermitted } from "./livePersistence";

describe("live submission admission policy", () => {
  it("allows manual canary while autoTrade is paused without bypassing emergency generation or intent state", () => {
    expect(liveSubmissionPermitted({
      armed: true,
      executionMode: "LIVE_MAINNET",
      autoTrade: false,
      manualCanary: true,
      generation: 7,
      expectedGeneration: 7,
      intentStatus: "PENDING_SEND",
    })).toBe(true);
    expect(liveSubmissionPermitted({
      armed: true,
      executionMode: "LIVE_MAINNET",
      autoTrade: false,
      manualCanary: true,
      generation: 8,
      expectedGeneration: 7,
      intentStatus: "PENDING_SEND",
    })).toBe(false);
    expect(liveSubmissionPermitted({
      armed: true,
      executionMode: "LIVE_MAINNET",
      autoTrade: false,
      manualCanary: true,
      generation: 7,
      expectedGeneration: 7,
      intentStatus: "CANCEL",
    })).toBe(false);
    expect(liveSubmissionPermitted({
      armed: true,
      executionMode: "LIVE_MAINNET",
      autoTrade: false,
      manualCanary: false,
      generation: 7,
      expectedGeneration: 7,
      intentStatus: "PENDING_SEND",
    })).toBe(false);
  });

  it("requires current armed and LIVE_MAINNET under the same admission decision", () => {
    const current = {
      armed: true,
      executionMode: "LIVE_MAINNET",
      autoTrade: true,
      manualCanary: false,
      generation: 7,
      expectedGeneration: 7,
      intentStatus: "PENDING_SEND",
    };
    expect(liveSubmissionPermitted({ ...current, armed: false })).toBe(false);
    expect(liveSubmissionPermitted({ ...current, executionMode: "PAPER" })).toBe(false);
  });
});
