import type { Candle, DataSource, MarketQuality } from "@contracts/trading";
import {
  BinanceNetworkError,
  BinanceRequestError,
  binance,
  createMarketSnapshot,
  type MarketSnapshot,
} from "./binance";

type StreamCategory = "PUBLIC" | "MARKET";
type StreamData = Record<string, unknown>;

function isStreamData(value: unknown): value is StreamData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STREAM_BASES: Record<DataSource, Record<StreamCategory, string>> = {
  MAINNET: {
    PUBLIC: "wss://fstream.binance.com/public",
    MARKET: "wss://fstream.binance.com/market",
  },
  TESTNET: {
    PUBLIC: "wss://stream.binancefuture.com",
    MARKET: "wss://stream.binancefuture.com",
  },
};

export interface WebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface MarketDataClient {
  readonly dataSource: DataSource;
  getMarketSnapshot(symbol: string): Promise<MarketSnapshot>;
  getCandles(symbol: string, interval: string, limit?: number): Promise<Candle[]>;
}

export interface OneMinuteRiskData {
  candle: Candle;
  eventTime: number;
  closed: boolean;
  usage: "RISK_ONLY";
  formalSignalEligible: false;
}

export interface SymbolMonitorMetrics {
  symbol: string;
  connected: boolean;
  degraded: boolean;
  quality: MarketQuality;
  stableSince: number | null;
  snapshot: MarketSnapshot | null;
  oneMinute: OneMinuteRiskData | null;
  reconnects: number;
  messages: number;
  missedMessages: number | null;
  lastMessageAt: number | null;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
}

export interface MonitorMetrics {
  running: boolean;
  source: DataSource;
  sourceHealthy: boolean;
  connections: number;
  openConnections: number;
  reconnects: number;
  messages: number;
  malformedMessages: number;
  missedMessages: number | null;
  rateLimits: number;
  degradedSymbols: number;
  lastMessageAt: number | null;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
}

export interface MonitorObservabilitySnapshot {
  metrics: MonitorMetrics;
  symbols: Record<string, SymbolMonitorMetrics>;
}

export interface MarketMonitorOptions {
  client?: MarketDataClient;
  now?: () => number;
  webSocketFactory?: WebSocketFactory;
  maxStreamsPerConnection?: number;
  reconnectDelayMs?: number;
  restPollIntervalMs?: number;
  bookStaleMs?: number;
  candleStaleMs?: number;
}

interface SymbolState {
  symbol: string;
  connected: boolean;
  links: Record<StreamCategory, boolean>;
  transportReason: string | null;
  stableSince: number | null;
  snapshot: MarketSnapshot | null;
  oneMinute: OneMinuteRiskData | null;
  reconnects: number;
  messages: number;
  lastMessageAt: number | null;
  latencyTotalMs: number;
  latencySamples: number;
  maxLatencyMs: number | null;
}

interface ConnectionGroup {
  symbols: string[];
  category: StreamCategory;
  generation: number;
  retired: boolean;
  socket: WebSocketLike;
  open: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

function invalidQuality(reason: string): MarketQuality {
  return { valid: false, reasons: [reason], bookAgeMs: null, markAgeMs: null, candleAgeMs: null };
}

function latencyMetrics(state: SymbolState) {
  return {
    lastMessageAt: state.lastMessageAt,
    averageLatencyMs: state.latencySamples > 0 ? state.latencyTotalMs / state.latencySamples : null,
    maxLatencyMs: state.maxLatencyMs,
  };
}

export class MarketMonitor {
  private readonly client: MarketDataClient;
  private readonly now: () => number;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly maxStreamsPerConnection: number;
  private readonly reconnectDelayMs: number;
  private readonly restPollIntervalMs: number;
  private readonly bookStaleMs: number;
  private readonly candleStaleMs: number;
  private source: DataSource;
  private generation = 0;
  private running = false;
  private sourceHealthy = true;
  private states = new Map<string, SymbolState>();
  private groups = new Set<ConnectionGroup>();
  private restTimer: ReturnType<typeof setInterval> | null = null;
  private reconnects = 0;
  private messages = 0;
  private malformedMessages = 0;
  private rateLimits = 0;
  private lastMessageAt: number | null = null;
  private latencyTotalMs = 0;
  private latencySamples = 0;
  private maxLatencyMs: number | null = null;

