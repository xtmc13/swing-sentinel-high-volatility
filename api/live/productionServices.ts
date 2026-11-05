import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { liveIntents, livePositions, tradingSettings } from "@db/schema";
import type { Opportunity } from "@contracts/trading";
import { getSettings as readSettings, settingsFromRow } from "../queries/trading";
import { binance } from "../services/binance";
import { alignedCorrelation } from "../services/risk";
import { log } from "../lib/logger";
import { BinanceSignedClient } from "./binanceSigned";
import { binanceCredentialStore } from "../credentials/binanceCredentialStore";
import {
  createLiveAdapter,
  createLiveAdmissionGuard,
  createStoredLiveAdapter,
  type LiveCredentials,
  type ServerEnvironment,
} from "./liveConfig";
import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import { createMainnetLiveExecutionAdapter, readLiveAccountValuation } from "./liveExecution";
import {
  getLiveIntentReservations,
  getPendingLiveIntentSymbols,
  loadLiveIntentMetadata,
  type LiveDatabase,
  type LiveFinalGateResult,
  type LiveTransaction,
} from "./livePersistence";
import { runLivePreflight, type LivePreflightResult } from "./livePreflight";
import {
  calculateLivePositionRisk,
  estimateFlatLiquidationPrice,
  validateLivePortfolioAdmission,
} from "./liveRisk";
import {
  addDecimals,
  ceilToStep,
  compareDecimals,
  decimal,
  divideDecimals,
  multiplyDecimals,
  normalizeDirectionalPrice,
  subtractDecimals,
  type DecimalString,
} from "./decimal";
import { DrizzleLiveDailyRisk, type LiveDailyRisk } from "./liveDailyRisk";
import {
  DrizzleReconciliationStore,
  LiveEntryAdmission,
  ReconciliationService,
  type ReconciliationStore,
} from "./reconciliation";
import {
  DrizzleAccountingStore,
  LiveAccountingSynchronizer,
  type LiveAccountingStore,
} from "./accounting";
import type { LiveOrderStore, LivePositionSeed } from "./orderStateMachine";
import type { OrderWireAccountMode } from "./orderWire";
import { UserDataStream, type UserDataSocket } from "./userDataStream";
import type { ProductionLiveServices } from "./productionRuntime";

export interface ProductionServicesOptions {
  env: ServerEnvironment;
  db: LiveDatabase;
  getSettings?: typeof readSettings;
  workerId?: string;
  client?: BinanceSignedClient;
  orderStore?: LiveOrderStore;
  reconciliationStore?: ReconciliationStore;
  accountingStore?: LiveAccountingStore;
  dailyRisk?: LiveDailyRisk;
  market?: Pick<typeof binance, "getCandles">;
  socketFactory?: (url: string) => UserDataSocket;
  now?: () => number;
  reconciliationIntervalMs?: number;
  pauseAutoTrade?: () => Promise<void>;
  accountMode?: OrderWireAccountMode;
}

interface FreshPreflight {
  checkedAt: number;
  account: Awaited<ReturnType<BinanceSignedClient["account"]>>;
  result: Extract<LivePreflightResult, { ok: true }>;
  daily: { dailyLocked: boolean; todayPnlPct: number };
  correlations: Record<string, number | null>;
}

