import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/VolatilityBadge", () => ({ default: () => null }));
vi.mock("@/components/terminal-context", () => ({
  useTerminal: () => ({
    data: {
      settings: DEFAULT_SETTINGS,
      markets: [{
        symbol: "BTCUSDT", baseAsset: "BTC", eligible: true, quoteVolume: 1_000_000,
        spreadBps: 1, change24h: 0, liquidityScore: 90, price: 100, markPrice: 100,
        fundingRate: 0, maxLeverage: 20, filterReason: "",
      }],
      volatilityStates: [{
        symbol: "BTCUSDT", mode: "NORMAL",
        metrics: { atrQuantile: null, tickSigma: null, spreadRatio: null },
      }],
      marketQuality: {},
    },
    setSelectedSymbol: vi.fn(),
  }),
}));

import MarketsPage from "./MarketsPage";

describe("MarketsPage 不可用数值", () => {
  it("使用固定零值而不是横线或 NaN", () => {
    const html = renderToStaticMarkup(createElement(MarketsPage));

    expect(html).toContain("P0.0");
    expect(html).toContain("0.00σ");
    expect(html).toContain("0.00×");
    expect(html).toContain("0 ms");
    expect(html).not.toContain("—");
    expect(html).not.toContain("NaN");
  });
});
