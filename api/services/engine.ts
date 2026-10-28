import type {
  AccountSnapshot,
  EngineState,
  Market,
  MarketQuality,
  Opportunity,
  TradingSettings,
  VolatilityState,
} from "@contracts/trading";
import { binance } from "./binance";
import { analyzeMarket } from "./opportunity";
import {
  getAccountSnapshot,
  manageOpenPositions,
  openPaperPosition,
} from "./paper";
import { addEvent, getOpenPositions, getSettings } from "../queries/trading";
import { getVolatilityState, saveVolatilityState } from "../queries/volatility";
import { getDb } from "../queries/connection";
import { equitySnapshots } from "@db/schema";
import { log } from "../lib/logger";
import {
  MarketMonitor,
  type MonitorMetrics,
  type MonitorObservabilitySnapshot,
  type SymbolMonitorMetrics,
} from "./marketMonitor";
import { evaluateVolatility, type EvaluateVolatilityInput } from "./volatility";
import { atrSeries, closedCandles } from "./indicators";

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export interface EngineMarketClient {
  readonly dataSource: "MAINNET" | "TESTNET";
  readonly sourceGeneration: number;
  readonly isConnected: boolean;
  getMarkets(settings: TradingSettings): Promise<Market[]>;
  getMarketSnapshot(symbol: string): ReturnType<typeof binance.getMarketSnapshot>;
  getCandles(symbol: string, interval: string, limit?: number): ReturnType<typeof binance.getCandles>;
  getBaselineCandles(symbol: string, interval: "5m", days: number): ReturnType<typeof binance.getBaselineCandles>;
}

export interface EngineMonitor {
  start(symbols: string[]): void;
  stop(): void;
  getMetrics(): MonitorMetrics;
  getSymbolMetrics(symbol: string): SymbolMonitorMetrics | undefined;
  getObservabilitySnapshot?(): MonitorObservabilitySnapshot;
}

export type EngineRiskData = Omit<
  EvaluateVolatilityInput,
  "symbol" | "settings" | "quality" | "currentSpreadBps"
>;

type EventLevel = "INFO" | "WARN" | "ERROR" | "SUCCESS";
type OpenResult = { ok: boolean; reason: string };

export interface TradingEngineDependencies {
  now: () => number;
  market: EngineMarketClient;
  monitor: EngineMonitor;
  getSettings: typeof getSettings;
  getOpenPositions: typeof getOpenPositions;
  getAccountSnapshot: () => Promise<AccountSnapshot>;
  saveEquitySnapshot: (snapshot: AccountSnapshot) => Promise<void>;
  manageOpenPositions: () => Promise<void>;
  getVolatilityState: typeof getVolatilityState;
  saveVolatilityState: typeof saveVolatilityState;
  addEvent: (level: EventLevel, category: string, message: string, symbol?: string) => Promise<void>;
  riskData: (symbol: string, settings: TradingSettings) => Promise<EngineRiskData>;
  analyzeMarket: typeof analyzeMarket;
  openPaperPosition: (opportunity: Opportunity, executionHealthy: () => boolean) => Promise<OpenResult>;
  concurrency: number;
}

interface AtrBaseline {
  loadedAt: number;
  currentAtr: number;
  atrBaseline: number[];
}

const emptyRiskData: EngineRiskData = {
  currentAtr: Number.NaN,
  atrBaseline: [],
  currentTickReturn: Number.NaN,
  tickReturnBaseline: [],
  spreadBaselineBps: [],
};

function disconnectedQuality(reason: string): MarketQuality {
  return { valid: false, reasons: [reason], bookAgeMs: null, markAgeMs: null, candleAgeMs: null };
}

export class TradingEngine {
  markets: Market[] = [];
  opportunities: Opportunity[] = [];
  lastScanAt: string | null = null;
  scanning = false;

  private readonly deps: TradingEngineDependencies;
  private ticking = false;
  private riskChecking = false;
  private lastSnapshot = 0;
  private lastFormalScan = 0;
  private lastRiskCheck = 0;
  private lastPositionCheck = 0;
  private generation = 0;
  private monitorKey = "";
  private marketSource: "MAINNET" | "TESTNET";
  private marketGeneration: number;
  private states = new Map<string, VolatilityState>();
  private invalidatedStateSymbols = new Set<string>();
  private failedRiskSymbols = new Set<string>();
  private atrBaselines = new Map<string, AtrBaseline>();
  private tickReturns = new Map<string, number[]>();
  private tickCloses = new Map<string, number>();
  private tickPreviousCloses = new Map<string, number>();
  private lastOneMinuteAt = new Map<string, number>();
  private spreadSamples = new Map<string, { bookTime: number; values: number[] }>();

