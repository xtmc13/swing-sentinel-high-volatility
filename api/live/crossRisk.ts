import type { Side } from "@contracts/trading";
import type { BinanceLeverageBracket, BinancePositionRisk } from "./binanceSigned";
import {
  addDecimals,
  ceilToStep,
  compareDecimals,
  decimal,
  divideDecimals,
  floorToStep,
  multiplyDecimals,
  subtractDecimals,
  type DecimalString,
} from "./decimal";

export interface CrossRiskPosition {
  remote: BinancePositionRisk;
  brackets: BinanceLeverageBracket["brackets"];
}

export interface CrossRiskSnapshot {
  crossWalletBalance: DecimalString;
  crossUnrealizedPnl: DecimalString;
  positions: CrossRiskPosition[];
  multiAssets: boolean;
  observedAt: number;
  collateral?: {
    haircut: DecimalString;
    observedAt: number;
  };
  relatedPendingIntents?: number;
}

export interface CrossLiquidationCandidate {
  symbol: string;
  side: Side;
  quantity: DecimalString;
  entryPrice: DecimalString;
  stopPrice: DecimalString;
  tickSize: DecimalString;
  brackets: BinanceLeverageBracket["brackets"];
}

export type CrossLiquidationBoundary =
  | { ok: false; reason: string }
  | {
      ok: true;
      liquidationPrice: DecimalString | null;
      noPositiveRoot: boolean;
      liquidationPriceSource: "PRETRADE_ESTIMATE";
      maintenanceBracket: number | null;
    };

type Bracket = BinanceLeverageBracket["brackets"][number];

const ROOT_DIVISION = { decimalPlaces: 30, roundingMode: "ROUND_HALF_UP" } as const;

export function selectUniqueCrossBracket(brackets: Bracket[], notional: DecimalString): Bracket | null {
  const sorted = [...brackets].sort((left, right) => compareDecimals(left.notionalFloor, right.notionalFloor)
    || left.bracket - right.bracket);
  const matches = sorted.filter((bracket, index) => compareDecimals(notional, bracket.notionalFloor) >= 0
    && (compareDecimals(notional, bracket.notionalCap) < 0
      || (index === sorted.length - 1 && compareDecimals(notional, bracket.notionalCap) === 0)));
  return matches.length === 1 ? matches[0] : null;
}

function maintenance(quantity: DecimalString, price: DecimalString, bracket: {
  maintMarginRatio: DecimalString;
  cum: DecimalString;
}): DecimalString {
  const value = subtractDecimals(multiplyDecimals(multiplyDecimals(quantity, price), bracket.maintMarginRatio), bracket.cum);
  return compareDecimals(value, "0") < 0 ? "0" : value;
}

function adverse(price: DecimalString, entryPrice: DecimalString, side: Side): boolean {
  const comparison = compareDecimals(price, entryPrice);
  return side === "LONG" ? comparison < 0 : comparison > 0;
}

function stopPrecedes(stopPrice: DecimalString, boundary: DecimalString, side: Side): boolean {
  const comparison = compareDecimals(stopPrice, boundary);
  return side === "LONG" ? comparison > 0 : comparison < 0;
}

function reject(reason: string): CrossLiquidationBoundary {
  return { ok: false, reason };
}