  constructor(options: MarketMonitorOptions = {}) {
    this.client = options.client ?? binance;
    this.source = this.client.dataSource;
    this.now = options.now ?? Date.now;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.maxStreamsPerConnection = options.maxStreamsPerConnection ?? 200;
    if (!Number.isInteger(this.maxStreamsPerConnection) || this.maxStreamsPerConnection < 3 || this.maxStreamsPerConnection > 1024) {
      throw new Error("maxStreamsPerConnection must be an integer from 3 to 1024");
    }
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.restPollIntervalMs = options.restPollIntervalMs ?? 15_000;
    this.bookStaleMs = options.bookStaleMs ?? 5000;
    this.candleStaleMs = options.candleStaleMs ?? 90_000;
  }

  start(symbols: string[]) {
    this.stop();
    this.states.clear();
    this.reconnects = 0;
    this.messages = 0;
    this.malformedMessages = 0;
    this.rateLimits = 0;
    this.lastMessageAt = null;
    this.latencyTotalMs = 0;
    this.latencySamples = 0;
    this.maxLatencyMs = null;
    this.source = this.client.dataSource;
    this.sourceHealthy = true;
    this.running = true;
    const generation = this.generation;
    const uniqueSymbols = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
    for (const symbol of uniqueSymbols) {
      this.states.set(symbol, {
        symbol,
        connected: false,
        links: { PUBLIC: false, MARKET: false },
        transportReason: "等待行情",
        stableSince: null,
        snapshot: null,
        oneMinute: null,
        reconnects: 0,
        messages: 0,
        lastMessageAt: null,
        latencyTotalMs: 0,
        latencySamples: 0,
        maxLatencyMs: null,
      });
    }

    const symbolsPerConnection = Math.max(1, Math.floor(this.maxStreamsPerConnection / 3));
    for (let offset = 0; offset < uniqueSymbols.length; offset += symbolsPerConnection) {
      const group = uniqueSymbols.slice(offset, offset + symbolsPerConnection);
      this.openConnection(group, "MARKET", false, generation);
      this.openConnection(group, "PUBLIC", false, generation);
    }
    if (this.restPollIntervalMs > 0) {
      this.restTimer = setInterval(() => void this.recoverDegraded(), this.restPollIntervalMs);
    }
  }

  stop() {
    this.generation += 1;
    this.running = false;
    if (this.restTimer) clearInterval(this.restTimer);
    this.restTimer = null;
    const retiredGroups = [...this.groups];
    this.groups.clear();
    for (const group of retiredGroups) {
      group.retired = true;
      group.open = false;
      if (group.reconnectTimer) clearTimeout(group.reconnectTimer);
      group.reconnectTimer = null;
      group.socket.close(1000, "monitor stop");
    }
    for (const state of this.states.values()) {
      state.connected = false;
      state.links = { PUBLIC: false, MARKET: false };
    }
  }

  private isCurrentSocket(group: ConnectionGroup, socket: WebSocketLike, generation: number) {
    return this.running
      && this.generation === generation
      && group.generation === generation
      && !group.retired
      && this.groups.has(group)
      && group.socket === socket;
  }

