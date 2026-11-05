import { describe, expect, it } from "vitest";
import type {
  BinanceLeverageBracket,
  BinanceMultiAssetsMarginResponse,
  BinanceOpenOrder,
  BinancePositionRisk,
  BinancePositionSideResponse,
  BinanceSymbolContract,
} from "./binanceSigned";
import { runLivePreflight, type LivePreflightClient, type LivePreflightInput } from "./livePreflight";

const isolatedPosition: BinancePositionRisk = {
  symbol: "BTCUSDT",
  positionAmt: "0",
  entryPrice: "0",
  markPrice: "100",
  liquidationPrice: "0",
  leverage: "5",
  marginType: "isolated",
};

function client(overrides: {
  positionSide?: BinancePositionSideResponse;
  multiAssets?: BinanceMultiAssetsMarginResponse;
  positions?: BinancePositionRisk[];
  orders?: BinanceOpenOrder[];
  brackets?: BinanceLeverageBracket[];
  contract?: BinanceSymbolContract;
} = {}): LivePreflightClient {
  return {
    positionSide: async () => overrides.positionSide ?? { dualSidePosition: false },
    multiAssetsMargin: async () => overrides.multiAssets ?? { multiAssetsMargin: false },
    positionRisk: async () => overrides.positions ?? [isolatedPosition],
    openOrders: async () => overrides.orders ?? [],
    leverageBracket: async () => overrides.brackets ?? [{
      symbol: "BTCUSDT",
      brackets: [{
        bracket: 1,
        initialLeverage: 10,
        notionalCap: "50000",
        notionalFloor: "0",
        maintMarginRatio: "0.01",
        cum: "0",
      }],
    }],
    exchangeInfo: async () => ({
      symbols: [overrides.contract ?? {
        symbol: "BTCUSDT",
        pair: "BTCUSDT",
        contractType: "PERPETUAL",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        marginAsset: "USDT",
        pricePrecision: 2,
        quantityPrecision: 3,
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.01" },
          { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
        ],
      }],
    }),
  };
}

function input(overrides: Partial<LivePreflightInput> = {}): LivePreflightInput {
  return {
    client: client(),
    symbol: "BTCUSDT",
    allowedSymbols: ["BTCUSDT"],
    leverageMode: "FIXED",
    fixedLeverage: 5,
    reconciliationIssues: [],
    ...overrides,
  };
}

