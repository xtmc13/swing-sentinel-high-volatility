import type { Side } from "@contracts/trading";
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
  type: "LIMIT" | "MARKET" | "STOP_MARKET";
  status: LiveOrderStatus;
  price: DecimalString;
  stopPrice: DecimalString | null;
  originalQuantity: DecimalString;
  executedQuantity: DecimalString;
  averagePrice: DecimalString;
  commission: DecimalString;
  reduceOnly: boolean;
  createdAt: number;
}

export interface LivePositionSeed {
  id: string;
  symbol: string;
  side: Side;
  stopPrice: DecimalString;
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
}

export interface LiveOrderStore {
  insertOrder(order: LiveOrder): Promise<void>;
  getOrder(clientOrderId: string): Promise<LiveOrder | null>;
  listOrders(): Promise<LiveOrder[]>;
  transitionOrder(
    clientOrderId: string,
    expectedStatuses: LiveOrderStatus[],
    patch: Partial<LiveOrder>,
  ): Promise<LiveOrder | null>;
  applyFill(orderId: string, fill: LiveFill, seed: LivePositionSeed): Promise<FillApplication>;
  getPosition(positionId: string): Promise<LivePosition | null>;
  listOpenPositions(): Promise<LivePosition[]>;
}

const WORKING_STATUSES = new Set<LiveOrderStatus>([
  "PENDING_SEND", "SUBMITTING", "NEW", "PARTIALLY_FILLED", "REPLACE", "UNKNOWN", "RECONCILING",
]);
const EXACT_AVERAGE = { decimalPlaces: 30, roundingMode: "ROUND_HALF_UP" } as const;

function copyOrder(order: LiveOrder): LiveOrder {
  return { ...order };
}

function copyPosition(position: LivePosition | null): LivePosition | null {
  return position ? { ...position } : null;
}

export function applyNewFill(
  currentOrder: LiveOrder,
  currentPosition: LivePosition | null,
  fill: LiveFill,
  seed: LivePositionSeed,
): { order: LiveOrder; position: LivePosition } {
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
    status: compareDecimals(executedQuantity, currentOrder.originalQuantity) === 0
      ? "FILLED" : "PARTIALLY_FILLED",
    executedQuantity,
    averagePrice,
    commission: addDecimals(currentOrder.commission, fill.commission),
  };

  if (currentOrder.reduceOnly) {
    if (!currentPosition || currentPosition.status !== "OPEN") throw new Error("Reduce-only fill has no open position");
    const quantity = subtractDecimals(currentPosition.quantity, fill.quantity);
    if (compareDecimals(quantity, "0") < 0) throw new Error("Reduce-only fill exceeds live position");
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
    },
  };
}

export class InMemoryLiveOrderStore implements LiveOrderStore {
  private readonly orders = new Map<string, LiveOrder>();
  private readonly fills = new Map<string, LiveFill[]>();
  private readonly positions = new Map<string, LivePosition>();

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

  async listOpenPositions(): Promise<LivePosition[]> {
    return [...this.positions.values()].filter((position) => position.status === "OPEN").map((position) => ({ ...position }));
  }
}

export interface OrderStateMachineOptions {
  alert?: (message: string) => unknown;
  id?: () => string;
}

export class OrderStateMachine {
  private readonly alert: (message: string) => unknown;
  private readonly id: () => string;

