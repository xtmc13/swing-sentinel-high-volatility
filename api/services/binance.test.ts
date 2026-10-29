import { describe, expect, it } from "vitest";
import type { DataSource } from "@contracts/trading";
import { BinanceFuturesClient } from "./binance";

const NOW = 1_800_000_000_000;
const INTERVAL_MS = 300_000;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function book(symbol: string, time = NOW, bid = "99", ask = "101") {
  return { symbol, bidPrice: bid, bidQty: "2", askPrice: ask, askQty: "3", time };
}

function premium(symbol: string, time = NOW, markPrice = "100") {
  return {
    symbol,
    markPrice,
    indexPrice: "100.1",
    estimatedSettlePrice: "100.1",
    lastFundingRate: "0.0001",
    interestRate: "0.0001",
    nextFundingTime: NOW + 3_600_000,
    time,
  };
}

function candleRow(openTime: number, close = 100): unknown[] {
  return [openTime, "99", "101", "98", String(close), "123", openTime + INTERVAL_MS - 1];
}

function clientWith(fetchFake: typeof fetch, source: DataSource = "MAINNET", now = NOW) {
  return new BinanceFuturesClient({ source, fetch: fetchFake, now: () => now });
}

describe("单源 REST 行情", () => {
  it("缓存键包含数据源且切换源时整代失效", async () => {
    const calls: string[] = [];
    const fetchFake = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const testnet = url.startsWith("https://testnet.binancefuture.com");
      return response([candleRow(NOW - INTERVAL_MS, testnet ? 200 : 100)]);
    }) as typeof fetch;
    const client = clientWith(fetchFake);

    const main = await client.getCandles("BTCUSDT", "5m", 1);
    const cached = await client.getCandles("BTCUSDT", "5m", 1);
    client.setDataSource("TESTNET");
    const test = await client.getCandles("BTCUSDT", "5m", 1);

    expect(main[0].close).toBe(100);
    expect(cached).toBe(main);
    expect(test[0].close).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("数据源切换推进执行准入使用的源代际", () => {
    const client = clientWith((async () => { throw new Error("not used"); }) as typeof fetch) as BinanceFuturesClient & { sourceGeneration?: number };

    expect(client.sourceGeneration).toBe(0);
    client.setDataSource("TESTNET");
    expect(client.sourceGeneration).toBe(1);
    client.setDataSource("TESTNET");
    expect(client.sourceGeneration).toBe(1);
  });

  it("主网失败不会回退到测试网或混合两个源", async () => {
    const calls: string[] = [];
    const fetchFake = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://fapi.binance.com")) throw new Error("mainnet unavailable");
      return response(book("BTCUSDT"));
    }) as typeof fetch;
    const client = clientWith(fetchFake);

    await expect(client.getMarketSnapshot("BTCUSDT")).rejects.toThrow("mainnet unavailable");
    expect(calls.every((url) => url.startsWith("https://fapi.binance.com"))).toBe(true);
    expect(client.dataSource).toBe("MAINNET");
  });

  it("快照的盘口和标记价来自同一源并计算单源质量", async () => {
    const fetchFake = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/ticker/bookTicker")) return response(book("BTCUSDT"));
      if (url.includes("/premiumIndex")) return response(premium("BTCUSDT"));
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const snapshot = await clientWith(fetchFake).getMarketSnapshot("BTCUSDT");

    expect(snapshot).toMatchObject({
      source: "MAINNET",
      symbol: "BTCUSDT",
      bid: 99,
      ask: 101,
      mid: 100,
      markPrice: 100,
      bookTime: NOW,
      markTime: NOW,
    });
    expect(snapshot.spreadBps).toBe(200);
    expect(snapshot.quality).toEqual({ valid: true, reasons: [], bookAgeMs: 0, markAgeMs: 0, candleAgeMs: null });
  });

  it.each([
    { name: "NaN", value: book("BTCUSDT", NOW, "not-a-number", "101"), reason: "盘口价格无效" },
    { name: "非正 bid", value: book("BTCUSDT", NOW, "0", "101"), reason: "盘口价格无效" },
    { name: "非正 ask", value: book("BTCUSDT", NOW, "99", "-1"), reason: "盘口价格无效" },
    { name: "交叉盘口", value: book("BTCUSDT", NOW, "102", "101"), reason: "盘口交叉" },
    { name: "陈旧盘口", value: book("BTCUSDT", NOW - 5001), reason: "盘口陈旧" },
  ])("拒绝$name盘口", async ({ value, reason }) => {
    const fetchFake = (async (input: string | URL | Request) => {
      const url = String(input);
      return response(url.includes("/ticker/bookTicker") ? value : premium("BTCUSDT"));
    }) as typeof fetch;

    const snapshot = await clientWith(fetchFake).getMarketSnapshot("BTCUSDT");

    expect(snapshot.quality.valid).toBe(false);
    expect(snapshot.quality.reasons).toContain(reason);
  });

  it("拒绝非正标记价、无效时间戳和陈旧标记价", async () => {
    const values = [
      { value: premium("BTCUSDT", NOW, "0"), reason: "标记价无效" },
      { value: premium("BTCUSDT", Number.NaN), reason: "标记价时间无效" },
      { value: premium("BTCUSDT", NOW - 5001), reason: "标记价陈旧" },
    ];
    for (const { value, reason } of values) {
      const fetchFake = (async (input: string | URL | Request) => {
        const url = String(input);
        return response(url.includes("/ticker/bookTicker") ? book("BTCUSDT") : value);
      }) as typeof fetch;
      const snapshot = await clientWith(fetchFake).getMarketSnapshot("BTCUSDT");
      expect(snapshot.quality.valid).toBe(false);
      expect(snapshot.quality.reasons).toContain(reason);
    }
  });
});

