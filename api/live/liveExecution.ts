import type { AccountSnapshot, Opportunity, PositionView, TradingSettings } from "@contracts/trading";
import { DEFAULT_MOMENTUM_CONFIG } from "../services/momentum";
import { managePositionPrice } from "../services/risk";
import type { BinanceAccountResponse, BinancePositionRisk, LiveOrderGateway } from "./binanceSigned";
import { withFullUserTradePagination, type LiveAccountingStore } from "./accounting";
import type { AssertCurrentLiveAdmission } from "./liveConfig";
import type { LiveDailyRisk } from "./liveDailyRisk";
import {
  addDecimals,
  compareDecimals,
  decimal,
  multiplyDecimals,
  normalizeDirectionalPrice,
  subtractDecimals,
  type DecimalString,
} from "./decimal";
import {
  claimLiveIntent,
  createLiveIntent,
  pauseLiveExecution,
  type ClaimLiveIntentInput,
  type ClaimLiveIntentResult,
  type CreateLiveIntentInput,
  type CreateLiveIntentOptions,
  type CreateLiveIntentResult,
  type LiveDatabase,
  type LiveFinalGateContext,
  type LiveFinalGateResult,
  type LiveTransaction,
} from "./livePersistence";
import {
  OrderStateMachine,
  type LiveFill,
  type LiveOrder,
  type LiveOrderStore,
  type LivePosition,
  type LivePositionSeed,
} from "./orderStateMachine";
import type { OrderWireAccountMode } from "./orderWire";
import type {
  CloseExecutionResult,
  EmergencyExecutionResult,
  ExecutionAdapter,
  ExecutionSnapshot,
  OpenExecutionResult,
} from "../services/executionCoordinator";

export type PrepareLiveIntent = (
  opportunity: Opportunity,
) => Omit<CreateLiveIntentInput, "id" | "workerId">;

export interface MainnetLiveExecutionDependencies {
  store: LiveOrderStore;
  gateway: LiveOrderGateway & {
    account(): Promise<BinanceAccountResponse>;
    positionRisk(symbol?: string): Promise<BinancePositionRisk[]>;
  };
  accounting?: Pick<LiveAccountingStore, "listLedgerEntries">;
  dailyRisk?: LiveDailyRisk;
  getSettings?: () => Promise<TradingSettings>;
  userTradesPageLimit?: number;
  workerId: string;
  assertCurrentAdmission: AssertCurrentLiveAdmission;
  accountMode?: OrderWireAccountMode;
  createIntent: (
    input: CreateLiveIntentInput,
    options: CreateLiveIntentOptions,
  ) => Promise<CreateLiveIntentResult>;
  claimIntent: (input: ClaimLiveIntentInput) => Promise<ClaimLiveIntentResult>;
  prepareIntent: PrepareLiveIntent;
  finalGate: (
    opportunity: Opportunity,
    input: CreateLiveIntentInput,
    tx: LiveTransaction,
    context: LiveFinalGateContext,
  ) => LiveFinalGateResult | Promise<LiveFinalGateResult>;
  pauseAutoTrade: () => Promise<void>;
  alert?: (message: string) => unknown;
  now?: () => number;
  id?: () => string;
}

let executionTail: Promise<void> = Promise.resolve();
const protectionLocks = new WeakMap<LiveOrderStore, Map<string, Promise<void>>>();

async function serializeProtectionOperation<T>(
  store: LiveOrderStore,
  positionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let locks = protectionLocks.get(store);
  if (!locks) {
    locks = new Map<string, Promise<void>>();
    protectionLocks.set(store, locks);
  }
  const previous = locks.get(positionId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  locks.set(positionId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(positionId) === tail) locks.delete(positionId);
  }
}

