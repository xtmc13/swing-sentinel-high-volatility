import type {
  EntrySemantics,
  LiquidationPriceSource,
  MarginType,
  PositionSide,
  Side,
  StrategyType,
} from "@contracts/trading";
import type { AssertCurrentLiveAdmission } from "./liveConfig";
import { liveSubmissionPermitted } from "./livePersistence";
import { buildOrderWire, type OrderWireAccountMode } from "./orderWire";
import type {
  BinanceOpenOrder,
  LiveOrderGateway,
  PlaceOrderRequest,
} from "./binanceSigned";
import {
  addDecimals,
  compareDecimals,
  decimal,
  divideDecimals,
  multiplyDecimals,
  subtractDecimals,
  type DecimalString,
} from "./decimal";

export type LiveOrderStatus =
  | "PENDING_SEND"
  | "SUBMITTING"
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL"
  | "REPLACE"
  | "UNKNOWN"
  | "RECONCILING";

export interface LiveOrder {
  id: string;
  intentId: string;
  clientOrderId: string;
  exchangeOrderId: string | null;
  symbol: string;
  side: Side;
  positionSide?: PositionSide | null;
  marginType?: MarginType | null;
  entrySemantics?: EntrySemantics | null;
  effectiveLeverage?: number | null;
  maintenanceBracket?: number | null;
  maintMarginRatio?: DecimalString | null;
  cumMaintenance?: DecimalString | null;
  notionalCap?: DecimalString | null;
  notionalFloor?: DecimalString | null;
  initialLeverage?: number | null;
  liquidationPriceSource?: LiquidationPriceSource | null;
  accountModeFingerprint?: string | null;
  compatibilityFrozen?: boolean;
  type: "LIMIT" | "MARKET" | "STOP_MARKET";
  status: LiveOrderStatus;
  price: DecimalString;
  maxEntryPrice?: DecimalString | null;
  stopPrice: DecimalString | null;
  originalQuantity: DecimalString;
  executedQuantity: DecimalString;
  averagePrice: DecimalString;
  commission: DecimalString;
  reduceOnly: boolean;
  manualCanary?: boolean;
  admissionGeneration?: number;
  createdAt: number;
}

export interface LivePositionSeed {
  id: string;
  signalId?: string;
  strategyType?: StrategyType;
  breakoutPrice?: DecimalString | null;
  exitPending?: boolean;
  symbol: string;
  side: Side;
  positionSide?: PositionSide | null;
  marginType?: MarginType | null;
  entrySemantics?: EntrySemantics | null;
  effectiveLeverage?: number | null;
  liquidationPriceSource?: LiquidationPriceSource | null;
  accountModeFingerprint?: string | null;
  compatibilityFrozen?: boolean;
  stopPrice: DecimalString;
  initialStopPrice?: DecimalString | null;
  tickSize?: DecimalString | null;
  liquidationPrice: DecimalString;
  leverage: DecimalString;
  maintenanceBracket: number;
  maintMarginRatio: DecimalString;
  cumMaintenance: DecimalString;
}

export interface LivePosition extends LivePositionSeed {
  status: "OPEN" | "CLOSED";
  initialQuantity: DecimalString;
  quantity: DecimalString;
  entryPrice: DecimalString;
  markPrice: DecimalString;
  isolatedWallet: DecimalString;
  openedAt: number;
  closedAt: number | null;
}

export interface LiveFill {
  exchangeTradeId: string;
  exchangeOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide?: PositionSide | "BOTH";
  price: DecimalString;
  quantity: DecimalString;
  commission: DecimalString;
  commissionAsset: string;
  realizedPnl: DecimalString;
  isMaker: boolean;
  executedAt: number;
}

export interface FillApplication {
  order: LiveOrder;
  position: LivePosition | null;
  inserted: boolean;
  unresolved?: string[];
}

export type LivePositionUpdate = Partial<Pick<LivePosition,
  "markPrice" | "liquidationPrice" | "isolatedWallet" | "stopPrice" | "exitPending"
  | "marginType" | "liquidationPriceSource" | "compatibilityFrozen">>;

export interface LiveOrderStore {
  insertOrder(order: LiveOrder): Promise<void>;
  getOrder(clientOrderId: string): Promise<LiveOrder | null>;
  listOrders(): Promise<LiveOrder[]>;
  listRecentOrders(limit: number): Promise<LiveOrder[]>;
  listActiveProtectionOrders(): Promise<LiveOrder[]>;
  transitionOrder(
    clientOrderId: string,
    expectedStatuses: LiveOrderStatus[],
    patch: Partial<LiveOrder>,
  ): Promise<LiveOrder | null>;
  transitionOrderQuantity(
    clientOrderId: string,
    expectedQuantity: DecimalString,
    quantity: DecimalString,
  ): Promise<LiveOrder | null>;
  createReplacement(
    parentClientOrderId: string,
    expectedExecutedQuantity: DecimalString,
    replacement: LiveOrder,
    expectedPositionQuantity?: DecimalString,
  ): Promise<LiveOrder | null>;
  admitOrder(
    clientOrderId: string,
    expectedGeneration: number,
    assertCurrentAdmission: AssertCurrentLiveAdmission,
  ): Promise<LiveOrder>;
  freezeCompatibility(intentIds: string[]): Promise<void>;
  applyFill(orderId: string, fill: LiveFill, seed: LivePositionSeed): Promise<FillApplication>;
  getPosition(positionId: string): Promise<LivePosition | null>;
  updatePosition(positionId: string, patch: LivePositionUpdate): Promise<LivePosition | null>;
  listOpenPositions(): Promise<LivePosition[]>;
}

const WORKING_STATUSES = new Set<LiveOrderStatus>([
  "PENDING_SEND", "SUBMITTING", "NEW", "PARTIALLY_FILLED", "REPLACE", "UNKNOWN", "RECONCILING",
]);
const EXACT_AVERAGE = { decimalPlaces: 30, roundingMode: "ROUND_HALF_UP" } as const;
const POSITION_LOCKS = new WeakMap<LiveOrderStore, Map<string, Promise<void>>>();

function copyOrder(order: LiveOrder): LiveOrder {
  return { ...order };
}

function copyPosition(position: LivePosition | null): LivePosition | null {
  return position ? { ...position } : null;
}

function isReduceOrder(order: LiveOrder): boolean {
  if (order.entrySemantics === "REDUCE") return true;
  if (order.entrySemantics === "ENTRY") return false;
  throw new Error("Order entrySemantics is required");
}

function assertNotCompatibilityFrozen(record: { compatibilityFrozen?: boolean }): void {
  if (record.compatibilityFrozen) throw new Error("Legacy compatibility record is frozen");
}

