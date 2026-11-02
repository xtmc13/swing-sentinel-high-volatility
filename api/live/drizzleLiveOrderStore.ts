import { and, eq } from "drizzle-orm";
import { liveFills, liveIntents, liveOrders, livePositions, tradingSettings } from "@db/schema";
import type { Side } from "@contracts/trading";
import { lockEmergencyGeneration, type LiveDatabase, type LiveTransaction } from "./livePersistence";
import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
} from "./decimal";
import {
  applyNewFill,
  type FillApplication,
  type LiveFill,
  type LiveOrder,
  type LiveOrderStatus,
  type LiveOrderStore,
  type LivePosition,
  type LivePositionSeed,
} from "./orderStateMachine";

type Reader = LiveDatabase | LiveTransaction;
type OrderRow = typeof liveOrders.$inferSelect;
type FillRow = typeof liveFills.$inferSelect;
type PositionRow = typeof livePositions.$inferSelect;

const EXACT_AVERAGE = { decimalPlaces: 30, roundingMode: "ROUND_HALF_UP" } as const;

function orderFromRows(row: OrderRow, fills: FillRow[]): LiveOrder {
  let executedQuantity = "0";
  let quote = "0";
  let commission = "0";
  for (const fill of fills) {
    if (fill.commissionAsset !== "USDT") throw new Error("Non-USDT commission requires reconciliation");
    executedQuantity = addDecimals(executedQuantity, fill.quantity);
    quote = addDecimals(quote, fill.quoteQuantity);
    commission = addDecimals(commission, fill.commission);
  }
  return {
    id: row.id,
    intentId: row.intentId,
    clientOrderId: row.clientOrderId,
    exchangeOrderId: row.exchangeOrderId,
    symbol: row.symbol,
    side: row.side as Side,
    type: row.type as LiveOrder["type"],
    status: row.status as LiveOrderStatus,
    price: row.price,
    stopPrice: row.type === "STOP_MARKET" ? row.price : null,
    originalQuantity: row.originalQuantity,
    executedQuantity,
    averagePrice: compareDecimals(executedQuantity, "0") > 0
      ? divideDecimals(quote, executedQuantity, EXACT_AVERAGE) : "0",
    commission,
    reduceOnly: row.reduceOnly,
    createdAt: row.createdAt.getTime(),
  };
}

function positionFromRow(row: PositionRow, stopPrice: string): LivePosition {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side as Side,
    status: row.status as LivePosition["status"],
    initialQuantity: row.initialQuantity,
    quantity: row.quantity,
    entryPrice: row.entryPrice,
    markPrice: row.markPrice,
    stopPrice,
    liquidationPrice: row.liquidationPrice,
    isolatedWallet: row.isolatedWallet,
    leverage: row.leverage,
    maintenanceBracket: row.maintenanceBracket,
    maintMarginRatio: row.maintMarginRatio,
    cumMaintenance: row.cumMaintenance,
    openedAt: row.openedAt.getTime(),
    closedAt: row.closedAt?.getTime() ?? null,
  };
}

async function readOrder(db: Reader, clientOrderId: string, lock = false): Promise<LiveOrder | null> {
    const query = db.select().from(liveOrders).where(eq(liveOrders.clientOrderId, clientOrderId)).limit(1);
    const rows = await (lock ? query.for("update") : query);
    const row = rows[0];
    if (!row) return null;
    const fills = await db.select().from(liveFills).where(eq(liveFills.orderId, row.id));
    return orderFromRows(row, fills);
}

async function readPosition(db: Reader, positionId: string, lock = false): Promise<LivePosition | null> {
    const query = db.select().from(livePositions).where(eq(livePositions.id, positionId)).limit(1);
    const rows = await (lock ? query.for("update") : query);
    if (!rows[0]) return null;
    const intents = await db.select({ stopPrice: liveIntents.stopPrice }).from(liveIntents)
      .where(eq(liveIntents.id, positionId)).limit(1);
    if (!intents[0]) throw new Error("Live position intent is missing");
    return positionFromRow(rows[0], intents[0].stopPrice);
}

export class DrizzleLiveOrderStore implements LiveOrderStore {
  constructor(private readonly db: LiveDatabase) {}

