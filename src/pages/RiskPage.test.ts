import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";

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
      settings: { ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" },
      execution: { executionMode: "LIVE_MAINNET", armed: false },
      volatilityStates: [],
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
});