export function applyNewFill(
  currentOrder: LiveOrder,
  currentPosition: LivePosition | null,
  fill: LiveFill,
  seed: LivePositionSeed,
): { order: LiveOrder; position: LivePosition } {
  if (seed.id !== currentOrder.intentId || seed.symbol !== currentOrder.symbol || seed.side !== currentOrder.side
    || seed.positionSide !== currentOrder.positionSide
    || seed.accountModeFingerprint !== currentOrder.accountModeFingerprint) {
    throw new Error("Fill intent ownership mismatch");
  }
  if (fill.symbol !== currentOrder.symbol) throw new Error("Fill symbol mismatch");
  if (currentOrder.exchangeOrderId !== null && fill.exchangeOrderId !== currentOrder.exchangeOrderId) {
    throw new Error("Fill exchange order mismatch");
  }
  const reducing = isReduceOrder(currentOrder);
  if (currentOrder.positionSide !== "LONG" && currentOrder.positionSide !== "SHORT") {
    throw new Error("Order positionSide is required");
  }
  const expectedSide = (reducing ? currentOrder.positionSide === "SHORT" : currentOrder.positionSide === "LONG")
    ? "BUY" : "SELL";
  if (fill.side !== expectedSide) throw new Error("Fill side mismatch");
  if (fill.commissionAsset !== "USDT") throw new Error("Non-USDT commission requires reconciliation");
  if (compareDecimals(fill.quantity, "0") <= 0 || compareDecimals(fill.price, "0") <= 0) {
    throw new Error("Fill price and quantity must be positive");
  }
  const executedQuantity = addDecimals(currentOrder.executedQuantity, fill.quantity);
  if (compareDecimals(executedQuantity, currentOrder.originalQuantity) > 0) {
    throw new Error("Fill exceeds remaining order quantity");
  }
  const previousQuote = multiplyDecimals(currentOrder.averagePrice, currentOrder.executedQuantity);
  const fillQuote = multiplyDecimals(fill.price, fill.quantity);
  const averagePrice = divideDecimals(addDecimals(previousQuote, fillQuote), executedQuantity, EXACT_AVERAGE);
  const order: LiveOrder = {
    ...currentOrder,
    exchangeOrderId: currentOrder.exchangeOrderId ?? fill.exchangeOrderId,
    status: currentOrder.status === "CANCEL" ? "CANCEL"
      : compareDecimals(executedQuantity, currentOrder.originalQuantity) === 0 ? "FILLED" : "PARTIALLY_FILLED",
    executedQuantity,
    averagePrice,
    commission: addDecimals(currentOrder.commission, fill.commission),
  };

  if (reducing) {
    if (!currentPosition || currentPosition.status !== "OPEN") throw new Error("Reduce fill has no open position");
    const quantity = subtractDecimals(currentPosition.quantity, fill.quantity);
    if (compareDecimals(quantity, "0") < 0) throw new Error("Reduce fill exceeds live position");
    return {
      order,
      position: {
        ...currentPosition,
        quantity,
        markPrice: fill.price,
        status: compareDecimals(quantity, "0") === 0 ? "CLOSED" : "OPEN",
        closedAt: compareDecimals(quantity, "0") === 0 ? fill.executedAt : null,
      },
    };
  }

  const position = currentPosition ?? {
    ...seed,
    initialStopPrice: seed.initialStopPrice ?? seed.stopPrice,
    status: "OPEN" as const,
    initialQuantity: "0",
    quantity: "0",
    entryPrice: "0",
    markPrice: fill.price,
    isolatedWallet: "0",
    openedAt: fill.executedAt,
    closedAt: null,
  };
  if (position.status !== "OPEN") throw new Error("Entry fill cannot reopen a closed live position");
  const quantity = addDecimals(position.quantity, fill.quantity);
  const oldQuote = multiplyDecimals(position.entryPrice, position.quantity);
  const entryPrice = divideDecimals(addDecimals(oldQuote, fillQuote), quantity, EXACT_AVERAGE);
  return {
    order,
    position: {
      ...position,
      initialQuantity: addDecimals(position.initialQuantity, fill.quantity),
      quantity,
      entryPrice,
      markPrice: fill.price,
      openedAt: Math.min(position.openedAt, fill.executedAt),
    },
  };
}

export class InMemoryLiveOrderStore implements LiveOrderStore {
  private readonly orders = new Map<string, LiveOrder>();
  private readonly fills = new Map<string, LiveFill[]>();
  private readonly positions = new Map<string, LivePosition>();
  private emergencyGeneration: number;
  private autoTrade: boolean;
  private armed: boolean;

  constructor(options: { emergencyGeneration?: number; autoTrade?: boolean; armed?: boolean } = {}) {
    this.emergencyGeneration = options.emergencyGeneration ?? 0;
    this.autoTrade = options.autoTrade ?? true;
    this.armed = options.armed ?? true;
  }

  pauseExecution(): void {
    this.emergencyGeneration += 1;
    this.autoTrade = false;
    this.armed = false;
    for (const [clientOrderId, order] of this.orders) {
      if (["PENDING_SEND", "SUBMITTING"].includes(order.status)) {
        this.orders.set(clientOrderId, { ...order, status: "CANCEL" });
      }
    }
  }

  addOrder(order: LiveOrder): void {
    if (this.orders.has(order.clientOrderId)) throw new Error("Duplicate clientOrderId");
    this.orders.set(order.clientOrderId, copyOrder(order));
  }

  async insertOrder(order: LiveOrder): Promise<void> {
    this.addOrder(order);
  }

  async getOrder(clientOrderId: string): Promise<LiveOrder | null> {
    const order = this.orders.get(clientOrderId);
    return order ? copyOrder(order) : null;
  }

  async listOrders(): Promise<LiveOrder[]> {
    return [...this.orders.values()].map(copyOrder);
  }

