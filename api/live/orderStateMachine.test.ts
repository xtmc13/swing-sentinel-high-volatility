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
    expect(await store.getPosition(seed.id)).toMatchObject({ quantity: "3", initialQuantity: "3", openedAt: 2 });

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

  it("duplicate workers create and submit only one replacement for a parent", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill(), seed);
    const other = new OrderStateMachine(store, gateway);

    await Promise.all([
      machine.replaceOrder("entry-1", "101"),
      other.replaceOrder("entry-1", "101"),
    ]);
    const replacements = (await store.listOrders()).filter((order) => order.type === "LIMIT"
      && order.clientOrderId !== "entry-1" && order.status === "NEW");
    expect(replacements).toHaveLength(1);
    expect(gateway.placed.filter((order) => order.type === "LIMIT")).toHaveLength(2);
  });

  it("replacement reconciles delayed remote fills before calculating the remainder", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill({ exchangeTradeId: "1" }), seed);
    gateway.trades.push(
      {
        symbol: seed.symbol, id: 1, orderId: 100, side: "BUY", price: "100", qty: "1",
        realizedPnl: "0", commission: "0.1", commissionAsset: "USDT", time: 2, buyer: true, maker: false,
      },
      {
        symbol: seed.symbol, id: 2, orderId: 100, side: "BUY", price: "100", qty: "1",
        realizedPnl: "0", commission: "0.1", commissionAsset: "USDT", time: 3, buyer: true, maker: false,
      },
    );

    const replacement = await machine.replaceOrder("entry-1", "101");
    expect(gateway.queries).toContain("entry-1");
    expect((await store.getOrder("entry-1"))?.executedQuantity).toBe("2");
    expect(gateway.placed.filter((order) => order.type === "LIMIT").at(-1))
      .toMatchObject({ newClientOrderId: replacement.clientOrderId, quantity: "1" });
  });

  it("accepts delayed valid fills after CANCEL and invalidates the overstated replacement", async () => {
    const { store, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill(), seed);
    await machine.replaceOrder("entry-1", "101");

    await machine.handleFill("entry-1", fill({ exchangeTradeId: "late-trade" }), seed);
    expect(await store.getOrder("entry-1")).toMatchObject({ status: "CANCEL", executedQuantity: "2" });
    expect((await store.getPosition(seed.id))?.quantity).toBe("2");
    expect((await store.getOrder("replace-entry-1"))?.status).toBe("CANCEL");
  });

  it("cancels and reconciles when another worker submits during replacement invalidation", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill(), seed);
    const replacement = await machine.replaceOrder("entry-1", "101");
    await store.transitionOrder(replacement.clientOrderId, ["NEW"], { status: "PENDING_SEND" });
    const transition = store.transitionOrder.bind(store);
    const otherWorker = new OrderStateMachine(store, gateway);
    store.transitionOrder = async (clientOrderId, expectedStatuses, patch) => {
      if (clientOrderId === replacement.clientOrderId && patch.status === "CANCEL"
        && expectedStatuses.includes("PENDING_SEND")) {
        await otherWorker.submit(clientOrderId);
        return null;
      }
      return transition(clientOrderId, expectedStatuses, patch);
    };

    const result = await machine.handleFill("entry-1", fill({ exchangeTradeId: "late-race" }), seed);
    expect((await store.getOrder(replacement.clientOrderId))?.status).toBe("CANCEL");
    expect(gateway.cancelled.some((order) => order.origClientOrderId === replacement.clientOrderId)).toBe(true);
    expect(result.unresolved ?? []).toHaveLength(0);
  });

  it("reports unresolved and freezes replacement when raced invalidation cannot confirm cancel", async () => {
    const { store, gateway, alerts, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill(), seed);
    const replacement = await machine.replaceOrder("entry-1", "101");
    await store.transitionOrder(replacement.clientOrderId, ["NEW"], { status: "PENDING_SEND" });
    const transition = store.transitionOrder.bind(store);
    const otherWorker = new OrderStateMachine(store, gateway);
    store.transitionOrder = async (clientOrderId, expectedStatuses, patch) => {
      if (clientOrderId === replacement.clientOrderId && patch.status === "CANCEL"
        && expectedStatuses.includes("PENDING_SEND")) {
        await otherWorker.submit(clientOrderId);
        return null;
      }
      return transition(clientOrderId, expectedStatuses, patch);
    };
    gateway.failCancel = true;

    const result = await machine.handleFill("entry-1", fill({ exchangeTradeId: "late-failed-race" }), seed);
    expect((await store.getOrder(replacement.clientOrderId))?.status).toBe("UNKNOWN");
    expect(result.unresolved).toHaveLength(1);
    expect(alerts.join(" ")).toContain("未解决");
  });

  it.each(["NEW", "PARTIALLY_FILLED"] as const)(
    "freezes a replacement left %s after post-cancel reconciliation",
    async (remoteStatus) => {
      const { store, gateway, alerts, machine } = setup();
      entry(store);
      await machine.submit("entry-1");
      await machine.handleFill("entry-1", fill(), seed);
      const replacement = await machine.replaceOrder("entry-1", "101");
      const query = gateway.queryOrder.bind(gateway);
      gateway.queryOrder = async (request) => {
        const actual = await query(request);
        if (request.origClientOrderId === replacement.clientOrderId && actual?.status === "CANCELED") {
          return { ...actual, status: remoteStatus };
        }
        return actual;
      };

      const result = await machine.handleFill("entry-1", fill({ exchangeTradeId: `late-${remoteStatus}` }), seed);
      expect((await store.getOrder(replacement.clientOrderId))?.status).toBe("UNKNOWN");
      expect(result.unresolved).toHaveLength(1);
      expect(alerts.join(" ")).toContain("UNKNOWN");
    },
  );

  it("retries cancel and recovery when freezing an invalidated replacement loses its state race", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill(), seed);
    const replacement = await machine.replaceOrder("entry-1", "101");
    const transition = store.transitionOrder.bind(store);
    gateway.failCancel = true;
    let raced = false;
    store.transitionOrder = async (clientOrderId, expectedStatuses, patch) => {
      if (!raced && clientOrderId === replacement.clientOrderId && patch.status === "UNKNOWN") {
        raced = true;
        await transition(clientOrderId, ["RECONCILING"], { status: "NEW" });
        gateway.failCancel = false;
        return null;
      }
      return transition(clientOrderId, expectedStatuses, patch);
    };

    const result = await machine.handleFill("entry-1", fill({ exchangeTradeId: "late-freeze-race" }), seed);
    expect(raced).toBe(true);
    expect((await store.getOrder(replacement.clientOrderId))?.status).toBe("CANCEL");
    expect(result.unresolved ?? []).toHaveLength(0);
  });

  it("does not overwrite a terminally filled replacement with the fallback freeze", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill(), seed);
    const replacement = await machine.replaceOrder("entry-1", "101");
    const getOrder = store.getOrder.bind(store);
    const transition = store.transitionOrder.bind(store);
    gateway.failCancel = true;
    let reconcilingReads = 0;
    store.getOrder = async (clientOrderId) => {
      const latest = await getOrder(clientOrderId);
      if (clientOrderId === replacement.clientOrderId && latest?.status === "RECONCILING") {
        reconcilingReads += 1;
        if (reconcilingReads === 2) {
          await transition(clientOrderId, ["RECONCILING"], { status: "FILLED" });
          return getOrder(clientOrderId);
        }
      }
      return latest;
    };

    const result = await machine.handleFill("entry-1", fill({ exchangeTradeId: "late-terminal-race" }), seed);
    expect(reconcilingReads).toBe(2);
    expect((await store.getOrder(replacement.clientOrderId))?.status).toBe("FILLED");
    expect(result.unresolved).toHaveLength(1);
  });

  it("rejects replacement from UNKNOWN until explicit reconciliation", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    gateway.failNextEntryAfterAccept = true;
    await machine.submit("entry-1");

    await expect(machine.replaceOrder("entry-1", "101")).rejects.toThrow("UNKNOWN");
    expect(gateway.cancelled).toHaveLength(0);
    expect(gateway.placed).toHaveLength(1);
  });

  it("maps terminal IOC acknowledgements to CANCEL rather than NEW", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    gateway.placeOrder = async (request) => ({
      symbol: request.symbol,
      orderId: 100,
      clientOrderId: "entry-1",
      price: "100",
      origQty: "3",
      executedQty: "0",
      status: "EXPIRED",
      side: "BUY",
      type: "LIMIT",
    });

    expect((await machine.submit("entry-1")).status).toBe("CANCEL");
    expect(await store.getPosition(seed.id)).toBeNull();
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

  it("validates fill symbol, exchange order, side, and intent ownership before persistence", async () => {
    const { store, machine } = setup();
    entry(store);
    await machine.submit("entry-1");

    for (const candidate of [
      { event: fill({ symbol: "ETHUSDT" }), owner: seed },
      { event: fill({ exchangeOrderId: "999" }), owner: seed },
      { event: fill({ side: "SELL" as const }), owner: seed },
      { event: fill(), owner: { ...seed, id: "other-intent" } },
    ]) {
      await expect(machine.handleFill("entry-1", candidate.event, candidate.owner)).rejects.toThrow();
    }
    expect((await store.getOrder("entry-1"))?.executedQuantity).toBe("0");
    expect(await store.getPosition(seed.id)).toBeNull();
  });

  it("a cross-worker REPLACE race reconciles instead of triggering a market exit", async () => {
    const { store, gateway, alerts, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill({ exchangeTradeId: "first" }), seed);
    const transition = store.transitionOrder.bind(store);
    store.transitionOrder = async (clientOrderId, expectedStatuses, patch) => {
      const current = await store.getOrder(clientOrderId);
      if (patch.status === "REPLACE" && current?.type === "STOP_MARKET" && current.status === "NEW") {
        await transition(clientOrderId, expectedStatuses, { status: "REPLACE" });
        return null;
      }
      return transition(clientOrderId, expectedStatuses, patch);
    };

    await machine.handleFill("entry-1", fill({ exchangeTradeId: "second" }), seed);
    expect(alerts).toHaveLength(0);
    expect(gateway.placed.filter((order) => order.type === "MARKET")).toHaveLength(0);
  });

  it("concurrent fills cannot shrink protection or trigger a duplicate-protection exit", async () => {
    const { store, gateway, alerts, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    await machine.handleFill("entry-1", fill({ exchangeTradeId: "first" }), seed);
    const cancel = gateway.cancelOrder.bind(gateway);
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let paused = false;
    gateway.cancelOrder = async (request) => {
      const order = await store.getOrder(request.origClientOrderId ?? "");
      if (!paused && order?.type === "STOP_MARKET") {
        paused = true;
        markStarted();
        await gate;
      }
      return cancel(request);
    };

    const second = machine.handleFill("entry-1", fill({ exchangeTradeId: "second" }), seed);
    await started;
    const third = machine.handleFill("entry-1", fill({ exchangeTradeId: "third" }), seed);
    release();
    await Promise.all([second, third]);

    const protections = (await store.listOrders()).filter((order) => order.type === "STOP_MARKET" && order.status === "NEW");
    expect(protections.at(-1)?.originalQuantity).toBe("3");
    expect(alerts).toHaveLength(0);
    expect(gateway.placed.filter((order) => order.type === "MARKET")).toHaveLength(0);
  });

  it("two workers creating the first deterministic protection do not exit on client ID collision", async () => {
    const { store, gateway, alerts, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    const first = new OrderStateMachine(store, gateway, { alert: (message) => alerts.push(message) });
    const second = new OrderStateMachine(store, gateway, { alert: (message) => alerts.push(message) });

    await Promise.all([
      first.handleFill("entry-1", fill({ exchangeTradeId: "worker-a" }), seed),
      second.handleFill("entry-1", fill({ exchangeTradeId: "worker-b" }), seed),
    ]);

    const protections = (await store.listOrders()).filter((order) => order.type === "STOP_MARKET" && order.status === "NEW");
    expect(protections.at(-1)?.originalQuantity).toBe("2");
    expect(alerts).toHaveLength(0);
    expect(gateway.placed.filter((order) => order.type === "MARKET")).toHaveLength(0);
  });

  it("a pending deterministic protection is submitted rather than replaced or treated as failed", async () => {
    const { store, gateway, alerts, machine } = setup();
    const parent = entry(store);
    await machine.submit("entry-1");
    store.addOrder({
      ...parent,
      id: "protection-row",
      clientOrderId: `protect-${seed.id}`,
      type: "STOP_MARKET",
      price: "99",
      stopPrice: "99",
      originalQuantity: "1",
      reduceOnly: true,
    });

    await machine.handleFill("entry-1", fill(), seed);
    expect((await store.getOrder(`protect-${seed.id}`))?.status).toBe("NEW");
    expect(alerts).toHaveLength(0);
    expect(gateway.placed.filter((order) => order.type === "MARKET")).toHaveLength(0);
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

  it("failed emergency cancels remain unresolved even without a position", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    gateway.failCancel = true;

    const emergency = await machine.emergency();
    expect(emergency.unsettled).toHaveLength(1);
    expect(emergency.unsettled[0]).toMatchObject({ positionId: seed.id, symbol: seed.symbol });
  });

  it("does not report a successful cancel when the conditional transition loses and recovery cannot confirm it", async () => {
    const { store, gateway, machine } = setup();
    entry(store);
    await machine.submit("entry-1");
    const transition = store.transitionOrder.bind(store);
    store.transitionOrder = async (clientOrderId, expectedStatuses, patch) => {
      if (patch.status === "CANCEL" && clientOrderId === "entry-1") return null;
      return transition(clientOrderId, expectedStatuses, patch);
    };
    gateway.queryOrder = async () => null;

    const emergency = await machine.emergency();
    expect(emergency.cancelled).toHaveLength(0);
    expect(emergency.unsettled).toHaveLength(1);
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