  async insertOrder(order: LiveOrder): Promise<void> {
    await this.db.insert(liveOrders).values({
      id: order.id,
      intentId: order.intentId,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: order.status,
      price: order.price,
      originalQuantity: order.originalQuantity,
      executedQuantity: "0",
      reduceOnly: order.reduceOnly,
      createdAt: new Date(order.createdAt),
    });
  }

  getOrder(clientOrderId: string): Promise<LiveOrder | null> {
    return readOrder(this.db, clientOrderId);
  }

  async listOrders(): Promise<LiveOrder[]> {
    const rows = await this.db.select().from(liveOrders);
    return Promise.all(rows.map((row) => readOrder(this.db, row.clientOrderId) as Promise<LiveOrder>));
  }

  async transitionOrder(
    clientOrderId: string,
    expectedStatuses: LiveOrderStatus[],
    patch: Partial<LiveOrder>,
  ): Promise<LiveOrder | null> {
    return this.db.transaction(async (tx) => {
      const current = await readOrder(tx, clientOrderId, true);
      if (!current || !expectedStatuses.includes(current.status)) return null;
      await tx.update(liveOrders).set({
        status: patch.status ?? current.status,
        exchangeOrderId: patch.exchangeOrderId === undefined ? current.exchangeOrderId : patch.exchangeOrderId,
      }).where(eq(liveOrders.id, current.id));
      if (patch.status && !current.reduceOnly) {
        await tx.update(liveIntents).set({ status: patch.status }).where(eq(liveIntents.id, current.intentId));
      }
      return readOrder(tx, clientOrderId);
    });
  }