  constructor(
    private readonly store: LiveOrderStore,
    private readonly gateway: LiveOrderGateway,
    options: OrderStateMachineOptions = {},
  ) {
    this.alert = options.alert ?? (() => undefined);
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  async createOrder(order: LiveOrder): Promise<LiveOrder> {
    await this.store.insertOrder(order);
    return order;
  }

  async submit(clientOrderId: string): Promise<LiveOrder> {
    const order = await this.requireOrder(clientOrderId);
    if (order.status !== "PENDING_SEND") return order;
    const submitting = await this.store.transitionOrder(clientOrderId, ["PENDING_SEND"], { status: "SUBMITTING" });
    if (!submitting) return this.requireOrder(clientOrderId);
    let acknowledgement: Partial<BinanceOpenOrder>;
    try {
      acknowledgement = await this.gateway.placeOrder(this.requestFor(submitting)) as Partial<BinanceOpenOrder>;
      if ((typeof acknowledgement.orderId !== "number" && typeof acknowledgement.orderId !== "string")
        || String(acknowledgement.orderId).length === 0) {
        throw new Error("Invalid order acknowledgement");
      }
    } catch {
      const unknown = await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], { status: "UNKNOWN" });
      return unknown ?? this.requireOrder(clientOrderId);
    }
    const updated = await this.store.transitionOrder(clientOrderId, ["SUBMITTING"], {
      status: "NEW",
      exchangeOrderId: String(acknowledgement.orderId),
    });
    return updated ?? this.requireOrder(clientOrderId);
  }

  async handleFill(clientOrderId: string, fill: LiveFill, seed: LivePositionSeed): Promise<FillApplication> {
    const order = await this.requireOrder(clientOrderId);
    const result = await this.store.applyFill(order.id, fill, seed);
    if (result.inserted && result.position?.status === "OPEN" && !order.reduceOnly) {
      await this.ensureProtection(result.position);
    }
    return result;
  }

  async replaceOrder(clientOrderId: string, newLimitPrice: DecimalString): Promise<LiveOrder> {
    const order = await this.requireOrder(clientOrderId);
    return this.replace(order, { price: decimal(newLimitPrice) });
  }

  async recover(clientOrderId: string, recoverySeed?: LivePositionSeed): Promise<LiveOrder> {
    const order = await this.requireOrder(clientOrderId);
    if (order.status !== "RECONCILING") {
      const reconciling = await this.store.transitionOrder(clientOrderId, [order.status], { status: "RECONCILING" });
      if (!reconciling) throw new Error("Order changed before reconciliation");
      order.status = "RECONCILING";
    }
    let remote: BinanceOpenOrder | null;
    try {
      remote = await this.gateway.queryOrder({ symbol: order.symbol, origClientOrderId: clientOrderId });
    } catch {
      const unknown = await this.store.transitionOrder(clientOrderId, ["RECONCILING"], { status: "UNKNOWN" });
      if (!unknown) throw new Error("Order changed during failed reconciliation");
      return unknown;
    }
    if (!remote) {
      const unknown = await this.store.transitionOrder(clientOrderId, ["RECONCILING"], { status: "UNKNOWN" });
      if (!unknown) throw new Error("Order changed during missing-order reconciliation");
      return unknown;
    }
    const reconciled = await this.store.transitionOrder(clientOrderId, ["RECONCILING"], {
      exchangeOrderId: String(remote.orderId),
      status: this.statusFromExchange(remote.status),
    });
    if (!reconciled) throw new Error("Order changed during reconciliation");
    const trades = await this.gateway.userTrades({ symbol: order.symbol, limit: 1000 });
    for (const trade of trades.filter((candidate) => String(candidate.orderId) === String(remote.orderId))) {
      const position = await this.store.getPosition(order.intentId);
      const seed = position ?? recoverySeed;
      if (!seed) throw new Error("Position seed is required for recovered fills");
      await this.handleFill(clientOrderId, {
        exchangeTradeId: String(trade.id),
        exchangeOrderId: String(trade.orderId),
        symbol: trade.symbol,
        side: trade.side === "SELL" ? "SELL" : "BUY",
        price: trade.price,
        quantity: trade.qty,
        commission: trade.commission,
        commissionAsset: trade.commissionAsset,
        realizedPnl: trade.realizedPnl,
        isMaker: trade.maker,
        executedAt: trade.time,
      }, seed);
    }
    return this.requireOrder(clientOrderId);
  }

  async closePosition(positionId: string): Promise<LiveOrder | null> {
    const position = await this.store.getPosition(positionId);
    if (!position || position.status !== "OPEN" || compareDecimals(position.quantity, "0") <= 0) return null;
    const order: LiveOrder = {
      id: this.id(),
      intentId: position.id,
      clientOrderId: `close-${this.id()}`,
      exchangeOrderId: null,
      symbol: position.symbol,
      side: position.side,
      type: "MARKET",
      status: "PENDING_SEND",
      price: "0",
      stopPrice: null,
      originalQuantity: position.quantity,
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      reduceOnly: true,
      createdAt: Date.now(),
    };
    await this.createOrder(order);
    return this.submit(order.clientOrderId);
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
        await this.store.transitionOrder(order.clientOrderId, [order.status], { status: "CANCEL" });
        cancelled.push(order.clientOrderId);
      } catch {
        await this.store.transitionOrder(order.clientOrderId, [order.status], { status: "UNKNOWN" });
      }
    }
    for (const position of await this.store.listOpenPositions()) {
      try {
        const close = await this.closePosition(position.id);
        if (!close || close.status === "UNKNOWN") {
          unsettled.push({ positionId: position.id, symbol: position.symbol, reason: "reduceOnly 平仓提交未确认" });
        } else {
          unsettled.push({ positionId: position.id, symbol: position.symbol, reason: "reduceOnly 平仓已提交，等待实际成交" });
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

  private async replace(
    order: LiveOrder,
    changes: { price?: DecimalString; quantity?: DecimalString },
  ): Promise<LiveOrder> {
    const replacing = await this.store.transitionOrder(order.clientOrderId, [order.status], { status: "REPLACE" });
    if (!replacing) throw new Error("Order changed before replacement");
    try {
      await this.gateway.cancelOrder({ symbol: order.symbol, origClientOrderId: order.clientOrderId });
    } catch {
      const unknown = await this.store.transitionOrder(order.clientOrderId, ["REPLACE"], { status: "UNKNOWN" });
      if (!unknown) throw new Error("Order changed after cancel timeout");
      return unknown;
    }
    const current = await this.requireOrder(order.clientOrderId);
    const remaining = changes.quantity ?? subtractDecimals(current.originalQuantity, current.executedQuantity);
    if (compareDecimals(remaining, "0") <= 0) {
      const filled = await this.store.transitionOrder(order.clientOrderId, ["REPLACE"], { status: "FILLED" });
      if (!filled) throw new Error("Order changed after final fill");
      return filled;
    }
    const cancelled = await this.store.transitionOrder(order.clientOrderId, ["REPLACE"], { status: "CANCEL" });
    if (!cancelled) throw new Error("Order changed after confirmed cancel");
    const replacement: LiveOrder = {
      ...current,
      id: this.id(),
      clientOrderId: `replace-${this.id()}`,
      exchangeOrderId: null,
      status: "PENDING_SEND",
      price: changes.price ?? current.price,
      originalQuantity: remaining,
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      createdAt: Date.now(),
    };
    await this.createOrder(replacement);
    return this.submit(replacement.clientOrderId);
  }

  private async ensureProtection(position: LivePosition): Promise<void> {
    const orders = await this.store.listOrders();
    const protection = orders.find((order) => order.intentId === position.id
      && order.type === "STOP_MARKET" && WORKING_STATUSES.has(order.status));
    try {
      if (!protection) {
        const order = this.protectionOrder(position);
        await this.createOrder(order);
        const submitted = await this.submit(order.clientOrderId);
        if (submitted.status !== "NEW") throw new Error("STOP_MARKET submission is UNKNOWN");
        return;
      }
      if (compareDecimals(protection.originalQuantity, position.quantity) !== 0) {
        const replaced = await this.replace(protection, { quantity: position.quantity });
        if (replaced.status !== "NEW") throw new Error("STOP_MARKET replacement is UNKNOWN");
      }
    } catch (error) {
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
    return {
      symbol: order.symbol,
      side: this.orderSide(order),
      type: order.type,
      quantity: order.originalQuantity,
      price: order.type === "MARKET" ? undefined : order.price,
      stopPrice: order.stopPrice ?? undefined,
      timeInForce: order.type === "LIMIT" ? "IOC" : undefined,
      reduceOnly: order.reduceOnly || undefined,
      newClientOrderId: order.clientOrderId,
    };
  }

  private orderSide(order: LiveOrder): "BUY" | "SELL" {
    const entryBuy = order.side === "LONG";
    return (order.reduceOnly ? !entryBuy : entryBuy) ? "BUY" : "SELL";
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
