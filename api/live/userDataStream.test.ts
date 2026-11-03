import { afterEach, describe, expect, it, vi } from "vitest";
import type { BinanceOpenOrder, LiveOrderGateway } from "./binanceSigned";
import { privateUserDataStreamUrl } from "./binanceSigned";
import { InMemoryReconciliationStore, LiveEntryAdmission, ReconciliationService } from "./reconciliation";
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
import { loadLiveIntentMetadata } from "./livePersistence";

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
  reconnectDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  intentMetadata?: {
    signalId: string;
    strategyType: "SWING" | "MOMENTUM";
    breakoutPrice: string | null;
  };
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
    loadIntentMetadata: async (currentOrder) => loadLiveIntentMetadata({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [options.intentMetadata ?? {
              signalId: "swing-persisted",
              strategyType: "SWING",
              breakoutPrice: null,
            }],
          }),
        }),
      }),
    } as never, currentOrder),
    reconcile: options.reconcile ?? (async () => {
      calls.push("reconcile");
      return { ok: true };
    }),
    pauseNewEntries: options.pause ?? (async () => { calls.push("pause"); }),
    keepAliveIntervalMs: 60_000,
    reconnectDelayMs: options.reconnectDelayMs ?? 0,
    sleep: options.sleep ?? (async () => undefined),
  });
  return { stream, sockets, calls, orders, store, client, machine };
}

