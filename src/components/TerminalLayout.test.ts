import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";

const view = vi.hoisted(() => ({ executionMode: "PAPER" as "PAPER" | "LIVE_MAINNET" }));

vi.mock("react-router", () => ({
  NavLink: ({ to, children }: { to: string; children: ReactNode }) => createElement("a", { href: to }, children),
  Outlet: () => createElement("div", null, "OUTLET"),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/providers/trpc", () => ({
  trpc: {
    trading: {
      dashboard: {
        useQuery: () => ({
          data: {
            source: "MAINNET",
            sourceLabel: "币安主网行情",
            lastScanAt: null,
            settings: { ...DEFAULT_SETTINGS, executionMode: view.executionMode },
            execution: { canSubmit: false },
            markets: [],
          },
          isLoading: false,
          isRefetching: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      setAutoTrade: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import TerminalLayout from "./TerminalLayout";

describe("TerminalLayout 侧栏", () => {
  it("PAPER 和 LIVE 均不渲染底部执行环境面板，并保留系统导航", () => {
    view.executionMode = "PAPER";
    const paper = renderToStaticMarkup(createElement(TerminalLayout));
    view.executionMode = "LIVE_MAINNET";
    const live = renderToStaticMarkup(createElement(TerminalLayout));

    for (const html of [paper, live]) {
      expect(html).toContain("系统导航");
      expect(html).toContain("交易总览");
      expect(html).not.toContain("执行环境");
      expect(html).not.toContain("不会请求 API 密钥");
      expect(html).not.toContain("armed 不代表已绕过任何预检或风险门控");
    }
  });
});
