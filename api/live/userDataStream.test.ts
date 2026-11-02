import { afterEach, describe, expect, it, vi } from "vitest";
import type { BinanceOpenOrder, LiveOrderGateway } from "./binanceSigned";
import { privateUserDataStreamUrl } from "./binanceSigned";
import { InMemoryReconciliationStore } from "./reconciliation";
import {
  InMemoryLiveOrderStore,
  OrderStateMachine,
  type LiveOrder,
  type LivePositionSeed,
} from "./orderStateMachine";
import {
  UserDataStream,
  type UserDataSocket,
} from "./userDataStream";

class FakeSocket implements UserDataSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
  }

  emit(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  disconnect(): void {
    this.onclose?.();
  }
}

function order(): LiveOrder {
  return {
    id: "order-1",
    intentId: "intent-1",
    clientOrderId: "client-1",
    exchangeOrderId: "901",
    symbol: "BTCUSDT",
    side: "LONG",
    type: "LIMIT",
    status: "NEW",
    price: "100",
    stopPrice: null,
    originalQuantity: "2",
    executedQuantity: "0",
    averagePrice: "0",
    commission: "0",
    reduceOnly: false,
    createdAt: 1,
  };
}

const seed: LivePositionSeed = {
  id: "intent-1",
  symbol: "BTCUSDT",
  side: "LONG",
  stopPrice: "95",
  liquidationPrice: "80",
  leverage: "2",
  maintenanceBracket: 1,
  maintMarginRatio: "0.01",
  cumMaintenance: "0",
};

function fillEvent(eventTime: number, tradeId: number, status = "FILLED") {
  return {
    e: "ORDER_TRADE_UPDATE",
    E: eventTime,
    T: eventTime,
    o: {
      s: "BTCUSDT",
      c: "client-1",
      i: 901,
      S: "BUY",
      o: "LIMIT",
      q: "2",
      p: "100",
      sp: "0",
      X: status,
      N: "USDT",
      n: "0.01",
      L: "100.5",
      l: "1",
      t: tradeId,
      rp: "0",
      m: false,
    },
  };
}

interface HarnessOptions {
  withOrder?: boolean;
  reconcile?: () => Promise<{ ok: boolean }>;
  pause?: () => Promise<void>;
}

function harness(options: HarnessOptions = {}) {
  const sockets: FakeSocket[] = [];
  const calls: string[] = [];
  const orders = new InMemoryLiveOrderStore();
  if (options.withOrder ?? true) orders.addOrder(order());
  const store = new InMemoryReconciliationStore();
  const gateway: LiveOrderGateway = {
    placeOrder: async (request) => ({
      symbol: request.symbol,
      orderId: 777,
      clientOrderId: request.newClientOrderId ?? "stop",
      price: request.price ?? "0",
      origQty: request.quantity,
      executedQty: "0",
      status: "NEW",
      side: request.side,
      type: request.type,
      reduceOnly: request.reduceOnly,
    } satisfies BinanceOpenOrder),
    cancelOrder: async () => { throw new Error("unexpected cancel"); },
    queryOrder: async () => null,
    userTrades: async () => [],
  };
  const machine = new OrderStateMachine(orders, gateway);
  const client = {
    createListenKey: async () => {
      calls.push("create");
      return { listenKey: `key-${calls.filter((call) => call === "create").length}` };
    },
    keepAliveListenKey: async () => {
      calls.push("keepAlive");
      return {};
    },
    closeListenKey: async () => {
      calls.push("close");
      return {};
    },
    syncServerTime: async () => { calls.push("sync"); },
    account: async () => {
      calls.push("account");
      return {
        assets: [{
          asset: "USDT",
          walletBalance: "1001.000000000000000000000000000002",
          availableBalance: "950.250000000000000000000000000001",
          crossWalletBalance: "1001",
        }],
      };
    },
  };
  const stream = new UserDataStream({
    client,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      calls.push(`connect:${url}`);
      return socket;
    },
    machine,
    orders,
    store,
    seedFor: async () => seed,
    reconcile: options.reconcile ?? (async () => {
      calls.push("reconcile");
      return { ok: true };
    }),
    pauseNewEntries: options.pause ?? (async () => { calls.push("pause"); }),
    keepAliveIntervalMs: 60_000,
    reconnectDelayMs: 0,
    sleep: async () => undefined,
  });
  return { stream, sockets, calls, orders, store, client, machine };
}

const running: UserDataStream[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((stream) => stream.stop()));
});

