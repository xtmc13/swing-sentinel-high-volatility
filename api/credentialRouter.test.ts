import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { BinanceCredentialStore } from "./credentials/binanceCredentialStore";
import { createCredentialRouter } from "./credentialRouter";
import { credentialBodyLimit } from "./lib/httpLimits";
import { log } from "./lib/logger";

const credentials = { apiKey: "A".repeat(64), apiSecret: "b".repeat(64) };

function setup(overrides: Partial<BinanceCredentialStore> = {}) {
  const store: BinanceCredentialStore = {
    status: vi.fn(async () => ({ configured: false })),
    save: vi.fn(async () => ({ configured: true })),
    delete: vi.fn(async () => ({ configured: false })),
    ...overrides,
  };
  const invalidate = vi.fn(async () => undefined);
  const router = createCredentialRouter(store, invalidate);
  const caller = router.createCaller({
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
  return { caller, store, router, invalidate };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Binance credential API", () => {
  it("reads only the configured boolean", async () => {
    const { caller } = setup({ status: async () => ({ configured: true }) });

    expect(await caller.status()).toEqual({ configured: true });
  });

  it("saves and replaces credentials with only a configured response", async () => {
    const { caller, store } = setup();

    expect(await caller.save(credentials)).toEqual({ configured: true });
    expect(store.save).toHaveBeenCalledWith(credentials);
  });

  it("deletes credentials with only a configured response", async () => {
    const { caller, store } = setup();

    expect(await caller.delete()).toEqual({ configured: false });
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it("invalidates before and after writes so a concurrent request cannot retain old credentials", async () => {
    const { caller, store, invalidate } = setup();
    const saveOrder = () => (store.save as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const deleteOrder = () => (store.delete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];

    await caller.save(credentials);
    await caller.delete();

    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(saveOrder());
    expect(invalidate.mock.invocationCallOrder[1]).toBeGreaterThan(saveOrder());
    expect(invalidate.mock.invocationCallOrder[2]).toBeLessThan(deleteOrder());
    expect(invalidate.mock.invocationCallOrder[3]).toBeGreaterThan(deleteOrder());
  });

  it.each([
    { apiKey: "short", apiSecret: credentials.apiSecret },
    { apiKey: credentials.apiKey, apiSecret: "short" },
    { apiKey: `${"A".repeat(63)}!`, apiSecret: credentials.apiSecret },
    { apiKey: credentials.apiKey, apiSecret: `${"b".repeat(63)}_` },
    { apiKey: "A".repeat(65), apiSecret: credentials.apiSecret },
    { apiKey: 7, apiSecret: credentials.apiSecret },
    { ...credentials, armed: true },
    { ...credentials, autoTrade: true },
  ])("rejects malformed input or live-gate fields before storage", async (input) => {
    const { caller, store } = setup();

    await expect(caller.save(input as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("returns a clear safe error when the server master key is missing", async () => {
    const { caller } = setup({
      save: async () => {
        throw new Error("CREDENTIAL_ENCRYPTION_KEY must contain exactly 32 bytes as base64 or 64 hexadecimal characters");
      },
    });

    await expect(caller.save(credentials)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "CREDENTIAL_ENCRYPTION_KEY must contain exactly 32 bytes as base64 or 64 hexadecimal characters",
    });
  });

  it("does not expose credentials through internal errors or server logs", async () => {
    const logError = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const { caller } = setup({
      save: async () => { throw new Error(`database rejected ${credentials.apiSecret}`); },
    });

    const failure = await caller.save(credentials).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "币安 MAINNET 凭据保存失败" });
    expect(JSON.stringify(failure)).not.toContain(credentials.apiSecret);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(credentials.apiSecret);
  });

  it("rejects credential HTTP bodies over 4 KiB before the procedure runs", async () => {
    const { store, router } = setup();
    const app = new Hono();
    app.use("/api/trpc/*", credentialBodyLimit);
    app.use("/api/trpc/*", (c) => fetchRequestHandler({
      endpoint: "/api/trpc",
      req: c.req.raw,
      router,
      createContext: () => ({ req: c.req.raw, resHeaders: new Headers() }),
    }));
    const oversized = { apiKey: "A".repeat(5000), apiSecret: credentials.apiSecret };

    const response = await app.request("http://localhost/api/trpc/trading.saveSettings,credentials.save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: oversized }),
    });

    expect(response.status).toBe(413);
    expect(store.save).not.toHaveBeenCalled();
  });
});