export function estimateCrossLiquidationBoundary(
  snapshot: CrossRiskSnapshot,
  candidate: CrossLiquidationCandidate,
): CrossLiquidationBoundary {
  if (!Number.isSafeInteger(snapshot.observedAt)) return reject("Cross 快照时间无效");
  if (snapshot.relatedPendingIntents !== undefined
    && (!Number.isSafeInteger(snapshot.relatedPendingIntents) || snapshot.relatedPendingIntents < 0)) {
    return reject("Cross 相关待成交意图数量无效");
  }
  if ((snapshot.relatedPendingIntents ?? 0) > 0) {
    return reject("存在相关 cross 待成交意图，未显式模拟其成交后敏感性");
  }

  try {
    const entryPrice = decimal(candidate.entryPrice);
    const stopPrice = decimal(candidate.stopPrice);
    const quantity = decimal(candidate.quantity);
    const tickSize = decimal(candidate.tickSize);
    if (compareDecimals(entryPrice, "0") <= 0 || compareDecimals(stopPrice, "0") <= 0
      || compareDecimals(quantity, "0") <= 0 || compareDecimals(tickSize, "0") <= 0) {
      return reject("Cross 候选价格、数量和 tick 必须为正数");
    }
    const stopDistance = candidate.side === "LONG"
      ? subtractDecimals(entryPrice, stopPrice) : subtractDecimals(stopPrice, entryPrice);
    if (compareDecimals(stopDistance, "0") <= 0) return reject("Cross 候选止损方向无效");

    let walletBalance = decimal(snapshot.crossWalletBalance);
    const unrealizedPnl = decimal(snapshot.crossUnrealizedPnl);
    if (snapshot.multiAssets) {
      if (!snapshot.collateral) return reject("多资产 cross 缺少可验证的抵押品折算率");
      const haircut = decimal(snapshot.collateral.haircut);
      if (!Number.isSafeInteger(snapshot.collateral.observedAt)
        || snapshot.collateral.observedAt < snapshot.observedAt
        || snapshot.collateral.observedAt - snapshot.observedAt > 10_000
        || compareDecimals(haircut, "0") <= 0 || compareDecimals(haircut, "1") > 0) {
        return reject("多资产 cross 抵押品折算率缺失、陈旧或无效");
      }
      walletBalance = multiplyDecimals(walletBalance, haircut);
    }

    let calculatedUnrealizedPnl: DecimalString = "0";
    let existingMaintenance: DecimalString = "0";
    const identities = new Set<string>();
    for (const position of snapshot.positions) {
      const marginType = position.remote.marginType.toLowerCase();
      if (marginType !== "cross" && marginType !== "isolated") return reject("持仓 marginType 无效");
      if (marginType !== "cross" || compareDecimals(position.remote.positionAmt, "0") === 0) continue;
      const signedQuantity = decimal(position.remote.positionAmt);
      const absoluteQuantity = compareDecimals(signedQuantity, "0") < 0
        ? subtractDecimals("0", signedQuantity) : signedQuantity;
      const markPrice = decimal(position.remote.markPrice);
      const positionEntry = decimal(position.remote.entryPrice);
      const currentNotional = multiplyDecimals(absoluteQuantity, markPrice);
      const currentBracket = selectUniqueCrossBracket(position.brackets, currentNotional);
      if (!currentBracket) {
        return reject(`${position.remote.symbol} 当前 cross 名义价值档位缺失或有歧义`);
      }
      const maintMarginRatio = decimal(currentBracket.maintMarginRatio);
      const cumMaintenance = decimal(currentBracket.cum);
      if (compareDecimals(markPrice, "0") <= 0 || compareDecimals(positionEntry, "0") < 0
        || compareDecimals(maintMarginRatio, "0") < 0 || compareDecimals(cumMaintenance, "0") < 0) {
        return reject(`${position.remote.symbol} cross 持仓维持保证金数据无效`);
      }
      if ((position.remote.positionSide === "LONG" && compareDecimals(signedQuantity, "0") < 0)
        || (position.remote.positionSide === "SHORT" && compareDecimals(signedQuantity, "0") > 0)) {
        return reject(`${position.remote.symbol} positionSide 与持仓数量方向不一致`);
      }
      const identity = `${position.remote.symbol}:${position.remote.positionSide ?? "BOTH"}`;
      if (identities.has(identity)) return reject(`${identity} cross 持仓腿不唯一`);
      identities.add(identity);
      if (position.remote.symbol === candidate.symbol) {
        return reject("目标合约已有 cross 持仓，必须先显式合并成交后目标腿");
      }
      calculatedUnrealizedPnl = addDecimals(calculatedUnrealizedPnl, multiplyDecimals(
        signedQuantity, subtractDecimals(markPrice, positionEntry),
      ));
      existingMaintenance = addDecimals(existingMaintenance, maintenance(absoluteQuantity, markPrice, {
        maintMarginRatio, cum: cumMaintenance,
      }));
    }
    if (compareDecimals(calculatedUnrealizedPnl, unrealizedPnl) !== 0) {
      return reject("Cross uPnL 与全部 cross 持仓腿不一致");
    }

    const brackets = [...candidate.brackets].sort((left, right) => left.bracket - right.bracket);
    if (brackets.length === 0) return reject("缺少候选成交后的维持保证金档位");
    for (const bracket of brackets) {
      decimal(bracket.notionalFloor);
      decimal(bracket.notionalCap);
      decimal(bracket.maintMarginRatio);
      decimal(bracket.cum);
      if (!Number.isInteger(bracket.bracket) || bracket.bracket < 1
        || compareDecimals(bracket.notionalFloor, "0") < 0
        || compareDecimals(bracket.notionalCap, bracket.notionalFloor) < 0
        || compareDecimals(bracket.maintMarginRatio, "0") < 0
        || compareDecimals(bracket.cum, "0") < 0) {
        return reject("候选维持保证金档位无效");
      }
    }
    const entryNotional = multiplyDecimals(quantity, entryPrice);
    const entryBracket = selectUniqueCrossBracket(brackets, entryNotional);
    if (!entryBracket) return reject("候选成交名义价值档位缺失或有歧义");
    const entryBrackets = [entryBracket];

    const signedQuantity = candidate.side === "LONG" ? quantity : subtractDecimals("0", quantity);
    const crossEquity = addDecimals(walletBalance, unrealizedPnl);
    const intercept = subtractDecimals(
      subtractDecimals(crossEquity, existingMaintenance),
      multiplyDecimals(signedQuantity, entryPrice),
    );
    const equityAt = (price: DecimalString) => addDecimals(intercept, multiplyDecimals(signedQuantity, price));
    const valueAt = (price: DecimalString, bracket: Bracket) => subtractDecimals(
      equityAt(price), maintenance(quantity, price, bracket),
    );
    for (const bracket of entryBrackets) {
      if (compareDecimals(valueAt(entryPrice, bracket), "0") <= 0) {
        return reject("候选成交后 cross 权益已不超过维持保证金");
      }
    }
    const proveSolvencyPath = (rootPrice: DecimalString): string | null => {
      const rootNotional = multiplyDecimals(quantity, rootPrice);
      const lowerNotional = candidate.side === "LONG" ? rootNotional : entryNotional;
      const upperNotional = candidate.side === "LONG" ? entryNotional : rootNotional;
      const pathBrackets = [...brackets].sort((left, right) => compareDecimals(
        left.notionalFloor, right.notionalFloor,
      ) || left.bracket - right.bracket);
      let coveredThrough = lowerNotional;
      let previousCap: DecimalString | null = null;
      for (const bracket of pathBrackets) {
        if (compareDecimals(bracket.notionalCap, lowerNotional) < 0
          || compareDecimals(bracket.notionalFloor, upperNotional) > 0) continue;
        if (previousCap !== null && compareDecimals(bracket.notionalFloor, previousCap) < 0) {
          return "入场到强平根的档位覆盖有歧义";
        }
        if (compareDecimals(bracket.notionalFloor, coveredThrough) > 0) {
          return "入场到强平根的档位覆盖存在缺口";
        }
        const segmentLower = compareDecimals(bracket.notionalFloor, lowerNotional) > 0
          ? bracket.notionalFloor : lowerNotional;
        const segmentUpper = compareDecimals(bracket.notionalCap, upperNotional) < 0
          ? bracket.notionalCap : upperNotional;
        for (const endpointNotional of [segmentLower, segmentUpper]) {
          if (compareDecimals(endpointNotional, rootNotional) === 0) continue;
          const price = divideDecimals(endpointNotional, quantity, ROOT_DIVISION);
          if (compareDecimals(valueAt(price, bracket), "0") <= 0) {
            return "入场到强平根之间存在更早强平或无偿付能力区间";
          }
        }
        previousCap = bracket.notionalCap;
        if (compareDecimals(bracket.notionalCap, coveredThrough) > 0) coveredThrough = bracket.notionalCap;
        if (compareDecimals(coveredThrough, upperNotional) >= 0) break;
      }
      return compareDecimals(coveredThrough, upperNotional) < 0
        ? "入场到强平根的档位覆盖存在缺口" : null;
    };

    const roots: Array<{ price: DecimalString; bracket: number }> = [];
    for (const bracket of brackets) {
      const possibleRoots: Array<{ price: DecimalString; clamped: boolean }> = [];
      const slope = subtractDecimals(signedQuantity, multiplyDecimals(quantity, bracket.maintMarginRatio));
      if (compareDecimals(slope, "0") !== 0) {
        possibleRoots.push({
          price: divideDecimals(
            subtractDecimals("0", addDecimals(intercept, bracket.cum)), slope, ROOT_DIVISION,
          ),
          clamped: false,
        });
      }
      possibleRoots.push({
        price: divideDecimals(subtractDecimals("0", intercept), signedQuantity, ROOT_DIVISION),
        clamped: true,
      });
      for (const possible of possibleRoots) {
        const notional = multiplyDecimals(quantity, possible.price);
        const rawMaintenance = subtractDecimals(
          multiplyDecimals(notional, bracket.maintMarginRatio), bracket.cum,
        );
        if (compareDecimals(possible.price, "0") > 0 && adverse(possible.price, entryPrice, candidate.side)
          && compareDecimals(notional, bracket.notionalFloor) >= 0
          && compareDecimals(notional, bracket.notionalCap) <= 0
          && (possible.clamped ? compareDecimals(rawMaintenance, "0") <= 0
            : compareDecimals(rawMaintenance, "0") >= 0)) {
          roots.push({ price: possible.price, bracket: bracket.bracket });
        }
      }
    }
    if (roots.length > 0) {
      const root = roots.reduce((selected, current) => {
        const comparison = compareDecimals(current.price, selected.price);
        return (candidate.side === "LONG" ? comparison > 0 : comparison < 0) ? current : selected;
      });
      const bracket = brackets.find((candidateBracket) => candidateBracket.bracket === root.bracket)!;
      const pathIssue = proveSolvencyPath(root.price);
      if (pathIssue) return reject(pathIssue);
      const boundary = candidate.side === "LONG"
        ? ceilToStep(root.price, tickSize) : floorToStep(root.price, tickSize);
      if (!stopPrecedes(stopPrice, boundary, candidate.side)) {
        return reject("止损必须先于保守 cross 组合强平边界");
      }
      return {
        ok: true,
        liquidationPrice: boundary,
        noPositiveRoot: false,
        liquidationPriceSource: "PRETRADE_ESTIMATE",
        maintenanceBracket: bracket.bracket,
      };
    }

    if (candidate.side === "SHORT") return reject("SHORT 无正根时无法证明完整正价格区间的强平边界");
    let coveredThrough: DecimalString = "0";
    for (const bracket of brackets) {
      const lower = divideDecimals(bracket.notionalFloor, quantity, ROOT_DIVISION);
      const upper = divideDecimals(bracket.notionalCap, quantity, ROOT_DIVISION);
      if (compareDecimals(upper, "0") < 0 || compareDecimals(lower, entryPrice) > 0) continue;
      const segmentLower = compareDecimals(lower, "0") < 0 ? "0" : lower;
      const segmentUpper = compareDecimals(upper, entryPrice) > 0 ? entryPrice : upper;
      if (compareDecimals(segmentLower, segmentUpper) > 0) continue;
      if (compareDecimals(segmentLower, coveredThrough) > 0) return reject("LONG 无正根且档位区间覆盖不完整");
      for (const price of [segmentLower, segmentUpper]) {
        const comparison = compareDecimals(valueAt(price, bracket), "0");
        if (comparison < 0 || (comparison === 0 && compareDecimals(price, "0") > 0)) {
          return reject("LONG 无正根但不能证明止损先于全部正价格强平边界");
        }
      }
      if (compareDecimals(segmentUpper, coveredThrough) > 0) coveredThrough = segmentUpper;
    }
    if (compareDecimals(coveredThrough, entryPrice) < 0) return reject("LONG 无正根且无法覆盖至入场价");
    return {
      ok: true,
      liquidationPrice: null,
      noPositiveRoot: true,
      liquidationPriceSource: "PRETRADE_ESTIMATE",
      maintenanceBracket: null,
    };
  } catch {
    return reject("Cross 组合强平输入不是有效十进制或档位数据");
  }
}
