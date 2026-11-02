import { describe, expect, it, vi } from "vitest";
import { createLiveAdapter, createLiveAdmissionGuard, getLivePublicStatus, liveTradingEnabled } from "./liveConfig";

const credentials = {
  BINANCE_MAINNET_API_KEY: "fake-key",
  BINANCE_MAINNET_API_SECRET: "fake-secret",
};

describe("live configuration", () => {
  it("enables live trading only for the exact string true", () => {
    expect(liveTradingEnabled({ LIVE_TRADING_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "True", " true", "true ", "1"]) {
      expect(liveTradingEnabled({ LIVE_TRADING_ENABLED: value })).toBe(false);
    }
  });

  it("publishes only a credentialsConfigured boolean", () => {
    expect(getLivePublicStatus({})).toEqual({ credentialsConfigured: false });
    expect(getLivePublicStatus({ BINANCE_MAINNET_API_KEY: "fake-key" })).toEqual({ credentialsConfigured: false });
    expect(getLivePublicStatus(credentials)).toEqual({ credentialsConfigured: true });
    expect(JSON.stringify(getLivePublicStatus(credentials))).not.toContain("fake-key");
    expect(JSON.stringify(getLivePublicStatus(credentials))).not.toContain("fake-secret");
  });

  it("does not invoke the adapter factory without both credentials", () => {
    const factory = vi.fn();
    for (const env of [
      { LIVE_TRADING_ENABLED: "true" },
      { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key" },
      { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_SECRET: "fake-secret" },
      { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: " ", BINANCE_MAINNET_API_SECRET: "fake-secret" },
    ]) {
      expect(() => createLiveAdapter(env, factory)).toThrow("Live adapter is disabled or credentials are not configured");
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not invoke the adapter factory when the global switch is off", () => {
    const factory = vi.fn();
    expect(() => createLiveAdapter({ ...credentials, LIVE_TRADING_ENABLED: "TRUE" }, factory))
      .toThrow("Live adapter is disabled or credentials are not configured");
    expect(factory).not.toHaveBeenCalled();
  });

  it("constructs through the injected factory only when all gates pass", () => {
    const adapter = { kind: "fake-live-adapter" };
    const factory = vi.fn().mockReturnValue(adapter);
    expect(createLiveAdapter({ ...credentials, LIVE_TRADING_ENABLED: "true" }, factory)).toBe(adapter);
    expect(factory).toHaveBeenCalledWith({ apiKey: "fake-key", apiSecret: "fake-secret" });
  });

  it("admission guard reevaluates current env and fresh preflight without caching", async () => {
    let enabled = "true";
    let checkedAt = 1_800_000_000_000;
    const preflight = vi.fn(async () => ({ ready: true, reasons: [], checkedAt: new Date(checkedAt).toISOString() }));
    const guard = createLiveAdmissionGuard(
      { get LIVE_TRADING_ENABLED() { return enabled; } },
      preflight,
      () => 1_800_000_001_000,
    );

    await expect(guard()).resolves.toBeUndefined();
    enabled = "false";
    await expect(guard()).rejects.toThrow("LIVE_TRADING_ENABLED");
    enabled = "true";
    checkedAt = 1_799_999_900_000;
    await expect(guard()).rejects.toThrow("预检");
    expect(preflight).toHaveBeenCalledTimes(2);
  });
});
