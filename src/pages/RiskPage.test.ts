import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";

const view = vi.hoisted(() => ({ executionMode: "LIVE_MAINNET" as "PAPER" | "LIVE_MAINNET" }));
const mutations = vi.hoisted(() => ({
  save: vi.fn(),
  setMode: vi.fn(),
  setControls: vi.fn(),
  manualCanary: vi.fn(),
  emergency: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/components/terminal-context", () => ({
  useTerminal: () => ({
    data: {
      settings: { ...DEFAULT_SETTINGS, executionMode: view.executionMode },
      execution: { executionMode: view.executionMode, armed: false },
      volatilityStates: [],
      account: {
        dualSide: true,
        multiAssets: true,
        symbolLeverages: { BTCUSDT: 150, ETHUSDT: 20 },
        symbolMarginTypes: { BTCUSDT: "CROSS", ETHUSDT: "ISOLATED" },
      },
      positions: [{
        id: "live-position-1",
        symbol: "BTCUSDT", effectiveLeverage: 150, maintenanceBracket: 2,
        marginType: "CROSS", liquidationPriceSource: "EXCHANGE",
      }],
      events: [],
    },
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/BinanceCredentialForm", () => ({
  default: () => createElement("div", null, "BINANCE CREDENTIAL FORM"),
}));

vi.mock("@/components/ExecutionStatusPanel", () => ({
  default: () => null,
}));

vi.mock("@/providers/trpc", () => ({
  trpc: {
    trading: {
      saveSettings: { useMutation: () => ({ mutate: mutations.save, isPending: false }) },
      setExecutionMode: { useMutation: () => ({ mutate: mutations.setMode, isPending: false }) },
      setLiveControls: { useMutation: () => ({ mutate: mutations.setControls, isPending: false }) },
      manualCanary: { useMutation: () => ({ mutate: mutations.manualCanary, isPending: false }) },
      emergencyStop: { useMutation: () => ({ mutate: mutations.emergency, isPending: false }) },
      reset: { useMutation: () => ({ mutate: mutations.reset, isPending: false }) },
    },
  },
}));

import RiskPage from "./RiskPage";

describe("RiskPage 公共实时控制", () => {
  beforeEach(() => {
    view.executionMode = "LIVE_MAINNET";
  });

  it("保留凭据、armed 和 canary 表单，但不渲染管理员或只读限制", () => {
    const html = renderToStaticMarkup(createElement(RiskPage));

    expect(html).toContain("BINANCE CREDENTIAL FORM");
    expect(html).toContain("ARM LIVE MAINNET");
    expect(html).toContain("SUBMIT LIVE CANARY");
    expect(html).toContain("提交真实 canary IOC");
    expect(html).not.toContain("管理员");
    expect(html).not.toContain("只读");
    expect(html).not.toContain('type="password"');
  });

  it("展示真实账户模式、逐 symbol 杠杆和强平价来源，并支持账户配置模式", () => {
    const html = renderToStaticMarkup(createElement(RiskPage));

    expect(html).toContain('value="ACCOUNT_CONFIGURED"');
    expect(html).toContain("DUAL");
    expect(html).toContain("MULTI-ASSETS");
    expect(html).toContain("BTCUSDT");
    expect(html).toContain("150×");
    expect(html).toContain("CROSS");
    expect(html).toContain("EXCHANGE");
    expect(html).not.toContain("满杠杆模式使用系统内置的模拟标的上限");
  });

  it("PAPER 主账户重置使用中性账户文案", () => {
    view.executionMode = "PAPER";
    const html = renderToStaticMarkup(createElement(RiskPage));

    expect(html).toContain("重置账户");
    expect(html).not.toContain("重置模拟账户");
  });
});
