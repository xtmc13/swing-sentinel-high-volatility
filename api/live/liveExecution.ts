import type { AccountSnapshot, Opportunity, PositionView } from "@contracts/trading";
import { DEFAULT_MOMENTUM_CONFIG } from "../services/momentum";
import type { BinanceAccountResponse, LiveOrderGateway } from "./binanceSigned";
import { withFullUserTradePagination } from "./accounting";
import { divideDecimals, multiplyDecimals, subtractDecimals, type DecimalString } from "./decimal";
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
  gateway: LiveOrderGateway & { account(): Promise<BinanceAccountResponse> };
  userTradesPageLimit?: number;
  workerId: string;
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

export class MainnetLiveExecutionAdapter implements ExecutionAdapter {
  readonly machine: OrderStateMachine;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly replacementCounts = new Map<string, number>();

  constructor(private readonly dependencies: MainnetLiveExecutionDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? (() => crypto.randomUUID());
    this.machine = new OrderStateMachine(
      dependencies.store,
      withFullUserTradePagination(dependencies.gateway, dependencies.userTradesPageLimit),
      { alert: dependencies.alert, id: this.id },
    );
  }

  async open(opportunity: Opportunity, executionHealthy?: () => boolean): Promise<OpenExecutionResult> {
    return serializeOpenAndEmergency(() => this.openWhenSerialized(opportunity, executionHealthy));
  }

  private async openWhenSerialized(opportunity: Opportunity, executionHealthy?: () => boolean): Promise<OpenExecutionResult> {
    if (executionHealthy && !executionHealthy()) return { ok: false, reason: "实时执行健康检查未通过" };
    const input: CreateLiveIntentInput = {
      ...this.dependencies.prepareIntent(opportunity),
      id: this.id(),
      workerId: this.dependencies.workerId,
    };
    const approvals: Extract<LiveFinalGateResult, { approved: true }>[] = [];
    const created = await this.dependencies.createIntent(input, {
      requireAutoTrade: true,
      finalGate: async (tx) => {
        const approval = await this.dependencies.finalGate(opportunity, input, tx);
        if (approval.approved) approvals.push(approval);
        return approval;
      },
    });
    if (!created.ok) return { ok: false, reason: created.reason };
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
      stopPrice: null,
      originalQuantity: approval.quantity,
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      reduceOnly: false,
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

  handleFill(clientOrderId: string, fill: LiveFill, seed: LivePositionSeed) {
    return this.machine.handleFill(clientOrderId, fill, seed);
  }

  recover(clientOrderId: string, seed: LivePositionSeed) {
    return this.machine.recover(clientOrderId, seed);
  }

  async replaceOrder(clientOrderId: string, newLimitPrice: DecimalString) {
    const order = await this.dependencies.store.getOrder(clientOrderId);
    if (!order) throw new Error("Live order not found");
    if (order.type === "LIMIT" && !order.reduceOnly) {
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
    return undefined;
  }

  async emergency(): Promise<EmergencyExecutionResult> {
    return serializeOpenAndEmergency(async () => {
      await this.dependencies.pauseAutoTrade();
      const result = await this.machine.emergency();
      return { ok: result.unsettled.length === 0, paused: true, settled: [], unsettled: result.unsettled };
    });
  }

  async account(): Promise<AccountSnapshot> {
    const response = await this.dependencies.gateway.account();
    const asset = response.assets.find((candidate) => candidate.asset === "USDT");
    if (!asset) throw new Error("签名账户缺少 USDT 余额");
    const equity = Number(asset.walletBalance);
    const availableMargin = Number(asset.availableBalance);
    if (!Number.isFinite(equity) || !Number.isFinite(availableMargin)) throw new Error("签名账户余额无效");
    return {
      equity,
      cash: equity,
      availableMargin,
      usedMargin: Math.max(0, equity - availableMargin),
      unrealizedPnl: 0,
      realizedPnl: 0,
      todayPnl: 0,
      todayPnlPct: 0,
      dayStartEquity: equity,
      valuationValid: true,
      valuationIssues: [],
      dailyLocked: false,
    };
  }

  async positions(): Promise<PositionView[]> {
    const positions = await this.dependencies.store.listOpenPositions();
    return positions.map((position) => this.positionView(position));
  }

  async snapshot(): Promise<ExecutionSnapshot> {
    const [account, positions] = await Promise.all([this.account(), this.positions()]);
    return { account, positions };
  }

  async resetPaperSimulation(): Promise<never> {
    throw new Error("LIVE_MAINNET 禁止 paper reset");
  }

  private positionView(position: LivePosition): PositionView {
    const quantity = Number(position.quantity);
    const entryPrice = Number(position.entryPrice);
    const markPrice = Number(position.markPrice);
    const direction = position.side === "LONG" ? 1 : -1;
    const unrealizedPnl = direction * quantity * (markPrice - entryPrice);
    const margin = Number(divideDecimals(
      multiplyDecimals(position.quantity, position.entryPrice),
      position.leverage,
      { decimalPlaces: 30, roundingMode: "ROUND_DOWN" },
    ));
    const stopDistance = Number(subtractDecimals(entryPrice.toString(), position.stopPrice));
    const initialRisk = Math.abs(Number(position.initialQuantity) * stopDistance);
    return {
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      qty: quantity,
      initialQty: Number(position.initialQuantity),
      entryPrice,
      markPrice,
      stopPrice: Number(position.stopPrice),
      targetPrice: 0,
      liquidationPrice: Number(position.liquidationPrice),
      leverage: Number(position.leverage),
      margin,
      unrealizedPnl,
      unrealizedPct: margin > 0 ? unrealizedPnl / margin * 100 : 0,
      realizedPnl: 0,
      openedAt: new Date(position.openedAt).toISOString(),
      holdingMinutes: Math.max(0, (this.now() - position.openedAt) / 60_000),
      rMultiple: initialRisk > 0 ? unrealizedPnl / initialRisk : 0,
      valuationValid: Number.isFinite(unrealizedPnl),
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
