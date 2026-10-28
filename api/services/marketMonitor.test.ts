import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesClient } from "./binance";
import { MarketMonitor, type WebSocketLike } from "./marketMonitor";

const NOW = 1_800_000_000_000;

type Listener = (event: unknown) => void;

class FakeWebSocket implements WebSocketLike {
  readonly listeners = new Map<string, Listener[]>();
  readyState = 0;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  message(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  disconnect() {
    this.readyState = 3;
    this.emit("close", { code: 1006, reason: "test disconnect" });
  }

  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "stop" });
  }
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function restBook(symbol: string, time = NOW) {
  return { symbol, bidPrice: "99", bidQty: "2", askPrice: "101", askQty: "3", time };
}

function restPremium(symbol: string, time = NOW) {
  return {
    symbol,
    markPrice: "100",
    indexPrice: "100.1",
    estimatedSettlePrice: "100.1",
    lastFundingRate: "0.0001",
    interestRate: "0.0001",
    nextFundingTime: NOW + 3_600_000,
    time,
  };
}

function bookEvent(
  symbol: string,
  updateId = 1,
  eventTime = NOW,
  prices: { bid?: string; ask?: string } = {},
) {
  return {
    stream: `${symbol.toLowerCase()}@bookTicker`,
    data: {
      e: "bookTicker",
      E: eventTime,
      s: symbol,
      u: updateId,
      b: prices.bid ?? "99",
      B: "2",
      a: prices.ask ?? "101",
      A: "3",
      T: eventTime,
    },
  };
}

function markEvent(symbol: string, eventTime = NOW) {
  return {
    stream: `${symbol.toLowerCase()}@markPrice@1s`,
    data: {
      e: "markPriceUpdate", E: eventTime, s: symbol, p: "100", i: "100.1", P: "100.1",
      r: "0.0001", T: NOW + 3_600_000,
    },
  };
}

function klineEvent(symbol: string, closed: boolean, eventTime = NOW) {
  return {
    stream: `${symbol.toLowerCase()}@kline_1m`,
    data: {
      e: "kline",
      E: eventTime,
      s: symbol,
      k: {
        t: eventTime - 60_000,
        T: eventTime - 1,
        s: symbol,
        i: "1m",
        f: 100,
        L: 200,
        o: "99",
        c: "100",
        h: "101",
        l: "98",
        v: "123",
        n: 101,
        x: closed,
        q: "12300",
        V: "60",
        Q: "6000",
        B: "0",
      },
    },
  };
}

const monitors: MarketMonitor[] = [];
let now = NOW;

function setup(options: {
  symbols?: string[];
  fetch?: typeof fetch;
  maxStreamsPerConnection?: number;
} = {}) {
  const sockets: FakeWebSocket[] = [];
  const fetchFake = options.fetch ?? (async () => { throw new Error("unexpected REST"); }) as typeof fetch;
  const client = new BinanceFuturesClient({ source: "MAINNET", fetch: fetchFake, now: () => now });
  const monitor = new MarketMonitor({
    client,
    now: () => now,
    webSocketFactory: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    maxStreamsPerConnection: options.maxStreamsPerConnection ?? 3,
    reconnectDelayMs: 1000,
    restPollIntervalMs: 0,
  });
  monitors.push(monitor);
  monitor.start(options.symbols ?? ["BTCUSDT"]);
  return { monitor, sockets, client };
}

function freshRestFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input));
  const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
  if (url.pathname === "/fapi/v1/ticker/bookTicker") return Promise.resolve(response(restBook(symbol, now)));
  if (url.pathname === "/fapi/v1/premiumIndex") return Promise.resolve(response(restPremium(symbol, now)));
  if (url.pathname === "/fapi/v1/klines") {
    return Promise.resolve(response([[now - 60_000, "99", "101", "98", "100", "123", now - 1]]));
  }
  return Promise.reject(new Error(`unexpected ${url}`));
}

function openAndFeed(sockets: FakeWebSocket[], symbols: string[], oneMinuteTime = NOW) {
  sockets.forEach((socket) => socket.open());
  for (const symbol of symbols) {
    const lower = symbol.toLowerCase();
    sockets.find((socket) => socket.url.includes(`${lower}@bookTicker`))?.message(bookEvent(symbol, 1, now));
    sockets.find((socket) => socket.url.includes(`${lower}@markPrice@1s`))?.message(markEvent(symbol, now));
    sockets.find((socket) => socket.url.includes(`${lower}@kline_1m`))?.message(klineEvent(symbol, false, oneMinuteTime));
  }
}

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.useRealTimers();
  now = NOW;
});