function allowedSymbols(env: ServerEnvironment): string[] {
  return [...new Set((env.BINANCE_MAINNET_ALLOWED_SYMBOLS ?? "")
    .split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}

function admissionLiquidationPrice(
  result: Extract<LivePreflightResult, { ok: true }>,
  side: Opportunity["side"],
  entryPrice: DecimalString,
  actualLeverage: number,
): DecimalString {
  if (compareDecimals(result.positionRisk.positionAmt, "0") !== 0
    || compareDecimals(result.positionRisk.liquidationPrice, "0") > 0) {
    return result.positionRisk.liquidationPrice;
  }
  const maintMarginRatio = result.brackets.map((bracket) => bracket.maintMarginRatio)
    .reduce((highest, value) => compareDecimals(value, highest) > 0 ? value : highest);
  return estimateFlatLiquidationPrice({
    side, entryPrice, leverage: actualLeverage, maintMarginRatio,
  });
}

function defaultSocket(url: string): UserDataSocket {
  if (typeof WebSocket === "undefined") throw new Error("Production WebSocket is unavailable");
  const socket = new WebSocket(url);
  return {
    set onmessage(handler: UserDataSocket["onmessage"]) {
      socket.onmessage = handler ? (event) => handler({ data: event.data }) : null;
    },
    set onclose(handler: UserDataSocket["onclose"]) { socket.onclose = handler; },
    set onerror(handler: UserDataSocket["onerror"]) { socket.onerror = handler; },
    close: () => socket.close(),
  };
}

export async function createBinanceProductionLiveServicesFromStore(
  options: ProductionServicesOptions,
  loadStored: () => Promise<LiveCredentials | null> = () => binanceCredentialStore.load(),
): Promise<ProductionLiveServices> {
  const client = options.client ?? await createStoredLiveAdapter(
    options.env,
    loadStored,
    (credentials) => new BinanceSignedClient(credentials),
  );
  let accountMode = options.accountMode;
  if (!accountMode) {
    const [positionSide, multiAssetsMargin] = await Promise.all([client.positionSide(), client.multiAssetsMargin()]);
    if (typeof positionSide.dualSidePosition !== "boolean" || typeof multiAssetsMargin.multiAssetsMargin !== "boolean") {
      throw new Error("Signed account mode response is incomplete");
    }
    const mode = { dualSide: positionSide.dualSidePosition, multiAssets: multiAssetsMargin.multiAssetsMargin };
    accountMode = {
      dualSide: mode.dualSide,
      multiAssets: mode.multiAssets,
      fingerprint: createHash("sha256").update(JSON.stringify(mode)).digest("hex"),
    };
  }
  return createBinanceProductionLiveServices({ ...options, client, accountMode });
}

export function createBinanceProductionLiveServices(options: ProductionServicesOptions): ProductionLiveServices {
  const now = options.now ?? Date.now;
  const getSettings = options.getSettings ?? readSettings;
  const symbols = allowedSymbols(options.env);
  const client = options.client ?? createLiveAdapter(
    options.env,
    (credentials) => new BinanceSignedClient(credentials),
  );
  const orders = options.orderStore ?? new DrizzleLiveOrderStore(options.db);
  const reconciliationStore = options.reconciliationStore ?? new DrizzleReconciliationStore(options.db);
  const accountingStore = options.accountingStore ?? new DrizzleAccountingStore(options.db);
  const dailyRisk = options.dailyRisk ?? new DrizzleLiveDailyRisk(options.db);
  const admission = new LiveEntryAdmission(true);
  const fresh = new Map<string, FreshPreflight>();

  async function currentSeed(order: { intentId: string }): Promise<LivePositionSeed> {
    const rows = await options.db.select().from(liveIntents).where(eq(liveIntents.id, order.intentId)).limit(1);
    const intent = rows[0];
    if (!intent) throw new Error("Live position intent is missing");
    const effectiveLeverage = intent.effectiveLeverage;
    if (!Number.isInteger(effectiveLeverage) || (effectiveLeverage ?? 0) < 1
      || !Number.isInteger(intent.maintenanceBracket) || (intent.maintenanceBracket ?? 0) < 1
      || intent.maintMarginRatio === null || intent.cumMaintenance === null
      || (intent.marginType !== "ISOLATED" && intent.marginType !== "CROSS")
      || (intent.liquidationPriceSource !== "EXCHANGE"
        && intent.liquidationPriceSource !== "PRETRADE_ESTIMATE")) {
      throw new Error("Live intent lacks persisted compatibility, leverage, bracket, or liquidation metadata");
    }
    return {
      id: intent.id,
      signalId: intent.signalId,
      strategyType: intent.strategyType === "MOMENTUM" ? "MOMENTUM" : "SWING",
      breakoutPrice: intent.breakoutPrice ?? undefined,
      symbol: intent.symbol,
      side: intent.side === "SHORT" ? "SHORT" : "LONG",
      positionSide: intent.positionSide === "SHORT" ? "SHORT" : intent.positionSide === "LONG" ? "LONG" : null,
      marginType: intent.marginType,
      entrySemantics: intent.entrySemantics === "REDUCE" ? "REDUCE" : intent.entrySemantics === "ENTRY" ? "ENTRY" : null,
      effectiveLeverage,
      liquidationPriceSource: intent.liquidationPriceSource,
      accountModeFingerprint: intent.accountModeFingerprint,
      compatibilityFrozen: intent.compatibilityFrozen,
      stopPrice: intent.stopPrice,
      tickSize: intent.tickSize,
      liquidationPrice: intent.liquidationPrice,
      leverage: String(effectiveLeverage),
      maintenanceBracket: intent.maintenanceBracket!,
      maintMarginRatio: intent.maintMarginRatio,
      cumMaintenance: intent.cumMaintenance,
    };
  }

  const assertCurrentAdmission = createLiveAdmissionGuard(options.env, () => preflight(), now);
  const adapter = createMainnetLiveExecutionAdapter({
    db: options.db,
    store: orders,
    gateway: client,
    accounting: accountingStore,
    dailyRisk,
    getSettings,
    workerId: options.workerId ?? `live-${process.pid}`,
    pauseAutoTrade: options.pauseAutoTrade,
    accountMode: options.accountMode,
    assertCurrentAdmission: async () => {
      if (!admission.allowed) throw new Error("私有流或对账已冻结主网新开仓");
      await assertCurrentAdmission();
    },
    alert: (message) => log.error("live execution alert", { message }),
    prepareIntent: (opportunity) => {
      const cached = fresh.get(opportunity.symbol);
      if (!cached || cached.checkedAt > now() || now() - cached.checkedAt > 10_000) {
        throw new Error("缺少新鲜的主网签名预检");
      }
      const actualLeverage = Number(cached.result.positionRisk.leverage);
      const limitPrice = normalizeDirectionalPrice(
        decimal(String(opportunity.limitPrice)), cached.result.filters.tickSize, opportunity.side,
      );
      const stopPrice = normalizeDirectionalPrice(
        decimal(String(opportunity.stop)), cached.result.filters.tickSize, opportunity.side,
      );
      return {
        signalId: opportunity.signalId,
        symbol: opportunity.symbol,
        side: opportunity.side,
        positionSide: opportunity.side,
        entrySemantics: "ENTRY",
        accountModeFingerprint: options.accountMode?.fingerprint ?? null,
        quantity: "0",
        limitPrice,
        tickSize: cached.result.filters.tickSize,
        stopPrice,
        liquidationPrice: admissionLiquidationPrice(cached.result, opportunity.side, limitPrice, actualLeverage),
        leverage: Number.isInteger(actualLeverage) ? actualLeverage : 0,
        notional: "0",
        reservedMargin: "0",
        reservedRisk: "0",
        expiresAt: new Date(opportunity.expiryTime),
        leaseDurationMs: 5_000,
      };
    },
    finalGate: async (opportunity: Opportunity, input, tx: LiveTransaction, context): Promise<LiveFinalGateResult> => {
      const cached = fresh.get(opportunity.symbol);
      if (!cached || cached.checkedAt > now() || now() - cached.checkedAt > 10_000
        || opportunity.expiryTime <= now()) {
        return { approved: false, reason: "签名预检已陈旧或动量信号已过期" };
      }
      const settingsRow = (await tx.select().from(tradingSettings).where(eq(tradingSettings.id, 1)).limit(1))[0];
      if (!settingsRow) return { approved: false, reason: "缺少交易设置" };
      const settings = settingsFromRow(settingsRow);
      let valuation: ReturnType<typeof readLiveAccountValuation>;
      try {
        valuation = readLiveAccountValuation(
          cached.account, cached.result.positions, options.accountMode?.multiAssets === true,
        );
      } catch (error) {
        return {
          approved: false,
          reason: `真实账户汇总估值无效：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const [positions, intentStops, pendingIntents, pendingSymbols] = await Promise.all([
        tx.select().from(livePositions).where(eq(livePositions.status, "OPEN")),
        tx.select({ id: liveIntents.id, stopPrice: liveIntents.stopPrice }).from(liveIntents),
        getLiveIntentReservations(tx),
        getPendingLiveIntentSymbols(tx),
      ]);
      const activeRemote = cached.result.positions.filter((position) => compareDecimals(position.positionAmt, "0") !== 0);
      const marginType = cached.result.positionRisk.marginType.toUpperCase();
      if (marginType !== "ISOLATED" && marginType !== "CROSS") {
        return { approved: false, reason: "目标合约 marginType 无效" };
      }
      if (marginType === "CROSS" && (pendingSymbols.length > 0
        || activeRemote.some((position) => position.marginType.toLowerCase() === "cross"))) {
        return { approved: false, reason: "存在 cross 持仓或相关待单，必须完成组合强平估算后才能新增" };
      }
      let existingExposure: DecimalString = "0";
      const portfolioPositions: Array<{ remote: (typeof activeRemote)[number]; stopPrice: DecimalString }> = [];
      for (const remote of activeRemote) {
        const remotePositionSide = remote.positionSide === "LONG" || remote.positionSide === "SHORT"
          ? remote.positionSide
          : compareDecimals(remote.positionAmt, "0") < 0 ? "SHORT" : "LONG";
        const localMatches = positions.filter((position) => position.symbol === remote.symbol
          && position.positionSide === remotePositionSide);
        if (localMatches.length !== 1) {
          return { approved: false, reason: `${remote.symbol} ${remotePositionSide} 已管理持仓缺失或不唯一` };
        }
        const local = localMatches[0];
        const intentStop = intentStops.find((intent) => intent.id === local.id);
        if (!intentStop) {
          return { approved: false, reason: `${remote.symbol} ${remotePositionSide} 缺少该腿意图的持久止损` };
        }
        const signedQuantity = compareDecimals(remote.positionAmt, "0") < 0
          ? subtractDecimals("0", remote.positionAmt) : remote.positionAmt;
        existingExposure = addDecimals(existingExposure, multiplyDecimals(signedQuantity, remote.markPrice));
        portfolioPositions.push({ remote, stopPrice: intentStop.stopPrice });
      }
      const actualLeverage = Number(cached.result.positionRisk.leverage);
      const risk = calculateLivePositionRisk({
        side: opportunity.side,
        walletBalance: valuation.equity,
        availableBalance: valuation.availableBalance,
        entryPrice: input.limitPrice,
        stopPrice: input.stopPrice,
        liquidationPrice: admissionLiquidationPrice(
          cached.result, opportunity.side, input.limitPrice, actualLeverage,
        ),
        actualLeverage: cached.result.positionRisk.leverage,
        leverageMode: settings.leverageMode,
        fixedLeverage: settings.fixedLeverage,
        riskPerTradePct: settings.riskPerTradePct,
        mode: context.mode,
        highVolatilityRiskMultiplier: context.highVolatilityRiskMultiplier,
        marginPerTradePct: settings.marginPerTradePct,
        totalMarginCapPct: settings.totalMarginCapPct,
        takerFeeBps: settings.takerFeeBps,
        slippageBps: settings.slippageBps,
        stepSize: cached.result.filters.stepSize,
        minQuantity: cached.result.filters.minQuantity,
        minNotional: cached.result.filters.minNotional,
        brackets: cached.result.brackets,
        pendingIntents: [pendingIntents],
        existingPositionMargin: valuation.usedMargin,
        existingExposure,
      });
      if (!risk.ok) return { approved: false, reason: risk.reason };
      let quantity = risk.quantity;
      let notional = risk.notional;
      let reservedMargin = risk.initialMargin;
      let reservedRisk = risk.estimatedRisk;
      if (input.manualCanary) {
        const byNotional = divideDecimals(cached.result.filters.minNotional, input.limitPrice, {
          decimalPlaces: 30, roundingMode: "ROUND_UP",
        });
        quantity = ceilToStep(
          compareDecimals(cached.result.filters.minQuantity, byNotional) >= 0
            ? cached.result.filters.minQuantity : byNotional,
          cached.result.filters.stepSize,
        );
        if (compareDecimals(quantity, risk.quantity) > 0) {
          return { approved: false, reason: "canary 最小安全数量超过风险或保证金批准上限" };
        }
        notional = multiplyDecimals(quantity, input.limitPrice);
        reservedMargin = divideDecimals(notional, String(risk.effectiveLeverage), {
          decimalPlaces: 30, roundingMode: "ROUND_DOWN",
        });
        reservedRisk = multiplyDecimals(quantity, divideDecimals(risk.estimatedRisk, risk.quantity, {
          decimalPlaces: 30, roundingMode: "ROUND_UP",
        }));
      }
      const approvedBracket = [...cached.result.brackets]
        .sort((left, right) => left.bracket - right.bracket)
        .find((bracket) => compareDecimals(notional, bracket.notionalFloor) >= 0
          && compareDecimals(notional, bracket.notionalCap) <= 0);
      if (!approvedBracket || risk.effectiveLeverage > approvedBracket.initialLeverage) {
        return { approved: false, reason: "最终批准名义价值没有可用杠杆档位" };
      }
      const portfolio = validateLivePortfolioAdmission({
        symbol: opportunity.symbol,
        side: opportunity.side,
        walletBalance: valuation.equity,
        candidateRisk: Number(reservedRisk),
        maxPositions: settings.maxPositions,
        dailyLossLimitPct: settings.dailyLossLimitPct,
        dailyLocked: cached.daily.dailyLocked,
        todayPnlPct: cached.daily.todayPnlPct,
        portfolioStopRiskPct: settings.portfolioStopRiskPct,
        correlatedDirectionRiskPct: settings.correlatedDirectionRiskPct,
        correlationThreshold: settings.correlationThreshold,
        takerFeeBps: settings.takerFeeBps,
        slippageBps: settings.slippageBps,
        positions: portfolioPositions,
        pendingIntents: pendingSymbols.map((symbol) => ({ symbol })),
        correlations: cached.correlations,
      });
      if (!portfolio.ok) return { approved: false, reason: portfolio.reasons.join("；") };
      return {
        approved: true,
        signalId: opportunity.signalId,
        quantity,
        notional,
        reservedMargin,
        reservedRisk,
        effectiveLeverage: risk.effectiveLeverage,
        marginType,
        maintenanceBracket: approvedBracket.bracket,
        maintMarginRatio: approvedBracket.maintMarginRatio,
        cumMaintenance: approvedBracket.cum,
        liquidationPriceSource: compareDecimals(cached.result.positionRisk.positionAmt, "0") !== 0
          || compareDecimals(cached.result.positionRisk.liquidationPrice, "0") > 0
          ? "EXCHANGE" : "PRETRADE_ESTIMATE",
        validUntil: new Date(Math.min(opportunity.expiryTime, now() + 5_000)),
      };
    },
  });

  const accounting = new LiveAccountingSynchronizer({
    client,
    store: accountingStore,
    incomeParams: {},
    symbols,
  });
  const reconciliationService = new ReconciliationService({
    client,
    orders,
    store: reconciliationStore,
    recovery: adapter.machine,
    accounting,
    seedFor: currentSeed,
    ledger: accountingStore,
    pauseNewEntries: () => admission.pauseForReconciliation(),
    now,
  });
  let running = false;
  let lastRunAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let reconcileTail: Promise<void> = Promise.resolve();
  let markFirstReconcile: (() => void) | null = null;
  const firstReconcile = new Promise<void>((resolve) => { markFirstReconcile = resolve; });
  const reconcile = async () => {
    const previous = reconcileTail;
    let release!: () => void;
    reconcileTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const result = await reconciliationService.reconcile();
      lastRunAt = now();
      markFirstReconcile?.();
      markFirstReconcile = null;
      return result;
    } finally {
      release();
    }
  };
  const stream = new UserDataStream({
    client,
    socketFactory: options.socketFactory ?? defaultSocket,
    machine: adapter.machine,
    orders,
    store: reconciliationStore,
    seedFor: currentSeed,
    loadIntentMetadata: (order) => loadLiveIntentMetadata(options.db, order),
    reconcile,
    pauseNewEntries: () => admission.suspend(),
    now,
  });

  async function preflight() {
    const checkedAt = now();
    if (symbols.length === 0) {
      return { ready: false, reasons: ["BINANCE_MAINNET_ALLOWED_SYMBOLS 未配置"], checkedAt: null };
    }
    try {
      const settings = await getSettings();
      const [account, accountSnapshot, issues, ownedOrders, managedPositions] = await Promise.all([
        client.account(),
        adapter.account(),
        reconciliationStore.listIssues(),
        orders.listOrders(),
        orders.listOpenPositions(),
      ]);
      const results = await Promise.all(symbols.map((symbol) => runLivePreflight({
        client,
        symbol,
        allowedSymbols: symbols,
        leverageMode: settings.leverageMode,
        fixedLeverage: settings.fixedLeverage,
        reconciliationIssues: issues,
        ownedClientOrderIds: ownedOrders.map((order) => order.clientOrderId),
        managedPositionSymbols: managedPositions.map((position) => position.symbol),
      })));
      const reasons = results.flatMap((result) => result.ok ? [] : result.reasons);
      const market = options.market ?? binance;
      const entries = await Promise.all(results.map(async (result, index) => {
        const symbol = symbols[index];
        if (!result.ok) return null;
        const active = result.positions.filter((position) => compareDecimals(position.positionAmt, "0") !== 0
          && position.symbol !== symbol);
        const correlations: Record<string, number | null> = {};
        if (active.length > 0) {
          const candidateCandles = await market.getCandles(symbol, "15m", settings.correlationWindow + 2);
          await Promise.all(active.map(async (position) => {
            const otherCandles = await market.getCandles(position.symbol, "15m", settings.correlationWindow + 2);
            correlations[position.symbol] = alignedCorrelation(
              candidateCandles, otherCandles, checkedAt, settings.correlationWindow,
            );
          }));
        }
        return {
          symbol,
          value: {
            checkedAt,
            account,
            result,
            daily: {
              dailyLocked: accountSnapshot.dailyLocked,
              todayPnlPct: accountSnapshot.todayPnlPct,
            },
            correlations,
          },
        };
      }));
      results.forEach((result, index) => {
        const entry = entries[index];
        if (result.ok && entry) fresh.set(entry.symbol, entry.value);
        else fresh.delete(symbols[index]);
      });
      const ws = stream.health();
      if (!ws.running || !ws.connected || (ws.lastMessageAt !== null && ws.lastMessageAt > now())) {
        reasons.push("私有 WS 未连接或心跳时间无效");
      }
      if (!running || lastRunAt === null || lastRunAt > now() || now() - lastRunAt > 10_000) {
        reasons.push("REST 对账未运行或已陈旧");
      }
      if (issues.some((issue) => issue.status !== "RESOLVED" && ["ERROR", "CRITICAL"].includes(issue.severity))) {
        reasons.push("存在未解决的严重对账问题");
      }
      return { ready: reasons.length === 0, reasons: [...new Set(reasons)], checkedAt: new Date(checkedAt).toISOString() };
    } catch {
      fresh.clear();
      return { ready: false, reasons: ["主网签名预检失败"], checkedAt: null };
    }
  }

  return {
    adapter,
    preflight,
    privateWs: stream,
    reconciliation: { health: () => ({ configured: true, running, lastRunAt }) },
    async start() {
      if (running) return;
      await admission.suspend();
      const streamStart = stream.start();
      void streamStart.catch((error) => {
        running = false;
        log.error("private user-data stream stopped", { error: error instanceof Error ? error.message : String(error) });
      });
      await Promise.race([firstReconcile, streamStart]);
      running = true;
      if (lastRunAt === null) lastRunAt = now();
      const interval = options.reconciliationIntervalMs ?? 5_000;
      timer = setInterval(() => { void reconcile(); }, interval);
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      await admission.pauseFromOperator();
      await stream.stop();
      fresh.clear();
    },
  };
}
