import type { PlaceOrderRequest } from "./binanceSigned";
import type { LiveOrder } from "./orderStateMachine";

export interface OrderWireAccountMode {
  dualSide: boolean;
  multiAssets?: boolean;
  fingerprint: string;
}

export type OrderWireOrder = Pick<LiveOrder,
  "symbol" | "positionSide" | "entrySemantics" | "accountModeFingerprint" | "type"
  | "originalQuantity" | "price" | "stopPrice" | "clientOrderId">;

const ACCOUNT_FINGERPRINT = /^[0-9a-f]{64}$/;

export function buildOrderWire(order: OrderWireOrder, accountMode: OrderWireAccountMode): PlaceOrderRequest {
  if (!ACCOUNT_FINGERPRINT.test(accountMode.fingerprint)
    || typeof order.accountModeFingerprint !== "string"
    || !ACCOUNT_FINGERPRINT.test(order.accountModeFingerprint)
    || order.accountModeFingerprint !== accountMode.fingerprint) {
    throw new Error("Invalid or mismatched account mode fingerprint");
  }
  if (order.positionSide !== "LONG" && order.positionSide !== "SHORT") {
    throw new Error("Invalid order positionSide");
  }
  if (order.entrySemantics !== "ENTRY" && order.entrySemantics !== "REDUCE") {
    throw new Error("Invalid order entrySemantics");
  }

  const reducing = order.entrySemantics === "REDUCE";
  const entryBuy = order.positionSide === "LONG";
  const request: PlaceOrderRequest = {
    symbol: order.symbol,
    side: (reducing ? !entryBuy : entryBuy) ? "BUY" : "SELL",
    positionSide: accountMode.dualSide ? order.positionSide : "BOTH",
    type: order.type,
    quantity: order.originalQuantity,
    price: order.type === "MARKET" ? undefined : order.price,
    stopPrice: order.stopPrice ?? undefined,
    timeInForce: order.type === "LIMIT" ? "IOC" : undefined,
    newClientOrderId: order.clientOrderId,
  };
  if (!accountMode.dualSide && reducing) request.reduceOnly = true;
  return request;
}