  private openConnection(
    symbols: string[],
    category: StreamCategory,
    isReconnect: boolean,
    generation: number,
    existing?: ConnectionGroup,
  ) {
    if (!this.running || this.generation !== generation || existing?.retired) return;
    const streams = symbols.flatMap((symbol) => {
      const lower = symbol.toLowerCase();
      return category === "MARKET"
        ? [`${lower}@kline_1m`, `${lower}@markPrice@1s`]
        : [`${lower}@bookTicker`];
    });
    const url = `${STREAM_BASES[this.source][category]}/stream?streams=${streams.join("/")}`;
    const socket = this.webSocketFactory(url);
    const group: ConnectionGroup = existing ?? {
      symbols,
      category,
      generation,
      retired: false,
      socket,
      open: false,
      reconnectTimer: null,
    };
    group.socket = socket;
    group.open = false;
    group.reconnectTimer = null;
    this.groups.add(group);

    socket.addEventListener("open", () => {
      if (!this.isCurrentSocket(group, socket, generation)) return;
      group.open = true;
      if (isReconnect) this.reconnects += 1;
      for (const symbol of group.symbols) {
        const state = this.states.get(symbol);
        if (!state) continue;
        state.links[group.category] = true;
        state.connected = state.links.PUBLIC && state.links.MARKET;
        state.transportReason = state.connected ? null : "WebSocket断开";
        if (isReconnect) state.reconnects += 1;
      }
    });
    socket.addEventListener("message", (event) => this.onMessage(group, socket, generation, event));
    socket.addEventListener("close", () => {
      if (!this.isCurrentSocket(group, socket, generation)) return;
      group.open = false;
      for (const symbol of group.symbols) {
        const state = this.states.get(symbol);
        if (!state) continue;
        state.links[group.category] = false;
        state.connected = false;
        state.transportReason = "WebSocket断开";
        state.stableSince = null;
      }
      if (!group.reconnectTimer) {
        group.reconnectTimer = setTimeout(() => {
          if (this.isCurrentSocket(group, socket, generation)) {
            this.openConnection(group.symbols, group.category, true, generation, group);
          }
        }, this.reconnectDelayMs);
      }
    });
    socket.addEventListener("error", (event) => {
      if (!this.isCurrentSocket(group, socket, generation)) return;
      const message = String((event as { message?: unknown })?.message ?? "");
      if (/429|418|rate.?limit/i.test(message)) this.rateLimits += 1;
    });
  }

  private onMessage(
    group: ConnectionGroup,
    socket: WebSocketLike,
    generation: number,
    event: unknown,
  ) {
    if (!this.isCurrentSocket(group, socket, generation) || !group.open) return;
    let envelope: StreamData;
    try {
      const parsed: unknown = JSON.parse(String(isStreamData(event) ? event.data : undefined));
      if (!isStreamData(parsed)) {
        this.malformedMessages += 1;
        return;
      }
      envelope = parsed;
    } catch {
      this.malformedMessages += 1;
      return;
    }
    const data = envelope.data;
    if (!isStreamData(data)) return;
    const symbol = typeof data.s === "string" ? data.s.toUpperCase() : "";
    const state = this.states.get(symbol);
    if (!state || !group.symbols.includes(symbol) || typeof envelope.stream !== "string") return;

    this.messages += 1;
    state.messages += 1;
    state.lastMessageAt = this.now();
    this.lastMessageAt = state.lastMessageAt;
    const eventTime = Number(data.E ?? data.T);
    const latency = this.now() - eventTime;
    if (Number.isFinite(latency) && latency >= 0) {
      state.latencyTotalMs += latency;
      state.latencySamples += 1;
      state.maxLatencyMs = Math.max(state.maxLatencyMs ?? 0, latency);
      this.latencyTotalMs += latency;
      this.latencySamples += 1;
      this.maxLatencyMs = Math.max(this.maxLatencyMs ?? 0, latency);
    }

    if (envelope.stream.endsWith("@bookTicker")) this.onBook(state, data, eventTime);
    else if (envelope.stream.endsWith("@markPrice@1s")) this.onMark(state, data, eventTime);
    else if (envelope.stream.endsWith("@kline_1m")) this.onOneMinute(state, data, eventTime);
  }

