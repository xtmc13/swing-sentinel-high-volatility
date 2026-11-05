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
  if (typeof positionSide.dualSidePosition !== "boolean"
    || typeof multiAssets.multiAssetsMargin !== "boolean") {
    reasons.push("账户 positionSide 或 multi-assets 模式响应不完整");
  }
  if (!input.allowedSymbols.includes(input.symbol)) reasons.push(`${input.symbol} 不在主网合约白名单`);
  if (input.leverageMode !== "FIXED" && input.leverageMode !== "ACCOUNT_CONFIGURED") {
    reasons.push("主网禁止使用 SYMBOL_MAX，必须选择 FIXED 或 ACCOUNT_CONFIGURED");
  }
  if (input.leverageMode === "FIXED"
    && (!Number.isInteger(input.fixedLeverage) || input.fixedLeverage < 1)) {
    reasons.push("主网固定杠杆必须为正整数");
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

  const targetPositions = positions.filter((candidate) => candidate.symbol === input.symbol);
  const positionRisk = targetPositions[0];
  if (!positionRisk) reasons.push("缺少目标合约的真实持仓与杠杆数据");
  else {
    const marginType = positionRisk.marginType.toLowerCase();
    if (marginType !== "isolated" && marginType !== "cross") {
      reasons.push("目标合约 marginType 必须为 isolated 或 cross");
    }
    const actualLeverage = Number(positionRisk.leverage);
    if (!Number.isInteger(actualLeverage) || actualLeverage < 1) {
      reasons.push("交易所实际杠杆必须为正整数");
    } else if (input.leverageMode === "FIXED"
      && compareDecimals(positionRisk.leverage, String(input.fixedLeverage)) !== 0) {
      reasons.push("交易所实际杠杆与固定杠杆配置不符");
    }
    if (targetPositions.some((candidate) => compareDecimals(candidate.leverage, positionRisk.leverage) !== 0
      || candidate.marginType.toLowerCase() !== marginType)) {
      reasons.push("目标合约不同 positionSide 的杠杆或 marginType 不一致");
    }
    if (positionSide.dualSidePosition
      && targetPositions.some((candidate) => candidate.positionSide !== "LONG" && candidate.positionSide !== "SHORT")) {
      reasons.push("双向模式缺少目标合约 LONG/SHORT positionSide");
    }
    if (!positionSide.dualSidePosition
      && targetPositions.some((candidate) => candidate.positionSide !== undefined && candidate.positionSide !== "BOTH")) {
      reasons.push("单向模式目标合约 positionSide 必须为 BOTH");
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