async function serializeOpenAndEmergency<T>(operation: () => Promise<T>): Promise<T> {
  const previous = executionTail;
  let release!: () => void;
  executionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function acceptedMomentumEntryCap(opportunity: Opportunity): DecimalString | null {
  const breakout = opportunity.breakoutPrice;
  const atr = opportunity.atr15;
  if (breakout === undefined || atr === undefined
    || ![breakout, atr, opportunity.limitPrice].every(Number.isFinite)
    || breakout <= 0 || atr <= 0 || opportunity.limitPrice <= 0) return null;
  const direction = opportunity.side === "LONG" ? 1 : -1;
  const bpsLimit = breakout * (1 + direction * DEFAULT_MOMENTUM_CONFIG.maxChaseBps / 10_000);
  const atrLimit = breakout + direction * atr * DEFAULT_MOMENTUM_CONFIG.maxChaseAtr;
  const cap = opportunity.side === "LONG" ? Math.min(bpsLimit, atrLimit) : Math.max(bpsLimit, atrLimit);
  try {
    const accepted = decimal(String(opportunity.limitPrice));
    return exceedsDirectionalLimit(accepted, decimal(String(cap)), opportunity.side) ? null : accepted;
  } catch {
    return null;
  }
}

function exceedsDirectionalLimit(price: DecimalString, cap: DecimalString, side: Opportunity["side"]): boolean {
  const comparison = compareDecimals(price, cap);
  return side === "LONG" ? comparison > 0 : comparison < 0;
}

export interface LiveAccountValuation {
  equity: DecimalString;
  cash: DecimalString;
  availableBalance: DecimalString;
  usedMargin: DecimalString;
  unrealizedPnl: DecimalString;
}

function signedDecimal(value: unknown, label: string): DecimalString {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} 缺失或无效`);
  return decimal(value);
}

export function signedPositionInitialMargin(position: BinancePositionRisk): DecimalString {
  if (position.positionInitialMargin !== undefined) {
    return signedDecimal(position.positionInitialMargin, `${position.symbol} positionInitialMargin`);
  }
  if (position.marginType.toLowerCase() === "isolated" && position.isolatedWallet !== undefined) {
    return signedDecimal(position.isolatedWallet, `${position.symbol} isolatedWallet`);
  }
  throw new Error(`${position.symbol} 缺少签名持仓初始保证金`);
}

export function readLiveAccountValuation(
  response: BinanceAccountResponse,
  remotePositions: BinancePositionRisk[],
  multiAssets: boolean,
): LiveAccountValuation {
  const active = remotePositions.filter((position) => compareDecimals(position.positionAmt, "0") !== 0);
  let unrealizedPnl: DecimalString = "0";
  let positionMargin: DecimalString = "0";
  for (const position of active) {
    unrealizedPnl = addDecimals(unrealizedPnl, multiplyDecimals(
      position.positionAmt, subtractDecimals(position.markPrice, position.entryPrice),
    ));
    if (response.totalPositionInitialMargin === undefined) {
      positionMargin = addDecimals(positionMargin, signedPositionInitialMargin(position));
    }
  }
  const asset = response.assets.find((candidate) => candidate.asset === "USDT");
  if (multiAssets && (response.totalMarginBalance === undefined
    || response.totalWalletBalance === undefined || response.availableBalance === undefined)) {
    throw new Error("多资产账户缺少 totalMarginBalance、totalWalletBalance 或 availableBalance");
  }
  if (!multiAssets && !asset) throw new Error("签名账户缺少 USDT 余额");
  const equity = signedDecimal(
    response.totalMarginBalance ?? (asset ? addDecimals(asset.walletBalance, unrealizedPnl) : undefined),
    "totalMarginBalance",
  );
  const cash = signedDecimal(response.totalWalletBalance ?? asset?.walletBalance, "totalWalletBalance");
  const availableBalance = signedDecimal(response.availableBalance ?? asset?.availableBalance, "availableBalance");
  const usedMargin = signedDecimal(response.totalPositionInitialMargin ?? positionMargin, "totalPositionInitialMargin");
  if (compareDecimals(usedMargin, "0") < 0) throw new Error("持仓初始保证金不能为负数");
  return { equity, cash, availableBalance, usedMargin, unrealizedPnl };
}

function unavailableAccount(): AccountSnapshot {
  return {
    equity: 0,
    cash: 0,
    availableMargin: 0,
    usedMargin: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    todayPnl: 0,
    todayPnlPct: 0,
    dayStartEquity: 0,
    valuationValid: false,
    valuationIssues: ["签名 LIVE 账户或持仓估值不可用"],
    dailyLocked: true,
  };
}

export class MainnetLiveExecutionAdapter implements ExecutionAdapter {
  readonly machine: OrderStateMachine;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly replacementCounts = new Map<string, number>();
  private readonly entryMetadata = new Map<string,
    Pick<LivePositionSeed, "signalId" | "strategyType" | "breakoutPrice">>();
  private readonly dependencies: MainnetLiveExecutionDependencies;

  constructor(dependencies: MainnetLiveExecutionDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? (() => crypto.randomUUID());
    this.machine = new OrderStateMachine(
      dependencies.store,
      withFullUserTradePagination(dependencies.gateway, dependencies.userTradesPageLimit),
      {
        alert: dependencies.alert,
        id: this.id,
        assertCurrentAdmission: dependencies.assertCurrentAdmission,
        accountMode: dependencies.accountMode,
      },
    );
  }

  async open(
    opportunity: Opportunity,
    executionHealthy?: () => boolean,
    options: { manualCanary?: boolean } = {},
  ): Promise<OpenExecutionResult> {
    return serializeOpenAndEmergency(() => this.openWhenSerialized(opportunity, executionHealthy, options));
  }

  private async openWhenSerialized(
    opportunity: Opportunity,
    executionHealthy?: () => boolean,
    options: { manualCanary?: boolean } = {},
  ): Promise<OpenExecutionResult> {
    if (executionHealthy && !executionHealthy()) return { ok: false, reason: "实时执行健康检查未通过" };
    const input: CreateLiveIntentInput = {
      ...this.dependencies.prepareIntent(opportunity),
      id: this.id(),
      signalId: opportunity.signalId,
      strategyType: opportunity.strategyType,
      manualCanary: options.manualCanary === true,
      breakoutPrice: opportunity.breakoutPrice === undefined ? undefined : String(opportunity.breakoutPrice),
      workerId: this.dependencies.workerId,
    };
    const entryCap = opportunity.strategyType === "MOMENTUM"
      ? acceptedMomentumEntryCap(opportunity)
      : input.limitPrice;
    if (!entryCap) return { ok: false, reason: "动量限价或 bps/ATR 上限无效" };
    try {
      if (exceedsDirectionalLimit(decimal(input.limitPrice), entryCap, opportunity.side)) {
        return { ok: false, reason: "prepareIntent 限价超过动量机会或 bps/ATR 上限" };
      }
    } catch {
      return { ok: false, reason: "prepareIntent 限价无效" };
    }
    const approvals: Extract<LiveFinalGateResult, { approved: true }>[] = [];
    const created = await this.dependencies.createIntent(input, {
      requireAutoTrade: !options.manualCanary,
      assertCurrentAdmission: this.dependencies.assertCurrentAdmission,
      finalGate: async (tx, context) => {
        const approval = await this.dependencies.finalGate(opportunity, input, tx, context);
        if (approval.approved) approvals.push(approval);
        return approval;
      },
    });
    if (!created.ok) return { ok: false, reason: created.reason };
    this.entryMetadata.set(input.id, {
      signalId: input.signalId,
      strategyType: input.strategyType,
      breakoutPrice: input.breakoutPrice,
    });
    const approval = approvals[0];
    if (!approval) return { ok: false, reason: "final gate 未返回已持久化的批准值" };
    const claimed = await this.dependencies.claimIntent({
      id: input.id,
      workerId: this.dependencies.workerId,
      expectedVersion: created.version,
      leaseDurationMs: input.leaseDurationMs,
    });
    if (!claimed.ok) return { ok: false, reason: claimed.reason };

    const clientOrderId = `${input.id}-entry`;
    await this.machine.createOrder({
      id: this.id(),
      intentId: input.id,
      clientOrderId,
      exchangeOrderId: null,
      symbol: input.symbol,
      side: input.side,
      positionSide: input.positionSide,
      marginType: approval.marginType,
      entrySemantics: input.entrySemantics,
      effectiveLeverage: approval.effectiveLeverage,
      maintenanceBracket: approval.maintenanceBracket,
      maintMarginRatio: approval.maintMarginRatio,
      cumMaintenance: approval.cumMaintenance,
      liquidationPriceSource: approval.liquidationPriceSource,
      accountModeFingerprint: input.accountModeFingerprint,
      compatibilityFrozen: false,
      type: "LIMIT",
      status: "PENDING_SEND",
      price: input.limitPrice,
      maxEntryPrice: entryCap,
      stopPrice: null,
      originalQuantity: approval.quantity,
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      reduceOnly: false,
      manualCanary: options.manualCanary === true,
      admissionGeneration: created.emergencyGeneration,
      createdAt: this.now(),
    });
    const submitted = await this.machine.submit(clientOrderId, created.emergencyGeneration);
    if (submitted.status === "CANCEL" && submitted.executedQuantity === "0") {
      return { ok: false, reason: "IOC 已终止且没有实际成交" };
    }
    if (submitted.status === "CANCEL") {
      return { ok: true, positionId: input.id, reason: "IOC 已终止，已有实际成交" };
    }
    if (!["NEW", "PARTIALLY_FILLED", "FILLED"].includes(submitted.status)) {
      return { ok: false, reason: `订单提交未确认（${submitted.status}），必须先对账` };
    }
    return { ok: true, positionId: input.id, reason: "live IOC 已提交，等待实际成交回报" };
  }

  private withEntryMetadata(seed: LivePositionSeed): LivePositionSeed {
    const metadata = this.entryMetadata.get(seed.id);
    return {
      ...seed,
      signalId: seed.signalId ?? metadata?.signalId,
      strategyType: seed.strategyType ?? metadata?.strategyType,
      breakoutPrice: seed.breakoutPrice ?? metadata?.breakoutPrice,
      exitPending: seed.exitPending ?? false,
    };
  }

  handleFill(clientOrderId: string, fill: LiveFill, seed: LivePositionSeed) {
    return this.machine.handleFill(clientOrderId, fill, this.withEntryMetadata(seed));
  }

  recover(clientOrderId: string, seed: LivePositionSeed) {
    return this.machine.recover(clientOrderId, this.withEntryMetadata(seed));
  }

  async replaceOrder(clientOrderId: string, newLimitPrice: DecimalString) {
    const order = await this.dependencies.store.getOrder(clientOrderId);
    if (!order) throw new Error("Live order not found");
    if (order.compatibilityFrozen) throw new Error("Legacy compatibility record is frozen");
    if (order.type === "LIMIT" && order.entrySemantics === "ENTRY") {
      if (!order.maxEntryPrice) throw new Error("缺少持久化动量限价");
      try {
        if (exceedsDirectionalLimit(decimal(newLimitPrice), order.maxEntryPrice, order.side)) {
          throw new Error("改单限价超过持久化动量上限");
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("限价")) throw error;
        throw new Error("改单限价无效");
      }
      let attempts = this.replacementCounts.get(order.intentId);
      if (attempts === undefined) {
        const orders = await this.dependencies.store.listOrders();
        attempts = orders.filter((candidate) => candidate.intentId === order.intentId
          && candidate.type === "LIMIT" && candidate.entrySemantics === "ENTRY"
          && candidate.clientOrderId !== `${order.intentId}-entry`).length;
      }
      if (attempts >= DEFAULT_MOMENTUM_CONFIG.maxReplacements) throw new Error("动量入场最多改单 1 次");
      this.replacementCounts.set(order.intentId, attempts + 1);
    }
    return this.machine.replaceOrder(clientOrderId, newLimitPrice);
  }

  async close(positionId: string, reason = "人工平仓"): Promise<CloseExecutionResult> {
    await this.dependencies.store.updatePosition(positionId, { exitPending: true });
    const order = await this.machine.closePosition(positionId);
    if (!order) {
      return { ok: false, reason: "真实持仓不存在或已关闭", unsettled: false, alreadyClosed: true, pnl: undefined };
    }
    if (order.status === "UNKNOWN" || order.status === "CANCEL") {
      return {
        ok: false,
        reason: `REDUCE 平仓结果 ${order.status}，必须对账或受控重试`,
        unsettled: true,
        alreadyClosed: false,
      };
    }
    return { ok: true, reason: `${reason}：REDUCE 已提交，等待实际成交`, pnl: Number.NaN, unsettled: true, alreadyClosed: false };
  }

  async manage(): Promise<void> {
    const account = await this.account();
    const settings = await this.dependencies.getSettings?.();
    if (!settings) throw new Error("LIVE 持仓管理缺少交易设置");
    const positions = await this.refreshPositions();
    for (const position of positions) {
      const direction = position.side === "LONG" ? 1 : -1;
      const entryPrice = Number(position.entryPrice);
      if (position.initialStopPrice == null) throw new Error(`${position.symbol} 缺少原始止损历史`);
      const initialStop = Number(position.initialStopPrice);
      const initialRisk = Math.abs(entryPrice - initialStop);
      if (!(initialRisk > 0)) throw new Error(`${position.symbol} 缺少有效原始止损`);
      const targetPrice = entryPrice + direction * initialRisk * 2.2;
      const management = managePositionPrice({
        side: position.side,
        entryPrice,
        stopPrice: Number(position.stopPrice),
        targetPrice,
        liquidationPrice: Number(position.liquidationPrice),
        price: Number(position.markPrice),
        initialRisk,
        maxFavorableR: 0,
        mode: "NORMAL",
        dailyLossLocked: account.dailyLocked,
        timedOut: this.now() - position.openedAt >= 72 * 60 * 60_000,
        takerFeeBps: settings.takerFeeBps,
        slippageBps: settings.slippageBps,
      });
      if (management.action === "CLOSE") {
        await this.machine.closePosition(position.id);
        continue;
      }
      if (compareDecimals(String(management.stopPrice), position.stopPrice) === 0) continue;
      await this.tightenStop(position.id, management.stopPrice, "常规移动止损");
    }
  }

  private async serializeProtection<T>(positionId: string, operation: () => Promise<T>): Promise<T> {
    return serializeProtectionOperation(this.dependencies.store, positionId, operation);
  }

  async tightenStop(positionId: string, stopPrice: number, reason: string) {
    return this.serializeProtection(positionId, async () => {
      if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false as const, changed: false as const, reason: "收紧止损价格无效" };
      const stored = await this.dependencies.store.getPosition(positionId);
      if (!stored || stored.status !== "OPEN" || stored.exitPending) {
        return { ok: true as const, changed: false as const, reason: "持仓不存在、已关闭或正在退出" };
      }
      if (!stored.tickSize) return { ok: false as const, changed: false as const, reason: `${stored.symbol} 缺少持久化 tickSize` };
      const [position] = await this.refreshPositions([stored]);
      const normalized = normalizeDirectionalPrice(String(stopPrice), position.tickSize!, position.side);
      const tighter = position.side === "LONG"
        ? compareDecimals(normalized, position.stopPrice) > 0
        : compareDecimals(normalized, position.stopPrice) < 0;
      const clearOfMark = position.side === "LONG"
        ? compareDecimals(normalized, position.markPrice) < 0
        : compareDecimals(normalized, position.markPrice) > 0;
      if (!tighter || !clearOfMark) {
        return { ok: true as const, changed: false as const, reason: "止损相同、宽松或越过有效标记价" };
      }
      const updated = await this.updateTrailingProtection(position, normalized);
      if (updated === null) return { ok: true as const, changed: false as const, reason: "持仓或保护单已变化，跳过旧收紧请求" };
      return updated
        ? { ok: true as const, changed: true as const, reason: `${reason}：STOP_MARKET 已确认` }
        : { ok: false as const, changed: false as const, reason: `${reason}：止损未一致确认，已尝试保护性退出` };
    });
  }

  private assertPositionIdentity(position: LivePosition): void {
    if (position.compatibilityFrozen) throw new Error(`${position.symbol} 持仓 compatibility frozen`);
    if (!this.dependencies.accountMode
      || position.accountModeFingerprint !== this.dependencies.accountMode.fingerprint) {
      throw new Error(`${position.symbol} 持仓 account mode fingerprint 与当前模式不一致`);
    }
  }

  private protectionOwnedBy(position: LivePosition, order: LiveOrder): boolean {
    return order.intentId === position.id && order.symbol === position.symbol
      && order.positionSide === position.positionSide
      && order.accountModeFingerprint === position.accountModeFingerprint
      && order.entrySemantics === "REDUCE" && order.type === "STOP_MARKET";
  }

  private async currentProtection(position: LivePosition): Promise<LiveOrder | undefined> {
    const protections = (await this.dependencies.store.listActiveProtectionOrders())
      .filter((order) => order.intentId === position.id);
    if (protections.some((order) => order.compatibilityFrozen)) {
      throw new Error("STOP_MARKET compatibility frozen");
    }
    if (protections.some((order) => !this.protectionOwnedBy(position, order))) {
      throw new Error("STOP_MARKET ownership, positionSide, fingerprint, or entrySemantics mismatch");
    }
    return protections[0];
  }

  private async updateTrailingProtection(position: LivePosition, stopPrice: DecimalString): Promise<boolean | null> {
    try {
      this.assertPositionIdentity(position);
      let protection = await this.currentProtection(position);
      if (!protection) await this.machine.protectPosition(position.id);
      protection = await this.currentProtection(position);
      if (!protection || protection.status !== "NEW") throw new Error("现有 STOP_MARKET 未确认");
      const latest = await this.dependencies.store.getPosition(position.id);
      if (!latest || latest.status !== "OPEN" || latest.exitPending) return null;
      this.assertPositionIdentity(latest);
      const tighterThanPosition = latest.side === "LONG"
        ? compareDecimals(stopPrice, latest.stopPrice) > 0
        : compareDecimals(stopPrice, latest.stopPrice) < 0;
      const tighterThanProtection = protection.stopPrice === null ? true : latest.side === "LONG"
        ? compareDecimals(stopPrice, protection.stopPrice) > 0
        : compareDecimals(stopPrice, protection.stopPrice) < 0;
      if (!tighterThanPosition || !tighterThanProtection) return null;
      const replaced = await this.machine.replaceOrder(protection.clientOrderId, stopPrice);
      if (replaced.status === "CANCEL" && (await this.dependencies.store.getPosition(position.id))?.exitPending) return null;
      if (replaced.status !== "NEW" || !replaced.stopPrice
        || compareDecimals(replaced.stopPrice, stopPrice) !== 0) {
        throw new Error(`STOP_MARKET replacement 未确认（${replaced.status}）`);
      }
      const persisted = await this.dependencies.store.updatePosition(position.id, { stopPrice });
      if (!persisted) throw new Error("STOP_MARKET 已确认但持仓持久化失败");
      return true;
    } catch (error) {
      this.dependencies.alert?.(
        `${position.symbol} 移动止损未一致确认，保留原持久止损并尝试 REDUCE 退出：${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        const exit = await this.machine.closePosition(position.id);
        if (!exit || exit.status === "UNKNOWN") {
          this.dependencies.alert?.(`${position.symbol} 移动止损失败后的 REDUCE 退出仍未确认`);
        }
      } catch (exitError) {
        this.dependencies.alert?.(
          `${position.symbol} REDUCE 退出提交失败：${exitError instanceof Error ? exitError.message : String(exitError)}`,
        );
      }
      return false;
    }
  }

  async emergency(): Promise<EmergencyExecutionResult> {
    return serializeOpenAndEmergency(async () => {
      await this.dependencies.pauseAutoTrade();
      const result = await this.machine.emergency();
      return { ok: result.unsettled.length === 0, paused: true, settled: [], unsettled: result.unsettled };
    });
  }

  async account(): Promise<AccountSnapshot> {
    const [response, remotePositions, settings, ledger] = await Promise.all([
      this.dependencies.gateway.account(),
      this.dependencies.gateway.positionRisk(),
      this.dependencies.getSettings?.(),
      this.dependencies.accounting?.listLedgerEntries() ?? Promise.resolve([]),
    ]);
    if (!settings || !this.dependencies.dailyRisk) throw new Error("LIVE 日损状态存储未配置");
    let valuation: LiveAccountValuation;
    try {
      valuation = readLiveAccountValuation(
        response, remotePositions, this.dependencies.accountMode?.multiAssets === true,
      );
    } catch {
      return unavailableAccount();
    }
    const equity = Number(valuation.equity);
    const availableMargin = Number(valuation.availableBalance);
    const cash = Number(valuation.cash);
    const unrealized = Number(valuation.unrealizedPnl);
    const margin = Number(valuation.usedMargin);
    if (![equity, availableMargin, cash, unrealized, margin].every(Number.isFinite)) {
      return unavailableAccount();
    }
    const dayKey = new Date(this.now()).toISOString().slice(0, 10);
    const daily = await this.dependencies.dailyRisk.evaluate(dayKey, equity, settings.dailyLossLimitPct);
    const dayStartedAt = Date.parse(`${dayKey}T00:00:00.000Z`);
    const realizedPnl = ledger.filter((entry) => entry.asset === "USDT" && entry.occurredAt >= dayStartedAt
      && ["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"].includes(entry.entryType))
      .reduce((total, entry) => total + (entry.entryType === "COMMISSION"
        ? -Math.abs(Number(entry.amount)) : Number(entry.amount)), 0);
    const todayPnl = equity - daily.dayStartEquity;
    const symbolLeverages: Record<string, number> = {};
    const symbolMarginTypes: NonNullable<AccountSnapshot["symbolMarginTypes"]> = {};
    for (const position of remotePositions) {
      const leverage = Number(position.leverage);
      if (Number.isInteger(leverage) && leverage > 0) symbolLeverages[position.symbol] = leverage;
      const marginType = position.marginType.toUpperCase();
      if (marginType === "ISOLATED" || marginType === "CROSS") symbolMarginTypes[position.symbol] = marginType;
    }
    return {
      equity,
      cash,
      availableMargin,
      usedMargin: margin,
      unrealizedPnl: unrealized,
      realizedPnl,
      todayPnl,
      todayPnlPct: daily.dayStartEquity > 0 ? todayPnl / daily.dayStartEquity * 100 : 0,
      dayStartEquity: daily.dayStartEquity,
      dualSide: this.dependencies.accountMode?.dualSide ?? null,
      multiAssets: this.dependencies.accountMode?.multiAssets ?? null,
      symbolLeverages,
      symbolMarginTypes,
      valuationBasis: "EXCHANGE_ACCOUNT_TOTALS",
      valuationValid: true,
      valuationIssues: [],
      dailyLocked: daily.dailyLocked,
    };
  }

  async positions(): Promise<PositionView[]> {
    const positions = await this.dependencies.store.listOpenPositions();
    try {
      const refreshed = await this.refreshPositions(positions);
      return refreshed.map((position) => this.positionView(position, true));
    } catch {
      return positions.map((position) => this.positionView(position, false));
    }
  }

  private async refreshPositions(existing?: LivePosition[]): Promise<LivePosition[]> {
    const [positions, remotePositions] = await Promise.all([
      existing ?? this.dependencies.store.listOpenPositions(),
      this.dependencies.gateway.positionRisk(),
    ]);
    const refreshed: LivePosition[] = [];
    for (const position of positions) {
      if (!this.dependencies.accountMode
        || position.accountModeFingerprint !== this.dependencies.accountMode.fingerprint) {
        throw new Error(`${position.symbol} 持仓 account mode fingerprint 与当前模式不一致`);
      }
      if (position.positionSide !== "LONG" && position.positionSide !== "SHORT") {
        throw new Error(`${position.symbol} 缺少持仓 positionSide 身份`);
      }
      const expectedPositionSide = this.dependencies.accountMode.dualSide ? position.positionSide : "BOTH";
      const matches = remotePositions.filter((candidate) => candidate.symbol === position.symbol
        && candidate.positionSide === expectedPositionSide && compareDecimals(candidate.positionAmt, "0") !== 0);
      if (matches.length !== 1) throw new Error(`${position.symbol} ${expectedPositionSide} 签名 positionSide 持仓缺失或不唯一`);
      const remote = matches[0];
      const expectedQuantity = position.side === "SHORT"
        ? `-${decimal(position.quantity)}` : decimal(position.quantity);
      if (compareDecimals(expectedQuantity, remote.positionAmt) !== 0) {
        throw new Error(`${position.symbol} 签名持仓数量与数据库不一致`);
      }
      const marginType = remote.marginType.toUpperCase();
      if (marginType !== "ISOLATED" && marginType !== "CROSS") throw new Error(`${position.symbol} marginType 无效`);
      const updated = await this.dependencies.store.updatePosition(position.id, {
        markPrice: remote.markPrice,
        liquidationPrice: remote.liquidationPrice,
        isolatedWallet: signedPositionInitialMargin(remote),
        marginType,
        liquidationPriceSource: "EXCHANGE",
      });
      if (!updated) throw new Error(`${position.symbol} 持仓更新失败`);
      refreshed.push(updated);
    }
    return refreshed;
  }

  async snapshot(): Promise<ExecutionSnapshot> {
    const [account, positions] = await Promise.all([
      this.account().catch(unavailableAccount),
      this.positions(),
    ]);
    return { account, positions };
  }

  async resetPaperSimulation(): Promise<never> {
    throw new Error("LIVE_MAINNET 禁止 paper reset");
  }

  private positionView(position: LivePosition, signedValuation: boolean): PositionView {
    const quantity = Number(position.quantity);
    const entryPrice = Number(position.entryPrice);
    const markPrice = signedValuation ? Number(position.markPrice) : 0;
    const direction = position.side === "LONG" ? 1 : -1;
    const unrealizedPnl = signedValuation ? direction * quantity * (markPrice - entryPrice) : 0;
    const margin = Number(position.isolatedWallet);
    const initialStop = position.initialStopPrice == null ? Number.NaN : Number(position.initialStopPrice);
    const initialRisk = Math.abs(Number(position.initialQuantity) * (entryPrice - initialStop));
    const targetPrice = entryPrice + direction * Math.abs(entryPrice - initialStop) * 2.2;
    const valuationValid = signedValuation && Number.isFinite(unrealizedPnl) && Number.isFinite(margin);
    return {
      id: position.id,
      signalId: position.signalId,
      strategyType: position.strategyType,
      breakoutPrice: position.breakoutPrice === null || position.breakoutPrice === undefined
        ? undefined : Number(position.breakoutPrice),
      exitPending: position.exitPending ?? false,
      symbol: position.symbol,
      side: position.side,
      positionSide: position.positionSide,
      marginType: position.marginType,
      entrySemantics: position.entrySemantics,
      effectiveLeverage: position.effectiveLeverage ?? null,
      maintenanceBracket: position.maintenanceBracket,
      maintMarginRatio: position.maintMarginRatio,
      cumMaintenance: position.cumMaintenance,
      accountModeFingerprint: position.accountModeFingerprint,
      compatibilityFrozen: position.compatibilityFrozen,
      qty: quantity,
      initialQty: Number(position.initialQuantity),
      entryPrice,
      markPrice,
      stopPrice: Number(position.stopPrice),
      targetPrice,
      liquidationPrice: Number(position.liquidationPrice),
      liquidationPriceSource: position.liquidationPriceSource,
      leverage: position.effectiveLeverage ?? Number(position.leverage),
      margin,
      unrealizedPnl,
      unrealizedPct: valuationValid && margin > 0 ? unrealizedPnl / margin * 100 : 0,
      realizedPnl: 0,
      openedAt: new Date(position.openedAt).toISOString(),
      holdingMinutes: Math.max(0, (this.now() - position.openedAt) / 60_000),
      rMultiple: valuationValid && initialRisk > 0 ? unrealizedPnl / initialRisk : 0,
      valuationValid,
    };
  }
}

export function createMainnetLiveExecutionAdapter(
  dependencies: Omit<
    MainnetLiveExecutionDependencies,
    "createIntent" | "claimIntent" | "pauseAutoTrade"
  > & {
    db: LiveDatabase;
    pauseAutoTrade?: MainnetLiveExecutionDependencies["pauseAutoTrade"];
  },
): MainnetLiveExecutionAdapter {
  return new MainnetLiveExecutionAdapter({
    ...dependencies,
    createIntent: (input, options) => createLiveIntent(dependencies.db, input, options),
    claimIntent: (input) => claimLiveIntent(dependencies.db, input),
    pauseAutoTrade: dependencies.pauseAutoTrade ?? (() => pauseLiveExecution(dependencies.db)),
  });
}
