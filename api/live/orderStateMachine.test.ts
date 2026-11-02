import { describe, expect, it } from "vitest";
import type {
  BinanceOpenOrder,
  BinanceUserTrade,
  CancelOrderRequest,
  LiveOrderGateway,
  PlaceOrderRequest,
} from "./binanceSigned";
import {
  InMemoryLiveOrderStore,
  OrderStateMachine,
  type LiveFill,
  type LiveOrder,
  type LivePositionSeed,
} from "./orderStateMachine";

class FakeGateway implements LiveOrderGateway {
  readonly placed: PlaceOrderRequest[] = [];
  readonly cancelled: CancelOrderRequest[] = [];
  readonly queries: string[] = [];
  readonly exchangeOrders = new Map<string, BinanceOpenOrder>();
  readonly trades: BinanceUserTrade[] = [];
  failPlaceType: string | null = null;
  failCancel = false;
  failNextEntryAfterAccept = false;
  private nextOrderId = 100;

  async placeOrder(request: PlaceOrderRequest): Promise<BinanceOpenOrder> {
    this.placed.push(request);
    const orderId = this.nextOrderId++;
    const clientOrderId = request.newClientOrderId ?? `client-${orderId}`;
    const order: BinanceOpenOrder = {
      symbol: request.symbol,
      orderId,
      clientOrderId,
      price: request.price ?? "0",
      origQty: request.quantity,
      executedQty: "0",
      status: "NEW",
      side: request.side,
      type: request.type,
      reduceOnly: request.reduceOnly,
    };
    this.exchangeOrders.set(clientOrderId, order);
    if (this.failPlaceType === request.type || (this.failNextEntryAfterAccept && request.type === "LIMIT")) {
      this.failNextEntryAfterAccept = false;
      throw new Error("transport timeout");
    }
    return order;
  }

  async cancelOrder(request: CancelOrderRequest): Promise<BinanceOpenOrder> {
    this.cancelled.push(request);
    if (this.failCancel) throw new Error("cancel timeout");
    const key = request.origClientOrderId ?? "";
    const current = this.exchangeOrders.get(key);
    if (!current) throw new Error("unknown order");
    const cancelled = { ...current, status: "CANCELED" };
    this.exchangeOrders.set(key, cancelled);
    return cancelled;
  }

  async queryOrder(request: CancelOrderRequest): Promise<BinanceOpenOrder | null> {
    const key = request.origClientOrderId ?? "";
    this.queries.push(key);
    return this.exchangeOrders.get(key) ?? null;
  }

  async userTrades(): Promise<BinanceUserTrade[]> {
    return this.trades;
  }

  account(): Promise<never> {
    throw new Error("not used");
  }
}

const seed: LivePositionSeed = {
  id: "intent-1",
  symbol: "BTCUSDT",
  side: "LONG",
  stopPrice: "99",
  liquidationPrice: "50",
  leverage: "5",
  maintenanceBracket: 1,
  maintMarginRatio: "0.01",
  cumMaintenance: "0",
};

function entry(store: InMemoryLiveOrderStore, quantity = "3"): LiveOrder {
  const order: LiveOrder = {
    id: "entry-row-1",
    intentId: seed.id,
    clientOrderId: "entry-1",
    exchangeOrderId: null,
    symbol: seed.symbol,
    side: seed.side,
    type: "LIMIT",
    status: "PENDING_SEND",
    price: "100",
    stopPrice: null,
    originalQuantity: quantity,
    executedQuantity: "0",
    averagePrice: "0",
    commission: "0",
    reduceOnly: false,
    createdAt: 1,
  };
  store.addOrder(order);
  return order;
}

function fill(overrides: Partial<LiveFill> = {}): LiveFill {
  return {
    exchangeTradeId: "trade-1",
    exchangeOrderId: "100",
    symbol: seed.symbol,
    side: "BUY",
    price: "100",
    quantity: "1",
    commission: "0.1",
    commissionAsset: "USDT",
    realizedPnl: "0",
    isMaker: false,
    executedAt: 2,
    ...overrides,
  };
}

function setup() {
  const store = new InMemoryLiveOrderStore();
  const gateway = new FakeGateway();
  const alerts: string[] = [];
  const machine = new OrderStateMachine(store, gateway, { alert: (message) => alerts.push(message) });
  return { store, gateway, alerts, machine };
}