  async listRecentOrders(limit: number): Promise<LiveOrder[]> {
    return [...this.orders.values()].sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit).map(copyOrder);
  }

  async listActiveProtectionOrders(): Promise<LiveOrder[]> {
    return [...this.orders.values()].filter((order) => order.type === "STOP_MARKET"
      && order.entrySemantics === "REDUCE" && ["NEW", "PARTIALLY_FILLED"].includes(order.status)).map(copyOrder);
  }

  async transitionOrder(
    clientOrderId: string,
    expectedStatuses: LiveOrderStatus[],
    patch: Partial<LiveOrder>,
  ): Promise<LiveOrder | null> {
    const current = this.orders.get(clientOrderId);
    if (!current || !expectedStatuses.includes(current.status)) return null;
    const next = { ...current, ...patch, clientOrderId: current.clientOrderId };
    this.orders.set(clientOrderId, next);
    return copyOrder(next);
  }

  async transitionOrderQuantity(
    clientOrderId: string,
    expectedQuantity: DecimalString,
    quantity: DecimalString,
  ): Promise<LiveOrder | null> {
    const current = this.orders.get(clientOrderId);
    if (!current || current.status !== "SUBMITTING" || current.exchangeOrderId !== null
      || compareDecimals(current.originalQuantity, expectedQuantity) !== 0) return null;
    const next = { ...current, originalQuantity: quantity };
    this.orders.set(clientOrderId, next);
    return copyOrder(next);
  }

  async createReplacement(
    parentClientOrderId: string,
    expectedExecutedQuantity: DecimalString,
    replacement: LiveOrder,
    expectedPositionQuantity?: DecimalString,
  ): Promise<LiveOrder | null> {
    const parent = this.orders.get(parentClientOrderId);
    if (!parent || parent.status !== "CANCEL"
      || compareDecimals(parent.executedQuantity, expectedExecutedQuantity) !== 0
      || this.orders.has(replacement.clientOrderId)) return null;
    if (expectedPositionQuantity !== undefined) {
      const position = this.positions.get(parent.intentId);
      if (!position || compareDecimals(position.quantity, expectedPositionQuantity) !== 0) return null;
    }
    this.orders.set(parentClientOrderId, { ...parent, status: "CANCEL" });
    this.orders.set(replacement.clientOrderId, copyOrder(replacement));
    return copyOrder(replacement);
  }

  async admitOrder(
    clientOrderId: string,
    expectedGeneration: number,
    assertCurrentAdmission: AssertCurrentLiveAdmission,
  ): Promise<LiveOrder> {
    const order = this.orders.get(clientOrderId);
    if (!order) throw new Error("Live order not found");
    if (!["PENDING_SEND", "SUBMITTING"].includes(order.status)) return copyOrder(order);
    assertNotCompatibilityFrozen(order);
    const permitted = () => liveSubmissionPermitted({
      armed: this.armed,
      executionMode: "LIVE_MAINNET",
      autoTrade: this.autoTrade,
      manualCanary: order.manualCanary ?? false,
      generation: this.emergencyGeneration,
      expectedGeneration,
      intentStatus: this.orders.get(clientOrderId)?.status ?? "MISSING",
    });
    if (!permitted()) {
      const cancelled = { ...order, status: "CANCEL" as const };
      this.orders.set(clientOrderId, cancelled);
      return copyOrder(cancelled);
    }
    let authorized = true;
    try {
      await assertCurrentAdmission();
    } catch {
      authorized = false;
    }
    const current = this.orders.get(clientOrderId) ?? order;
    assertNotCompatibilityFrozen(current);
    if (!authorized || !permitted()) {
      const cancelled = { ...current, status: "CANCEL" as const };
      this.orders.set(clientOrderId, cancelled);
      return copyOrder(cancelled);
    }
    if (order.status === "SUBMITTING") return copyOrder(order);
    const submitting = { ...order, status: "SUBMITTING" as const };
    this.orders.set(clientOrderId, submitting);
    return copyOrder(submitting);
  }

  async freezeCompatibility(intentIds: string[]): Promise<void> {
    const ids = new Set(intentIds);
    for (const [clientOrderId, order] of this.orders) {
      if (ids.has(order.intentId)) this.orders.set(clientOrderId, { ...order, compatibilityFrozen: true });
    }
    for (const [positionId, position] of this.positions) {
      if (ids.has(positionId)) this.positions.set(positionId, { ...position, compatibilityFrozen: true });
    }
  }

  async applyFill(orderId: string, fill: LiveFill, seed: LivePositionSeed): Promise<FillApplication> {
    const order = [...this.orders.values()].find((candidate) => candidate.id === orderId);
    if (!order) throw new Error("Live order not found");
    const orderFills = this.fills.get(order.id) ?? [];
    if (orderFills.some((candidate) => candidate.exchangeTradeId === fill.exchangeTradeId
      && candidate.symbol === fill.symbol)) {
      return { order: copyOrder(order), position: copyPosition(this.positions.get(seed.id) ?? null), inserted: false };
    }
    const currentPosition = this.positions.get(seed.id) ?? null;
    const next = applyNewFill(order, currentPosition, fill, seed);
    this.fills.set(order.id, [...orderFills, { ...fill }]);
    this.orders.set(order.clientOrderId, next.order);
    this.positions.set(seed.id, next.position);
    return { order: copyOrder(next.order), position: copyPosition(next.position), inserted: true };
  }

  async getPosition(positionId: string): Promise<LivePosition | null> {
    return copyPosition(this.positions.get(positionId) ?? null);
  }

  async updatePosition(positionId: string, patch: LivePositionUpdate): Promise<LivePosition | null> {
    const current = this.positions.get(positionId);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.positions.set(positionId, updated);
    return copyPosition(updated);
  }

  async listOpenPositions(): Promise<LivePosition[]> {
    return [...this.positions.values()].filter((position) => position.status === "OPEN").map((position) => ({ ...position }));
  }
}

export interface OrderStateMachineOptions {
  alert?: (message: string) => unknown;
  id?: () => string;
  assertCurrentAdmission?: AssertCurrentLiveAdmission;
  assertOrderAdmission?: (order: LiveOrder) => Promise<void>;
  accountMode?: OrderWireAccountMode;
}

