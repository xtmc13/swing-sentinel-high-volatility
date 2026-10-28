import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  type AccountSnapshot,
  type Candle,
  type Market,
  type MarketQuality,
  type Opportunity,
  type TradingSettings,
  type VolatilityState,
} from "@contracts/trading";
import {
  createTradingEngine,
  engine as productionEngine,
  startAutomation,
  type EngineMonitor,
  type EngineRiskData,
  type TradingEngineDependencies,
} from "./engine";

const START = 1_800_000_000_000;
const validQuality: MarketQuality = {
  valid: true,
  reasons: [],
  bookAgeMs: 1,
  markAgeMs: 1,
  candleAgeMs: 1,
};

function market(symbol: string): Market {
  return {
    symbol,
    baseAsset: symbol.replace("USDT", ""),
    price: 100,
    markPrice: 100,
    change24h: 1,
    quoteVolume: 100_000_000,
    spreadBps: 1,
    fundingRate: 0,
    high24h: 110,
    low24h: 90,
    maxLeverage: 20,
    liquidityScore: 90,
    eligible: true,
    filterReason: "流动性合格",
  };
}

function opportunity(symbol: string, now: number, stateVersion: number): Opportunity {
  return {
    id: `${symbol}-${now}`,
    symbol,
    side: "LONG",
    status: "READY",
    score: 90,
    regime: "多头共振",
    entry: 100,
    stop: 99,
    target: 102.2,
    stopDistancePct: 1,
    rewardRisk: 2.2,
    leverage: 20,
    marginPct: 2,
    riskPct: 0.35,
    reasons: ["测试正式信号"],
    signalCloseTime: now - 1000,
    stateVersion,
    sourceGeneration: 0,
    atr15: 1,
    createdAt: new Date(now).toISOString(),
  };
}

function state(symbol: string, mode: VolatilityState["mode"] = "NORMAL"): VolatilityState {
  return {
    symbol,
    mode,
    confirmationCount: 0,
    stableSince: null,
    metrics: { atrQuantile: 0.5, tickSigma: 1, spreadRatio: 1 },
    lastDataAt: START,
    version: mode === "NORMAL" ? 0 : 1,
  };
}

const account: AccountSnapshot = {
  equity: 100_000,
  cash: 100_000,
  availableMargin: 100_000,
  usedMargin: 0,
  unrealizedPnl: 0,
  realizedPnl: 0,
  todayPnl: 0,
  todayPnlPct: 0,
  dayStartEquity: 100_000,
};

const normalRiskData: EngineRiskData = {
  currentAtr: 1,
  atrBaseline: Array.from({ length: 2016 }, (_, index) => index < 1008 ? 0 : 2),
  currentTickReturn: 0,
  tickReturnBaseline: [0, 0, 0],
  spreadBaselineBps: Array(120).fill(1),
};

interface HarnessOptions {
  symbols?: string[];
  settings?: Partial<TradingSettings>;
  states?: Record<string, VolatilityState>;
  riskData?: EngineRiskData | ((symbol: string) => EngineRiskData);
  quality?: MarketQuality;
  sourceHealthy?: boolean;
  stableSince?: number | null;
  baselineCandles?: (source: "MAINNET" | "TESTNET") => Candle[];
  oneMinute?: () => NonNullable<ReturnType<EngineMonitor["getSymbolMetrics"]>>["oneMinute"];
  dependencies?: Partial<TradingEngineDependencies>;
}

