import type { Candle, DataSource, HistoricalFundingRate, Market, MarketQuality, TradingSettings } from "@contracts/trading";

const BASES: Record<DataSource, string> = {
  MAINNET: "https://fapi.binance.com",
  TESTNET: "https://testnet.binancefuture.com",
};

// Public market data does not expose account-specific leverage brackets. These are
// simulation ceilings, not a claim about the user's Binance account permissions.
const SIMULATION_LEVERAGE_CAPS: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 100, SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75,
  DOGEUSDT: 75, ADAUSDT: 50, LINKUSDT: 75, AVAXUSDT: 50, TONUSDT: 50,
  SUIUSDT: 50, NEARUSDT: 50, LTCUSDT: 75, BCHUSDT: 75, ARBUSDT: 50,
  OPUSDT: 50, INJUSDT: 50, ATOMUSDT: 50, ETCUSDT: 50, FILUSDT: 50,
};

type CacheEntry<T> = { at: number; value: T };
type NumericRow = (string | number)[];

interface ExchangeFilter {
  filterType?: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  notional?: string;
}

interface ExchangeInstrument {
  symbol: string;
  baseAsset: string;
  contractType: string;
  quoteAsset: string;
  status: string;
  filters: ExchangeFilter[];
}

interface ExchangeInfo {
  symbols?: ExchangeInstrument[];
}

interface Ticker24Hour {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
}

interface BookTicker {
  symbol: string;
  bidPrice: string;
  askPrice: string;
  time?: number;
}

interface PremiumIndex {
  symbol: string;
  markPrice: string;
  lastFundingRate?: string;
  time?: number;
}

interface FundingRateRow {
  symbol?: string;
  fundingTime?: string | number;
  fundingRate?: string | number;
}

export interface SymbolMeta {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface MarketSnapshot {
  source: DataSource;
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  markPrice: number;
  spreadBps: number;
  bookTime: number;
  markTime: number;
  observedAt: number;
  quality: MarketQuality;
}

export interface BinanceClientOptions {
  source?: DataSource;
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  bookStaleMs?: number;
}

interface SnapshotInput {
  source: DataSource;
  symbol: string;
  bid: number;
  ask: number;
  markPrice: number;
  bookTime: number;
  markTime: number;
  candleTime?: number;
}

export class BinanceRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BinanceRequestError";
    this.status = status;
  }
}

export class BinanceNetworkError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BinanceNetworkError";
    this.cause = cause;
  }
}

export function createMarketSnapshot(
  input: SnapshotInput,
  now: number,
  bookStaleMs = 5000,
  candleStaleMs = 90_000,
  requireCandle = false,
): MarketSnapshot {
  const reasons: string[] = [];
  const bookPricesValid = Number.isFinite(input.bid) && input.bid > 0 && Number.isFinite(input.ask) && input.ask > 0;
  if (!bookPricesValid) reasons.push("盘口价格无效");
  if (bookPricesValid && input.ask < input.bid) reasons.push("盘口交叉");

  const bookTimeValid = Number.isFinite(input.bookTime) && input.bookTime > 0 && input.bookTime <= now + 1000;
  const markTimeValid = Number.isFinite(input.markTime) && input.markTime > 0 && input.markTime <= now + 1000;
  const bookAgeMs = bookTimeValid ? Math.max(0, now - input.bookTime) : null;
  const markAgeMs = markTimeValid ? Math.max(0, now - input.markTime) : null;
  if (!bookTimeValid) reasons.push("盘口时间无效");
  else if (bookAgeMs === null || bookAgeMs > bookStaleMs) reasons.push("盘口陈旧");

  if (!Number.isFinite(input.markPrice) || input.markPrice <= 0) reasons.push("标记价无效");
  if (!markTimeValid) reasons.push("标记价时间无效");
  else if (markAgeMs === null || markAgeMs > bookStaleMs) reasons.push("标记价陈旧");

  let candleAgeMs: number | null = null;
  if (requireCandle && input.candleTime === undefined) reasons.push("缺少1M数据");
  if (input.candleTime !== undefined) {
    const candleTimeValid = Number.isFinite(input.candleTime) && input.candleTime > 0 && input.candleTime <= now + 1000;
    candleAgeMs = candleTimeValid ? Math.max(0, now - input.candleTime) : null;
    if (!candleTimeValid) reasons.push("1M数据时间无效");
    else if (candleAgeMs === null || candleAgeMs > candleStaleMs) reasons.push("1M数据陈旧");
  }

  const mid = bookPricesValid ? (input.bid + input.ask) / 2 : Number.NaN;
  return {
    source: input.source,
    symbol: input.symbol,
    bid: input.bid,
    ask: input.ask,
    mid,
    markPrice: input.markPrice,
    spreadBps: Number.isFinite(mid) && mid > 0 ? (input.ask - input.bid) / mid * 10_000 : Number.NaN,
    bookTime: input.bookTime,
    markTime: input.markTime,
    observedAt: now,
    quality: { valid: reasons.length === 0, reasons, bookAgeMs, markAgeMs, candleAgeMs },
  };
}

