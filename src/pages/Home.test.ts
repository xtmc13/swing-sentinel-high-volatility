import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";

const view = vi.hoisted(() => ({
  executionMode: "PAPER" as "PAPER" | "LIVE_MAINNET",
  valuationValid: true,
}));

vi.mock("@/components/terminal-context", () => ({
  useTerminal: () => ({
    data: {
      source: "MAINNET",
      lastScanAt: null,
      settings: { ...DEFAULT_SETTINGS, executionMode: view.executionMode },
      account: {
        equity: view.valuationValid ? 100_000 : 0,
        availableMargin: 0,
        usedMargin: 0,
        todayPnl: 0,
        todayPnlPct: 0,
        valuationValid: view.valuationValid,
        valuationIssues: view.valuationValid ? [] : ["交易所账户接口不可用"],
        dailyLocked: false,
      },
      markets: [],
      opportunities: [],
      positions: [],
      events: [],
      portfolioRisk: { totalRisk: 0, totalRiskPct: 0, remainingTotalRisk: 0, correlatedLimit: 0, positions: [] },
      monitor: {
        running: false,
        sourceHealthy: false,
        connections: 0,
        openConnections: 0,
        reconnects: 0,
        messages: 0,
        malformedMessages: 0,
        missedMessages: null,
        rateLimits: 0,
        degradedSymbols: 0,
        lastMessageAt: null,
        averageLatencyMs: null,
        maxLatencyMs: null,
      },
    },
    selectedSymbol: "",
    setSelectedSymbol: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/MarketChart", () => ({ default: () => null }));
vi.mock("@/providers/trpc", () => ({
  trpc: {
    trading: {
      scan: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      closePosition: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import Home from "./Home";

describe("Home 主账户指标", () => {
  beforeEach(() => {
    view.executionMode = "PAPER";
    view.valuationValid = true;
  });

  it.each(["PAPER", "LIVE_MAINNET"] as const)("%s 使用统一的账户权益标签", (executionMode) => {
    view.executionMode = executionMode;
    const html = renderToStaticMarkup(createElement(Home));

    expect(html).toContain("账户权益");
    expect(html).not.toContain("模拟账户权益");
    expect(html).not.toContain("真实账户权益");
  });

  it("LIVE 账户接口不可用时继续显示零值和估值不可用，不填充模拟余额", () => {
    view.executionMode = "LIVE_MAINNET";
    view.valuationValid = false;
    const html = renderToStaticMarkup(createElement(Home));

    expect(html).toContain("账户权益");
    expect(html).toContain("估值不可用");
    expect(html).toContain("交易所账户接口不可用");
    expect(html).not.toContain("100,000");
  });
});
