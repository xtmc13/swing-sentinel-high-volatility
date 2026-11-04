import { describe, expect, it, vi } from "vitest";
import {
  BINANCE_MAINNET_PRIVATE_WS_URL,
  BINANCE_MAINNET_REST_URL,
  BinanceSignedClient,
  BinanceSignedError,
  privateUserDataStreamUrl,
  type LiveOrderGateway,
} from "./binanceSigned";

const NOW = 1_700_000_000_000;
const credentials = { apiKey: "test-key", apiSecret: "test-secret" };

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function clientWith(fetchImpl: typeof fetch, options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  return new BinanceSignedClient({
    ...credentials,
    fetch: fetchImpl,
    now: options.now ?? (() => NOW),
    sleep: options.sleep ?? vi.fn().mockResolvedValue(undefined),
  });
}

function requestUrl(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return new URL(fetchMock.mock.calls[call]![0] as string);
}

describe("Binance signed mainnet client", () => {
  it("pins REST and private user-data URLs to Binance mainnet", () => {
    expect(BINANCE_MAINNET_REST_URL).toBe("https://fapi.binance.com");
    expect(BINANCE_MAINNET_PRIVATE_WS_URL).toBe("wss://fstream.binance.com/ws");
    expect(privateUserDataStreamUrl("listen key/with spaces")).toBe(
      "wss://fstream.binance.com/ws/listen%20key%2Fwith%20spaces",
    );
  });

  it("rejects missing credentials and long receive windows without making requests", () => {
    const fetchMock = vi.fn();
    expect(() => new BinanceSignedClient({ apiKey: "", apiSecret: "x", fetch: fetchMock })).toThrow("API credentials required");
    expect(() => new BinanceSignedClient({ apiKey: "x", apiSecret: " ", fetch: fetchMock })).toThrow("API credentials required");
    expect(() => new BinanceSignedClient({ ...credentials, fetch: fetchMock, recvWindow: 5001 })).toThrow("recvWindow");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the known-answer HMAC-SHA256 signature and API key header", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse({ assets: [] }));
    const client = clientWith(fetchMock);

    await client.account();

    const url = requestUrl(fetchMock, 1);
    expect(url.origin).toBe("https://fapi.binance.com");
    expect(url.pathname).toBe("/fapi/v2/account");
    expect(url.searchParams.get("timestamp")).toBe(String(NOW));
    expect(url.searchParams.get("recvWindow")).toBe("5000");
    expect(url.searchParams.get("signature")).toBe("3c006375c631729ab444c2afb86bee2999c35b6eeec838b8f96697e8f096d7b3");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: "GET",
      headers: { "X-MBX-APIKEY": "test-key" },
    });
    expect(url.search).not.toContain("test-key");
    expect(url.search).not.toContain("test-secret");
  });

  it("applies the server-time offset to signed timestamps", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW + 250 }))
      .mockResolvedValueOnce(jsonResponse([]));
    const client = clientWith(fetchMock);

    await client.positionRisk("BTCUSDT");

    const url = requestUrl(fetchMock, 1);
    expect(url.pathname).toBe("/fapi/v2/positionRisk");
    expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
    expect(url.searchParams.get("timestamp")).toBe(String(NOW + 250));
    expect(url.searchParams.get("signature")).toBeTruthy();
  });

  it("shares one server-time sync across concurrent signed reads", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockImplementation(async () => jsonResponse({}));
    const client = clientWith(fetchMock);

    await Promise.all([client.positionSide(), client.multiAssetsMargin()]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/fapi/v1/time"))).toHaveLength(1);
  });

  it("sanitizes exchange errors without reflecting credentials, signatures, or response text", async () => {
    const secretBody = JSON.stringify({
      code: -1102,
      msg: "test-key test-secret 3c006375c631729ab444c2afb86bee2999c35b6eeec838b8f96697e8f096d7b3 sensitive-body",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(new Response(secretBody, { status: 400 }));
    const client = clientWith(fetchMock);

    const error = await client.account().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BinanceSignedError);
    expect((error as BinanceSignedError).status).toBe(400);
    expect((error as BinanceSignedError).code).toBe(-1102);
    expect((error as Error).message).toBe("Binance request failed with status 400");
    expect((error as Error).message).not.toContain("sensitive-body");
    expect((error as Error).message).not.toContain("test-key");
    expect((error as Error).message).not.toContain("test-secret");
    expect((error as Error).message).not.toContain("3c006375");
  });

  it("sanitizes network failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockRejectedValueOnce(new Error("test-key test-secret signed-url"));
    const client = clientWith(fetchMock);

    const error = await client.account().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BinanceSignedError);
    expect((error as Error).message).toBe("Binance network request failed");
    expect((error as Error).message).not.toContain("test-key");
    expect((error as Error).message).not.toContain("signed-url");
  });

  it("backs off after rate limiting and retries only the read request", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse({ code: -1003, msg: "secret rate-limit body" }, { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(jsonResponse({ assets: [{ asset: "USDT", availableBalance: "0.100000000000000001" }] }));
    const client = clientWith(fetchMock, { sleep });

    const account = await client.account();

    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(account.assets[0]!.availableBalance).toBe("0.100000000000000001");
  });

  it("uses capped exponential backoff when Retry-After is absent", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ assets: [] }));
    const client = clientWith(fetchMock, { sleep });

    await client.account();

    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it.each([Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 11])(
    "rejects invalid maxRateLimitRetries=%s without making requests",
    (maxRateLimitRetries) => {
      const fetchMock = vi.fn();
      expect(() => new BinanceSignedClient({ ...credentials, fetch: fetchMock, maxRateLimitRetries }))
        .toThrow("maxRateLimitRetries");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("honors the full server Retry-After cooldown without capping it", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { "Retry-After": "120" } }))
      .mockResolvedValueOnce(jsonResponse({ assets: [] }));
    const client = clientWith(fetchMock, { sleep });

    await client.account();

    expect(sleep).toHaveBeenCalledWith(120_000);
  });

  it("stops after the configured rate-limit retries are exhausted", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockImplementation(async () => jsonResponse({ code: -1003 }, { status: 429 }));
    const client = new BinanceSignedClient({
      ...credentials,
      fetch: fetchMock,
      now: () => NOW,
      sleep,
      maxRateLimitRetries: 2,
    });

    const error = await client.account().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BinanceSignedError);
    expect((error as BinanceSignedError).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it.each([
    { name: "userTrades negative startTime", invoke: (client: BinanceSignedClient) => client.userTrades({ symbol: "BTCUSDT", startTime: -1 }) },
    { name: "userTrades infinite endTime", invoke: (client: BinanceSignedClient) => client.userTrades({ symbol: "BTCUSDT", endTime: Infinity }) },
    { name: "userTrades fractional fromId", invoke: (client: BinanceSignedClient) => client.userTrades({ symbol: "BTCUSDT", fromId: 0.5 }) },
    { name: "userTrades zero limit", invoke: (client: BinanceSignedClient) => client.userTrades({ symbol: "BTCUSDT", limit: 0 }) },
    { name: "userTrades excessive limit", invoke: (client: BinanceSignedClient) => client.userTrades({ symbol: "BTCUSDT", limit: 1001 }) },
    { name: "userTrades reversed time range", invoke: (client: BinanceSignedClient) => client.userTrades({ symbol: "BTCUSDT", startTime: 10, endTime: 9 }) },
    { name: "income NaN startTime", invoke: (client: BinanceSignedClient) => client.income({ startTime: Number.NaN }) },
    { name: "income unsafe endTime", invoke: (client: BinanceSignedClient) => client.income({ endTime: Number.MAX_SAFE_INTEGER + 1 }) },
    { name: "income fractional limit", invoke: (client: BinanceSignedClient) => client.income({ limit: 1.5 }) },
    { name: "income reversed time range", invoke: (client: BinanceSignedClient) => client.income({ startTime: 10, endTime: 9 }) },
  ])("rejects $name before any network request", async ({ invoke }) => {
    const fetchMock = vi.fn();
    const client = clientWith(fetchMock);

    await expect(invoke(client)).rejects.toThrow("Invalid signed numeric parameters");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "account", invoke: (client: BinanceSignedClient) => client.account(), path: "/fapi/v2/account", query: {} },
    { name: "positionRisk", invoke: (client: BinanceSignedClient) => client.positionRisk("BTCUSDT"), path: "/fapi/v2/positionRisk", query: { symbol: "BTCUSDT" } },
    { name: "leverageBracket", invoke: (client: BinanceSignedClient) => client.leverageBracket("BTCUSDT"), path: "/fapi/v1/leverageBracket", query: { symbol: "BTCUSDT" } },
    { name: "positionSide", invoke: (client: BinanceSignedClient) => client.positionSide(), path: "/fapi/v1/positionSide/dual", query: {} },
    { name: "multiAssetsMargin", invoke: (client: BinanceSignedClient) => client.multiAssetsMargin(), path: "/fapi/v1/multiAssetsMargin", query: {} },
    { name: "openOrders", invoke: (client: BinanceSignedClient) => client.openOrders("BTCUSDT"), path: "/fapi/v1/openOrders", query: { symbol: "BTCUSDT" } },
    {
      name: "userTrades",
      invoke: (client: BinanceSignedClient) => client.userTrades({ symbol: "BTCUSDT", startTime: 123, limit: 100 }),
      path: "/fapi/v1/userTrades",
      query: { symbol: "BTCUSDT", startTime: "123", limit: "100" },
    },
    {
      name: "income",
      invoke: (client: BinanceSignedClient) => client.income({ symbol: "BTCUSDT", incomeType: "COMMISSION", startTime: 123, endTime: 456, limit: 100 }),
      path: "/fapi/v1/income",
      query: { symbol: "BTCUSDT", incomeType: "COMMISSION", startTime: "123", endTime: "456", limit: "100" },
    },
  ])("implements the signed $name read endpoint", async ({ invoke, path, query }) => {
    const payload = path.includes("account") || path.includes("Margin") || path.includes("dual") ? {} : [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse(payload));
    const client = clientWith(fetchMock);

    await invoke(client);

    const url = requestUrl(fetchMock, 1);
    expect(url.origin).toBe("https://fapi.binance.com");
    expect(url.pathname).toBe(path);
    for (const [key, value] of Object.entries(query)) expect(url.searchParams.get(key)).toBe(value);
    expect(url.searchParams.get("signature")).toBeTruthy();
  });

  it("reads contract filters through the unsigned exchangeInfo endpoint without a time sync", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ symbols: [] }));
    const client = clientWith(fetchMock);

    await client.exchangeInfo("BTCUSDT");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = requestUrl(fetchMock);
    expect(url.pathname).toBe("/fapi/v1/exchangeInfo");
    expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
    expect(url.searchParams.has("signature")).toBe(false);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "GET", headers: undefined });
  });

  it("preserves trade and income decimal strings without numeric conversion", async () => {
    const trade = { symbol: "BTCUSDT", price: "67000.100000000000000001", qty: "0.000000000000000003", commission: "0.000000000000000001" };
    const income = { symbol: "BTCUSDT", incomeType: "COMMISSION", income: "-0.000000000000000001" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse([trade]))
      .mockResolvedValueOnce(jsonResponse([income]));
    const client = clientWith(fetchMock);

    await expect(client.userTrades({ symbol: "BTCUSDT" })).resolves.toEqual([trade]);
    await expect(client.income({ symbol: "BTCUSDT" })).resolves.toEqual([income]);
  });

  it("preserves int64 income transaction IDs as exact strings", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(new Response(
        '[{"symbol":"BTCUSDT","incomeType":"FUNDING_FEE","income":"0.01","asset":"USDT","time":1700000000000,"tranId":9223372036854775806}]',
        { headers: { "content-type": "application/json" } },
      ));
    const client = clientWith(fetchMock);

    const records = await client.income({ symbol: "BTCUSDT" });

    expect(records[0]?.tranId).toBe("9223372036854775806");
  });

  it.each([
    { method: "POST", invoke: (client: BinanceSignedClient) => client.createListenKey() },
    { method: "PUT", invoke: (client: BinanceSignedClient) => client.keepAliveListenKey() },
    { method: "DELETE", invoke: (client: BinanceSignedClient) => client.closeListenKey() },
  ])("uses API-key-only $method listenKey lifecycle requests", async ({ method, invoke }) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ listenKey: "fake-listen-key" }));
    const client = clientWith(fetchMock);

    await invoke(client);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = requestUrl(fetchMock);
    expect(url.pathname).toBe("/fapi/v1/listenKey");
    expect(url.search).toBe("");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method, headers: { "X-MBX-APIKEY": "test-key" } });
  });

  it("submits signed IOC orders without automatic retries and preserves decimal parameters", async () => {
    const acknowledgement = {
      symbol: "BTCUSDT", orderId: 123, clientOrderId: "entry-1", price: "67000.100000000000000001",
      origQty: "0.000000000000000003", executedQty: "0", status: "NEW", side: "BUY", positionSide: "BOTH", type: "LIMIT",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse(acknowledgement));
    const client = clientWith(fetchMock);

    await expect(client.placeOrder({
      symbol: "BTCUSDT", side: "BUY", positionSide: "BOTH", type: "LIMIT", quantity: "0.000000000000000003",
      price: "67000.100000000000000001", timeInForce: "IOC", newClientOrderId: "entry-1",
    })).resolves.toEqual(acknowledgement);
    const url = requestUrl(fetchMock, 1);
    expect(url.pathname).toBe("/fapi/v1/order");
    expect(url.searchParams.get("price")).toBe("67000.100000000000000001");
    expect(url.searchParams.get("quantity")).toBe("0.000000000000000003");
    expect(url.searchParams.get("positionSide")).toBe("BOTH");
    expect(url.searchParams.get("timeInForce")).toBe("IOC");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "POST", headers: { "X-MBX-APIKEY": "test-key" } });
  });

  it("never retries a timed-out or rate-limited order submission", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse({ code: -1003 }, { status: 429, headers: { "Retry-After": "0" } }));
    const client = clientWith(fetchMock);

    await expect(client.placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "1" }))
      .rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels and queries orders through signed endpoints; unknown query orders return null", async () => {
    const cancelled = {
      symbol: "BTCUSDT", orderId: 123, clientOrderId: "entry-1", price: "100", origQty: "1",
      executedQty: "0", status: "CANCELED", side: "BUY", type: "LIMIT",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ serverTime: NOW }))
      .mockResolvedValueOnce(jsonResponse(cancelled))
      .mockResolvedValueOnce(jsonResponse(cancelled))
      .mockResolvedValueOnce(jsonResponse({ code: -2011 }, { status: 400 }));
    const client = clientWith(fetchMock);

    await expect(client.cancelOrder({ symbol: "BTCUSDT", origClientOrderId: "entry-1" })).resolves.toEqual(cancelled);
    await expect(client.queryOrder({ symbol: "BTCUSDT", origClientOrderId: "entry-1" })).resolves.toEqual(cancelled);
    await expect(client.queryOrder({ symbol: "BTCUSDT", origClientOrderId: "missing" })).resolves.toBeNull();
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: "GET" });
    expect(requestUrl(fetchMock, 1).pathname).toBe("/fapi/v1/order");
    expect(requestUrl(fetchMock, 2).pathname).toBe("/fapi/v1/order");
  });

  it("times out a hung signed transport even when fetch ignores abort signals", async () => {
    const client = new BinanceSignedClient({
      ...credentials,
      requestTimeoutMs: 5,
      fetch: (async () => new Promise<Response>(() => undefined)) as typeof fetch,
      now: () => NOW,
    });

    await expect(client.placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "1" }))
      .rejects.toMatchObject({ message: "Binance request timed out" });
  });

  it("applies the same hard deadline to response body parsing and listenKey calls", async () => {
    const hungBody = { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => undefined) } as unknown as Response;
    const client = new BinanceSignedClient({
      ...credentials,
      requestTimeoutMs: 5,
      fetch: (async () => hungBody) as typeof fetch,
      now: () => NOW,
    });

    await expect(client.createListenKey()).rejects.toMatchObject({ message: "Binance request timed out" });
  });

  it("keeps the gateway fake-transport friendly", () => {
    const gateway: LiveOrderGateway = {
      placeOrder: async (request) => ({ quantity: request.quantity }),
      cancelOrder: async (request) => ({ symbol: request.symbol }),
      queryOrder: async () => null,
      userTrades: async () => [],
    };
    expect(gateway).toBeDefined();
  });
});