export class BinanceFuturesClient {
  private source: DataSource;
  private generation = 0;
  private connected = false;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly bookStaleMs: number;
  private responseCache = new Map<string, CacheEntry<unknown>>();
  private candleCache = new Map<string, CacheEntry<Candle[]>>();

  constructor(options: BinanceClientOptions = {}) {
    this.source = options.source ?? "MAINNET";
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 7000;
    this.bookStaleMs = options.bookStaleMs ?? 5000;
  }

  get dataSource() { return this.source; }
  get sourceGeneration() { return this.generation; }
  get isConnected() { return this.connected; }
  get sourceLabel() {
    return this.source === "MAINNET" ? "币安 USDⓈ-M 主网公开行情" : "币安期货测试网公开行情";
  }

  setDataSource(source: DataSource) {
    if (source === this.source) return;
    this.source = source;
    this.generation += 1;
    this.connected = false;
    this.responseCache.clear();
    this.candleCache.clear();
  }

  private async request<T = unknown>(source: DataSource, path: string, timeout = this.requestTimeoutMs): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${BASES[source]}${path}`, { signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      this.connected = false;
      throw new BinanceNetworkError(error);
    }
    if (!response.ok) {
      this.connected = false;
      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        if (error instanceof TypeError) throw new BinanceNetworkError(error);
        throw error;
      }
      throw new BinanceRequestError(response.status, `Binance ${response.status}: ${body.slice(0, 180)}`);
    }
    try {
      const value = await response.json();
      this.connected = true;
      return value as T;
    } catch (error) {
      this.connected = false;
      if (error instanceof TypeError) throw new BinanceNetworkError(error);
      throw error;
    }
  }

  private async cached<T>(source: DataSource, key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    const sourceKey = `${source}:${key}`;
    const cached = this.responseCache.get(sourceKey) as CacheEntry<T> | undefined;
    if (cached && this.now() - cached.at < ttl) return cached.value;
    const value = await loader();
    this.responseCache.set(sourceKey, { at: this.now(), value });
    return value;
  }

  private async exchangeInfo(source: DataSource) {
    return this.cached<ExchangeInfo>(source, "exchange", 60 * 60_000, () => this.request<ExchangeInfo>(source, "/fapi/v1/exchangeInfo"));
  }

  async getMarkets(settings: TradingSettings): Promise<Market[]> {
    const source = this.source;
    const [exchange, tickers, books, premiums] = await Promise.all([
      this.exchangeInfo(source),
      this.cached<Ticker24Hour[]>(source, "ticker", 5000, () => this.request<Ticker24Hour[]>(source, "/fapi/v1/ticker/24hr")),
      this.cached<BookTicker[]>(source, "book", 5000, () => this.request<BookTicker[]>(source, "/fapi/v1/ticker/bookTicker")),
      this.cached<PremiumIndex[]>(source, "premium", 5000, () => this.request<PremiumIndex[]>(source, "/fapi/v1/premiumIndex")),
    ]);
    const tickerMap = new Map(tickers.map((item) => [item.symbol, item]));
    const bookMap = new Map(books.map((item) => [item.symbol, item]));
    const premiumMap = new Map(premiums.map((item) => [item.symbol, item]));
    const markets: Market[] = [];
    for (const instrument of exchange.symbols ?? []) {
      if (instrument.contractType !== "PERPETUAL" || instrument.quoteAsset !== "USDT" || instrument.status !== "TRADING") continue;
      const ticker = tickerMap.get(instrument.symbol);
      const book = bookMap.get(instrument.symbol);
      const premium = premiumMap.get(instrument.symbol);
      if (!ticker || !book) continue;
      const price = Number(ticker.lastPrice);
      const bid = Number(book.bidPrice);
      const ask = Number(book.askPrice);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : price;
      const spreadBps = mid > 0 ? Math.max(0, (ask - bid) / mid * 10_000) : 9999;
      const quoteVolume = Number(ticker.quoteVolume);
      const volumeScore = Math.min(100, Math.log10(Math.max(1, quoteVolume)) / 10 * 100);
      const spreadScore = Math.max(0, 100 - spreadBps * 20);
      const reasons: string[] = [];
      if (quoteVolume < settings.minQuoteVolume) reasons.push("24h 成交额不足");
      if (spreadBps > settings.maxSpreadBps) reasons.push("点差超限");
      if (!(price > 0)) reasons.push("价格异常");
      markets.push({
        symbol: instrument.symbol,
        baseAsset: instrument.baseAsset,
        price,
        markPrice: Number(premium?.markPrice ?? price),
        change24h: Number(ticker.priceChangePercent),
        quoteVolume,
        spreadBps,
        fundingRate: Number(premium?.lastFundingRate ?? 0),
        high24h: Number(ticker.highPrice),
        low24h: Number(ticker.lowPrice),
        maxLeverage: SIMULATION_LEVERAGE_CAPS[instrument.symbol] ?? 20,
        liquidityScore: Math.round((volumeScore * 0.7 + spreadScore * 0.3) * 10) / 10,
        eligible: reasons.length === 0,
        filterReason: reasons.length ? reasons.join(" · ") : "流动性合格",
      });
    }
    return markets.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.quoteVolume - a.quoteVolume);
  }

  async getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
    const source = this.source;
    const encoded = encodeURIComponent(symbol);
    const [book, premium] = await Promise.all([
      this.request<BookTicker>(source, `/fapi/v1/ticker/bookTicker?symbol=${encoded}`),
      this.request<PremiumIndex>(source, `/fapi/v1/premiumIndex?symbol=${encoded}`),
    ]);
    return createMarketSnapshot({
      source,
      symbol,
      bid: Number(book.bidPrice),
      ask: Number(book.askPrice),
      markPrice: Number(premium.markPrice),
      bookTime: Number(book.time),
      markTime: Number(premium.time),
    }, this.now(), this.bookStaleMs);
  }

  async getCandles(symbol: string, interval: string, limit = 240): Promise<Candle[]> {
    const source = this.source;
    const key = `${source}:${symbol}:${interval}:${limit}`;
    const cached = this.candleCache.get(key);
    if (cached && this.now() - cached.at < 12_000) return cached.value;
    const raw = await this.request<NumericRow[]>(source, `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`);
    const value = raw.map((row) => ({
      time: Number(row[0]) / 1000,
      closeTime: Number(row[6]),
      open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
      close: Number(row[4]), volume: Number(row[5]),
    }));
    this.candleCache.set(key, { at: this.now(), value });
    return value;
  }

  async getBaselineCandles(symbol: string, interval = "5m", days = 7): Promise<Candle[]> {
    if (interval !== "5m" || !Number.isFinite(days) || days <= 0) throw new Error("Baseline requires a positive 5m window");
    const source = this.source;
    const now = this.now();
    const intervalMs = 300_000;
    const required = Math.ceil(days * 86_400_000 / intervalMs);
    const startTime = now - required * intervalMs;
    const byOpenTime = new Map<number, Candle>();
    let endTime = now - 1;

    while (byOpenTime.size < required) {
      const limit = Math.min(1500, required - byOpenTime.size);
      const path = `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=${limit}&endTime=${endTime}`;
      const raw = await this.request<NumericRow[]>(source, path);
      if (!Array.isArray(raw) || raw.length === 0) break;
      for (const row of raw) {
        const openTime = Number(row[0]);
        const closeTime = Number(row[6]);
        if (openTime >= startTime && closeTime <= now) {
          byOpenTime.set(openTime, {
            time: openTime / 1000,
            closeTime,
            open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
            close: Number(row[4]), volume: Number(row[5]),
          });
        }
      }
      endTime = Number(raw[0][0]) - 1;
    }

    const candles = [...byOpenTime.values()].sort((a, b) => a.time - b.time);
    if (candles.length < required) throw new Error(`Insufficient 5m baseline: ${candles.length}/${required}`);
    return candles.slice(-required);
  }

  async getSymbolMeta(symbol: string): Promise<SymbolMeta> {
    const exchange = await this.exchangeInfo(this.source);
    const instrument = (exchange.symbols ?? []).find((item) => item.symbol === symbol);
    if (!instrument) throw new Error(`Unknown symbol ${symbol}`);
    const filter = (name: string) => instrument.filters.find((item) => item.filterType === name) ?? {};
    const price = filter("PRICE_FILTER");
    const lot = filter("LOT_SIZE");
    const notional = filter("MIN_NOTIONAL");
    return {
      symbol,
      tickSize: Number(price.tickSize ?? 0.01),
      stepSize: Number(lot.stepSize ?? 0.001),
      minQty: Number(lot.minQty ?? 0),
      minNotional: Number(notional.notional ?? 5),
    };
  }

  async getHistoricalCandles(symbol: string, interval: string, limit: number, endTime = this.now() - 1): Promise<Candle[]> {
    const intervals: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
    if (!intervals[interval] || !Number.isInteger(limit) || limit <= 0 || !Number.isFinite(endTime)) {
      throw new Error("Invalid historical candle request");
    }
    const source = this.source;
    const byOpenTime = new Map<number, Candle>();
    let cursor = endTime;
    while (byOpenTime.size < limit) {
      const batch = Math.min(1500, limit - byOpenTime.size);
      const path = `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${batch}&endTime=${cursor}`;
      const raw = await this.request<NumericRow[]>(source, path);
      if (!Array.isArray(raw) || raw.length === 0) break;
      const firstOpen = Number(raw[0]?.[0]);
      if (!Number.isFinite(firstOpen)) throw new Error(`Invalid historical candles for ${symbol}`);
      for (const row of raw) {
        const openTime = Number(row[0]);
        const closeTime = Number(row[6]);
        if (closeTime <= endTime) {
          byOpenTime.set(openTime, {
            time: openTime / 1000,
            closeTime,
            open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
            close: Number(row[4]), volume: Number(row[5]),
          });
        }
      }
      cursor = firstOpen - 1;
    }
    if (byOpenTime.size < limit) throw new Error(`Insufficient ${interval} history for ${symbol}: ${byOpenTime.size}/${limit}`);
    return [...byOpenTime.values()].sort((a, b) => a.time - b.time).slice(-limit);
  }

  async getFundingRates(symbol: string, startTime: number, endTime: number): Promise<HistoricalFundingRate[]> {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime < startTime) {
      throw new Error("Invalid funding history request");
    }
    const raw = await this.request<FundingRateRow[]>(this.source, `/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${startTime}&endTime=${endTime}&limit=1000`);
    if (!Array.isArray(raw)) throw new Error(`Invalid funding history for ${symbol}`);
    if (raw.length >= 1000) throw new Error(`Funding history requires pagination for ${symbol}; refusing incomplete results`);
    const funding = raw.map((item) => {
      const fundingTime = Number(item?.fundingTime);
      const fundingRate = Number(item?.fundingRate);
      if (item?.symbol !== symbol || !Number.isFinite(fundingTime) || !Number.isFinite(fundingRate)
        || fundingTime < startTime || fundingTime > endTime) {
        throw new Error(`Invalid funding history row for ${symbol}`);
      }
      return { symbol, fundingTime, fundingRate };
    });
    return funding.sort((a, b) => a.fundingTime - b.fundingTime);
  }

  async getOrderBook(symbol: string, limit = 20) {
    return this.request(this.source, `/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
  }
}

export const binance = new BinanceFuturesClient();