  constructor(dependencies: Partial<TradingEngineDependencies> = {}) {
    const now = dependencies.now ?? Date.now;
    const market = dependencies.market ?? binance;
    this.deps = {
      now,
      market,
      monitor: dependencies.monitor ?? new MarketMonitor({ client: market, now }),
      getSettings: dependencies.getSettings ?? getSettings,
      getOpenPositions: dependencies.getOpenPositions ?? getOpenPositions,
      getAccountSnapshot: dependencies.getAccountSnapshot ?? (() => getAccountSnapshot()),
      saveEquitySnapshot: dependencies.saveEquitySnapshot ?? (async (snapshot) => {
        await getDb().insert(equitySnapshots).values({
          equity: snapshot.equity,
          cash: snapshot.cash,
          unrealized: snapshot.unrealizedPnl,
        });
      }),
      manageOpenPositions: dependencies.manageOpenPositions ?? manageOpenPositions,
      getVolatilityState: dependencies.getVolatilityState ?? getVolatilityState,
      saveVolatilityState: dependencies.saveVolatilityState ?? saveVolatilityState,
      addEvent: dependencies.addEvent ?? addEvent,
      riskData: dependencies.riskData ?? ((symbol, settings) => this.loadRiskData(symbol, settings)),
      analyzeMarket: dependencies.analyzeMarket ?? analyzeMarket,
      openPaperPosition: dependencies.openPaperPosition ?? openPaperPosition,
      concurrency: dependencies.concurrency ?? 3,
    };
    this.marketSource = this.deps.market.dataSource;
    this.marketGeneration = this.deps.market.sourceGeneration;
  }

  private candidates(settings: TradingSettings) {
    return this.markets.filter((item) => item.eligible).slice(0, settings.universeSize);
  }

  private syncMonitor(settings: TradingSettings) {
    const symbols = this.candidates(settings).map((item) => item.symbol);
    let sourceChanged = false;
    if (this.marketSource !== this.deps.market.dataSource || this.marketGeneration !== this.deps.market.sourceGeneration) {
      for (const symbol of new Set([...this.states.keys(), ...symbols])) this.invalidatedStateSymbols.add(symbol);
      this.states.clear();
      this.failedRiskSymbols.clear();
      this.atrBaselines.clear();
      this.tickReturns.clear();
      this.tickCloses.clear();
      this.tickPreviousCloses.clear();
      this.lastOneMinuteAt.clear();
      this.spreadSamples.clear();
      this.discardOpportunities();
      this.monitorKey = "";
      this.lastRiskCheck = 0;
      this.marketSource = this.deps.market.dataSource;
      this.marketGeneration = this.deps.market.sourceGeneration;
      sourceChanged = true;
    }
    const key = `${this.deps.market.dataSource}:${this.deps.market.sourceGeneration}:${symbols.join(",")}`;
    if (symbols.length && key !== this.monitorKey) {
      this.deps.monitor.start(symbols);
      this.monitorKey = key;
    }
    return sourceChanged;
  }

  async refreshMarkets() {
    const settings = await this.deps.getSettings();
    this.markets = await this.deps.market.getMarkets(settings);
    const sourceChanged = this.syncMonitor(settings);
    if (sourceChanged) await this.reevaluateRisk(this.candidates(settings).map((item) => item.symbol));
    return this.markets;
  }

  getDashboardObservability() {
    const snapshot = this.deps.monitor.getObservabilitySnapshot?.();
    const monitor = snapshot?.metrics ?? this.deps.monitor.getMetrics();
    const quality = Object.fromEntries(this.markets.map((market) => {
      if (!monitor.sourceHealthy) return [market.symbol, disconnectedQuality("共享行情源故障")];
      const symbolQuality = snapshot
        ? snapshot.symbols[market.symbol]?.quality
        : this.deps.monitor.getSymbolMetrics(market.symbol)?.quality;
      return [market.symbol, symbolQuality ?? disconnectedQuality("等待行情")];
    }));
    return {
      states: [...this.states.values()],
      quality,
      monitor,
    };
  }

  private sourceHealthy() {
    return this.deps.monitor.getMetrics().sourceHealthy;
  }

  private symbolQuality(symbol: string) {
    if (!this.sourceHealthy()) return disconnectedQuality("共享行情源故障");
    return this.deps.monitor.getSymbolMetrics(symbol)?.quality ?? disconnectedQuality("等待行情");
  }