export async function serializeLivePositionOperation<T>(
  store: LiveOrderStore,
  positionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let locks = POSITION_LOCKS.get(store);
  if (!locks) {
    locks = new Map<string, Promise<void>>();
    POSITION_LOCKS.set(store, locks);
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

export class OrderStateMachine {
  private readonly store: LiveOrderStore;
  private readonly gateway: LiveOrderGateway;
  private readonly alert: (message: string) => unknown;
  private readonly id: () => string;
  private readonly assertCurrentAdmission?: AssertCurrentLiveAdmission;
  private readonly assertOrderAdmission?: (order: LiveOrder) => Promise<void>;
  private readonly accountMode?: OrderWireAccountMode;

  constructor(
    store: LiveOrderStore,
    gateway: LiveOrderGateway,
    options: OrderStateMachineOptions = {},
  ) {
    this.store = store;
    this.gateway = gateway;
    this.alert = options.alert ?? (() => undefined);
    this.id = options.id ?? (() => crypto.randomUUID());
    this.assertCurrentAdmission = options.assertCurrentAdmission;
    this.assertOrderAdmission = options.assertOrderAdmission;
    this.accountMode = options.accountMode;
  }

  async createOrder(order: LiveOrder): Promise<LiveOrder> {
    await this.store.insertOrder(order);
    return order;
  }

  async submit(
    clientOrderId: string,
    expectedGeneration?: number,
    assertOrderAdmission?: (order: LiveOrder) => Promise<void>,
  ): Promise<LiveOrder> {
    const order = await this.requireOrder(clientOrderId);
    if (order.status !== "PENDING_SEND") return order;
    assertNotCompatibilityFrozen(order);
    if (expectedGeneration !== undefined && !this.assertCurrentAdmission) {
      return await this.store.transitionOrder(clientOrderId, ["PENDING_SEND"], { status: "CANCEL" }) ?? order;
    }
    const submitting = expectedGeneration === undefined
      ? await this.store.transitionOrder(clientOrderId, ["PENDING_SEND"], { status: "SUBMITTING" })
      : await this.store.admitOrder(clientOrderId, expectedGeneration, this.assertCurrentAdmission!);
    if (!submitting || submitting.status !== "SUBMITTING") return submitting ?? this.requireOrder(clientOrderId);
    const admissionState = await this.requireOrder(clientOrderId);
    if (admissionState.status !== "SUBMITTING") return admissionState;
    assertNotCompatibilityFrozen(admissionState);
    const admissionAssertion = assertOrderAdmission
      ?? (expectedGeneration === undefined ? undefined : this.assertOrderAdmission);
    if (admissionAssertion) {
      try {
        await admissionAssertion(admissionState);
      } catch (error) {
        await this.alert(`${admissionState.clientOrderId} admission snapshot mismatch: ${
          error instanceof Error ? error.message : String(error)
        }`);
        return await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], { status: "CANCEL" })
          ?? this.requireOrder(clientOrderId);
      }
    }
    const finalAdmission = expectedGeneration === undefined ? admissionState
      : await this.store.admitOrder(clientOrderId, expectedGeneration, this.assertCurrentAdmission!);
    if (finalAdmission.status !== "SUBMITTING") return finalAdmission;
    assertNotCompatibilityFrozen(finalAdmission);
    if (admissionAssertion) {
      try {
        await admissionAssertion(finalAdmission);
      } catch (error) {
        await this.alert(`${finalAdmission.clientOrderId} admission snapshot mismatch: ${
          error instanceof Error ? error.message : String(error)
        }`);
        return await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], { status: "CANCEL" })
          ?? this.requireOrder(clientOrderId);
      }
    }
    let transportOrder = finalAdmission;
    if (this.accountMode?.dualSide && finalAdmission.entrySemantics === "REDUCE") {
      try {
        const quantity = await this.authoritativeReduceQuantity(finalAdmission);
        if (compareDecimals(quantity, "0") === 0) {
          const cancelled = await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], { status: "CANCEL" });
          if (!cancelled) return this.requireOrder(clientOrderId);
          await this.reconcileZeroTarget(finalAdmission);
          return cancelled;
        }
        const updated = await this.store.transitionOrderQuantity(
          clientOrderId, finalAdmission.originalQuantity, quantity,
        );
        if (!updated) return this.requireOrder(clientOrderId);
        if (compareDecimals(updated.originalQuantity, quantity) !== 0) {
          await this.alert(`${finalAdmission.clientOrderId} REDUCE quantity CAS returned ${updated.originalQuantity}, expected ${quantity}`);
          return await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], { status: "UNKNOWN" })
            ?? this.requireOrder(clientOrderId);
        }
        transportOrder = updated;
      } catch (error) {
        await this.alert(`${finalAdmission.symbol} ${finalAdmission.positionSide} REDUCE 数量复核失败：${
          error instanceof Error ? error.message : String(error)
        }`);
        return await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], { status: "UNKNOWN" })
          ?? this.requireOrder(clientOrderId);
      }
    }
    let acknowledgement: Partial<BinanceOpenOrder>;
    try {
      acknowledgement = await this.gateway.placeOrder(this.requestFor(transportOrder)) as Partial<BinanceOpenOrder>;
      if ((typeof acknowledgement.orderId !== "number" && typeof acknowledgement.orderId !== "string")
        || String(acknowledgement.orderId).length === 0) {
        throw new Error("Invalid order acknowledgement");
      }
    } catch {
      const unknown = await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], { status: "UNKNOWN" });
      return unknown ?? this.requireOrder(clientOrderId);
    }
    const updated = await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], {
      status: this.statusFromExchange(acknowledgement.status ?? "NEW"),
      exchangeOrderId: String(acknowledgement.orderId),
    });
    return updated ?? this.requireOrder(clientOrderId);
  }

  private async serializePosition<T>(positionId: string, operation: () => Promise<T>): Promise<T> {
    return serializeLivePositionOperation(this.store, positionId, operation);
  }

  private async applyFillAndProtect(clientOrderId: string, fill: LiveFill, seed: LivePositionSeed): Promise<FillApplication> {
    const order = await this.requireOrder(clientOrderId);
    if (!this.accountMode || order.accountModeFingerprint !== this.accountMode.fingerprint) {
      throw new Error("Fill account mode fingerprint mismatch");
    }
    const expectedPositionSide = this.accountMode.dualSide ? order.positionSide : "BOTH";
    if (!expectedPositionSide || fill.positionSide !== expectedPositionSide) {
      throw new Error("Fill positionSide mismatch");
    }
    const result = await this.store.applyFill(order.id, fill, seed);
    const unresolved: string[] = [];
    if (result.inserted && order.status === "CANCEL") {
      const issue = await this.invalidateReplacement(order);
      if (issue) unresolved.push(issue);
    }
    if (result.inserted && result.position?.status === "OPEN" && order.entrySemantics === "ENTRY") {
      await this.ensureProtection(result.position);
    }
    if (result.position?.status === "CLOSED" && order.entrySemantics === "REDUCE") {
      unresolved.push(...await this.cancelResidualProtection(result.position));
    }
    return unresolved.length > 0 ? { ...result, unresolved } : result;
  }

  private async reconcileZeroTarget(order: Pick<LiveOrder,
    "intentId" | "symbol" | "positionSide" | "accountModeFingerprint"
  >): Promise<void> {
    const position = await this.store.getPosition(order.intentId);
    if (!position || position.status !== "OPEN" || position.symbol !== order.symbol
      || position.positionSide !== order.positionSide
      || position.accountModeFingerprint !== order.accountModeFingerprint) {
      await this.alert(`${order.symbol} ${order.positionSide} remote position is zero; local identity requires reconciliation`);
      return;
    }
    const unresolved = await this.cancelResidualProtection(position);
    await this.alert(`${order.symbol} ${order.positionSide} remote position is zero; reconciliation remains unresolved${
      unresolved.length > 0 ? `: ${unresolved.join("；")}` : ""
    }`);
  }

  private async cancelResidualProtection(position: LivePosition): Promise<string[]> {
    const unresolved: string[] = [];
    const protections = (await this.store.listOrders()).filter((order) => this.protectionOwnedBy(position, order)
      && WORKING_STATUSES.has(order.status));
    for (const protection of protections) {
      try {
        if (protection.status === "PENDING_SEND") {
          const cancelled = await this.store.transitionOrder(protection.clientOrderId, ["PENDING_SEND"], { status: "CANCEL" });
          if (!cancelled) throw new Error("protection state changed during cleanup");
          continue;
        }
        await this.gateway.cancelOrder({ symbol: protection.symbol, origClientOrderId: protection.clientOrderId });
        const confirmed = await this.reconcile(protection);
        if (confirmed.status !== "CANCEL") throw new Error(`protection cancel remains ${confirmed.status}`);
      } catch (error) {
        const message = `${position.symbol} ${position.positionSide} 残留保护单 ${protection.clientOrderId} 清理失败：${
          error instanceof Error ? error.message : String(error)
        }`;
        await this.alert(message);
        unresolved.push(message);
      }
    }
    return unresolved;
  }

  private async invalidateReplacement(parent: LiveOrder): Promise<string | null> {
    let replacement = await this.store.getOrder(`replace-${parent.clientOrderId}`);
    while (replacement) {
      if (replacement.status === "CANCEL") return null;
      if (replacement.status === "FILLED") {
        return this.reportInvalidationIssue(parent, replacement, "父单 CANCEL 后 replacement 已成交");
      }
      if (replacement.status === "UNKNOWN") {
        return this.reportInvalidationIssue(parent, replacement, "cancel 无法确认，相关 replacement 已冻结为 UNKNOWN");
      }
      if (replacement.status === "PENDING_SEND") {
        const cancelled = await this.store.transitionOrder(replacement.clientOrderId, ["PENDING_SEND"], { status: "CANCEL" });
        replacement = cancelled ?? await this.requireOrder(replacement.clientOrderId);
        continue;
      }
      if (!WORKING_STATUSES.has(replacement.status)) {
        return this.reportInvalidationIssue(parent, replacement, `replacement 状态 ${replacement.status} 无法失效`);
      }
      const reconciling = await this.store.transitionOrder(replacement.clientOrderId, [replacement.status], {
        status: "RECONCILING",
      });
      replacement = reconciling ?? await this.requireOrder(replacement.clientOrderId);
      if (!reconciling) continue;
      try {
        await this.gateway.cancelOrder({ symbol: replacement.symbol, origClientOrderId: replacement.clientOrderId });
        replacement = await this.reconcile(replacement);
      } catch {
        replacement = await this.requireOrder(replacement.clientOrderId);
      }
      if (replacement.status === "CANCEL") return null;
      if (replacement.status === "FILLED") {
        return this.reportInvalidationIssue(parent, replacement, "父单 CANCEL 后 replacement 已成交");
      }
      if (replacement.status === "UNKNOWN") {
        return this.reportInvalidationIssue(parent, replacement, "cancel 无法确认，相关 replacement 已冻结为 UNKNOWN");
      }
      const latest = await this.requireOrder(replacement.clientOrderId);
      if (latest.status === "CANCEL") return null;
      if (latest.status === "FILLED") {
        return this.reportInvalidationIssue(parent, latest, "父单 CANCEL 后 replacement 已成交");
      }
      if (latest.status === "UNKNOWN") {
        return this.reportInvalidationIssue(parent, latest, "cancel 无法确认，相关 replacement 已冻结为 UNKNOWN");
      }
      const unknown = await this.store.transitionOrder(latest.clientOrderId, [latest.status], { status: "UNKNOWN" });
      replacement = unknown ?? await this.requireOrder(latest.clientOrderId);
    }
    return null;
  }

  private async reportInvalidationIssue(parent: LiveOrder, replacement: LiveOrder, detail: string): Promise<string> {
    const message = `${parent.symbol} replacement ${replacement.clientOrderId} 未解决：${detail}`;
    await this.alert(message);
    return message;
  }

  async handleFill(clientOrderId: string, fill: LiveFill, seed: LivePositionSeed): Promise<FillApplication> {
    return this.serializePosition(seed.id, () => this.applyFillAndProtect(clientOrderId, fill, seed));
  }

  async replaceOrder(clientOrderId: string, newLimitPrice: DecimalString): Promise<LiveOrder> {
    const order = await this.requireOrder(clientOrderId);
    return this.serializePosition(order.intentId, () => this.replace(order, { price: decimal(newLimitPrice) }));
  }

  async recover(clientOrderId: string, recoverySeed?: LivePositionSeed): Promise<LiveOrder> {
    const order = await this.requireOrder(clientOrderId);
    return this.serializePosition(order.intentId, () => this.reconcile(order, recoverySeed));
  }

  async protectPosition(positionId: string): Promise<void> {
    const position = await this.store.getPosition(positionId);
    if (!position || position.status !== "OPEN") return;
    this.assertPositionIdentity(position);
    return this.serializePosition(positionId, () => this.ensureProtection(position));
  }

  private async reconcile(order: LiveOrder, recoverySeed?: LivePositionSeed): Promise<LiveOrder> {
    if (order.status !== "RECONCILING") {
      const reconciling = await this.store.transitionOrder(order.clientOrderId, [order.status], { status: "RECONCILING" });
      if (!reconciling) throw new Error("Order changed before reconciliation");
    }
    let remote: BinanceOpenOrder | null;
    try {
      remote = await this.gateway.queryOrder({ symbol: order.symbol, origClientOrderId: order.clientOrderId });
    } catch {
      const unknown = await this.store.transitionOrder(order.clientOrderId, ["RECONCILING"], { status: "UNKNOWN" });
      if (!unknown) throw new Error("Order changed during failed reconciliation");
      return unknown;
    }
    if (!remote) return this.recoveryIssue(order, "remote order is missing");
    const identityIssue = this.recoveredIdentityIssue(order, remote);
    if (identityIssue) return this.recoveryIssue(order, identityIssue);
    const reconciled = await this.store.transitionOrder(order.clientOrderId, ["RECONCILING"], {
      exchangeOrderId: String(remote.orderId),
      status: "RECONCILING",
    });
    if (!reconciled) throw new Error("Order changed during reconciliation");
    let recoveredQuantity: DecimalString = "0";
    try {
      const trades = await this.gateway.userTrades({ symbol: order.symbol, limit: 1000 });
      for (const trade of trades.filter((candidate) => String(candidate.orderId) === String(remote.orderId))) {
        const position = await this.store.getPosition(order.intentId);
        const seed = position ?? recoverySeed;
        if (!seed) throw new Error("Position seed is required for recovered fills");
        recoveredQuantity = addDecimals(recoveredQuantity, trade.qty);
        await this.applyFillAndProtect(order.clientOrderId, {
          exchangeTradeId: String(trade.id),
          exchangeOrderId: String(trade.orderId),
          symbol: trade.symbol,
          side: trade.side === "SELL" ? "SELL" : "BUY",
          positionSide: trade.positionSide,
          price: trade.price,
          quantity: trade.qty,
          commission: trade.commission,
          commissionAsset: trade.commissionAsset,
          realizedPnl: trade.realizedPnl,
          isMaker: trade.maker,
          executedAt: trade.time,
        }, seed);
      }
    } catch (error) {
      return this.recoveryIssue(order, `trade recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const latest = await this.requireOrder(order.clientOrderId);
    if (compareDecimals(latest.executedQuantity, remote.executedQty) !== 0) {
      return this.recoveryIssue(order, `recovered executedQty ${latest.executedQuantity} != remote.executedQty ${remote.executedQty}`);
    }
    if (remote.status === "FILLED" && (compareDecimals(remote.executedQty, "0") <= 0
      || compareDecimals(latest.executedQuantity, latest.originalQuantity) !== 0
      || compareDecimals(recoveredQuantity, remote.executedQty) !== 0)) {
      return this.recoveryIssue(order, `positive FILLED lacks complete corresponding trades for remote.executedQty ${remote.executedQty}`);
    }
    const terminal = await this.store.transitionOrder(order.clientOrderId, [latest.status], {
      status: this.statusFromExchange(remote.status),
    });
    if (!terminal) throw new Error("Order changed while finishing reconciliation");
    return terminal;
  }

  private recoveredIdentityIssue(order: LiveOrder, remote: BinanceOpenOrder): string | null {
    try {
      const expected = this.requestFor(order);
      if (remote.clientOrderId !== order.clientOrderId || remote.symbol !== order.symbol
        || remote.side !== expected.side || remote.positionSide !== expected.positionSide
        || remote.type !== expected.type || compareDecimals(remote.origQty, order.originalQuantity) !== 0) {
        return "remote order identity, positionSide, type, side, or original quantity mismatch";
      }
      if (order.exchangeOrderId !== null && String(remote.orderId) !== order.exchangeOrderId) {
        return "remote exchange order identity mismatch";
      }
      if (expected.reduceOnly === true && remote.reduceOnly !== true) return "remote reduceOnly identity mismatch";
      if (expected.reduceOnly === undefined && remote.reduceOnly === true) {
        return "remote reduceOnly is forbidden when the expected wire omits it";
      }
      const executed = decimal(remote.executedQty);
      if (compareDecimals(executed, "0") < 0 || compareDecimals(executed, order.originalQuantity) > 0) {
        return "remote.executedQty is outside the persisted order quantity";
      }
      return null;
    } catch (error) {
      return `remote identity validation failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async recoveryIssue(order: LiveOrder, detail: string): Promise<LiveOrder> {
    await this.alert(`${order.symbol} ${order.positionSide} ${order.clientOrderId} recovery issue: ${detail}`);
    const latest = await this.requireOrder(order.clientOrderId);
    if (latest.status === "UNKNOWN") return latest;
    const unknown = await this.store.transitionOrder(order.clientOrderId, [latest.status], { status: "UNKNOWN" });
    if (!unknown) throw new Error("Order changed while recording recovery issue");
    return unknown;
  }

  private assertPositionIdentity(position: LivePosition): void {
    assertNotCompatibilityFrozen(position);
    if (!this.accountMode || position.accountModeFingerprint !== this.accountMode.fingerprint) {
      throw new Error("Position account mode fingerprint mismatch");
    }
    if (position.positionSide !== "LONG" && position.positionSide !== "SHORT") {
      throw new Error("Position positionSide is required");
    }
  }

  private protectionOwnedBy(position: LivePosition, order: LiveOrder): boolean {
    return order.intentId === position.id && order.symbol === position.symbol
      && order.positionSide === position.positionSide
      && order.accountModeFingerprint === position.accountModeFingerprint
      && order.entrySemantics === "REDUCE" && order.type === "STOP_MARKET";
  }

  private async authoritativeReduceQuantity(order: Pick<LiveOrder, "symbol" | "positionSide">): Promise<DecimalString> {
    if (!this.gateway.positionRisk) throw new Error("Dual REDUCE requires signed positionRisk");
    const matches = (await this.gateway.positionRisk(order.symbol)).filter((candidate) =>
      candidate.symbol === order.symbol && candidate.positionSide === order.positionSide);
    if (matches.length !== 1) throw new Error(`${order.symbol} ${order.positionSide} remote position is not unique`);
    const signed = decimal(matches[0].positionAmt);
    const quantity = order.positionSide === "SHORT" ? subtractDecimals("0", signed) : signed;
    if (compareDecimals(quantity, "0") < 0) throw new Error("Remote position direction mismatch");
    return quantity;
  }

  private async closeQuantity(position: LivePosition): Promise<DecimalString> {
    this.assertPositionIdentity(position);
    if (!this.accountMode!.dualSide) return position.quantity;
    return this.authoritativeReduceQuantity(position);
  }

  async closePosition(positionId: string): Promise<LiveOrder | null> {
    const position = await this.store.getPosition(positionId);
    if (!position || position.status !== "OPEN" || compareDecimals(position.quantity, "0") <= 0) return null;
    this.assertPositionIdentity(position);
    let clientOrderId = `close-${positionId}`;
    const reuse = async (id: string) => {
      const existing = await this.store.getOrder(id);
      if (!existing) return null;
      if (existing.intentId !== positionId || existing.symbol !== position.symbol
        || existing.positionSide !== position.positionSide
        || existing.accountModeFingerprint !== position.accountModeFingerprint
        || existing.type !== "MARKET" || existing.entrySemantics !== "REDUCE") {
        throw new Error("Deterministic close order ownership mismatch");
      }
      return existing.status === "PENDING_SEND" ? this.submit(id) : existing;
    };
    const closeOrders = (await this.store.listOrders()).flatMap((order) => {
      const match = new RegExp(`^close-${positionId}(?:-retry-(\\d+))?$`).exec(order.clientOrderId);
      if (order.intentId !== positionId || order.type !== "MARKET" || order.entrySemantics !== "REDUCE" || !match) {
        return [];
      }
      return [{ order, sequence: match[1] === undefined ? 0 : Number(match[1]) }];
    }).sort((left, right) => left.sequence - right.sequence || left.order.id.localeCompare(right.order.id));
    let latest = closeOrders.at(-1)?.order;
    if (latest) {
      let reused = await reuse(latest.clientOrderId);
      if (reused && ["UNKNOWN", "RECONCILING"].includes(reused.status)) {
        reused = await this.reconcile(reused, position);
      }
      if (!reused || reused.status !== "CANCEL") return reused;
      latest = reused;
      const cancelled = reused;
      const retry = closeOrders.filter(({ order }) => order.clientOrderId === cancelled.clientOrderId
        ? cancelled.status === "CANCEL" : order.status === "CANCEL").length;
      clientOrderId = `close-${positionId}-retry-${retry}`;
      const raced = await reuse(clientOrderId);
      if (raced) return raced;
    }
    const quantity = await this.closeQuantity(position);
    if (compareDecimals(quantity, "0") <= 0) {
      await this.reconcileZeroTarget({
        intentId: position.id,
        symbol: position.symbol,
        positionSide: position.positionSide,
        accountModeFingerprint: position.accountModeFingerprint,
      });
      if (latest?.status === "CANCEL") return latest;
      throw new Error("Target remote position is already zero; reconciliation required");
    }
    const order: LiveOrder = {
      id: this.id(),
      intentId: position.id,
      clientOrderId,
      exchangeOrderId: null,
      symbol: position.symbol,
      side: position.side,
      positionSide: position.positionSide,
      marginType: position.marginType,
      entrySemantics: "REDUCE",
      effectiveLeverage: position.effectiveLeverage ?? Number(position.leverage),
      maintenanceBracket: position.maintenanceBracket,
      maintMarginRatio: position.maintMarginRatio,
      cumMaintenance: position.cumMaintenance,
      liquidationPriceSource: position.liquidationPriceSource,
      accountModeFingerprint: position.accountModeFingerprint,
      compatibilityFrozen: position.compatibilityFrozen,
      type: "MARKET",
      status: "PENDING_SEND",
      price: "0",
      stopPrice: null,
      originalQuantity: quantity,
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      reduceOnly: true,
      createdAt: Date.now(),
    };
    try {
      await this.createOrder(order);
    } catch (error) {
      const raced = await reuse(clientOrderId);
      if (!raced) throw error;
      return raced;
    }
    return this.submit(clientOrderId);
  }

  async emergency(): Promise<{
    cancelled: string[];
    unsettled: { positionId: string; symbol: string; reason: string }[];
  }> {
    const cancelled: string[] = [];
    const unsettled: { positionId: string; symbol: string; reason: string }[] = [];
    const orders = await this.store.listOrders();
    for (const order of orders.filter((candidate) => WORKING_STATUSES.has(candidate.status))) {
      try {
        await this.gateway.cancelOrder({ symbol: order.symbol, origClientOrderId: order.clientOrderId });
        const transitioned = await this.store.transitionOrder(order.clientOrderId, [order.status], { status: "CANCEL" });
        const actual = transitioned?.status === "CANCEL" ? transitioned : await this.recover(order.clientOrderId);
        if (actual.status !== "CANCEL") throw new Error("Cancel state could not be confirmed");
        cancelled.push(order.clientOrderId);
      } catch {
        await this.store.transitionOrder(order.clientOrderId, [order.status], { status: "UNKNOWN" });
        unsettled.push({
          positionId: order.intentId,
          symbol: order.symbol,
          reason: `系统订单 ${order.clientOrderId} 撤销失败`,
        });
      }
    }
    for (const position of await this.store.listOpenPositions()) {
      try {
        const close = await this.closePosition(position.id);
        if (!close || close.status === "UNKNOWN") {
          unsettled.push({ positionId: position.id, symbol: position.symbol, reason: "REDUCE 平仓提交未确认" });
        } else {
          unsettled.push({ positionId: position.id, symbol: position.symbol, reason: "REDUCE 平仓已提交，等待实际成交" });
        }
      } catch (error) {
        unsettled.push({
          positionId: position.id,
          symbol: position.symbol,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { cancelled, unsettled };
  }

  private async submitReplacement(order: LiveOrder): Promise<LiveOrder> {
    if (order.type !== "LIMIT" || order.entrySemantics !== "ENTRY") return this.submit(order.clientOrderId);
    if (order.admissionGeneration === undefined) {
      return await this.store.transitionOrder(order.clientOrderId, ["PENDING_SEND"], { status: "CANCEL" }) ?? order;
    }
    return this.submit(order.clientOrderId, order.admissionGeneration);
  }

  private async replace(
    order: LiveOrder,
    changes: { price?: DecimalString; quantity?: DecimalString },
  ): Promise<LiveOrder> {
    assertNotCompatibilityFrozen(order);
    if (!["NEW", "PARTIALLY_FILLED"].includes(order.status)) {
      throw new Error(`${order.status} order requires reconciliation before replacement`);
    }
    if (!this.accountMode || order.accountModeFingerprint !== this.accountMode.fingerprint) {
      throw new Error("Replacement account mode fingerprint mismatch");
    }
    if (order.type === "STOP_MARKET") {
      const position = await this.store.getPosition(order.intentId);
      if (!position || position.status !== "OPEN" || !this.protectionOwnedBy(position, order)) {
        throw new Error("STOP_MARKET replacement ownership or fingerprint mismatch");
      }
      this.assertPositionIdentity(position);
    }
    const replacementClientOrderId = `replace-${order.clientOrderId}`;
    let replacing = await this.store.transitionOrder(order.clientOrderId, [order.status], { status: "REPLACE" });
    if (!replacing) {
      const existing = await this.store.getOrder(replacementClientOrderId);
      if (existing) return this.submitReplacement(existing);
      const latest = await this.requireOrder(order.clientOrderId);
      if (latest.status === "CANCEL") replacing = latest;
      else if (["REPLACE", "RECONCILING", "UNKNOWN"].includes(latest.status)) {
        const reconciled = await this.reconcile(latest);
        if (reconciled.status !== "CANCEL") return reconciled;
        replacing = reconciled;
      } else throw new Error("Order changed before replacement");
    }
    let current = replacing;
    if (current.status !== "CANCEL") {
      try {
        await this.gateway.cancelOrder({ symbol: order.symbol, origClientOrderId: order.clientOrderId });
      } catch {
        const unknown = await this.store.transitionOrder(order.clientOrderId, ["REPLACE"], { status: "UNKNOWN" });
        if (!unknown) throw new Error("Order changed after cancel timeout");
        return unknown;
      }
      current = await this.reconcile(replacing);
    }
    if (current.status !== "CANCEL") throw new Error("Replacement cancel was not confirmed");
    const latestPosition = current.type === "STOP_MARKET" ? await this.store.getPosition(current.intentId) : null;
    const remaining = latestPosition?.quantity
      ?? changes.quantity
      ?? subtractDecimals(current.originalQuantity, current.executedQuantity);
    if (latestPosition?.exitPending) return current;
    if (compareDecimals(remaining, "0") <= 0) return current;
    const replacement: LiveOrder = {
      ...current,
      id: this.id(),
      clientOrderId: replacementClientOrderId,
      exchangeOrderId: null,
      status: "PENDING_SEND",
      price: changes.price ?? current.price,
      stopPrice: current.type === "STOP_MARKET" ? changes.price ?? current.stopPrice : current.stopPrice,
      originalQuantity: remaining,
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      createdAt: Date.now(),
    };
    let created = await this.store.createReplacement(
      current.clientOrderId,
      current.executedQuantity,
      replacement,
      latestPosition?.quantity,
    );
    if (!created) created = await this.store.getOrder(replacementClientOrderId);
    if (!created) throw new Error("Order or position changed during replacement");
    const revalidatedParent = await this.requireOrder(current.clientOrderId);
    const revalidatedPosition = current.type === "STOP_MARKET" ? await this.store.getPosition(current.intentId) : null;
    if (revalidatedParent.status !== "CANCEL"
      || compareDecimals(revalidatedParent.executedQuantity, current.executedQuantity) !== 0
      || (latestPosition && (!revalidatedPosition
        || compareDecimals(revalidatedPosition.quantity, latestPosition.quantity) !== 0))) {
      await this.store.transitionOrder(replacement.clientOrderId, ["PENDING_SEND"], { status: "CANCEL" });
      throw new Error("Late fill changed the replacement basis");
    }
    return this.submitReplacement(replacement);
  }

  private async ensureProtection(position: LivePosition): Promise<void> {
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const latest = await this.store.getPosition(position.id);
        if (!latest || latest.status !== "OPEN") return;
        this.assertPositionIdentity(latest);
        const orders = await this.store.listOrders();
        const protections = orders.filter((order) => order.intentId === latest.id
          && order.type === "STOP_MARKET" && WORKING_STATUSES.has(order.status));
        if (protections.some((order) => !this.protectionOwnedBy(latest, order))) {
          throw new Error("STOP_MARKET ownership, positionSide, fingerprint, or entrySemantics mismatch");
        }
        if (protections.some((order) => order.compatibilityFrozen)) {
          throw new Error("STOP_MARKET compatibility frozen");
        }
        const protection = protections[0];
        if (protection && ["SUBMITTING", "RECONCILING", "REPLACE"].includes(protection.status)) return;
        if (protection?.status === "UNKNOWN") throw new Error("STOP_MARKET requires reconciliation");
        if (protection?.status === "PENDING_SEND") {
          const submitted = await this.submit(protection.clientOrderId);
          if (submitted.status === "SUBMITTING") return;
          if (submitted.status !== "NEW") throw new Error("STOP_MARKET submission is UNKNOWN");
          continue;
        }
        if (protection?.status === "NEW"
          && compareDecimals(protection.originalQuantity, latest.quantity) === 0) return;
        if (!protection) {
          const order = this.protectionOrder(latest);
          try {
            await this.createOrder(order);
          } catch (error) {
            if (await this.store.getOrder(order.clientOrderId)) continue;
            throw error;
          }
          const submitted = await this.submit(order.clientOrderId);
          if (submitted.status !== "NEW") throw new Error("STOP_MARKET submission is UNKNOWN");
          continue;
        }
        const replaced = await this.replace(protection, { quantity: latest.quantity });
        if (replaced.status !== "NEW") throw new Error("STOP_MARKET replacement is UNKNOWN");
      }
      throw new Error("STOP_MARKET position version kept changing");
    } catch (error) {
      const current = await this.store.getPosition(position.id);
      if (current?.compatibilityFrozen) throw error;
      const orders = await this.store.listOrders();
      const frozenProtection = orders.some((order) => this.protectionOwnedBy(position, order)
        && order.compatibilityFrozen && WORKING_STATUSES.has(order.status));
      if (frozenProtection) throw error;
      const protectionInFlight = orders.some((order) => this.protectionOwnedBy(position, order)
        && WORKING_STATUSES.has(order.status) && order.status !== "UNKNOWN");
      if (protectionInFlight) return;
      await this.alert(`${position.symbol} 交易所保护单失败：${error instanceof Error ? error.message : String(error)}`);
      await this.closePosition(position.id);
    }
  }

  private protectionOrder(position: LivePosition): LiveOrder {
    return {
      id: this.id(),
      intentId: position.id,
      clientOrderId: `protect-${position.id}`,
      exchangeOrderId: null,
      symbol: position.symbol,
      side: position.side,
      positionSide: position.positionSide,
      marginType: position.marginType,
      entrySemantics: "REDUCE",
      effectiveLeverage: position.effectiveLeverage ?? Number(position.leverage),
      maintenanceBracket: position.maintenanceBracket,
      maintMarginRatio: position.maintMarginRatio,
      cumMaintenance: position.cumMaintenance,
      liquidationPriceSource: position.liquidationPriceSource,
      accountModeFingerprint: position.accountModeFingerprint,
      compatibilityFrozen: position.compatibilityFrozen,
      type: "STOP_MARKET",
      status: "PENDING_SEND",
      price: position.stopPrice,
      stopPrice: position.stopPrice,
      originalQuantity: position.quantity,
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      reduceOnly: true,
      createdAt: Date.now(),
    };
  }

  private requestFor(order: LiveOrder): PlaceOrderRequest {
    if (!this.accountMode) throw new Error("Account mode is required for new order submission");
    return buildOrderWire(order, this.accountMode);
  }

  private statusFromExchange(status: string): LiveOrderStatus {
    if (status === "NEW") return "NEW";
    if (status === "PARTIALLY_FILLED") return "PARTIALLY_FILLED";
    if (status === "FILLED") return "FILLED";
    if (["CANCELED", "CANCELLED", "EXPIRED", "REJECTED"].includes(status)) return "CANCEL";
    return "UNKNOWN";
  }

  private async requireOrder(clientOrderId: string): Promise<LiveOrder> {
    const order = await this.store.getOrder(clientOrderId);
    if (!order) throw new Error("Live order not found");
    return order;
  }
}
