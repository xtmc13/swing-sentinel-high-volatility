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
  type LiveOrderStore,
  type LivePosition,
  type LivePositionSeed,
} from "./orderStateMachine";
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
    if (order.type === "LIMIT" && !order.reduceOnly) {
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
          && candidate.type === "LIMIT" && !candidate.reduceOnly
          && candidate.clientOrderId !== `${order.intentId}-entry`).length;
      }
      if (attempts >= DEFAULT_MOMENTUM_CONFIG.maxReplacements) throw new Error("动量入场最多改单 1 次");
      this.replacementCounts.set(order.intentId, attempts + 1);
    }
    return this.machine.replaceOrder(clientOrderId, newLimitPrice);
  }

  async close(positionId: string, reason = "人工平仓"): Promise<CloseExecutionResult> {
    const order = await this.machine.closePosition(positionId);
    if (!order) {
      return { ok: false, reason: "真实持仓不存在或已关闭", unsettled: false, alreadyClosed: true, pnl: undefined };
    }
    if (order.status === "UNKNOWN") {
      return { ok: false, reason: "reduceOnly 平仓结果 UNKNOWN，必须先对账", unsettled: true, alreadyClosed: false };
    }
    return { ok: true, reason: `${reason}：reduceOnly 已提交，等待实际成交`, pnl: Number.NaN, unsettled: true, alreadyClosed: false };
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
      if (!position.tickSize) throw new Error(`${position.symbol} 缺少持久化 tickSize`);
      const stopPrice = normalizeDirectionalPrice(
        String(management.stopPrice), position.tickSize, position.side,
      );
      await this.updateTrailingProtection(position, stopPrice);
    }
  }

  private async updateTrailingProtection(position: LivePosition, stopPrice: DecimalString): Promise<void> {
    try {
      let protection = (await this.dependencies.store.listActiveProtectionOrders())
        .find((order) => order.intentId === position.id);
      if (!protection) await this.machine.protectPosition(position.id);
      protection = (await this.dependencies.store.listActiveProtectionOrders())
        .find((order) => order.intentId === position.id);
      if (!protection || protection.status !== "NEW") throw new Error("现有 STOP_MARKET 未确认");
      const replaced = await this.machine.replaceOrder(protection.clientOrderId, stopPrice);
      if (replaced.status !== "NEW" || !replaced.stopPrice
        || compareDecimals(replaced.stopPrice, stopPrice) !== 0) {
        throw new Error(`STOP_MARKET replacement 未确认（${replaced.status}）`);
      }
      const persisted = await this.dependencies.store.updatePosition(position.id, { stopPrice });
      if (!persisted) throw new Error("STOP_MARKET 已确认但持仓持久化失败");
    } catch (error) {
      this.dependencies.alert?.(
        `${position.symbol} 移动止损未一致确认，保留原持久止损并尝试 reduceOnly 退出：${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        const exit = await this.machine.closePosition(position.id);
        if (!exit || exit.status === "UNKNOWN") {
          this.dependencies.alert?.(`${position.symbol} 移动止损失败后的 reduceOnly 退出仍未确认`);
        }
      } catch (exitError) {
        this.dependencies.alert?.(
          `${position.symbol} reduceOnly 退出提交失败：${exitError instanceof Error ? exitError.message : String(exitError)}`,
        );
      }
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
    const asset = response.assets.find((candidate) => candidate.asset === "USDT");
    if (!asset) throw new Error("签名账户缺少 USDT 余额");
    if (!settings || !this.dependencies.dailyRisk) throw new Error("LIVE 日损状态存储未配置");
    const active = remotePositions.filter((position) => compareDecimals(position.positionAmt, "0") !== 0);
    let unrealizedPnl: DecimalString = "0";
    let usedMargin: DecimalString = "0";
    for (const position of active) {
      unrealizedPnl = addDecimals(unrealizedPnl, multiplyDecimals(
        position.positionAmt, subtractDecimals(position.markPrice, position.entryPrice),
      ));
      if (position.isolatedWallet === undefined) throw new Error(`${position.symbol} 缺少签名 isolated margin`);
      usedMargin = addDecimals(usedMargin, position.isolatedWallet);
    }
    const equity = Number(addDecimals(asset.walletBalance, unrealizedPnl));
    const availableMargin = Number(asset.availableBalance);
    const cash = Number(asset.walletBalance);
    const unrealized = Number(unrealizedPnl);
    const margin = Number(usedMargin);
    if (![equity, availableMargin, cash, unrealized, margin].every(Number.isFinite)) {
      throw new Error("签名账户或持仓估值无效");
    }
    const dayKey = new Date(this.now()).toISOString().slice(0, 10);
    const daily = await this.dependencies.dailyRisk.evaluate(dayKey, equity, settings.dailyLossLimitPct);
    const dayStartedAt = Date.parse(`${dayKey}T00:00:00.000Z`);
    const realizedPnl = ledger.filter((entry) => entry.asset === "USDT" && entry.occurredAt >= dayStartedAt
      && ["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"].includes(entry.entryType))
      .reduce((total, entry) => total + (entry.entryType === "COMMISSION"
        ? -Math.abs(Number(entry.amount)) : Number(entry.amount)), 0);
    return {
      equity,
      cash,
      availableMargin,
      usedMargin: margin,
      unrealizedPnl: unrealized,
      realizedPnl,
      todayPnl: equity - daily.dayStartEquity,
      todayPnlPct: (equity - daily.dayStartEquity) / daily.dayStartEquity * 100,
      dayStartEquity: daily.dayStartEquity,
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
      const remote = remotePositions.find((candidate) => candidate.symbol === position.symbol
        && compareDecimals(candidate.positionAmt, "0") !== 0);
      if (!remote) throw new Error(`${position.symbol} 缺少签名持仓标记`);
      const expectedQuantity = position.side === "SHORT"
        ? `-${decimal(position.quantity)}` : decimal(position.quantity);
      if (compareDecimals(expectedQuantity, remote.positionAmt) !== 0) {
        throw new Error(`${position.symbol} 签名持仓数量与数据库不一致`);
      }
      if (remote.isolatedWallet === undefined) throw new Error(`${position.symbol} 缺少签名 isolated margin`);
      const updated = await this.dependencies.store.updatePosition(position.id, {
        markPrice: remote.markPrice,
        liquidationPrice: remote.liquidationPrice,
        isolatedWallet: remote.isolatedWallet,
      });
      if (!updated) throw new Error(`${position.symbol} 持仓更新失败`);
      refreshed.push(updated);
    }
    return refreshed;
  }

  async snapshot(): Promise<ExecutionSnapshot> {
    const [account, positions] = await Promise.all([
      this.account().catch((): AccountSnapshot => ({
        equity: Number.NaN,
        cash: Number.NaN,
        availableMargin: Number.NaN,
        usedMargin: Number.NaN,
        unrealizedPnl: Number.NaN,
        realizedPnl: Number.NaN,
        todayPnl: Number.NaN,
        todayPnlPct: Number.NaN,
        dayStartEquity: Number.NaN,
        valuationValid: false,
        valuationIssues: ["签名 LIVE 账户或持仓估值不可用"],
        dailyLocked: true,
      })),
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
    const markPrice = signedValuation ? Number(position.markPrice) : Number.NaN;
    const direction = position.side === "LONG" ? 1 : -1;
    const unrealizedPnl = signedValuation ? direction * quantity * (markPrice - entryPrice) : Number.NaN;
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
      qty: quantity,
      initialQty: Number(position.initialQuantity),
      entryPrice,
      markPrice,
      stopPrice: Number(position.stopPrice),
      targetPrice,
      liquidationPrice: Number(position.liquidationPrice),
      leverage: Number(position.leverage),
      margin,
      unrealizedPnl,
      unrealizedPct: valuationValid && margin > 0 ? unrealizedPnl / margin * 100 : Number.NaN,
      realizedPnl: Number.NaN,
      openedAt: new Date(position.openedAt).toISOString(),
      holdingMinutes: Math.max(0, (this.now() - position.openedAt) / 60_000),
      rMultiple: valuationValid && initialRisk > 0 ? unrealizedPnl / initialRisk : Number.NaN,
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
