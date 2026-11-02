import { describe, expect, it } from "vitest";
import { liveSubmissionPermitted } from "./livePersistence";

describe("live submission admission policy", () => {
  it("allows manual canary while autoTrade is paused without bypassing emergency generation or intent state", () => {
    expect(liveSubmissionPermitted({
      autoTrade: false,
      manualCanary: true,
      generation: 7,
      expectedGeneration: 7,
      intentStatus: "PENDING_SEND",
    })).toBe(true);
    expect(liveSubmissionPermitted({
      autoTrade: false,
      manualCanary: true,
      generation: 8,
      expectedGeneration: 7,
      intentStatus: "PENDING_SEND",
    })).toBe(false);
    expect(liveSubmissionPermitted({
      autoTrade: false,
      manualCanary: true,
      generation: 7,
      expectedGeneration: 7,
      intentStatus: "CANCEL",
    })).toBe(false);
    expect(liveSubmissionPermitted({
      autoTrade: false,
      manualCanary: false,
      generation: 7,
      expectedGeneration: 7,
      intentStatus: "PENDING_SEND",
    })).toBe(false);
  });
});
