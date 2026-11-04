import type { LeverageMode } from "@contracts/trading";
import type {
  BinanceExchangeInfoResponse,
  BinanceLeverageBracket,
  BinanceMultiAssetsMarginResponse,
  BinanceOpenOrder,
  BinancePositionRisk,
  BinancePositionSideResponse,
} from "./binanceSigned";
import { compareDecimals, type DecimalString } from "./decimal";

export interface LivePreflightClient {
  positionSide(): Promise<BinancePositionSideResponse>;
  multiAssetsMargin(): Promise<BinanceMultiAssetsMarginResponse>;
  positionRisk(symbol?: string): Promise<BinancePositionRisk[]>;
  openOrders(symbol?: string): Promise<BinanceOpenOrder[]>;
  leverageBracket(symbol?: string): Promise<BinanceLeverageBracket[]>;
  exchangeInfo(symbol?: string): Promise<BinanceExchangeInfoResponse>;
}

export interface LiveReconciliationIssue {
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
}

export interface LivePreflightInput {
  client: LivePreflightClient;
  symbol: string;
  allowedSymbols: string[];
  leverageMode: LeverageMode;
  fixedLeverage: number;
  reconciliationIssues: LiveReconciliationIssue[];
  ownedClientOrderIds?: string[];
  managedPositionSymbols?: string[];
}

export interface LiveContractFilters {
  tickSize: DecimalString;
  stepSize: DecimalString;
  minQuantity: DecimalString;
  minNotional: DecimalString;
}

export type LivePreflightResult =
  | { ok: false; reasons: string[] }
  | {
      ok: true;
      filters: LiveContractFilters;
      brackets: BinanceLeverageBracket["brackets"];
      positionRisk: BinancePositionRisk;
      positions: BinancePositionRisk[];
    };

function filterValue(
  contract: BinanceExchangeInfoResponse["symbols"][number],
  filterType: string,
  key: string,
): DecimalString | null {
  const filter = contract.filters.find((candidate) => candidate.filterType === filterType);
  const value = filter?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function runLivePreflight(input: LivePreflightInput): Promise<LivePreflightResult> {
  const [positionSide, multiAssets, positions, orders, leverageBrackets, exchangeInfo] = await Promise.all([
    input.client.positionSide(),
    input.client.multiAssetsMargin(),
    input.client.positionRisk(),
    input.client.openOrders(),
    input.client.leverageBracket(input.symbol),
    input.client.exchangeInfo(input.symbol),
  ]);
  const reasons: string[] = [];
  if (positionSide.dualSidePosition) reasons.push("账户必须启用 one-way 模式");
  if (multiAssets.multiAssetsMargin) reasons.push("账户必须关闭 multi-assets 模式");
  if (!input.allowedSymbols.includes(input.symbol)) reasons.push(`${input.symbol} 不在主网合约白名单`);
  if (input.leverageMode !== "FIXED" || !Number.isInteger(input.fixedLeverage)
    || input.fixedLeverage < 1 || input.fixedLeverage > 20) {
    reasons.push("主网必须明确配置 1–20 的固定低杠杆，禁止 SYMBOL_MAX");
  }

  const contract = exchangeInfo.symbols.find((candidate) => candidate.symbol === input.symbol);
  if (!contract) reasons.push("交易所未返回目标合约");
  else {
    if (contract.contractType !== "PERPETUAL" || contract.quoteAsset !== "USDT"
      || contract.marginAsset !== "USDT") {
      reasons.push("仅允许 USDT 本位永续合约");
    }
    if (contract.status !== "TRADING") reasons.push("目标合约当前不可交易");
  }

  const positionRisk = positions.find((candidate) => candidate.symbol === input.symbol);
  if (!positionRisk) reasons.push("缺少目标合约的真实持仓与杠杆数据");
  else {
    if (positionRisk.marginType.toLowerCase() !== "isolated") reasons.push("目标合约必须使用 isolated margin");
    if (compareDecimals(positionRisk.leverage, String(input.fixedLeverage)) !== 0) {
      reasons.push("交易所实际杠杆与固定杠杆配置不符");
    }
  }

  const managedSymbols = new Set(input.managedPositionSymbols ?? []);
  const externalPositions = positions.filter((position) => compareDecimals(position.positionAmt, "0") !== 0
    && !managedSymbols.has(position.symbol));
  if (externalPositions.length > 0) {
    reasons.push(`存在未知外部持仓：${externalPositions.map((position) => position.symbol).join(",")}`);
  }
  const ownedOrderIds = new Set(input.ownedClientOrderIds ?? []);
  const externalOrders = orders.filter((order) => !ownedOrderIds.has(order.clientOrderId));
  if (externalOrders.length > 0) {
    reasons.push(`存在人工或外部订单：${externalOrders.map((order) => order.clientOrderId).join(",")}`);
  }
  if (input.reconciliationIssues.some((issue) => issue.status !== "RESOLVED"
    && (issue.severity === "CRITICAL" || issue.severity === "ERROR"))) {
    reasons.push("存在未解决的严重对账问题");
  }

  const brackets = leverageBrackets.find((candidate) => candidate.symbol === input.symbol)?.brackets;
  if (!brackets?.length) reasons.push("缺少真实维持保证金档位");
  const filters = contract ? {
    tickSize: filterValue(contract, "PRICE_FILTER", "tickSize"),
    stepSize: filterValue(contract, "LOT_SIZE", "stepSize"),
    minQuantity: filterValue(contract, "LOT_SIZE", "minQty"),
    minNotional: filterValue(contract, "MIN_NOTIONAL", "notional"),
  } : null;
  if (!filters?.tickSize || !filters.stepSize || !filters.minQuantity || !filters.minNotional) {
    reasons.push("合约价格、数量或最小名义价值过滤值不完整");
  }

  if (reasons.length > 0 || !positionRisk || !brackets || !filters?.tickSize
    || !filters.stepSize || !filters.minQuantity || !filters.minNotional) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    filters: {
      tickSize: filters.tickSize,
      stepSize: filters.stepSize,
      minQuantity: filters.minQuantity,
      minNotional: filters.minNotional,
    },
    brackets,
    positionRisk,
    positions,
  };
}