describe("七天已收盘基线", () => {
  it("按 1500 + 516 分页取得 2016 根 5M 已收盘 K 线", async () => {
    const calls: { limit: number; endTime: number }[] = [];
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const limit = Number(url.searchParams.get("limit"));
      const endTime = Number(url.searchParams.get("endTime"));
      calls.push({ limit, endTime });
      const lastOpen = Math.floor(endTime / INTERVAL_MS) * INTERVAL_MS;
      const rows = Array.from({ length: limit }, (_, index) => candleRow(lastOpen - (limit - 1 - index) * INTERVAL_MS));
      return response(rows);
    }) as typeof fetch;

    const candles = await clientWith(fetchFake).getBaselineCandles("BTCUSDT");

    expect(candles).toHaveLength(2016);
    expect(calls).toEqual([
      { limit: 1500, endTime: NOW - 1 },
      { limit: 516, endTime: NOW - 1500 * INTERVAL_MS - 1 },
    ]);
    expect(candles[0].time).toBe((NOW - 2016 * INTERVAL_MS) / 1000);
    expect(candles.at(-1)?.closeTime).toBe(NOW - 1);
    expect(candles.every((candle) => candle.closeTime < NOW)).toBe(true);
  });

  it("非 5M 对齐时间也能在两页内取得完整基线而不无限翻页", async () => {
    const now = NOW + 42_123;
    const calls: number[] = [];
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const limit = Number(url.searchParams.get("limit"));
      const endTime = Number(url.searchParams.get("endTime"));
      calls.push(limit);
      const lastOpen = Math.floor(endTime / INTERVAL_MS) * INTERVAL_MS;
      return response(Array.from({ length: limit }, (_, index) => candleRow(lastOpen - (limit - 1 - index) * INTERVAL_MS)));
    }) as typeof fetch;
    const candles = await clientWith(fetchFake, "MAINNET", now).getBaselineCandles("BTCUSDT");
    expect(candles).toHaveLength(2016);
    expect(calls).toEqual([1500, 517]);
    expect(candles[0].time).toBe(Math.floor((now - 2016 * INTERVAL_MS) / INTERVAL_MS) * INTERVAL_MS / 1000);
    expect(candles.at(-1)?.closeTime).toBe(Math.floor(now / INTERVAL_MS) * INTERVAL_MS - 1);
  });
});

describe("组合回测历史数据", () => {
  it("通用历史 K 线按固定终点向前分页且不返回未来数据", async () => {
    const calls: { limit: number; endTime: number }[] = [];
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const limit = Number(url.searchParams.get("limit"));
      const endTime = Number(url.searchParams.get("endTime"));
      calls.push({ limit, endTime });
      const lastOpen = Math.floor(endTime / INTERVAL_MS) * INTERVAL_MS;
      return response(Array.from({ length: limit }, (_, index) => candleRow(lastOpen - (limit - 1 - index) * INTERVAL_MS)));
    }) as typeof fetch;

    const result = await clientWith(fetchFake).getHistoricalCandles("BTCUSDT", "5m", 1501, NOW - 1);

    expect(result).toHaveLength(1501);
    expect(result[0].closeTime).toBe(NOW - 1500 * INTERVAL_MS - 1);
    expect(result.at(-1)?.closeTime).toBe(NOW - 1);
    expect(calls).toEqual([
      { limit: 1500, endTime: NOW - 1 },
      { limit: 1, endTime: NOW - 1500 * INTERVAL_MS - 1 },
    ]);
  });

  it("历史资金费使用显式时间范围并按时间排序", async () => {
    const fetchFake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/fapi/v1/fundingRate");
      expect(url.searchParams.get("startTime")).toBe("1000");
      expect(url.searchParams.get("endTime")).toBe("2000");
      return response([
        { symbol: "BTCUSDT", fundingRate: "0.0002", fundingTime: 2000 },
        { symbol: "BTCUSDT", fundingRate: "-0.0001", fundingTime: 1000 },
      ]);
    }) as typeof fetch;

    const result = await clientWith(fetchFake).getFundingRates("BTCUSDT", 1000, 2000);

    expect(result).toEqual([
      { symbol: "BTCUSDT", fundingTime: 1000, fundingRate: -0.0001 },
      { symbol: "BTCUSDT", fundingTime: 2000, fundingRate: 0.0002 },
    ]);
  });
});