describe("fill-driven live order state machine", () => {
  it("acknowledgement does not open a position; partial, out-of-order and duplicate fills aggregate exactly", async () => {
    const { store, gateway, machine } = setup();
    entry(store);

    const submitted = await machine.submit("entry-1");
    expect(submitted.status).toBe("NEW");
    expect(await store.getPosition(seed.id)).toBeNull();
    expect(gateway.placed[0]).toMatchObject({ type: "LIMIT", timeInForce: "IOC", price: "100" });

    await machine.handleFill("entry-1", fill({
      exchangeTradeId: "trade-2", price: "102", commission: "0.2", executedAt: 3,
    }), seed);
    expect((await store.getPosition(seed.id))?.quantity).toBe("1");

    await machine.handleFill("entry-1", fill({ quantity: "2", commission: "0.4" }), seed);
    const order = await store.getOrder("entry-1");
    expect(order).toMatchObject({
      status: "FILLED",
      executedQuantity: "3",
      averagePrice: "100.666666666666666666666666666667",
      commission: "0.6",
    });
    expect(await store.getPosition(seed.id)).toMatchObject({ quantity: "3", initialQuantity: "3" });

    const transportCalls = gateway.placed.length;
    const duplicate = await machine.handleFill("entry-1", fill({ quantity: "2", commission: "0.4" }), seed);
    expect(duplicate.inserted).toBe(false);
    expect((await store.getOrder("entry-1"))?.executedQuantity).toBe("3");
    expect(gateway.placed).toHaveLength(transportCalls);
    const protections = (await store.listOrders()).filter((order) => order.type === "STOP_MARKET" && order.status === "NEW");
    expect(protections.at(-1)).toMatchObject({ originalQuantity: "3", reduceOnly: true, side: "LONG" });
    expect(gateway.placed.filter((order) => order.type === "STOP_MARKET").at(-1))
      .toMatchObject({ quantity: "3", side: "SELL", reduceOnly: true });
  });

  it("a fill arriving before the submit acknowledgement wins the state race", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    const transport = gateway.placeOrder.bind(gateway);
    let acknowledge: ((order: BinanceOpenOrder) => void) | undefined;
    gateway.placeOrder = (request) => {
      if (request.type !== "LIMIT") return transport(request);
      gateway.placed.push(request);
      return new Promise<BinanceOpenOrder>((resolve) => { acknowledge = resolve; });
    };
    const submission = machine.submit("entry-1");
    for (let attempt = 0; attempt < 20 && !acknowledge; attempt += 1) await Promise.resolve();
    expect(acknowledge).toBeDefined();
    await machine.handleFill("entry-1", fill(), seed);

    acknowledge!({
      symbol: seed.symbol,
      orderId: 100,
      clientOrderId: "entry-1",
      price: "100",
      origQty: "3",
      executedQty: "1",
      status: "PARTIALLY_FILLED",
      side: "BUY",
      type: "LIMIT",
    });
    await expect(submission).resolves.toMatchObject({ status: "PARTIALLY_FILLED", executedQuantity: "1" });
    expect((await store.getPosition(seed.id))?.quantity).toBe("1");
  });

  it("cancel timeout enters UNKNOWN and recovery queries before any replacement", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    gateway.failCancel = true;

    const replaced = await machine.replaceOrder("entry-1", "101");
    expect(replaced.status).toBe("UNKNOWN");
    expect(gateway.placed).toHaveLength(1);
    expect(gateway.queries).toHaveLength(0);

    gateway.exchangeOrders.set("entry-1", { ...gateway.exchangeOrders.get("entry-1")!, status: "CANCELED" });
    await machine.recover("entry-1");
    expect(gateway.queries).toEqual(["entry-1"]);
    expect(gateway.placed).toHaveLength(1);
  });

  it("replacement confirms cancel and uses actual filled quantity for the remainder", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill(), seed);

    const replacement = await machine.replaceOrder("entry-1", "101");
    expect(replacement.clientOrderId).not.toBe("entry-1");
    expect(gateway.placed.at(-1)).toMatchObject({
      newClientOrderId: replacement.clientOrderId,
      quantity: "2",
      price: "101",
      timeInForce: "IOC",
    });
    expect((await store.getOrder("entry-1"))?.status).toBe("CANCEL");
  });

  it("crash recovery reconciles UNKNOWN from query plus user trades without duplicate fills", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    gateway.failNextEntryAfterAccept = true;

    expect((await machine.submit("entry-1")).status).toBe("UNKNOWN");
    expect(await store.getPosition(seed.id)).toBeNull();
    const exchange = gateway.exchangeOrders.get("entry-1")!;
    gateway.exchangeOrders.set("entry-1", { ...exchange, status: "FILLED", executedQty: "1" });
    gateway.trades.push({
      symbol: seed.symbol,
      id: 777,
      orderId: exchange.orderId,
      side: "BUY",
      price: "100",
      qty: "1",
      realizedPnl: "0",
      commission: "0.05",
      commissionAsset: "USDT",
      time: 4,
      buyer: true,
      maker: false,
    });

    await machine.recover("entry-1", seed);
    expect(await store.getPosition(seed.id)).toMatchObject({ quantity: "1", entryPrice: "100" });
    await machine.recover("entry-1", seed);
    expect((await store.getOrder("entry-1"))?.commission).toBe("0.05");
    expect((await store.getPosition(seed.id))?.quantity).toBe("1");
  });

  it("protection failure alerts and attempts a reduce-only market exit", async () => {
    const { store, gateway, alerts, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    gateway.failPlaceType = "STOP_MARKET";

    await machine.handleFill("entry-1", fill(), seed);
    expect(alerts.join(" ")).toContain("保护");
    expect(gateway.placed.at(-1)).toMatchObject({
      type: "MARKET",
      side: "SELL",
      quantity: "1",
      reduceOnly: true,
    });
  });

  it("duplicate workers cannot submit the same persisted order twice", async () => {
    const { store, gateway } = setup();
    entry(store);
    const first = new OrderStateMachine(store, gateway);
    const second = new OrderStateMachine(store, gateway);

    await Promise.all([first.submit("entry-1"), second.submit("entry-1")]);
    expect(gateway.placed).toHaveLength(1);
  });

  it("emergency cancels system orders and reports reduce-only exits unresolved until fills arrive", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill(), seed);

    const emergency = await machine.emergency();
    const close = gateway.placed.find((order) => order.type === "MARKET");
    expect(close).toMatchObject({ side: "SELL", quantity: "1", reduceOnly: true });
    expect(emergency.unsettled).toHaveLength(1);

    const closeOrder = (await store.listOrders()).find((order) => order.clientOrderId === close?.newClientOrderId)!;
    await machine.handleFill(closeOrder.clientOrderId, fill({
      exchangeTradeId: "close-trade",
      exchangeOrderId: String(gateway.exchangeOrders.get(closeOrder.clientOrderId)?.orderId),
      side: "SELL",
      realizedPnl: "1",
    }), seed);
    expect(await store.getPosition(seed.id)).toMatchObject({ status: "CLOSED", quantity: "0" });
  });
});
