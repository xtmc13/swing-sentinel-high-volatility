import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { liveIntents, livePositions, tradingSettings } from "@db/schema";
import type { Opportunity } from "@contracts/trading";
import { getSettings as readSettings, settingsFromRow } from "../queries/trading";
import { binance } from "../services/binance";
import { alignedCorrelation } from "../services/risk";
import { log } from "../lib/logger";
import {
  BinanceSignedClient,
  type BinanceAccountResponse,
  type BinanceLeverageBracket,
} from "./binanceSigned";
import { createBinanceCrossCollateralReader } from "./binanceCollateral";
import { canonicalSnapshot } from "./canonicalSnapshot";
import {
  estimateCrossLiquidationBoundary,
  selectUniqueCrossBracket,
  type CrossRiskPosition,
} from "./crossRisk";
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
import type { LiveOrder, LiveOrderStore, LivePositionSeed } from "./orderStateMachine";
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
  readCrossCollateral?: (observedAt: number) => Promise<{
    crossWalletBalance?: DecimalString;
    haircut: DecimalString;
    observedAt: number;
  }>;
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

function crossAccountValuation(
  account: BinanceAccountResponse,
  multiAssets: boolean,
  collateral?: { crossWalletBalance?: DecimalString },
) {
  const usdt = account.assets.find((asset) => asset.asset === "USDT");
  const crossWalletBalance = collateral?.crossWalletBalance ?? account.totalCrossWalletBalance
    ?? (multiAssets ? undefined : usdt?.crossWalletBalance);
  const crossUnrealizedPnl = account.totalCrossUnPnl
    ?? (multiAssets ? undefined : usdt?.crossUnPnl);
  if (crossWalletBalance === undefined || crossUnrealizedPnl === undefined) {
    throw new Error("缺少 cross 专用钱包或未实现盈亏");
  }
  return { crossWalletBalance, crossUnrealizedPnl };
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
  const readCrossCollateral = options.readCrossCollateral ?? createBinanceCrossCollateralReader(client, now);
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

  async function assertOrderAdmission(
    order: LiveOrder,
    approval?: Extract<LiveFinalGateResult, { approved: true }>,
  ): Promise<void> {
    if (!options.accountMode) throw new Error("缺少最终订单账户模式批准");
    const [positionSide, multiAssets, positions, leverageBrackets] = await Promise.all([
      client.positionSide(),
      client.multiAssetsMargin(),
      client.positionRisk(order.symbol),
      client.leverageBracket(order.symbol),
    ]);
    if (positionSide.dualSidePosition !== options.accountMode.dualSide
      || multiAssets.multiAssetsMargin !== options.accountMode.multiAssets) {
      throw new Error("最终订单账户模式与批准指纹不一致");
    }
    if (order.accountModeFingerprint !== options.accountMode.fingerprint) {
      throw new Error("最终订单账户模式指纹已变化");
    }
    if (approval && (order.effectiveLeverage !== approval.effectiveLeverage
      || order.maintenanceBracket !== approval.maintenanceBracket
      || compareDecimals(order.maintMarginRatio!, approval.maintMarginRatio) !== 0
      || compareDecimals(order.cumMaintenance!, approval.cumMaintenance) !== 0
      || order.marginType !== approval.marginType
      || compareDecimals(order.originalQuantity, approval.quantity) !== 0
      || compareDecimals(multiplyDecimals(order.originalQuantity, order.price), approval.notional) !== 0)) {
      throw new Error("最终订单与持久化批准令牌不一致");
    }
    const effectiveLeverage = approval?.effectiveLeverage ?? order.effectiveLeverage;
    const maintenanceBracket = approval?.maintenanceBracket ?? order.maintenanceBracket;
    const maintMarginRatio = approval?.maintMarginRatio ?? order.maintMarginRatio;
    const cumMaintenance = approval?.cumMaintenance ?? order.cumMaintenance;
    if (!Number.isInteger(effectiveLeverage) || !Number.isInteger(maintenanceBracket)
      || !maintMarginRatio || !cumMaintenance) {
      throw new Error("最终订单缺少持久化杠杆或 bracket 批准");
    }
    const expectedPositionSide = options.accountMode.dualSide ? order.positionSide : "BOTH";
    const target = positions.filter((position) => position.symbol === order.symbol
      && (position.positionSide ?? "BOTH") === expectedPositionSide);
    if (target.length !== 1 || Number(target[0].leverage) !== effectiveLeverage) {
      throw new Error("最终订单实际杠杆与批准值不一致");
    }
    const payload = leverageBrackets.filter((entry) => entry.symbol === order.symbol);
    const bracket = payload.length === 1
      ? selectUniqueCrossBracket(payload[0].brackets, multiplyDecimals(order.originalQuantity, order.price))
      : null;
    if (!bracket || bracket.bracket !== maintenanceBracket
      || compareDecimals(bracket.maintMarginRatio, maintMarginRatio) !== 0
      || compareDecimals(bracket.cum, cumMaintenance) !== 0
      || effectiveLeverage! > bracket.initialLeverage) {
      throw new Error("最终订单 bracket 与批准值不一致");
    }
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
    assertOrderAdmission,
    assertFreshOrderAdmission: (order) => assertOrderAdmission(order),
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
      if (marginType === "CROSS" && pendingSymbols.length > 0) {
        return { approved: false, reason: "存在 cross 持仓或相关待单，必须完成组合强平估算后才能新增" };
      }
      let existingExposure: DecimalString = "0";
      const portfolioPositions: Array<{ remote: (typeof activeRemote)[number]; stopPrice: DecimalString }> = [];
      const crossPositions: Array<{ remote: (typeof activeRemote)[number] }> = [];
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
        if (remote.marginType.toLowerCase() === "cross") crossPositions.push({ remote });
      }
      const crossSymbols = [...new Set(crossPositions.map((position) => position.remote.symbol))];
      const firstExistingBrackets: BinanceLeverageBracket[][] = [];
      const currentCrossPositions: CrossRiskPosition[] = [];
      if (marginType === "CROSS" && crossSymbols.length > 0) {
        try {
          const payloads = await Promise.all(crossSymbols.map((symbol) => client.leverageBracket(symbol)));
          for (const [index, symbol] of crossSymbols.entries()) {
            const payload = payloads[index];
            const matches = payload.filter((entry) => entry.symbol === symbol);
            if (matches.length !== 1) {
              return { approved: false, reason: `${symbol} 当前 cross bracket payload 缺失或有歧义` };
            }
            firstExistingBrackets.push(payload);
          }
          for (const position of crossPositions) {
            const index = crossSymbols.indexOf(position.remote.symbol);
            const payload = firstExistingBrackets[index];
            currentCrossPositions.push({
              remote: position.remote,
              brackets: payload.find((entry) => entry.symbol === position.remote.symbol)!.brackets,
            });
          }
        } catch (error) {
          return {
            approved: false,
            reason: `读取 cross 当前 brackets 失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      const actualLeverage = Number(cached.result.positionRisk.leverage);
      let approvedLiquidationPrice = marginType === "CROSS" ? "0" : admissionLiquidationPrice(
        cached.result, opportunity.side, input.limitPrice, actualLeverage,
      );
      const risk = calculateLivePositionRisk({
        side: opportunity.side,
        walletBalance: valuation.equity,
        availableBalance: valuation.availableBalance,
        entryPrice: input.limitPrice,
        stopPrice: input.stopPrice,
        liquidationPrice: marginType === "CROSS" ? null : approvedLiquidationPrice,
        portfolioLiquidation: marginType === "CROSS",
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
      const approvedBracket = selectUniqueCrossBracket(cached.result.brackets, notional);
      if (!approvedBracket || risk.effectiveLeverage > approvedBracket.initialLeverage) {
        return { approved: false, reason: "最终批准名义价值没有可用杠杆档位" };
      }
      if (marginType === "CROSS") {
        try {
          const multiAssets = options.accountMode?.multiAssets === true;
          let firstCollateral: {
            crossWalletBalance?: DecimalString;
            haircut: DecimalString;
            observedAt: number;
          } | undefined;
          if (multiAssets) {
            firstCollateral = await readCrossCollateral(cached.checkedAt);
            if (firstCollateral.observedAt < cached.checkedAt || firstCollateral.observedAt > now()
              || now() - firstCollateral.observedAt > 10_000) {
              return { approved: false, reason: "Cross collateral 首次读取时间不新鲜" };
            }
          }
          const boundary = estimateCrossLiquidationBoundary({
            ...crossAccountValuation(cached.account, multiAssets, firstCollateral),
            positions: currentCrossPositions,
            multiAssets,
            observedAt: cached.checkedAt,
            collateral: firstCollateral,
            relatedPendingIntents: pendingSymbols.length,
          }, {
            symbol: opportunity.symbol,
            side: opportunity.side,
            quantity,
            entryPrice: input.limitPrice,
            stopPrice: input.stopPrice,
            tickSize: cached.result.filters.tickSize,
            brackets: cached.result.brackets,
          });
          if (!boundary.ok) return { approved: false, reason: boundary.reason };
          approvedLiquidationPrice = boundary.liquidationPrice ?? "0";
          const [
            secondAccount, secondPositions, secondOrders, secondBrackets, secondCollateral,
            secondPositionSide, secondMultiAssets,
          ] = await Promise.all([
            client.account(),
            client.positionRisk(),
            client.openOrders(),
            Promise.all([opportunity.symbol, ...crossSymbols].map((symbol) => client.leverageBracket(symbol))),
            multiAssets ? readCrossCollateral(firstCollateral!.observedAt) : Promise.resolve(undefined),
            client.positionSide(),
            client.multiAssetsMargin(),
          ]);
          if (canonicalSnapshot(secondAccount) !== canonicalSnapshot(cached.account)
            || canonicalSnapshot(secondPositions) !== canonicalSnapshot(cached.result.positions)
            || canonicalSnapshot(secondOrders) !== canonicalSnapshot(cached.result.orders)
            || canonicalSnapshot(secondPositionSide) !== canonicalSnapshot(cached.result.positionSide)
            || canonicalSnapshot(secondMultiAssets) !== canonicalSnapshot(cached.result.multiAssets)) {
            return { approved: false, reason: "Cross 二次快照与预检账户模式、持仓或活动单不一致" };
          }
          const firstBrackets = [cached.result.leverageBrackets, ...firstExistingBrackets];
          if (secondBrackets.some((payload, index) =>
            canonicalSnapshot(payload) !== canonicalSnapshot(firstBrackets[index]))) {
            return { approved: false, reason: "Cross 二次快照 bracket payload 发生变化" };
          }
          if (multiAssets && (!secondCollateral
            || secondCollateral.observedAt < firstCollateral!.observedAt
            || secondCollateral.observedAt > now() || now() - secondCollateral.observedAt > 10_000
            || secondCollateral.haircut !== firstCollateral!.haircut
            || secondCollateral.crossWalletBalance !== firstCollateral!.crossWalletBalance)) {
            return { approved: false, reason: "Cross 二次 collateral valuation/haircut 无法刷新或发生变化" };
          }
        } catch (error) {
          return {
            approved: false,
            reason: `Cross 组合强平估算或二次快照失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
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
        liquidationPrice: approvedLiquidationPrice,
        liquidationPriceSource: marginType === "CROSS" ? "PRETRADE_ESTIMATE"
          : compareDecimals(cached.result.positionRisk.positionAmt, "0") !== 0
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
    accountMode: options.accountMode,
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
        managedPositions: managedPositions.map((position) => ({
          symbol: position.symbol, positionSide: position.positionSide,
        })),
      })));
      const modeMatches = results.map((result) => result.ok && options.accountMode !== undefined
        && result.positionSide.dualSidePosition === options.accountMode.dualSide
        && result.multiAssets.multiAssetsMargin === options.accountMode.multiAssets);
      const reasons = results.flatMap((result, index) => result.ok
        ? modeMatches[index] ? [] : ["账户模式与启动批准 fingerprint 不一致"]
        : result.reasons);
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
        if (result.ok && entry && modeMatches[index]) fresh.set(entry.symbol, entry.value);
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