  private discardOpportunities(symbol?: string) {
    this.generation += 1;
    this.opportunities = symbol
      ? this.opportunities.filter((item) => item.symbol !== symbol)
      : [];
  }

  private async report(level: EventLevel, category: string, message: string, symbol?: string) {
    try {
      await this.deps.addEvent(level, category, message, symbol);
    } catch (error) {
      log.error("engine event write failed", {
        category,
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async evaluateSymbol(symbol: string, settings: TradingSettings) {
    try {
      const sourceGeneration = this.marketGeneration;
      const persisted = await this.deps.getVolatilityState(symbol);
      const previous = this.invalidatedStateSymbols.has(symbol) ? null : persisted;
      const metrics = this.deps.monitor.getSymbolMetrics(symbol);
      const quality = this.symbolQuality(symbol);
      const risk = quality.valid ? await this.deps.riskData(symbol, settings) : emptyRiskData;
      const previousForEvaluation = previous && previous.mode !== "NORMAL"
        ? { ...previous, stableSince: metrics?.stableSince ?? null }
        : previous;
      const evaluated = evaluateVolatility({
        symbol,
        settings,
        quality,
        currentSpreadBps: metrics?.snapshot?.spreadBps ?? Number.NaN,
        ...risk,
      }, previousForEvaluation, this.deps.now());
      const next: VolatilityState = {
        symbol: evaluated.symbol,
        mode: evaluated.mode,
        confirmationCount: evaluated.confirmationCount,
        stableSince: evaluated.stableSince,
        metrics: evaluated.metrics,
        lastDataAt: metrics?.oneMinute?.eventTime ?? metrics?.snapshot?.markTime ?? this.deps.now(),
        version: evaluated.version,
      };
      if (sourceGeneration !== this.marketGeneration) {
        this.invalidatedStateSymbols.add(symbol);
        return;
      }
      await this.deps.saveVolatilityState(next);
      if (sourceGeneration !== this.marketGeneration) {
        this.invalidatedStateSymbols.add(symbol);
        return;
      }
      this.invalidatedStateSymbols.delete(symbol);
      this.states.set(symbol, next);
      this.failedRiskSymbols.delete(symbol);

      const previousMode = previous?.mode ?? "NORMAL";
      const transitioned = previousMode !== next.mode || previous?.version !== next.version;
      if (transitioned) {
        await this.report(
          next.mode === "EXTREME" ? "WARN" : "INFO",
          "三态迁移",
          `${previousMode}→${next.mode}；version ${previous?.version ?? 0}→${next.version}；${evaluated.reasons.join("、") || "指标稳定"}`,
          symbol,
        );
      }
      if (transitioned || !quality.valid) this.discardOpportunities(symbol);
    } catch (error) {
      this.failedRiskSymbols.add(symbol);
      this.discardOpportunities(symbol);
      log.error("symbol risk evaluation failed", { symbol, error: String(error) });
      await this.report("ERROR", "单币风控失败", error instanceof Error ? error.message : String(error), symbol);
    }
  }

  async reevaluateRisk(symbols?: string[]) {
    if (this.riskChecking) return;
    this.riskChecking = true;
    this.lastRiskCheck = this.deps.now();
    try {
      const settings = await this.deps.getSettings();
      const selected = symbols ?? this.candidates(settings).map((item) => item.symbol);
      await mapWithConcurrency([...new Set(selected)], this.deps.concurrency, async (symbol) => {
        await this.evaluateSymbol(symbol, settings);
        return null;
      });
    } finally {
      this.riskChecking = false;
    }
  }

  private canUseSignal(item: Opportunity) {
    const current = this.states.get(item.symbol);
    return this.sourceHealthy()
      && item.sourceGeneration === this.deps.market.sourceGeneration
      && !this.failedRiskSymbols.has(item.symbol)
      && current?.mode !== "EXTREME"
      && current?.version === item.stateVersion
      && this.symbolQuality(item.symbol).valid;
  }

  async scan(manual = false) {
    if (this.scanning) return this.opportunities;
    this.scanning = true;
    this.discardOpportunities();
    this.lastFormalScan = this.deps.now();
    try {
      const settings = await this.deps.getSettings();
      await this.refreshMarkets();
      const candidates = this.candidates(settings);
      const symbols = candidates.map((item) => item.symbol);
      if (this.lastRiskCheck !== this.deps.now() || symbols.some((symbol) => !this.states.has(symbol))) {
        await this.reevaluateRisk(symbols);
      }
      const generation = this.generation;
      const signalCandidates = candidates.filter((item) => {
        const current = this.states.get(item.symbol);
        return current && current.mode !== "EXTREME" && !this.failedRiskSymbols.has(item.symbol)
          && this.symbolQuality(item.symbol).valid;
      });
      const results = await mapWithConcurrency(signalCandidates, this.deps.concurrency, async (item) => {
        const current = this.states.get(item.symbol)!;
        return this.deps.analyzeMarket(item, settings, {
          now: this.deps.now(),
          stateVersion: current.version,
          sourceGeneration: this.marketGeneration,
        });
      });
      if (generation !== this.generation) return this.opportunities;

      const opportunities: Opportunity[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          opportunities.push(result.value);
        } else {
          const symbol = signalCandidates[index].symbol;
          log.error("opportunity analysis failed", { symbol, error: String(result.reason) });
          await this.report(
            "ERROR",
            "单币扫描失败",
            result.reason instanceof Error ? result.reason.message : String(result.reason),
            symbol,
          );
          if (generation !== this.generation) return this.opportunities;
        }
      }
      if (generation !== this.generation) return this.opportunities;
      this.opportunities = opportunities.sort((a, b) =>
        Number(b.status === "READY") - Number(a.status === "READY") || b.score - a.score);
      this.lastScanAt = new Date(this.deps.now()).toISOString();

      if (settings.autoTrade) {
        for (const item of this.opportunities.filter((candidate) => candidate.status === "READY")) {
          if (generation !== this.generation || !this.canUseSignal(item)) {
            this.discardOpportunities(item.symbol);
            continue;
          }
          try {
            const openRows = await this.deps.getOpenPositions();
            if (generation !== this.generation || !this.canUseSignal(item)) {
              this.discardOpportunities(item.symbol);
              continue;
            }
            if (openRows.length >= settings.maxPositions) break;
            const result = await this.deps.openPaperPosition(
              item,
              () => this.canUseSignal(item),
            );
            if (!result.ok && !result.reason.includes("已有持仓")) {
              await this.report("WARN", "风险拒绝", result.reason, item.symbol);
            }
          } catch (error) {
            log.error("symbol execution failed", { symbol: item.symbol, error: String(error) });
            await this.report(
              "ERROR",
              "单币执行失败",
              error instanceof Error ? error.message : String(error),
              item.symbol,
            );
          }
        }
      }
      if (manual) {
        await this.report("INFO", "扫描", `完成 ${candidates.length} 个高流动性合约扫描，${this.opportunities.filter((item) => item.status === "READY").length} 个可执行机会`);
      }
      return this.opportunities;
    } catch (error) {
      await this.report("ERROR", "扫描异常", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.scanning = false;
    }
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = await this.deps.getSettings();
      if (!this.markets.length) await this.refreshMarkets();
      else this.syncMonitor(settings);

      const protectedMode = !this.sourceHealthy()
        || [...this.states.values()].some((item) => item.mode !== "NORMAL");
      const riskInterval = (protectedMode ? settings.highRiskCheckIntervalSeconds : settings.normalScanIntervalSeconds) * 1000;
      if (this.deps.now() - this.lastRiskCheck >= riskInterval) {
        await this.reevaluateRisk();
      }

      const positionInterval = (protectedMode ? settings.highRiskCheckIntervalSeconds : Math.min(20, settings.normalScanIntervalSeconds)) * 1000;
      if (this.deps.now() - this.lastPositionCheck >= positionInterval) {
        this.lastPositionCheck = this.deps.now();
        try {
          await this.deps.manageOpenPositions();
        } catch (error) {
          log.error("position management failed", { error: String(error) });
          await this.report("ERROR", "持仓管理异常", error instanceof Error ? error.message : String(error));
        }
      }

      if (!this.scanning && this.deps.now() - this.lastFormalScan >= settings.normalScanIntervalSeconds * 1000) {
        if (this.sourceHealthy()) {
          await this.scan();
        } else {
          this.lastFormalScan = this.deps.now();
          this.discardOpportunities();
          await this.reevaluateRisk();
        }
      }

      if (this.deps.now() - this.lastSnapshot >= 300_000) {
        const snapshot = await this.deps.getAccountSnapshot();
        await this.deps.saveEquitySnapshot(snapshot);
        this.lastSnapshot = this.deps.now();
      }
    } catch (error) {
      log.error("engine tick failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
    }
  }

  async engineState(): Promise<EngineState> {
    if (!this.sourceHealthy()) return "DEGRADED";
    const settings = await this.deps.getSettings();
    if (!settings.autoTrade) return "PAUSED";
    const account = await this.deps.getAccountSnapshot();
    if (account.todayPnlPct <= -settings.dailyLossLimitPct) return "LOCKED";
    return "RUNNING";
  }

  private async loadRiskData(symbol: string, settings: TradingSettings): Promise<EngineRiskData> {
    const now = this.deps.now();
    const sourceGeneration = this.marketGeneration;
    let atr = this.atrBaselines.get(symbol);
    if (!atr || now - atr.loadedAt >= 300_000) {
      const [baseline, oneMinute] = await Promise.all([
        this.deps.market.getBaselineCandles(symbol, "5m", settings.atrBaselineDays),
        this.deps.market.getCandles(symbol, "1m", 122),
      ]);
      if (sourceGeneration !== this.marketGeneration) throw new Error("数据源已切换，丢弃旧风险基线");
      const series = atrSeries(closedCandles(baseline, now));
      atr = { loadedAt: now, currentAtr: series.at(-1) ?? Number.NaN, atrBaseline: series };
      this.atrBaselines.set(symbol, atr);
      const closedOneMinute = closedCandles(oneMinute, now);
      const returns: number[] = [];
      for (let index = 1; index < closedOneMinute.length; index += 1) {
        const previous = closedOneMinute[index - 1].close;
        if (previous > 0) returns.push(closedOneMinute[index].close / previous - 1);
      }
      this.tickReturns.set(symbol, returns.slice(-121));
      this.tickCloses.set(symbol, closedOneMinute.at(-1)?.close ?? Number.NaN);
      this.tickPreviousCloses.set(symbol, closedOneMinute.at(-2)?.close ?? Number.NaN);
      this.lastOneMinuteAt.set(symbol, (closedOneMinute.at(-1)?.time ?? 0) * 1000);
    }

    const metrics = this.deps.monitor.getSymbolMetrics(symbol);
    const latest = metrics?.oneMinute;
    if (latest) {
      const openTime = latest.candle.time * 1000;
      const previousOpenTime = this.lastOneMinuteAt.get(symbol) ?? 0;
      if (openTime > 0 && openTime >= previousOpenTime) {
        const sameCandle = openTime === previousOpenTime;
        const previousClose = sameCandle ? this.tickPreviousCloses.get(symbol) : this.tickCloses.get(symbol);
        if (previousClose && previousClose > 0) {
          const returns = [...(this.tickReturns.get(symbol) ?? [])];
          const nextReturn = latest.candle.close / previousClose - 1;
          if (sameCandle && returns.length) returns[returns.length - 1] = nextReturn;
          else if (!sameCandle) returns.push(nextReturn);
          this.tickReturns.set(symbol, returns.slice(-121));
        }
        if (!sameCandle) this.tickPreviousCloses.set(symbol, previousClose ?? Number.NaN);
        this.tickCloses.set(symbol, latest.candle.close);
        this.lastOneMinuteAt.set(symbol, openTime);
      }
    }

    const spread = metrics?.snapshot?.spreadBps;
    const bookTime = metrics?.snapshot?.bookTime ?? 0;
    let spreads = this.spreadSamples.get(symbol) ?? { bookTime: 0, values: [] };
    if (spread !== undefined && Number.isFinite(spread) && spread > 0 && bookTime > spreads.bookTime) {
      spreads = { bookTime, values: [...spreads.values, spread].slice(-121) };
      this.spreadSamples.set(symbol, spreads);
    }
    const returns = this.tickReturns.get(symbol) ?? [];
    return {
      currentAtr: atr.currentAtr,
      atrBaseline: atr.atrBaseline,
      currentTickReturn: returns.at(-1) ?? Number.NaN,
      tickReturnBaseline: returns.slice(0, -1),
      spreadBaselineBps: spreads.values.slice(0, -1),
    };
  }
}

export function createTradingEngine(dependencies: Partial<TradingEngineDependencies> = {}) {
  return new TradingEngine(dependencies);
}

export const engine = createTradingEngine();

export function startAutomation(): Promise<void> {
  const scope = globalThis as typeof globalThis & { __waveSentryAutomation?: Promise<void> };
  if (scope.__waveSentryAutomation) return scope.__waveSentryAutomation;
  scope.__waveSentryAutomation = (async () => {
    setInterval(() => void engine.tick(), 1000);
    await engine.tick();
  })();
  return scope.__waveSentryAutomation;
}
