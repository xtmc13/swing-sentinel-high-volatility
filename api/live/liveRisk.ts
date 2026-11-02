import type { Side } from "@contracts/trading";
import type { BinanceLeverageBracket } from "./binanceSigned";
import {
  addDecimals,
  compareDecimals,
  decimal,
  divideDecimals,
  floorToStep,
  multiplyDecimals,
  subtractDecimals,
  type DecimalString,
} from "./decimal";

export interface LiveIntentReservation {
  margin: DecimalString;
  risk: DecimalString;
}

export interface LiveRiskInput {
  side: Side;
  walletBalance: DecimalString;
  availableBalance: DecimalString;
  entryPrice: DecimalString;
  stopPrice: DecimalString;
  liquidationPrice: DecimalString;
  actualLeverage: DecimalString;
  leverageMode: "SYMBOL_MAX" | "FIXED";
  fixedLeverage: number;
  riskPerTradePct: number;
  marginPerTradePct: number;
  totalMarginCapPct: number;
  takerFeeBps: number;
  slippageBps: number;
  stepSize: DecimalString;
  minQuantity: DecimalString;
  minNotional: DecimalString;
  brackets: BinanceLeverageBracket["brackets"];
  pendingIntents: LiveIntentReservation[];
  existingPositionMargin: DecimalString;
  existingExposure: DecimalString;
}

export type LiveRiskResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      quantity: DecimalString;
      notional: DecimalString;
      totalExposure: DecimalString;
      initialMargin: DecimalString;
      maintenanceMargin: DecimalString;
      estimatedRisk: DecimalString;
      reservedMargin: DecimalString;
      reservedRisk: DecimalString;
      bracket: number;
    };

const EXACT_DIVISION = { decimalPlaces: 30, roundingMode: "ROUND_DOWN" } as const;

function percentage(value: DecimalString, pct: number): DecimalString {
  return divideDecimals(multiplyDecimals(value, String(pct)), "100", EXACT_DIVISION);
}

function minimum(...values: DecimalString[]): DecimalString {
  return values.reduce((left, right) => compareDecimals(left, right) <= 0 ? left : right);
}

export function calculateLivePositionRisk(input: LiveRiskInput): LiveRiskResult {
  if (input.leverageMode !== "FIXED") return { ok: false, reason: "主网禁止 SYMBOL_MAX，必须明确固定杠杆" };
  if (!Number.isInteger(input.fixedLeverage) || input.fixedLeverage < 1 || input.fixedLeverage > 20) {
    return { ok: false, reason: "主网固定杠杆必须在 1–20 之间" };
  }
  if (compareDecimals(input.actualLeverage, String(input.fixedLeverage)) !== 0) {
    return { ok: false, reason: "交易所实际杠杆与固定杠杆配置不符" };
  }
  const percentages = [
    input.riskPerTradePct,
    input.marginPerTradePct,
    input.totalMarginCapPct,
    input.takerFeeBps,
    input.slippageBps,
  ];
  if (!percentages.every(Number.isFinite) || percentages.some((value) => value < 0)) {
    return { ok: false, reason: "主网风险配置无效" };
  }

  try {
    const entryPrice = decimal(input.entryPrice);
    const stopPrice = decimal(input.stopPrice);
    const liquidationPrice = decimal(input.liquidationPrice);
    if (compareDecimals(entryPrice, "0") <= 0 || compareDecimals(stopPrice, "0") <= 0
      || compareDecimals(liquidationPrice, "0") <= 0) {
      return { ok: false, reason: "价格必须为正数" };
    }
    const stopDistance = input.side === "LONG"
      ? subtractDecimals(entryPrice, stopPrice)
      : subtractDecimals(stopPrice, entryPrice);
    const liquidationBuffer = input.side === "LONG"
      ? subtractDecimals(stopPrice, liquidationPrice)
      : subtractDecimals(liquidationPrice, stopPrice);
    if (compareDecimals(stopDistance, "0") <= 0 || compareDecimals(liquidationBuffer, "0") <= 0) {
      return { ok: false, reason: "止损方向或真实强平缓冲无效" };
    }

    const reservedMargin = addDecimals(...input.pendingIntents.map((intent) => intent.margin));
    const reservedRisk = addDecimals(...input.pendingIntents.map((intent) => intent.risk));
    const remainingRisk = subtractDecimals(percentage(input.walletBalance, input.riskPerTradePct), reservedRisk);
    const remainingCap = subtractDecimals(
      percentage(input.walletBalance, input.totalMarginCapPct),
      addDecimals(input.existingPositionMargin, reservedMargin),
    );
    const remainingAvailable = subtractDecimals(input.availableBalance, reservedMargin);
    const marginLimit = minimum(
      percentage(input.walletBalance, input.marginPerTradePct),
      remainingCap,
      remainingAvailable,
    );
    if (compareDecimals(remainingRisk, "0") <= 0 || compareDecimals(marginLimit, "0") <= 0) {
      return { ok: false, reason: "待成交意图预留后无可用风险或保证金额度" };
    }

    const twoSidedCostPerUnit = divideDecimals(
      multiplyDecimals(
        addDecimals(entryPrice, stopPrice),
        addDecimals(String(input.takerFeeBps), String(input.slippageBps)),
      ),
      "10000",
      EXACT_DIVISION,
    );
    const riskPerUnit = addDecimals(stopDistance, twoSidedCostPerUnit);
    const quantityByRisk = divideDecimals(remainingRisk, riskPerUnit, EXACT_DIVISION);
    const quantityByMargin = divideDecimals(
      multiplyDecimals(marginLimit, String(input.fixedLeverage)),
      entryPrice,
      EXACT_DIVISION,
    );
    const quantity = floorToStep(minimum(quantityByRisk, quantityByMargin), input.stepSize);
    if (compareDecimals(quantity, input.minQuantity) < 0 || compareDecimals(quantity, "0") <= 0) {
      return { ok: false, reason: "数量低于最小下单单位" };
    }

    const notional = multiplyDecimals(quantity, entryPrice);
    if (compareDecimals(notional, input.minNotional) < 0) {
      return { ok: false, reason: "名义价值低于交易所最小值" };
    }
    const totalExposure = addDecimals(input.existingExposure, notional);
    const bracket = [...input.brackets]
      .sort((left, right) => left.bracket - right.bracket)
      .find((candidate) => compareDecimals(totalExposure, candidate.notionalFloor) >= 0
        && compareDecimals(totalExposure, candidate.notionalCap) <= 0);
    if (!bracket) return { ok: false, reason: "总名义价值超出真实维持保证金档位" };
    if (input.fixedLeverage > bracket.initialLeverage) {
      return { ok: false, reason: "固定杠杆超过实际档位允许值" };
    }

    const initialMargin = divideDecimals(notional, String(input.fixedLeverage), EXACT_DIVISION);
    const maintenanceMargin = minimum(
      subtractDecimals(multiplyDecimals(totalExposure, bracket.maintMarginRatio), bracket.cum),
      totalExposure,
    );
    if (compareDecimals(initialMargin, marginLimit) > 0) {
      return { ok: false, reason: "初始保证金超过可用预留额度" };
    }
    return {
      ok: true,
      quantity,
      notional,
      totalExposure,
      initialMargin,
      maintenanceMargin: compareDecimals(maintenanceMargin, "0") < 0 ? "0" : maintenanceMargin,
      estimatedRisk: multiplyDecimals(quantity, riskPerUnit),
      reservedMargin,
      reservedRisk,
      bracket: bracket.bracket,
    };
  } catch {
    return { ok: false, reason: "主网十进制风险输入无效" };
  }
}