  private onBook(state: SymbolState, data: StreamData, eventTime: number) {
    this.updateSnapshot(state, {
      bid: Number(data.b),
      ask: Number(data.a),
      bookTime: eventTime,
      markPrice: state.snapshot?.markPrice ?? Number.NaN,
      markTime: state.snapshot?.markTime ?? Number.NaN,
    });
  }

  private onMark(state: SymbolState, data: StreamData, eventTime: number) {
    this.updateSnapshot(state, {
      bid: state.snapshot?.bid ?? Number.NaN,
      ask: state.snapshot?.ask ?? Number.NaN,
      bookTime: state.snapshot?.bookTime ?? Number.NaN,
      markPrice: Number(data.p),
      markTime: eventTime,
    });
  }

  private updateSnapshot(
    state: SymbolState,
    input: { bid: number; ask: number; bookTime: number; markPrice: number; markTime: number },
  ) {
    state.snapshot = createMarketSnapshot({
      source: this.source,
      symbol: state.symbol,
      ...input,
      candleTime: state.oneMinute?.eventTime,
    }, this.now(), this.bookStaleMs, this.candleStaleMs, true);
    if (state.connected && state.snapshot.quality.valid) {
      state.transportReason = null;
      this.sourceHealthy = true;
    }
    this.refreshSymbol(state);
  }

  private onOneMinute(state: SymbolState, data: StreamData, eventTime: number) {
    const candle = data.k;
    if (!isStreamData(candle) || candle.i !== "1m") return;
    state.oneMinute = {
      candle: {
        time: Number(candle.t) / 1000,
        closeTime: Number(candle.T),
        open: Number(candle.o),
        high: Number(candle.h),
        low: Number(candle.l),
        close: Number(candle.c),
        volume: Number(candle.v),
      },
      eventTime,
      closed: candle.x === true,
      usage: "RISK_ONLY",
      formalSignalEligible: false,
    };
    this.refreshSymbol(state);
  }

  private readSymbol(state: SymbolState) {
    const snapshot = state.snapshot ? createMarketSnapshot({
      source: this.source,
      symbol: state.symbol,
      bid: state.snapshot.bid,
      ask: state.snapshot.ask,
      bookTime: state.snapshot.bookTime,
      markPrice: state.snapshot.markPrice,
      markTime: state.snapshot.markTime,
      candleTime: state.oneMinute?.eventTime,
    }, this.now(), this.bookStaleMs, this.candleStaleMs, true) : null;
    const base = snapshot?.quality ?? invalidQuality(state.oneMinute ? "等待行情" : "缺少1M数据");
    const quality = state.transportReason
      ? { ...base, valid: false, reasons: [...new Set([state.transportReason, ...base.reasons])] }
      : base;
    return { snapshot, quality };
  }

  private refreshSymbol(state: SymbolState) {
    const { snapshot, quality } = this.readSymbol(state);
    state.snapshot = snapshot;
    if (quality.valid) {
      if (state.stableSince === null) state.stableSince = this.now();
    } else {
      state.stableSince = null;
    }
    return quality;
  }