describe("WebSocket 快速风险监测", () => {
  it("将盘口路由到 public、1M K 线和 1 秒标记价路由到 market 并按流数分连接", () => {
    const { sockets } = setup({ symbols: ["BTCUSDT", "ETHUSDT"], maxStreamsPerConnection: 3 });

    expect(sockets).toHaveLength(4);
    expect(sockets.map((socket) => socket.url)).toEqual([
      "wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1m/btcusdt@markPrice@1s",
      "wss://fstream.binance.com/public/stream?streams=btcusdt@bookTicker",
      "wss://fstream.binance.com/market/stream?streams=ethusdt@kline_1m/ethusdt@markPrice@1s",
      "wss://fstream.binance.com/public/stream?streams=ethusdt@bookTicker",
    ]);
  });

  it("1M 数据无论是否收盘都只用于风险预警，不能成为正式入场信号", () => {
    const { monitor, sockets } = setup();
    sockets[0].open();
    sockets[0].message(klineEvent("BTCUSDT", false));

    expect(monitor.getSymbolMetrics("BTCUSDT")?.oneMinute).toMatchObject({
      closed: false,
      usage: "RISK_ONLY",
      formalSignalEligible: false,
    });

    sockets[0].message(klineEvent("BTCUSDT", true));
    expect(monitor.getSymbolMetrics("BTCUSDT")?.oneMinute).toMatchObject({
      closed: true,
      usage: "RISK_ONLY",
      formalSignalEligible: false,
    });
  });

  it("单连接断开只降级该连接上的符号", () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const { monitor, sockets } = setup({ symbols });
    openAndFeed(sockets, symbols);

    sockets[0].disconnect();
    sockets[1].message(bookEvent("BTCUSDT", 2));

    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ connected: false, degraded: true, stableSince: null });
    expect(monitor.getSymbolMetrics("ETHUSDT")).toMatchObject({ connected: true, degraded: false });
    expect(monitor.getSymbolMetrics("ETHUSDT")?.quality.valid).toBe(true);
    expect(monitor.getMetrics()).toMatchObject({ sourceHealthy: true, degradedSymbols: 1, openConnections: 3 });
  });

  it("新鲜 REST 补全可在 WebSocket 未恢复时启动并保持稳定计时", async () => {
    const { monitor, sockets } = setup({ fetch: freshRestFetch as typeof fetch });
    sockets[0].open();
    sockets[0].disconnect();

    await monitor.recoverDegraded();
    const recovered = monitor.getSymbolMetrics("BTCUSDT");
    expect(recovered).toMatchObject({ connected: false, degraded: false, stableSince: NOW });
    expect(recovered?.quality.valid).toBe(true);
    expect(recovered?.oneMinute).not.toBeNull();
    expect(recovered?.quality.candleAgeMs).toBe(60_000);

    now += 1000;
    await monitor.recoverDegraded();
    expect(monitor.getSymbolMetrics("BTCUSDT")?.stableSince).toBe(NOW);
  });

  it("重连保留延迟和消息指标并将丢包明确标为不可用", async () => {
    vi.useFakeTimers();
    const { monitor, sockets } = setup();
    sockets[1].open();
    sockets[1].disconnect();
    await vi.advanceTimersByTimeAsync(1000);

    expect(sockets).toHaveLength(3);
    sockets[2].open();
    sockets[2].message(bookEvent("BTCUSDT", 100, NOW - 20));
    sockets[2].message(bookEvent("BTCUSDT", 103, NOW - 20));

    expect(monitor.getMetrics()).toMatchObject({
      reconnects: 1,
      messages: 2,
      missedMessages: null,
      averageLatencyMs: 20,
      maxLatencyMs: 20,
      openConnections: 1,
    });
    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ reconnects: 1, messages: 2, missedMessages: null });
  });

  it("同一连接上的多符号重连只计一次全局重连", async () => {
    vi.useFakeTimers();
    const { monitor, sockets } = setup({ symbols: ["BTCUSDT", "ETHUSDT"], maxStreamsPerConnection: 6 });
    sockets[1].open();
    sockets[1].disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[2].open();

    expect(monitor.getMetrics().reconnects).toBe(1);
    expect(monitor.getSymbolMetrics("BTCUSDT")?.reconnects).toBe(1);
    expect(monitor.getSymbolMetrics("ETHUSDT")?.reconnects).toBe(1);
  });

  it("共享 REST 数据源故障降级整个池并记录限流", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const limitedFetch = (async () => response({ code: -1003, msg: "too many requests" }, 429)) as typeof fetch;
    const { monitor, sockets } = setup({ symbols, fetch: limitedFetch });
    openAndFeed(sockets, symbols);

    await monitor.recoverDegraded(["BTCUSDT"]);

    expect(monitor.getMetrics()).toMatchObject({ sourceHealthy: false, degradedSymbols: 2, rateLimits: 1 });
    expect(monitor.getSymbolMetrics("ETHUSDT")?.quality.valid).toBe(false);
    expect(monitor.getSymbolMetrics("ETHUSDT")?.stableSince).toBeNull();
  });

  it("跨源 restart 后旧 open/message/close 回调不能写入新 run 或触发重连", async () => {
    vi.useFakeTimers();
    const { monitor, sockets, client } = setup();
    const oldSockets = [...sockets];
    openAndFeed(oldSockets, ["BTCUSDT"]);
    client.setDataSource("TESTNET");
    monitor.start(["BTCUSDT"]);

    openAndFeed(oldSockets, ["BTCUSDT"]);
    oldSockets.forEach((socket) => socket.disconnect());
    await vi.advanceTimersByTimeAsync(2000);

    expect(sockets).toHaveLength(4);
    expect(monitor.getMetrics()).toMatchObject({ source: "TESTNET", messages: 0, openConnections: 0 });
    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ snapshot: null, connected: false, stableSince: null });
  });

  it("重连后旧 socket 的延迟消息不能计入当前连接", async () => {
    vi.useFakeTimers();
    const { monitor, sockets } = setup();
    const oldSocket = sockets[1];
    oldSocket.open();
    oldSocket.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[2].open();

    oldSocket.message(bookEvent("BTCUSDT", 9));

    expect(monitor.getMetrics().messages).toBe(0);
    expect(monitor.getSymbolMetrics("BTCUSDT")?.snapshot).toBeNull();
  });

  it("in-flight REST 失败后不能写入已 stop/restart 的 generation", async () => {
    let rejectBook!: (reason: Error) => void;
    const pendingBook = new Promise<Response>((_, reject) => { rejectBook = reject; });
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/fapi/v1/ticker/bookTicker") return pendingBook;
      if (url.pathname === "/fapi/v1/premiumIndex") return response(restPremium("BTCUSDT", now));
      return freshRestFetch(input);
    }) as typeof fetch;
    const { monitor, client } = setup({ fetch: fetchFake });
    const recovery = monitor.recoverDegraded(["BTCUSDT"]);
    client.setDataSource("TESTNET");
    monitor.start(["BTCUSDT"]);

    rejectBook(new TypeError("old run network failure"));
    await recovery;

    expect(monitor.getMetrics()).toMatchObject({ source: "TESTNET", sourceHealthy: true });
    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ snapshot: null, stableSince: null });
    expect(monitor.getSymbolMetrics("BTCUSDT")?.quality.reasons).not.toContain("共享行情源故障");
  });

  it("BTC 到 ETH 的 restart 清除旧状态且恢复轮询不包含旧符号", async () => {
    const calls: string[] = [];
    const fetchFake = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return freshRestFetch(input);
    }) as typeof fetch;
    const { monitor } = setup({ fetch: fetchFake });

    monitor.start(["ETHUSDT"]);
    await monitor.recoverDegraded();

    expect(monitor.getSymbolMetrics("BTCUSDT")).toBeUndefined();
    expect(monitor.getSymbolMetrics("ETHUSDT")).toBeDefined();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => !url.includes("BTCUSDT"))).toBe(true);
  });

  it("缺失 1M 且 REST 补全失败时，新鲜盘口也不能把质量恢复为有效", async () => {
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/fapi/v1/klines") return response({ unexpected: true });
      return freshRestFetch(input);
    }) as typeof fetch;
    const { monitor, sockets } = setup({ fetch: fetchFake });
    sockets[0].open();
    sockets[0].disconnect();

    await monitor.recoverDegraded();

    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ degraded: true, stableSince: null });
    expect(monitor.getSymbolMetrics("BTCUSDT")?.quality.valid).toBe(false);
    expect(monitor.getSymbolMetrics("BTCUSDT")?.quality.reasons).toContain("缺少1M数据");
  });

  it("保留 1M 超过 90 秒时通过新鲜 REST 1M 完成恢复", async () => {
    const { monitor, sockets } = setup({ fetch: freshRestFetch as typeof fetch });
    openAndFeed(sockets, ["BTCUSDT"]);
    sockets[0].message(klineEvent("BTCUSDT", false));
    sockets[0].disconnect();
    now += 90_001;

    expect(monitor.getSymbolMetrics("BTCUSDT")?.quality).toMatchObject({ valid: false, candleAgeMs: 90_001 });
    await monitor.recoverDegraded();

    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ degraded: false, stableSince: now });
    expect(monitor.getSymbolMetrics("BTCUSDT")?.quality).toMatchObject({ valid: true, candleAgeMs: 60_000 });
    expect(monitor.getSymbolMetrics("BTCUSDT")?.oneMinute?.formalSignalEligible).toBe(false);
  });

  it("1M 在 90 秒有效、90 秒加 1 毫秒降级并清除稳定计时", () => {
    const { monitor, sockets } = setup();
    openAndFeed(sockets, ["BTCUSDT"]);
    sockets[0].message(klineEvent("BTCUSDT", false));

    now += 90_000;
    openAndFeed(sockets, ["BTCUSDT"]);
    expect(monitor.getSymbolMetrics("BTCUSDT")?.quality).toMatchObject({ valid: true, candleAgeMs: 90_000 });
    expect(monitor.getSymbolMetrics("BTCUSDT")?.stableSince).toBe(now);

    now += 1;
    openAndFeed(sockets, ["BTCUSDT"]);
    expect(monitor.getSymbolMetrics("BTCUSDT")?.quality).toMatchObject({ valid: false, candleAgeMs: 90_001 });
    expect(monitor.getSymbolMetrics("BTCUSDT")?.stableSince).toBeNull();
  });

  it.each([
    { name: "NaN", eventTime: NOW, prices: { bid: "not-a-number" }, reason: "盘口价格无效" },
    { name: "非正 bid", eventTime: NOW, prices: { bid: "0" }, reason: "盘口价格无效" },
    { name: "非正 ask", eventTime: NOW, prices: { ask: "-1" }, reason: "盘口价格无效" },
    { name: "交叉", eventTime: NOW, prices: { bid: "102", ask: "101" }, reason: "盘口交叉" },
    { name: "陈旧", eventTime: NOW - 5001, prices: {}, reason: "盘口陈旧" },
  ])("WS $name盘口只降级对应符号并重置稳定计时", ({ eventTime, prices, reason }) => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const { monitor, sockets } = setup({ symbols });
    openAndFeed(sockets, symbols);
    expect(monitor.getSymbolMetrics("BTCUSDT")?.stableSince).toBe(NOW);

    sockets[1].message(bookEvent("BTCUSDT", 2, eventTime, prices));

    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ degraded: true, stableSince: null });
    expect(monitor.getSymbolMetrics("BTCUSDT")?.quality.reasons).toContain(reason);
    expect(monitor.getSymbolMetrics("ETHUSDT")).toMatchObject({ degraded: false, stableSince: NOW });
  });

  it("符号局部 JSON 解析错误不触发共享源降级", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const malformed = {
      ok: true,
      status: 200,
      text: async () => "not-json",
      json: async () => { throw new SyntaxError("Unexpected token"); },
    } as unknown as Response;
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/fapi/v1/ticker/bookTicker") return malformed;
      return freshRestFetch(input);
    }) as typeof fetch;
    const { monitor, sockets } = setup({ symbols, fetch: fetchFake });
    openAndFeed(sockets, symbols);

    await monitor.recoverDegraded(["BTCUSDT"]);

    expect(monitor.getMetrics().sourceHealthy).toBe(true);
    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ degraded: true, stableSince: null });
    expect(monitor.getSymbolMetrics("ETHUSDT")).toMatchObject({ degraded: false, stableSince: NOW });
  });

  it("response.json 的网络 TypeError 按共享源故障降级整个池", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const terminated = {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => { throw new TypeError("terminated"); },
    } as unknown as Response;
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/fapi/v1/ticker/bookTicker") return terminated;
      return freshRestFetch(input);
    }) as typeof fetch;
    const { monitor, sockets } = setup({ symbols, fetch: fetchFake });
    openAndFeed(sockets, symbols);

    await monitor.recoverDegraded(["BTCUSDT"]);

    expect(monitor.getMetrics()).toMatchObject({ sourceHealthy: false, degradedSymbols: 2 });
    expect(monitor.getSymbolMetrics("ETHUSDT")?.stableSince).toBeNull();
  });

  it("非 2xx response.text 的网络 TypeError 按共享源故障降级整个池", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const terminated = {
      ok: false,
      status: 500,
      text: async () => { throw new TypeError("terminated"); },
      json: async () => ({}),
    } as unknown as Response;
    const fetchFake = (async () => terminated) as typeof fetch;
    const { monitor, sockets } = setup({ symbols, fetch: fetchFake });
    openAndFeed(sockets, symbols);

    await monitor.recoverDegraded(["BTCUSDT"]);

    expect(monitor.getMetrics()).toMatchObject({ sourceHealthy: false, degradedSymbols: 2 });
    expect(monitor.getSymbolMetrics("ETHUSDT")?.stableSince).toBeNull();
  });

  it("HTTP 200 null 盘口产生的局部 TypeError 不降级共享源", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/fapi/v1/ticker/bookTicker") return response(null);
      return freshRestFetch(input);
    }) as typeof fetch;
    const { monitor, sockets } = setup({ symbols, fetch: fetchFake });
    openAndFeed(sockets, symbols);

    await monitor.recoverDegraded(["BTCUSDT"]);

    expect(monitor.getMetrics().sourceHealthy).toBe(true);
    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ degraded: true, stableSince: null });
    expect(monitor.getSymbolMetrics("ETHUSDT")).toMatchObject({ degraded: false, stableSince: NOW });
  });

  it("HTTP 200 错误形状 1M 响应产生的局部 TypeError 不降级共享源", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/fapi/v1/klines") return response({ unexpected: true });
      return freshRestFetch(input);
    }) as typeof fetch;
    const { monitor, sockets } = setup({ symbols, fetch: fetchFake });
    openAndFeed(sockets, symbols);
    sockets[0].message(klineEvent("BTCUSDT", false));
    now += 90_001;
    openAndFeed(sockets, ["ETHUSDT"], now);

    await monitor.recoverDegraded(["BTCUSDT"]);

    expect(monitor.getMetrics().sourceHealthy).toBe(true);
    expect(monitor.getSymbolMetrics("BTCUSDT")).toMatchObject({ degraded: true, stableSince: null });
    expect(monitor.getSymbolMetrics("ETHUSDT")).toMatchObject({ degraded: false, stableSince: now });
  });

  it("HTTP 5xx 保留共享源故障降级整个池", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const fetchFake = (async () => response({ code: -1000, msg: "server error" }, 500)) as typeof fetch;
    const { monitor, sockets } = setup({ symbols, fetch: fetchFake });
    openAndFeed(sockets, symbols);

    await monitor.recoverDegraded(["BTCUSDT"]);

    expect(monitor.getMetrics()).toMatchObject({ sourceHealthy: false, degradedSymbols: 2 });
    expect(monitor.getSymbolMetrics("ETHUSDT")?.stableSince).toBeNull();
  });

  it("网络 TypeError 明确按共享源故障降级整个池", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT"];
    const fetchFake = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const { monitor, sockets } = setup({ symbols, fetch: fetchFake });
    openAndFeed(sockets, symbols);

    await monitor.recoverDegraded(["BTCUSDT"]);

    expect(monitor.getMetrics()).toMatchObject({ sourceHealthy: false, degradedSymbols: 2 });
    expect(monitor.getSymbolMetrics("ETHUSDT")?.stableSince).toBeNull();
  });

  it("只读观测快照计算当前质量但不改写快照或 stableSince", () => {
    const { monitor, sockets } = setup();
    openAndFeed(sockets, ["BTCUSDT"]);
    const before = monitor.getSymbolMetrics("BTCUSDT");
    expect(before?.stableSince).toBe(NOW);

    now += 5001;
    const result = monitor.getObservabilitySnapshot();

    expect(result.metrics.degradedSymbols).toBe(1);
    expect(result.symbols.BTCUSDT).toMatchObject({ degraded: true, stableSince: NOW });
    expect(result.symbols.BTCUSDT.snapshot).not.toBe(before?.snapshot);
    expect(result.symbols.BTCUSDT.quality.bookAgeMs).toBe(5001);
  });

  it("stop 关闭连接且不会留下重连或恢复定时器", async () => {
    vi.useFakeTimers();
    const { monitor, sockets } = setup();
    sockets[0].open();
    sockets[0].disconnect();
    monitor.stop();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets).toHaveLength(2);
    expect(monitor.getMetrics()).toMatchObject({ running: false, connections: 0, openConnections: 0 });
  });

  it("stop 主动关闭仍处于打开状态的 WebSocket", () => {
    const { monitor, sockets } = setup();
    sockets[0].open();

    monitor.stop();

    expect(sockets[0].readyState).toBe(3);
  });
});