describe("private user-data lifecycle", () => {
  it("creates and keeps alive a listenKey and closes it on stop", async () => {
    const h = harness();
    running.push(h.stream);

    await h.stream.start();
    expect(h.sockets[0]?.url).toBe(privateUserDataStreamUrl("key-1"));
    await h.stream.keepAlive();
    await h.stream.stop();

    expect(h.calls).toContain("keepAlive");
    expect(h.calls).toContain("close");
    expect(h.sockets[0]?.closed).toBe(true);
  });

  it("can retry startup after the initial REST reconciliation fails", async () => {
    let attempts = 0;
    const h = harness({
      reconcile: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return { ok: true };
      },
    });
    running.push(h.stream);

    await expect(h.stream.start()).rejects.toThrow("offline");
    await h.stream.start();

    expect(attempts).toBe(2);
    expect(h.sockets).toHaveLength(2);
  });

  it("pauses immediately on disconnect and reconciles before releasing buffered events", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      reconcile: async () => {
        h?.calls?.push("reconcile");
        if (h.sockets.length === 2) await gate;
        return { ok: true };
      },
    });
    running.push(h.stream);
    await h.stream.start();

    h.sockets[0]?.disconnect();
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    h.sockets[1]?.emit(fillEvent(200, 2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await h.orders.getOrder("client-1"))?.executedQuantity).toBe("0");

    release();
    await vi.waitFor(() => expect((h.orders as InMemoryLiveOrderStore).listOrders()).resolves.toBeDefined());
    await vi.waitFor(async () => {
      expect((await h.orders.getOrder("client-1"))?.executedQuantity).toBe("1");
    });
    const syncIndex = h.calls.lastIndexOf("sync");
    const reconcileIndex = h.calls.lastIndexOf("reconcile");
    expect(syncIndex).toBeGreaterThan(-1);
    expect(reconcileIndex).toBeGreaterThan(syncIndex);
    expect(h.calls[0]).toBe("pause");
  });

  it("reconnects when Binance expires the listenKey", async () => {
    const h = harness();
    running.push(h.stream);
    await h.stream.start();

    h.sockets[0]?.emit({ e: "listenKeyExpired", E: 100 });

    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    expect(h.calls.filter((call) => call === "create")).toHaveLength(2);
  });
});

describe("private order and account events", () => {
  it("applies out-of-order fills by trade ID without status regression or double accounting", async () => {
    const h = harness();
    running.push(h.stream);
    await h.stream.start();

    h.sockets[0]?.emit(fillEvent(200, 2, "FILLED"));
    await vi.waitFor(async () => expect((await h.orders.getOrder("client-1"))?.executedQuantity).toBe("1"));
    h.sockets[0]?.emit(fillEvent(150, 1, "PARTIALLY_FILLED"));
    h.sockets[0]?.emit(fillEvent(200, 2, "FILLED"));
    await vi.waitFor(async () => expect((await h.orders.getOrder("client-1"))?.executedQuantity).toBe("2"));

    const latest = await h.orders.getOrder("client-1");
    expect(latest).toMatchObject({ status: "FILLED", executedQuantity: "2", commission: "0.02" });
    expect((await h.orders.listOpenPositions())[0]?.quantity).toBe("2");
  });

  it("freezes and reports an unknown manual order event without applying it", async () => {
    const h = harness({ withOrder: false });
    running.push(h.stream);
    await h.stream.start();

    h.sockets[0]?.emit(fillEvent(200, 2));

    await vi.waitFor(async () => expect((await h.store.listIssues()).length).toBe(1));
    expect((await h.store.listIssues())[0]?.category).toBe("UNKNOWN_MANUAL_ORDER");
    expect(h.calls.filter((call) => call === "pause").length).toBeGreaterThan(0);
  });

  it("stores only newer account events using exact signed REST balances", async () => {
    const h = harness();
    running.push(h.stream);
    await h.store.appendAccountSnapshot({
      asset: "USDT",
      walletBalance: "1000",
      availableBalance: "900",
      crossWalletBalance: "1000",
      observedAt: 100,
    });
    await h.stream.start();
    const event = {
      e: "ACCOUNT_UPDATE",
      E: 200,
      a: {
        B: [{ a: "USDT", wb: "1001.000000000000000000000000000002", cw: "1001", bc: "1.5" }],
        P: [],
      },
    };

    h.sockets[0]?.emit(event);
    await vi.waitFor(async () => expect((await h.store.latestAccountSnapshots())[0]?.observedAt).toBe(200));
    h.sockets[0]?.emit(event);
    h.sockets[0]?.emit({ ...event, E: 150 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await h.store.latestAccountSnapshots()).toEqual([{
      asset: "USDT",
      walletBalance: "1001.000000000000000000000000000002",
      availableBalance: "950.250000000000000000000000000001",
      crossWalletBalance: "1001",
      observedAt: 200,
    }]);
    expect(h.calls.filter((call) => call === "account")).toHaveLength(1);
  });
});