  async createReplacement(
    parentClientOrderId: string,
    expectedExecutedQuantity: string,
    replacement: LiveOrder,
    expectedPositionQuantity?: string,
  ): Promise<LiveOrder | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const parent = await readOrder(tx, parentClientOrderId, true);
        if (!parent || parent.status !== "CANCEL"
          || compareDecimals(parent.executedQuantity, expectedExecutedQuantity) !== 0) return null;
        if (expectedPositionQuantity !== undefined) {
          const position = await readPosition(tx, parent.intentId, true);
          if (!position || compareDecimals(position.quantity, expectedPositionQuantity) !== 0) return null;
        }
        await tx.insert(liveOrders).values({
          id: replacement.id,
          intentId: replacement.intentId,
          clientOrderId: replacement.clientOrderId,
          exchangeOrderId: replacement.exchangeOrderId,
          symbol: replacement.symbol,
          side: replacement.side,
          type: replacement.type,
          status: replacement.status,
          price: replacement.price,
          originalQuantity: replacement.originalQuantity,
          executedQuantity: "0",
          reduceOnly: replacement.reduceOnly,
          createdAt: new Date(replacement.createdAt),
        });
        return replacement;
      });
    } catch (error) {
      const existing = await this.getOrder(replacement.clientOrderId);
      if (existing) return existing;
      throw error;
    }
  }

  async admitOrder(clientOrderId: string, expectedGeneration: number): Promise<LiveOrder> {
    return this.db.transaction(async (tx) => {
      const current = await readOrder(tx, clientOrderId, true);
      if (!current) throw new Error("Live order not found");
      if (current.status !== "PENDING_SEND") return current;
      const settings = await tx.select({ autoTrade: tradingSettings.autoTrade }).from(tradingSettings)
        .where(eq(tradingSettings.id, 1)).for("update");
      const generation = await lockEmergencyGeneration(tx);
      const intents = await tx.select({ status: liveIntents.status }).from(liveIntents)
        .where(eq(liveIntents.id, current.intentId)).for("update");
      const emergencyCancelled = intents[0]?.status === "CANCEL";
      if (emergencyCancelled || !settings[0]?.autoTrade || generation !== expectedGeneration
        || intents[0]?.status !== "PENDING_SEND") {
        await tx.update(liveOrders).set({ status: "CANCEL" }).where(eq(liveOrders.id, current.id));
        return { ...current, status: "CANCEL" };
      }
      await tx.update(liveOrders).set({ status: "SUBMITTING" }).where(eq(liveOrders.id, current.id));
      await tx.update(liveIntents).set({ status: "SUBMITTING" }).where(eq(liveIntents.id, current.intentId));
      return { ...current, status: "SUBMITTING" };
    });
  }

  async applyFill(orderId: string, fill: LiveFill, seed: LivePositionSeed): Promise<FillApplication> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(liveOrders).where(eq(liveOrders.id, orderId)).limit(1).for("update");
      const row = rows[0];
      if (!row) throw new Error("Live order not found");
      const currentOrder = await readOrder(tx, row.clientOrderId);
      if (!currentOrder) throw new Error("Live order not found");
      const duplicates = await tx.select({ id: liveFills.id }).from(liveFills).where(and(
        eq(liveFills.symbol, fill.symbol),
        eq(liveFills.exchangeTradeId, fill.exchangeTradeId),
      )).limit(1);
      if (duplicates.length) {
        return { order: currentOrder, position: await readPosition(tx, seed.id), inserted: false };
      }
      const currentPosition = await readPosition(tx, seed.id, true);
      const next = applyNewFill(currentOrder, currentPosition, fill, seed);
      await tx.insert(liveFills).values({
        id: crypto.randomUUID(),
        orderId,
        exchangeTradeId: fill.exchangeTradeId,
        exchangeOrderId: fill.exchangeOrderId,
        symbol: fill.symbol,
        side: fill.side,
        price: fill.price,
        quantity: fill.quantity,
        quoteQuantity: multiplyDecimals(fill.price, fill.quantity),
        commission: fill.commission,
        commissionAsset: fill.commissionAsset,
        realizedPnl: fill.realizedPnl,
        isMaker: fill.isMaker,
        executedAt: new Date(fill.executedAt),
      });
      await tx.update(liveOrders).set({
        status: next.order.status,
        exchangeOrderId: next.order.exchangeOrderId,
        executedQuantity: next.order.executedQuantity,
      }).where(eq(liveOrders.id, orderId));
      if (!next.order.reduceOnly) {
        await tx.update(liveIntents).set({ status: next.order.status }).where(eq(liveIntents.id, next.order.intentId));
      }
      await tx.insert(livePositions).values({
        id: next.position.id,
        symbol: next.position.symbol,
        side: next.position.side,
        status: next.position.status,
        initialQuantity: next.position.initialQuantity,
        quantity: next.position.quantity,
        entryPrice: next.position.entryPrice,
        markPrice: next.position.markPrice,
        liquidationPrice: next.position.liquidationPrice,
        isolatedWallet: next.position.isolatedWallet,
        leverage: next.position.leverage,
        maintenanceBracket: next.position.maintenanceBracket,
        maintMarginRatio: next.position.maintMarginRatio,
        cumMaintenance: next.position.cumMaintenance,
        openedAt: new Date(next.position.openedAt),
        closedAt: next.position.closedAt === null ? null : new Date(next.position.closedAt),
      }).onDuplicateKeyUpdate({
        set: {
          status: next.position.status,
          initialQuantity: next.position.initialQuantity,
          quantity: next.position.quantity,
          entryPrice: next.position.entryPrice,
          markPrice: next.position.markPrice,
          liquidationPrice: next.position.liquidationPrice,
          isolatedWallet: next.position.isolatedWallet,
          leverage: next.position.leverage,
          maintenanceBracket: next.position.maintenanceBracket,
          maintMarginRatio: next.position.maintMarginRatio,
          cumMaintenance: next.position.cumMaintenance,
          openedAt: new Date(next.position.openedAt),
          closedAt: next.position.closedAt === null ? null : new Date(next.position.closedAt),
        },
      });
      return { order: next.order, position: next.position, inserted: true };
    });
  }

  getPosition(positionId: string): Promise<LivePosition | null> {
    return readPosition(this.db, positionId);
  }

  async listOpenPositions(): Promise<LivePosition[]> {
    const rows = await this.db.select().from(livePositions).where(eq(livePositions.status, "OPEN"));
    return Promise.all(rows.map(async (row) => {
      const intents = await this.db.select({ stopPrice: liveIntents.stopPrice }).from(liveIntents)
        .where(eq(liveIntents.id, row.id)).limit(1);
      if (!intents[0]) throw new Error("Live position intent is missing");
      return positionFromRow(row, intents[0].stopPrice);
    }));
  }
}