describe("主网只读预检", () => {
  it("接受 one-way、单资产、USDT 永续、isolated 且固定杠杆一致的账户", async () => {
    const result = await runLivePreflight(input());
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.filters).toEqual({ tickSize: "0.01", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" });
      expect(result.brackets).toHaveLength(1);
    }
  });

  it("支持 dual、multi-assets、cross 和 ACCOUNT_CONFIGURED 的逐 symbol 实际杠杆", async () => {
    const result = await runLivePreflight(input({
      leverageMode: "ACCOUNT_CONFIGURED",
      fixedLeverage: 20,
      client: client({
        positionSide: { dualSidePosition: true },
        multiAssets: { multiAssetsMargin: true },
        positions: [
          { ...isolatedPosition, positionSide: "LONG", marginType: "cross", leverage: "150" },
          { ...isolatedPosition, positionSide: "SHORT", marginType: "cross", leverage: "150" },
          { ...isolatedPosition, symbol: "ETHUSDT", positionSide: "BOTH", leverage: "20" },
        ],
        brackets: [{
          symbol: "BTCUSDT",
          brackets: [{
            bracket: 1, initialLeverage: 150, notionalCap: "50000", notionalFloor: "0",
            maintMarginRatio: "0.005", cum: "0",
          }],
        }],
      }),
    }));

    expect(result).toMatchObject({ ok: true, positionRisk: { leverage: "150", marginType: "cross" } });
  });

  it("FIXED 仍要求实际杠杆一致，但不把其他 symbol 的杠杆套用到目标合约", async () => {
    const supported = await runLivePreflight(input({
      fixedLeverage: 5,
      client: client({
        positionSide: { dualSidePosition: true },
        multiAssets: { multiAssetsMargin: true },
        positions: [
          { ...isolatedPosition, positionSide: "LONG", marginType: "cross", leverage: "5" },
          { ...isolatedPosition, positionSide: "SHORT", marginType: "cross", leverage: "5" },
          { ...isolatedPosition, symbol: "ETHUSDT", leverage: "20" },
        ],
      }),
    }));
    const mismatch = await runLivePreflight(input({
      client: client({ positions: [{ ...isolatedPosition, leverage: "10" }] }),
    }));

    expect(supported.ok).toBe(true);
    expect(mismatch).toMatchObject({ ok: false });
    if (!mismatch.ok) expect(mismatch.reasons.join(" ")).toMatch(/杠杆/);
  });

  it.each([
    {
      name: "缺少 SHORT",
      rows: [{ ...isolatedPosition, positionSide: "LONG" as const }],
    },
    {
      name: "重复 LONG",
      rows: [
        { ...isolatedPosition, positionSide: "LONG" as const },
        { ...isolatedPosition, positionSide: "LONG" as const },
        { ...isolatedPosition, positionSide: "SHORT" as const },
      ],
    },
    {
      name: "重复 SHORT",
      rows: [
        { ...isolatedPosition, positionSide: "LONG" as const },
        { ...isolatedPosition, positionSide: "SHORT" as const },
        { ...isolatedPosition, positionSide: "SHORT" as const },
      ],
    },
    {
      name: "包含额外 BOTH",
      rows: [
        { ...isolatedPosition, positionSide: "LONG" as const },
        { ...isolatedPosition, positionSide: "SHORT" as const },
        { ...isolatedPosition, positionSide: "BOTH" as const },
      ],
    },
    {
      name: "包含 undefined positionSide",
      rows: [
        { ...isolatedPosition, positionSide: "LONG" as const },
        { ...isolatedPosition, positionSide: "SHORT" as const },
        { ...isolatedPosition, positionSide: undefined },
      ],
    },
  ])("dual 目标合约$name时失败关闭", async ({ rows }) => {
    const result = await runLivePreflight(input({
      client: client({
        positionSide: { dualSidePosition: true },
        positions: rows,
      }),
    }));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/唯一|LONG.*SHORT|SHORT.*LONG/);
  });

  it("拒绝非白名单、非 USDT 永续或不可交易合约并提取合法过滤值", async () => {
    const quarterly = await runLivePreflight(input({
      client: client({ contract: {
        symbol: "BTCUSDT",
        pair: "BTCUSDT",
        contractType: "CURRENT_QUARTER",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USD",
        marginAsset: "BTC",
        filters: [],
      } }),
    }));
    const notAllowed = await runLivePreflight(input({ allowedSymbols: ["ETHUSDT"] }));

    expect(quarterly.ok).toBe(false);
    expect(notAllowed.ok).toBe(false);
  });

  it("未知外部持仓或人工订单只拒绝和报告，不接管或撤销", async () => {
    const result = await runLivePreflight(input({
      client: client({
        positions: [
          { ...isolatedPosition, positionAmt: "0.01", entryPrice: "100" },
          { ...isolatedPosition, symbol: "ETHUSDT", positionAmt: "-1", entryPrice: "2000" },
        ],
        orders: [{
          symbol: "BTCUSDT",
          orderId: 42,
          clientOrderId: "manual-order",
          price: "99",
          origQty: "0.01",
          executedQty: "0",
          status: "NEW",
          side: "BUY",
          type: "LIMIT",
        }],
      }),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/外部持仓|人工|外部订单/);
  });

  it("dual 模式同 symbol 另一方向的外部持仓不被本系统持仓掩盖", async () => {
    const result = await runLivePreflight(input({
      managedPositions: [{ symbol: "BTCUSDT", positionSide: "LONG" }],
      client: client({
        positionSide: { dualSidePosition: true },
        positions: [
          { ...isolatedPosition, positionSide: "LONG", positionAmt: "1", entryPrice: "100" },
          { ...isolatedPosition, positionSide: "SHORT", positionAmt: "-1", entryPrice: "100" },
        ],
      }),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/外部持仓.*BTCUSDT SHORT/);
  });

  it("预检读取全账户持仓而不是只读取候选合约", async () => {
    const accountWideClient = client();
    accountWideClient.positionRisk = async (symbol?: string) => symbol
      ? [isolatedPosition]
      : [isolatedPosition, { ...isolatedPosition, symbol: "ETHUSDT", positionAmt: "-1", entryPrice: "2000" }];

    const result = await runLivePreflight(input({ client: accountWideClient }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toContain("ETHUSDT");
  });

  it("未解决的严重对账问题阻止开仓，已解决问题不阻止", async () => {
    const issue = { severity: "CRITICAL" as const, status: "OPEN" as const };
    expect((await runLivePreflight(input({ reconciliationIssues: [issue] }))).ok).toBe(false);
    expect((await runLivePreflight(input({
      reconciliationIssues: [{ ...issue, status: "RESOLVED" }],
    }))).ok).toBe(true);
  });
});
