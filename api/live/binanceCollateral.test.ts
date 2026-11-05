import { describe, expect, it, vi } from "vitest";
import type { BinanceAccountResponse, BinanceSignedClient } from "./binanceSigned";
import { createBinanceCrossCollateralReader } from "./binanceCollateral";

const NOW = 1_800_000_000_000;

function account(assets: BinanceAccountResponse["assets"]): BinanceAccountResponse {
  return {
    assets,
    totalWalletBalance: "1000",
    totalMarginBalance: "1000",
    availableBalance: "900",
  };
}

function clientWith(
  assets: BinanceAccountResponse["assets"],
  rates: Array<{ asset: string; collateralRate: string; updateTime: number }>,
  prices: Record<string, string>,
) {
  return {
    account: vi.fn(async () => account(assets)),
    collateralRate: vi.fn(async () => rates),
    premiumIndex: vi.fn(async (symbol: string) => ({
      symbol,
      markPrice: prices[symbol] ?? "0",
      indexPrice: prices[symbol] ?? "0",
      estimatedSettlePrice: prices[symbol] ?? "0",
      lastFundingRate: "0",
      interestRate: "0",
      nextFundingTime: NOW,
      time: NOW,
    })),
  } as unknown as BinanceSignedClient;
}

describe("Binance multi-asset cross collateral reader", () => {
  it("values signed collateral at current mark prices and applies official asset haircuts", async () => {
    const client = clientWith([
      { asset: "USDT", walletBalance: "600", availableBalance: "600", crossWalletBalance: "600" },
      { asset: "BNB", walletBalance: "1", availableBalance: "1", crossWalletBalance: "1" },
      { asset: "BTC", walletBalance: "0.1", availableBalance: "0.1", crossWalletBalance: "0.1" },
    ], [
      { asset: "BNB", collateralRate: "0.5", updateTime: NOW - 1000 },
      { asset: "BTC", collateralRate: "0.25", updateTime: NOW - 1000 },
    ], { BNBUSDT: "400", BTCUSDT: "1000" });
    const read = createBinanceCrossCollateralReader(client, () => NOW);

    await expect(read(NOW - 1000)).resolves.toEqual({
      crossWalletBalance: "1100",
      haircut: "0.75",
      observedAt: NOW,
    });
    expect(client.account).toHaveBeenCalledOnce();
    expect(client.collateralRate).toHaveBeenCalledOnce();
    expect(client.premiumIndex).toHaveBeenCalledWith("BNBUSDT");
    expect(client.premiumIndex).toHaveBeenCalledWith("BTCUSDT");
  });

  it("fails closed for unpriced collateral instead of inventing a haircut", async () => {
    const client = clientWith([
      { asset: "USDT", walletBalance: "600", availableBalance: "600", crossWalletBalance: "600" },
      { asset: "BNB", walletBalance: "1", availableBalance: "1", crossWalletBalance: "1" },
    ], [{ asset: "BNB", collateralRate: "0.5", updateTime: NOW - 1000 }], { BNBUSDT: "0" });
    const read = createBinanceCrossCollateralReader(client, () => NOW);

    await expect(read(NOW - 1000)).rejects.toThrow(/price|valuation|价格|估值/);
  });

  it("fails closed when an asset has no unique official collateral rate", async () => {
    const client = clientWith([
      { asset: "USDT", walletBalance: "600", availableBalance: "600", crossWalletBalance: "600" },
      { asset: "BNB", walletBalance: "1", availableBalance: "1", crossWalletBalance: "1" },
    ], [], { BNBUSDT: "400" });
    const read = createBinanceCrossCollateralReader(client, () => NOW);

    await expect(read(NOW - 1000)).rejects.toThrow(/collateralRate|haircut|折算/);
  });

  it("does not discount negative collateral liabilities", async () => {
    const client = clientWith([
      { asset: "USDT", walletBalance: "600", availableBalance: "600", crossWalletBalance: "600" },
      { asset: "BNB", walletBalance: "-1", availableBalance: "-1", crossWalletBalance: "-1" },
    ], [{ asset: "BNB", collateralRate: "0.5", updateTime: NOW - 1000 }], { BNBUSDT: "400" });
    const read = createBinanceCrossCollateralReader(client, () => NOW);

    await expect(read(NOW - 1000)).resolves.toEqual({
      crossWalletBalance: "200",
      haircut: "1",
      observedAt: NOW,
    });
  });

  it("rejects an observation older than the requested fresh boundary", async () => {
    const client = clientWith([
      { asset: "USDT", walletBalance: "600", availableBalance: "600", crossWalletBalance: "600" },
    ], [], {});
    const read = createBinanceCrossCollateralReader(client, () => NOW);

    await expect(read(NOW + 1)).rejects.toThrow(/fresh|time|时间|新鲜/);
  });
});
