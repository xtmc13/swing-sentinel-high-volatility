import type { LiveOrderView, ReconciliationIssueView, UnsettledIntentView } from "@contracts/trading";
import type { LiveOrderStore } from "./orderStateMachine";
import type { ReconciliationStore } from "./reconciliation";

export interface LiveOperations {
  orders: LiveOrderView[];
  unsettledIntents: UnsettledIntentView[];
  reconciliationIssues: ReconciliationIssueView[];
}

export async function readLiveOperations(
  orderStore: Pick<LiveOrderStore, "listOrders">,
  reconciliationStore: Pick<ReconciliationStore, "listIssues" | "listUnsettledIntents">,
): Promise<LiveOperations> {
  const [orders, unsettledIntents, issues] = await Promise.all([
    orderStore.listOrders(),
    reconciliationStore.listUnsettledIntents(),
    reconciliationStore.listIssues(),
  ]);
  return {
    orders: orders.map((order) => ({
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
      executedQuantity: order.executedQuantity,
      averagePrice: order.averagePrice,
      commission: order.commission,
      reduceOnly: order.reduceOnly,
      createdAt: new Date(order.createdAt).toISOString(),
    })).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 60),
    unsettledIntents,
    reconciliationIssues: issues.map((issue) => ({
      id: issue.id,
      category: issue.category,
      severity: issue.severity,
      status: issue.status,
      symbol: issue.symbol,
      message: issue.message,
      detectedAt: new Date(issue.detectedAt).toISOString(),
    })),
  };
}
