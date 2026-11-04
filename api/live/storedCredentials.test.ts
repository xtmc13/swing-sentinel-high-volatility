import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import { encryptBinanceCredentials, decryptBinanceCredentials } from "../credentials/credentialCrypto";
import {
  createStoredLiveAdapter,
  hasConfiguredLiveCredentials,
  type LiveCredentials,
} from "./liveConfig";
import { createBinanceProductionLiveServicesFromStore } from "./productionServices";
import { InMemoryLiveOrderStore } from "./orderStateMachine";
import { InMemoryReconciliationStore } from "./reconciliation";
import { InMemoryAccountingStore } from "./accounting";
import type { LiveDatabase } from "./livePersistence";

const clientConstruction = vi.hoisted(() => ({ credentials: [] as LiveCredentials[] }));
vi.mock("./binanceSigned", async (importOriginal) => {
  const original = await importOriginal<typeof import("./binanceSigned")>();
  return {
    ...original,
    BinanceSignedClient: class {
      constructor(credentials: LiveCredentials) { clientConstruction.credentials.push(credentials); }
      async positionSide() { return { dualSidePosition: false }; }
      async multiAssetsMargin() { return { multiAssetsMargin: false }; }
    },
  };
});

const stored = { apiKey: "S".repeat(64), apiSecret: "t".repeat(64) };
const fromEnv = { apiKey: "E".repeat(64), apiSecret: "v".repeat(64) };
const masterKey = Buffer.alloc(32, 31).toString("base64");

describe("stored live credential resolution", () => {
  it("constructs an adapter from stored credentials when no env pair exists", async () => {
    const adapter = { kind: "stored" };
    const factory = vi.fn(() => adapter);

    await expect(createStoredLiveAdapter(
      { LIVE_TRADING_ENABLED: "true" },
      async () => stored,
      factory,
    )).resolves.toBe(adapter);
    expect(factory).toHaveBeenCalledWith(stored);
  });

  it("uses a complete env pair first without reading storage", async () => {
    const load = vi.fn(async () => stored);
    const factory = vi.fn((credentials: LiveCredentials) => credentials);

    await expect(createStoredLiveAdapter({
      LIVE_TRADING_ENABLED: "true",
      BINANCE_MAINNET_API_KEY: fromEnv.apiKey,
      BINANCE_MAINNET_API_SECRET: fromEnv.apiSecret,
    }, load, factory)).resolves.toEqual(fromEnv);
    expect(load).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledWith(fromEnv);
  });

  it("uses storage for a partial env pair", async () => {
    await expect(createStoredLiveAdapter({
      LIVE_TRADING_ENABLED: "true",
      BINANCE_MAINNET_API_KEY: fromEnv.apiKey,
    }, async () => stored, (credentials) => credentials)).resolves.toBe(stored);
  });

  it("fails closed when stored decryption fails and never invokes the factory", async () => {
    const factory = vi.fn();

    await expect(createStoredLiveAdapter(
      { LIVE_TRADING_ENABLED: "true" },
      async () => { throw new Error("CREDENTIAL_ENCRYPTION_KEY must contain exactly 32 bytes as base64 or 64 hexadecimal characters"); },
      factory,
    )).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not read storage when the global live switch is off", async () => {
    const load = vi.fn(async () => stored);
    const factory = vi.fn();

    await expect(createStoredLiveAdapter({}, load, factory))
      .rejects.toThrow("Live adapter is disabled or credentials are not configured");
    expect(load).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("publishes only configured status from storage", async () => {
    const status = await hasConfiguredLiveCredentials({}, async () => ({ configured: true }));

    expect(status).toEqual({ credentialsConfigured: true });
    expect(JSON.stringify(status)).not.toContain(stored.apiKey);
    expect(JSON.stringify(status)).not.toContain(stored.apiSecret);
  });

  it("feeds decrypted stored credentials into the production signed client without starting services", async () => {
    clientConstruction.credentials.length = 0;
    const encrypted = encryptBinanceCredentials(stored, { CREDENTIAL_ENCRYPTION_KEY: masterKey });
    const services = await createBinanceProductionLiveServicesFromStore({
      env: {
        LIVE_TRADING_ENABLED: "true",
        CREDENTIAL_ENCRYPTION_KEY: masterKey,
        BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: {} as LiveDatabase,
      getSettings: async () => ({ ...DEFAULT_SETTINGS }),
      orderStore: new InMemoryLiveOrderStore(),
      reconciliationStore: new InMemoryReconciliationStore(),
      accountingStore: new InMemoryAccountingStore(),
    }, async () => decryptBinanceCredentials(encrypted, { CREDENTIAL_ENCRYPTION_KEY: masterKey }));

    expect(clientConstruction.credentials).toEqual([stored]);
    expect(services.reconciliation.health().running).toBe(false);
    expect(services.privateWs.health().running).toBe(false);
  });
});
