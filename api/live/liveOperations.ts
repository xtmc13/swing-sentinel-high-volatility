import type { LiveOrderView, ReconciliationIssueView, UnsettledIntentView } from "@contracts/trading";
import type { LiveOrderStore } from "./orderStateMachine";
import type { ReconciliationStore } from "./reconciliation";

export interface LiveOperations {
  orders: LiveOrderView[];
  protectionOrders: LiveOrderView[];
  unsettledIntents: UnsettledIntentView[];
  reconciliationIssues: ReconciliationIssueView[];
}

function orderView(order: Awaited<ReturnType<LiveOrderStore["listOrders"]>>[number]): LiveOrderView {
  return {
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
  };
}

export async function readLiveOperations(
  orderStore: Pick<LiveOrderStore, "listRecentOrders" | "listActiveProtectionOrders">,
  reconciliationStore: Pick<ReconciliationStore, "listIssues" | "listUnsettledIntents">,
): Promise<LiveOperations> {
  const [orders, protectionOrders, unsettledIntents, issues] = await Promise.all([
    orderStore.listRecentOrders(60),
    orderStore.listActiveProtectionOrders(),
    reconciliationStore.listUnsettledIntents(100),
    reconciliationStore.listIssues(100),
  ]);
  return {
    orders: orders.map(orderView),
    protectionOrders: protectionOrders.map(orderView),
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