const running: UserDataStream[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((stream) => stream.stop()));
  vi.useRealTimers();
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

  it("reports real running, connection and last-message health", async () => {
    const h = harness();
    running.push(h.stream);
    expect(h.stream.health()).toMatchObject({ configured: true, running: false, connected: false, lastMessageAt: null });

    await h.stream.start();
    expect(h.stream.health()).toMatchObject({ running: true, connected: true, reconnects: 0 });
    h.sockets[0].emit({ e: "ACCOUNT_UPDATE", E: 1_800_000_000_000, T: 1_800_000_000_000, a: { B: [{ a: "USDT" }], P: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.stream.health().lastMessageAt).toBe(1_800_000_000_000);
  });

  it("lets reconciliation own and resume admission after a non-owning stream suspension", async () => {
    const gate = new LiveEntryAdmission(true);
    const h = harness({
      withOrder: false,
      pause: () => gate.suspend(),
      reconcile: () => service.reconcile(),
    });
    const service = new ReconciliationService({
      client: {
        account: async () => ({ assets: [] }),
        positionRisk: async () => [],
        openOrders: async () => [],
      },
      orders: h.orders,
      store: h.store,
      recovery: { recover: async () => { throw new Error("unexpected"); } },
      accounting: { synchronize: async () => undefined },
      pauseNewEntries: () => gate.pauseForReconciliation(),
    });
    running.push(h.stream);

    await h.stream.start();

    expect(gate.allowed).toBe(true);
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

  it("backs off exponentially instead of hammering a failed reconciliation", async () => {
    const delays: number[] = [];
    const h = harness({
      reconnectDelayMs: 1_000,
      reconcile: async () => ({ ok: false }),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 3) await h.stream.stop();
      },
    });

    await h.stream.start();

    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(h.stream.health().running).toBe(false);
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

  it("retries ok:false without releasing events buffered by the failed attempt", async () => {
    let attempts = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const h = harness({
      reconcile: async () => {
        attempts += 1;
        if (attempts === 1) {
          await firstGate;
          return { ok: false };
        }
        await secondGate;
        return { ok: true };
      },
    });
    running.push(h.stream);
    const starting = h.stream.start();
    await vi.waitFor(() => expect(attempts).toBe(1));
    h.sockets[0]?.emit(fillEvent(200, 2));
    releaseFirst();
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect((await h.orders.getOrder("client-1"))?.executedQuantity).toBe("0");

    releaseSecond();
    await starting;

    expect(attempts).toBe(2);
    expect((await h.orders.getOrder("client-1"))?.executedQuantity).toBe("0");
  });

  it("does not install a socket when stop wins a pending listenKey request", async () => {
    const h = harness();
    running.push(h.stream);
    let release!: (value: { listenKey: string }) => void;
    h.client.createListenKey = () => new Promise((resolve) => { release = resolve; });
    const starting = h.stream.start();
    await Promise.resolve();

    await h.stream.stop();
    release({ listenKey: "late-key" });
    await starting;

    expect(h.sockets).toHaveLength(0);
  });

  it("does not release buffered events when stop wins pending reconciliation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ reconcile: async () => {
      await gate;
      return { ok: true };
    } });
    running.push(h.stream);
    const starting = h.stream.start();
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    h.sockets[0]?.emit(fillEvent(200, 2));

    await h.stream.stop();
    release();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect((await h.orders.getOrder("client-1"))?.executedQuantity).toBe("0");
  });

  it("invalidates admission ownership when stop abandons an in-flight reconciliation", async () => {
    const admission = new LiveEntryAdmission(true);
    let release!: () => void;
    let markStarted!: () => void;
    const accountGate = new Promise<void>((resolve) => { release = resolve; });
    const accountStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const h = harness({
      withOrder: false,
      pause: () => admission.suspend(),
      reconcile: () => service.reconcile(),
    });
    const service = new ReconciliationService({
      client: {
        account: async () => {
          markStarted();
          await accountGate;
          return { assets: [] };
        },
        positionRisk: async () => [],
        openOrders: async () => [],
      },
      orders: h.orders,
      store: h.store,
      recovery: { recover: async () => { throw new Error("unexpected"); } },
      accounting: { synchronize: async () => undefined },
      pauseNewEntries: () => admission.pauseForReconciliation(),
    });
    running.push(h.stream);
    const starting = h.stream.start();
    await accountStarted;

    await h.stream.stop();
    release();
    await starting;

    expect(admission.allowed).toBe(false);
  });

  it("installs exactly one keepalive when the start generation changes during reconciliation", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const h = harness({
      reconcile: async () => {
        attempts += 1;
        if (attempts === 1) h.sockets[0]?.disconnect();
        return { ok: true };
      },
    });
    running.push(h.stream);
    const starting = h.stream.start();
    await starting;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls.filter((call) => call === "keepAlive")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls.filter((call) => call === "keepAlive")).toHaveLength(2);
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

  it("loads persisted intent metadata into positions created by actual private fill events", async () => {
    const h = harness({
      intentMetadata: {
        signalId: "MOMENTUM:persisted-private-fill",
        strategyType: "MOMENTUM",
        breakoutPrice: "99.9",
      },
    });
    running.push(h.stream);
    await h.stream.start();

    h.sockets[0]?.emit(fillEvent(200, 2));
    await vi.waitFor(async () => expect((await h.orders.listOpenPositions()).length).toBe(1));

    expect(await h.orders.getPosition("intent-1")).toMatchObject({
      signalId: "MOMENTUM:persisted-private-fill",
      strategyType: "MOMENTUM",
      breakoutPrice: "99.9",
      exitPending: false,
    });
  });

  it("advances NEW to CANCELED when both events share a millisecond", async () => {
    const h = harness();
    running.push(h.stream);
    await h.stream.start();
    const created = fillEvent(100, 1, "NEW");
    created.o.l = "0";
    const cancelled = fillEvent(100, 2, "CANCELED");
    cancelled.o.l = "0";

    h.sockets[0]?.emit(created);
    h.sockets[0]?.emit(cancelled);

    await vi.waitFor(async () => expect((await h.orders.getOrder("client-1"))?.status).toBe("CANCEL"));
  });

  it("advances partial to final when both events share a millisecond", async () => {
    const h = harness();
    running.push(h.stream);
    await h.stream.start();
    const partial = fillEvent(100, 1, "PARTIALLY_FILLED");
    partial.o.l = "0";
    const filled = fillEvent(100, 2, "FILLED");
    filled.o.l = "0";

    h.sockets[0]?.emit(partial);
    h.sockets[0]?.emit(filled);

    await vi.waitFor(async () => expect((await h.orders.getOrder("client-1"))?.status).toBe("FILLED"));
    expect(await h.orders.listOpenPositions()).toEqual([]);
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
