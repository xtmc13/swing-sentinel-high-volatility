import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";

const view = vi.hoisted(() => ({
  executionMode: "PAPER" as "PAPER" | "LIVE_MAINNET",
  valuationValid: true,
  dailyLocked: false,
}));

vi.mock("@/components/terminal-context", () => ({
  useTerminal: () => ({
    data: {
      source: "MAINNET",
      lastScanAt: null,
      settings: { ...DEFAULT_SETTINGS, executionMode: view.executionMode },
      account: {
        equity: view.valuationValid ? 100_000 : Number.NaN,
        availableMargin: 0,
        usedMargin: 0,
        todayPnl: 0,
        todayPnlPct: 0,
        valuationValid: view.valuationValid,
        valuationIssues: view.valuationValid ? [] : ["交易所账户接口不可用"],
        dailyLocked: view.dailyLocked,
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
    view.dailyLocked = false;
  });

  it.each(["PAPER", "LIVE_MAINNET"] as const)("%s 使用统一的账户权益标签", (executionMode) => {
    view.executionMode = executionMode;
    const html = renderToStaticMarkup(createElement(Home));

    expect(html).toContain("账户权益");
    expect(html).not.toContain("模拟账户权益");
    expect(html).not.toContain("真实账户权益");
  });

  it("LIVE 账户接口不可用时显示固定标签和零值，并保留真实日损锁定警告", () => {
    view.executionMode = "LIVE_MAINNET";
    view.valuationValid = false;
    view.dailyLocked = true;
    const html = renderToStaticMarkup(createElement(Home));

    expect(html).toContain("账户权益");
    expect(html).toContain("0.00");
    expect(html).toContain("USDT");
    expect(html).toContain("+0.00%");
    expect(html).toContain("% 权益");
    expect(html).toContain("当日亏损熔断已锁存");
    expect(html).not.toContain("当日已锁定");
    expect(html).not.toContain("估值不可用");
    expect(html).not.toContain("交易所账户接口不可用");
    expect(html).not.toContain("100,000");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("N/A");
    expect(html).not.toContain("—");
  });
});