  async recoverDegraded(symbols?: string[]) {
    const generation = this.generation;
    const source = this.source;
    const selected = symbols
      ? symbols.map((symbol) => symbol.toUpperCase())
      : [...this.states.values()].filter((state) => !this.refreshSymbol(state).valid).map((state) => state.symbol);
    await Promise.all(selected.map(async (symbol) => {
      const state = this.states.get(symbol);
      if (!state) return;
      const isCurrent = () => this.running
        && this.generation === generation
        && this.source === source
        && this.states.get(symbol) === state;
      try {
        const oneMinuteAge = state.oneMinute ? this.now() - state.oneMinute.eventTime : null;
        const needsOneMinute = oneMinuteAge === null || !Number.isFinite(oneMinuteAge) || oneMinuteAge > this.candleStaleMs;
        const [snapshot, candles] = await Promise.all([
          this.client.getMarketSnapshot(symbol),
          needsOneMinute ? this.client.getCandles(symbol, "1m", 1) : Promise.resolve(null),
        ]);
        if (!isCurrent()) return;
        if (snapshot.source !== source) {
          state.transportReason = "数据源切换";
          state.stableSince = null;
          return;
        }
        if (candles) {
          const latest = candles.at(-1);
          if (!latest) throw new SyntaxError("Empty 1M recovery response");
          state.oneMinute = {
            candle: latest,
            eventTime: latest.time * 1000,
            closed: latest.closeTime <= this.now(),
            usage: "RISK_ONLY",
            formalSignalEligible: false,
          };
        }
        state.snapshot = snapshot;
        state.transportReason = null;
        this.sourceHealthy = true;
        this.refreshSymbol(state);
      } catch (error) {
        if (!isCurrent()) return;
        const status = error instanceof BinanceRequestError ? error.status : null;
        const errorName = error instanceof Error ? error.name : "";
        const networkFailure = error instanceof BinanceNetworkError || errorName === "AbortError" || errorName === "TimeoutError";
        if (status === 418 || status === 429) this.rateLimits += 1;
        if (networkFailure || status === 418 || status === 429 || (status !== null && status >= 500)) {
          this.sourceHealthy = false;
          for (const pooled of this.states.values()) {
            pooled.transportReason = "共享行情源故障";
            pooled.stableSince = null;
          }
        } else {
          state.transportReason = "REST补全失败";
          state.stableSince = null;
        }
      }
    }));
  }

  private aggregateMetrics(degradedSymbols: number): MonitorMetrics {
    return {
      running: this.running,
      source: this.source,
      sourceHealthy: this.sourceHealthy,
      connections: this.groups.size,
      openConnections: [...this.groups].filter((group) => group.open).length,
      reconnects: this.reconnects,
      messages: this.messages,
      malformedMessages: this.malformedMessages,
      missedMessages: null,
      rateLimits: this.rateLimits,
      degradedSymbols,
      lastMessageAt: this.lastMessageAt,
      averageLatencyMs: this.latencySamples > 0 ? this.latencyTotalMs / this.latencySamples : null,
      maxLatencyMs: this.maxLatencyMs,
    };
  }

  private symbolMetrics(state: SymbolState, snapshot: MarketSnapshot | null, quality: MarketQuality): SymbolMonitorMetrics {
    return {
      symbol: state.symbol,
      connected: state.connected,
      degraded: !quality.valid,
      quality,
      stableSince: state.stableSince,
      snapshot,
      oneMinute: state.oneMinute,
      reconnects: state.reconnects,
      messages: state.messages,
      missedMessages: null,
      ...latencyMetrics(state),
    };
  }

  getMetrics(): MonitorMetrics {
    let degradedSymbols = 0;
    for (const state of this.states.values()) {
      if (!this.refreshSymbol(state).valid) degradedSymbols += 1;
    }
    return this.aggregateMetrics(degradedSymbols);
  }

  getObservabilitySnapshot(): MonitorObservabilitySnapshot {
    let degradedSymbols = 0;
    const symbols: Record<string, SymbolMonitorMetrics> = {};
    for (const state of this.states.values()) {
      const { snapshot, quality } = this.readSymbol(state);
      if (!quality.valid) degradedSymbols += 1;
      symbols[state.symbol] = this.symbolMetrics(state, snapshot, quality);
    }
    return {
      metrics: this.aggregateMetrics(degradedSymbols),
      symbols,
    };
  }

  getSymbolMetrics(symbol: string): SymbolMonitorMetrics | undefined {
    const state = this.states.get(symbol.toUpperCase());
    if (!state) return undefined;
    const quality = this.refreshSymbol(state);
    return this.symbolMetrics(state, state.snapshot, quality);
  }
}