function harness(options: HarnessOptions = {}) {
  let now = START;
  const symbols = options.symbols ?? ["BTCUSDT"];
  const settings = { ...DEFAULT_SETTINGS, autoTrade: false, ...options.settings };
  const states = new Map(Object.entries(options.states ?? {}));
  const savedStates: VolatilityState[] = [];
  const events: { level: string; category: string; message: string; symbol?: string }[] = [];
  const opened: Opportunity[] = [];
  let analyses = 0;
  let managed = 0;
  let monitorStarts = 0;
  let sourceHealthy = options.sourceHealthy ?? true;
  let dataSource: "MAINNET" | "TESTNET" = "MAINNET";
  let sourceGeneration = 0;
  const monitor: EngineMonitor = {
    start: () => { monitorStarts += 1; },
    stop: () => undefined,
    getMetrics: () => ({
      running: true,
      source: "MAINNET",
      sourceHealthy,
      connections: 2,
      openConnections: 2,
      reconnects: 0,
      messages: 1,
      malformedMessages: 0,
      missedMessages: 0,
      rateLimits: 0,
      degradedSymbols: options.quality?.valid === false ? symbols.length : 0,
      lastMessageAt: now,
      averageLatencyMs: 1,
      maxLatencyMs: 1,
    }),
    getSymbolMetrics: (symbol) => ({
      symbol,
      connected: options.quality?.valid ?? true,
      degraded: !(options.quality?.valid ?? true),
      quality: options.quality ?? validQuality,
      stableSince: options.stableSince ?? null,
      snapshot: {
        source: "MAINNET",
        symbol,
        bid: 99.9,
        ask: 100.1,
        mid: 100,
        markPrice: 100,
        spreadBps: 1,
        bookTime: now,
        markTime: now,
        observedAt: now,
        quality: options.quality ?? validQuality,
      },
      oneMinute: options.oneMinute?.() ?? null,
      reconnects: 0,
      messages: 1,
      missedMessages: 0,
      lastMessageAt: now,
      averageLatencyMs: 1,
      maxLatencyMs: 1,
    }),
  };
  const dependencies: TradingEngineDependencies = {
    now: () => now,
    market: {
      get dataSource() { return dataSource; },
      get sourceGeneration() { return sourceGeneration; },
      isConnected: true,
      getMarkets: async () => symbols.map(market),
      getMarketSnapshot: async () => { throw new Error("not used"); },
      getCandles: async () => [],
      getBaselineCandles: async () => options.baselineCandles?.(dataSource) ?? [],
    } as TradingEngineDependencies["market"] & { sourceGeneration: number },
    monitor,
    getSettings: async () => settings,
    getOpenPositions: async () => [],
    getAccountSnapshot: async () => account,
    saveEquitySnapshot: async () => undefined,
    manageOpenPositions: async () => { managed += 1; },
    getVolatilityState: async (symbol) => states.get(symbol) ?? null,
    saveVolatilityState: async (next) => {
      states.set(next.symbol, next);
      savedStates.push(next);
    },
    addEvent: async (level, category, message, symbol) => {
      events.push({ level, category, message, symbol });
    },
    riskData: async (symbol) => typeof options.riskData === "function"
      ? options.riskData(symbol)
      : options.riskData ?? normalRiskData,
    analyzeMarket: async (item, _settings, context) => {
      analyses += 1;
      return opportunity(item.symbol, context?.now ?? now, context?.stateVersion ?? 0);
    },
    openPaperPosition: async (item) => {
      opened.push(item);
      return { ok: true as const, positionId: item.id, reason: "模拟开仓成交" };
    },
    concurrency: 3,
    ...options.dependencies,
  };
  const engine = createTradingEngine(dependencies);
  return {
    engine,
    settings,
    states,
    savedStates,
    events,
    opened,
    monitor,
    advance: (ms: number) => { now += ms; },
    analyses: () => analyses,
    managed: () => managed,
    monitorStarts: () => monitorStarts,
    setSourceHealthy: (healthy: boolean) => { sourceHealthy = healthy; },
    setDataSource: (source: "MAINNET" | "TESTNET") => {
      dataSource = source;
      sourceGeneration += 1;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("三态引擎编排", () => {
  it("NORMAL 只在 45 秒正式扫描生成并执行新信号，不因风险 tick 加速开仓", async () => {
    const h = harness({ settings: { autoTrade: true } });
    await h.engine.tick();
    expect(h.analyses()).toBe(1);
    expect(h.opened).toHaveLength(1);

    await h.advance(10_000);
    await h.engine.tick();
    await h.advance(34_999);
    await h.engine.tick();
    expect(h.analyses()).toBe(1);
    expect(h.opened).toHaveLength(1);

    await h.advance(1);
    await h.engine.tick();
    expect(h.analyses()).toBe(2);
    expect(h.opened).toHaveLength(2);
  });

  it("HIGH 每 10 秒只重估风险和管理持仓，不增加正式信号频率", async () => {
    const h = harness({
      settings: { autoTrade: true },
      states: { BTCUSDT: { ...state("BTCUSDT", "HIGH"), stableSince: START } },
    });
    await h.engine.tick();
    await h.advance(10_000);
    await h.engine.tick();
    await h.advance(10_000);
    await h.engine.tick();

    expect(h.managed()).toBe(3);
    expect(h.analyses()).toBe(1);
    expect(h.opened).toHaveLength(1);

    await h.advance(25_000);
    await h.engine.tick();
    expect(h.analyses()).toBe(2);
    expect(h.opened).toHaveLength(2);
  });

  it("EXTREME 立即阻断新开仓", async () => {
    const h = harness({
      settings: { autoTrade: true },
      states: { BTCUSDT: state("BTCUSDT", "EXTREME") },
    });
    await h.engine.tick();
    expect(h.opened).toHaveLength(0);
    expect(h.analyses()).toBe(0);
  });

  it("断流转为 EXTREME 并保证零新开仓", async () => {
    const quality = { ...validQuality, valid: false, reasons: ["WebSocket断开"] };
    const h = harness({
      settings: { autoTrade: true },
      quality,
      sourceHealthy: false,
      states: { BTCUSDT: state("BTCUSDT") },
    });
    await h.engine.scan(true);
    expect(h.opened).toHaveLength(0);
    expect(h.states.get("BTCUSDT")?.mode).toBe("EXTREME");
    expect(h.engine.opportunities).toHaveLength(0);
  });

  it("恢复只清理积压机会，随后必须重新扫描生成新信号才可开仓", async () => {
    const h = harness({
      settings: { autoTrade: true },
      states: { BTCUSDT: { ...state("BTCUSDT", "EXTREME"), stableSince: START - 180_000 } },
      stableSince: START - 180_000,
    });
    await h.engine.refreshMarkets();
    h.engine.opportunities = [opportunity("BTCUSDT", START - 60_000, 0)];

    await h.engine.reevaluateRisk();
    expect(h.states.get("BTCUSDT")?.mode).toBe("NORMAL");
    expect(h.engine.opportunities).toHaveLength(0);
    expect(h.opened).toHaveLength(0);

    await h.engine.scan(true);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].signalCloseTime).toBe(START - 1000);
    expect(h.opened[0].stateVersion).toBe(2);
  });

  it("单币分析失败不会中断其他合约，并记录隔离错误", async () => {
    const failing = harness({
      symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
      dependencies: {
        analyzeMarket: async (item, _settings, context) => {
          if (item.symbol === "ETHUSDT") throw new Error("单币数据损坏");
          return opportunity(item.symbol, context?.now ?? START, context?.stateVersion ?? 0);
        },
      },
    });
    const result = await failing.engine.scan(true);
    expect(result.map((item) => item.symbol)).toEqual(["BTCUSDT", "SOLUSDT"]);
    expect(failing.events.some((event) => event.category === "单币扫描失败" && event.symbol === "ETHUSDT")).toBe(true);
  });

  it.each([100, 150])("%i 个合约的全池扫描保持最多 3 个并发且有界完成", async (count) => {
    const symbols = Array.from({ length: count }, (_, index) => `COIN${index}USDT`);
    let active = 0;
    let maximum = 0;
    let completed = 0;
    const h = harness({
      symbols,
      settings: { universeSize: count },
      dependencies: {
        analyzeMarket: async (item, _settings, context) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await settle();
          active -= 1;
          completed += 1;
          return opportunity(item.symbol, context?.now ?? START, context?.stateVersion ?? 0);
        },
      },
    });
    const result = await h.engine.scan(true);
    expect(completed).toBe(count);
    expect(result).toHaveLength(count);
    expect(maximum).toBeLessThanOrEqual(3);
  });

  it("状态迁移持久化版本和审计，手动扫描也只通过统一执行入口开仓", async () => {
    const highRisk: EngineRiskData = {
      ...normalRiskData,
      currentAtr: 90,
      atrBaseline: Array.from({ length: 2016 }, (_, index) => index < 1815 ? 90 : 100),
    };
    const h = harness({
      settings: { autoTrade: true },
      states: { BTCUSDT: { ...state("BTCUSDT"), confirmationCount: 1 } },
      riskData: highRisk,
    });
    await h.engine.scan(true);
    expect(h.states.get("BTCUSDT")?.mode).toBe("HIGH");
    expect(h.states.get("BTCUSDT")?.version).toBe(1);
    expect(h.savedStates.length).toBeGreaterThan(0);
    expect(h.events.some((event) => event.category === "三态迁移" && event.message.includes("NORMAL→HIGH"))).toBe(true);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].stateVersion).toBe(1);
  });

  it("相同合约池重复刷新不会重复启动监测器", async () => {
    const h = harness();
    await h.engine.refreshMarkets();
    await h.engine.refreshMarkets();
    await h.engine.refreshMarkets();
    expect(h.monitorStarts()).toBe(1);
  });

  it("引擎检查后断流时，Task 4 动态健康准入仍拒绝开仓", async () => {
    let admission: boolean | undefined;
    const h = harness({
      settings: { autoTrade: true },
      dependencies: {
        openPaperPosition: async (_item, executionHealthy) => {
          h.setSourceHealthy(false);
          admission = executionHealthy();
          return { ok: false, reason: admission ? "错误放行" : "行情监测断开，禁止开仓" };
        },
      },
    });
    await h.engine.scan(true);
    expect(admission).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.events.some((event) => event.category === "风险拒绝" && event.message.includes("行情监测断开"))).toBe(true);
  });

  it("失败事件等待期间发生恢复时，旧扫描不能发布另一币的积压信号", async () => {
    const analysisStarted = deferred();
    const heldAnalysis = deferred<Opportunity>();
    const failureEventStarted = deferred();
    const releaseFailureEvent = deferred();
    const h = harness({
      symbols: ["BTCUSDT", "ETHUSDT"],
      stableSince: START - 180_000,
      states: {
        BTCUSDT: state("BTCUSDT"),
        ETHUSDT: state("ETHUSDT"),
      },
      dependencies: {
        analyzeMarket: async (item, _settings, context) => {
          if (item.symbol === "ETHUSDT") {
            analysisStarted.resolve();
            return heldAnalysis.promise;
          }
          return opportunity(item.symbol, context?.now ?? START, context?.stateVersion ?? 0);
        },
        addEvent: async (level, category, message, symbol) => {
          h.events.push({ level, category, message, symbol });
          if (category === "单币扫描失败") {
            failureEventStarted.resolve();
            await releaseFailureEvent.promise;
          }
        },
      },
    });
    const scanning = h.engine.scan(true);
    await analysisStarted.promise;
    heldAnalysis.reject(new Error("ETH 数据失败"));
    await failureEventStarted.promise;

    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      h.states.set(symbol, { ...state(symbol, "EXTREME"), stableSince: START - 180_000 });
    }
    await h.engine.reevaluateRisk();
    releaseFailureEvent.resolve();
    await scanning;

    expect(h.states.get("BTCUSDT")?.mode).toBe("NORMAL");
    expect(h.states.get("BTCUSDT")?.version).toBe(2);
    expect(h.engine.opportunities).toHaveLength(0);
  });

  it("挂起的旧分析跨越恢复后完成时也不能发布", async () => {
    const analysisStarted = deferred();
    const heldAnalysis = deferred();
    const h = harness({
      stableSince: START - 180_000,
      states: { BTCUSDT: state("BTCUSDT") },
      dependencies: {
        analyzeMarket: async (item, _settings, context) => {
          analysisStarted.resolve();
          await heldAnalysis.promise;
          return opportunity(item.symbol, context?.now ?? START, context?.stateVersion ?? 0);
        },
      },
    });
    const scanning = h.engine.scan(true);
    await analysisStarted.promise;
    h.states.set("BTCUSDT", { ...state("BTCUSDT", "EXTREME"), stableSince: START - 180_000 });
    await h.engine.reevaluateRisk();
    heldAnalysis.resolve();
    await scanning;

    expect(h.states.get("BTCUSDT")?.mode).toBe("NORMAL");
    expect(h.states.get("BTCUSDT")?.version).toBe(2);
    expect(h.engine.opportunities).toHaveLength(0);
  });

  it("单币执行抛错会审计且继续后续合约", async () => {
    const h = harness({
      symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
      settings: { autoTrade: true },
      dependencies: {
        openPaperPosition: async (item) => {
          if (item.symbol === "ETHUSDT") throw new Error("执行连接中断");
          h.opened.push(item);
          return { ok: true, positionId: item.id, reason: "模拟开仓成交" };
        },
      },
    });
    await expect(h.engine.scan(true)).resolves.toBeDefined();
    expect(h.opened.map((item) => item.symbol)).toEqual(["BTCUSDT", "SOLUSDT"]);
    expect(h.events.some((event) => event.category === "单币执行失败" && event.symbol === "ETHUSDT")).toBe(true);
  });

  it("单币风险状态持久化失败会失败关闭且不影响其他合约", async () => {
    const h = harness({
      symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
      dependencies: {
        saveVolatilityState: async (next) => {
          if (next.symbol === "ETHUSDT") throw new Error("状态写入失败");
          h.states.set(next.symbol, next);
          h.savedStates.push(next);
        },
      },
    });
    const result = await h.engine.scan(true);
    expect(result.map((item) => item.symbol)).toEqual(["BTCUSDT", "SOLUSDT"]);
    expect(h.events.some((event) => event.category === "单币风控失败" && event.symbol === "ETHUSDT")).toBe(true);
  });

  it("150 合约 Dashboard 使用一次只读观测快照，不按 symbol 重算聚合或刷新监测状态", () => {
    const symbols = Array.from({ length: 150 }, (_, index) => `S${index}USDT`);
    const metrics = {
      running: true,
      source: "MAINNET" as const,
      sourceHealthy: true,
      connections: 10,
      openConnections: 10,
      reconnects: 0,
      messages: 150,
      malformedMessages: 0,
      missedMessages: 0,
      rateLimits: 0,
      degradedSymbols: 0,
      lastMessageAt: START,
      averageLatencyMs: 1,
      maxLatencyMs: 1,
    };
    const getMetrics = vi.fn(() => metrics);
    const getSymbolMetrics = vi.fn(() => undefined);
    const getObservabilitySnapshot = vi.fn(() => ({
      metrics,
      symbols: Object.fromEntries(symbols.map((symbol) => [symbol, {
        symbol,
        connected: true,
        degraded: false,
        quality: validQuality,
        stableSince: START,
        snapshot: null,
        oneMinute: null,
        reconnects: 0,
        messages: 1,
        missedMessages: 0,
        lastMessageAt: START,
        averageLatencyMs: 1,
        maxLatencyMs: 1,
      }])),
    }));
    const engine = createTradingEngine({
      monitor: {
        start: vi.fn(),
        stop: vi.fn(),
        getMetrics,
        getSymbolMetrics,
        getObservabilitySnapshot,
      },
    });
    engine.markets = symbols.map(market);

    const result = engine.getDashboardObservability();

    expect(getObservabilitySnapshot).toHaveBeenCalledTimes(1);
    expect(getMetrics).not.toHaveBeenCalled();
    expect(getSymbolMetrics).not.toHaveBeenCalled();
    expect(Object.keys(result.quality)).toHaveLength(150);
    expect(result.monitor).toBe(metrics);
  });

  it("重复未收盘 1M 事件替换当前收益而不追加独立基线", async () => {
    const closed = [100, 101].map((close, index): Candle => {
      const time = START - (2 - index) * 60_000;
      return { time: time / 1000, closeTime: time + 59_999, open: close, high: close, low: close, close, volume: 1 };
    });
    let latest = {
      candle: { ...closed[1], close: 102 },
      eventTime: START + 1,
      closed: false,
      usage: "RISK_ONLY" as const,
      formalSignalEligible: false as const,
    };
    const h = harness({
      oneMinute: () => latest,
      dependencies: {
        market: {
          dataSource: "MAINNET",
          sourceGeneration: 0,
          isConnected: true,
          getMarkets: async () => [market("BTCUSDT")],
          getMarketSnapshot: async () => { throw new Error("not used"); },
          getCandles: async () => closed,
          getBaselineCandles: async () => [],
        },
      },
    });

    const initial = await h.engine["loadRiskData"]("BTCUSDT", h.settings);
    const repeated = await h.engine["loadRiskData"]("BTCUSDT", h.settings);

    expect(initial.tickReturnBaseline).toHaveLength(0);
    expect(repeated.currentTickReturn).toBeCloseTo(102 / 100 - 1, 10);
    expect(repeated.tickReturnBaseline).toHaveLength(0);

    latest = {
      ...latest,
      candle: { ...closed[1], time: closed[1].time + 60, closeTime: closed[1].closeTime + 60_000, close: 103 },
      eventTime: START + 2,
      closed: true,
    };
    const nextPeriod = await h.engine["loadRiskData"]("BTCUSDT", h.settings);
    expect(nextPeriod.currentTickReturn).toBeCloseTo(103 / 102 - 1, 10);
    expect(nextPeriod.tickReturnBaseline).toEqual([102 / 100 - 1]);
  });

  it("数据源切换使持久化旧状态与机会失效并强制保护性重估", async () => {
    const h = harness();
    await h.engine.refreshMarkets();
    h.states.set("BTCUSDT", state("BTCUSDT", "EXTREME"));
    h.engine.opportunities = [opportunity("BTCUSDT", START, 0)];

    h.setDataSource("TESTNET");
    await h.engine.refreshMarkets();

    expect(h.states.get("BTCUSDT")?.mode).toBe("NORMAL");
    expect(h.engine.opportunities).toHaveLength(0);
  });

  it("数据源切换重新加载 ATR 而不复用另一源派生缓存", async () => {
    const series = (range: number): Candle[] => Array.from({ length: 20 }, (_, index) => {
      const time = START - (20 - index) * 300_000;
      return { time: time / 1000, closeTime: time + 299_999, open: 100, high: 100 + range, low: 100, close: 100, volume: 1 };
    });
    const h = harness({ baselineCandles: (source) => series(source === "MAINNET" ? 1 : 3) });

    const main = await h.engine["loadRiskData"]("BTCUSDT", h.settings);
    h.setDataSource("TESTNET");
    await h.engine.refreshMarkets();
    const test = await h.engine["loadRiskData"]("BTCUSDT", h.settings);

    expect(main.currentAtr).toBeCloseTo(1, 10);
    expect(test.currentAtr).toBeCloseTo(3, 10);
  });

  it("执行准入回调在锁内使用最新 EXTREME 状态而不只检查行情质量", async () => {
    let admission: boolean | undefined;
    const h = harness({
      settings: { autoTrade: true },
      dependencies: {
        openPaperPosition: async (_item, executionHealthy) => {
          h.states.set("BTCUSDT", state("BTCUSDT", "EXTREME"));
          await h.engine.reevaluateRisk();
          admission = executionHealthy();
          return { ok: false, reason: admission ? "错误放行" : "EXTREME禁止新增风险" };
        },
      },
    });

    await h.engine.scan(true);

    expect(admission).toBe(false);
  });

  it("执行准入回调拒绝扫描后发生的数据源代际切换", async () => {
    let admission: boolean | undefined;
    const h = harness({
      settings: { autoTrade: true },
      dependencies: {
        openPaperPosition: async (_item, executionHealthy) => {
          h.setDataSource("TESTNET");
          admission = executionHealthy();
          return { ok: false, reason: admission ? "错误放行" : "数据源已切换" };
        },
      },
    });

    await h.engine.scan(true);

    expect(admission).toBe(false);
  });

  it("重复 startAutomation 调用只保留一个 interval 和一套自动化", async () => {
    const scope = globalThis as typeof globalThis & { __waveSentryAutomation?: Promise<void> };
    const previous = scope.__waveSentryAutomation;
    vi.useFakeTimers();
    const tick = vi.spyOn(productionEngine, "tick").mockResolvedValue();
    delete scope.__waveSentryAutomation;
    try {
      const first = startAutomation();
      const second = startAutomation();
      expect(second).toBe(first);
      await first;
      expect(vi.getTimerCount()).toBe(1);
      expect(tick).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(tick).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
      if (previous) scope.__waveSentryAutomation = previous;
      else delete scope.__waveSentryAutomation;
    }
  });
});
