import type { BinanceSignedClient } from "./binanceSigned";
import {
  addDecimals,
  compareDecimals,
  decimal,
  divideDecimals,
  multiplyDecimals,
  type DecimalString,
} from "./decimal";

export interface BinanceCrossCollateralSnapshot {
  crossWalletBalance: DecimalString;
  haircut: DecimalString;
  observedAt: number;
}

export type BinanceCrossCollateralReader = (
  notBefore?: number,
) => Promise<BinanceCrossCollateralSnapshot>;

export function createBinanceCrossCollateralReader(
  client: BinanceSignedClient,
  now: () => number = Date.now,
): BinanceCrossCollateralReader {
  return async (notBefore = 0) => {
    const account = await client.account();
    for (const asset of account.assets) {
      if (asset.crossWalletBalance === undefined && compareDecimals(asset.walletBalance, "0") !== 0) {
        throw new Error(`${asset.asset} collateral valuation is missing crossWalletBalance`);
      }
    }
    const collateral = account.assets.filter((asset) => asset.crossWalletBalance !== undefined
      && compareDecimals(asset.crossWalletBalance, "0") !== 0);
    const nonUsdt = collateral.filter((asset) => asset.asset !== "USDT");
    const [rates, prices] = await Promise.all([
      client.collateralRate(),
      Promise.all(nonUsdt.map(async (asset) => [asset.asset, await client.premiumIndex(`${asset.asset}USDT`)] as const)),
    ]);
    const observedAt = now();
    if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(notBefore)
      || observedAt < notBefore || observedAt - notBefore > 10_000) {
      throw new Error("Collateral observation time is not fresh");
    }
    let crossWalletBalance: DecimalString = "0";
    let collateralValue: DecimalString = "0";
    for (const asset of collateral) {
      const quantity = decimal(asset.crossWalletBalance!);
      let price: DecimalString = "1";
      let haircut: DecimalString = "1";
      if (asset.asset !== "USDT") {
        const priceRows = prices.filter(([assetName, row]) => assetName === asset.asset
          && row.symbol === `${asset.asset}USDT`);
        if (priceRows.length !== 1 || compareDecimals(priceRows[0][1].markPrice, "0") <= 0) {
          throw new Error(`${asset.asset} collateral price valuation is missing or ambiguous`);
        }
        price = decimal(priceRows[0][1].markPrice);
        const rateRows = rates.filter((rate) => rate.asset === asset.asset);
        if (rateRows.length !== 1 || !Number.isSafeInteger(rateRows[0].updateTime)
          || rateRows[0].updateTime < 0 || rateRows[0].updateTime > observedAt
          || compareDecimals(rateRows[0].collateralRate, "0") <= 0
          || compareDecimals(rateRows[0].collateralRate, "1") > 0) {
          throw new Error(`${asset.asset} collateralRate haircut is missing, future-dated, or ambiguous`);
        }
        if (compareDecimals(quantity, "0") > 0) haircut = decimal(rateRows[0].collateralRate);
      }
      const value = multiplyDecimals(quantity, price);
      crossWalletBalance = addDecimals(crossWalletBalance, value);
      collateralValue = addDecimals(collateralValue, multiplyDecimals(value, haircut));
    }
    if (compareDecimals(crossWalletBalance, "0") <= 0
      || compareDecimals(collateralValue, "0") <= 0) {
      throw new Error("Cross collateral valuation must be positive");
    }
    const haircut = divideDecimals(collateralValue, crossWalletBalance, {
      decimalPlaces: 30,
      roundingMode: "ROUND_DOWN",
    });
    if (compareDecimals(haircut, "0") <= 0 || compareDecimals(haircut, "1") > 0) {
      throw new Error("Aggregate collateral haircut is invalid");
    }
    return { crossWalletBalance, haircut, observedAt };
  };
}
