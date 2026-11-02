import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExecutionStatus } from "@contracts/trading";
import ExecutionStatusPanel from "./ExecutionStatusPanel";

function status(executionMode: "PAPER" | "LIVE_MAINNET"): ExecutionStatus {
  return {
    executionMode,
    armed: false,
    environmentEnabled: false,
    credentialsConfigured: false,
    adapterConfigured: false,
    canSubmit: false,
    reasons: ["主网执行未配置"],
    preflight: { ready: false, reasons: ["尚未执行主网预检"], checkedAt: null },
    momentum: { enabled: false, healthy: false, lastFrameAt: null, reason: "动量检测已关闭" },
    outstanding: { openPositions: 0, pendingIntents: 0, unfinishedOrders: 0 },
    reconciliation: { configured: false, running: false, healthy: false, openIssues: 0, severeIssues: 0, lastRunAt: null, lastDetectedAt: null },
    privateWs: { configured: false, running: false, connected: false, lastMessageAt: null, reconnects: 0 },
    missingProtections: [],
  };
}

describe("执行状态面板", () => {
  it("明确区分 PAPER 模拟和 LIVE 真实环境", () => {
    const paper = renderToStaticMarkup(createElement(ExecutionStatusPanel, { status: status("PAPER") }));
    const live = renderToStaticMarkup(createElement(ExecutionStatusPanel, { status: status("LIVE_MAINNET") }));

    expect(paper).toContain("PAPER · 模拟");
    expect(paper).not.toContain("LIVE · 真实");
    expect(live).toContain("LIVE · 真实");
    expect(live).toContain("凭据未配置");
  });

  it("以可访问定义列表展示预检、对账、私有 WS 和保护警告", () => {
    const current = status("LIVE_MAINNET");
    current.missingProtections.push("BTCUSDT 缺少有效止损保护");
    const html = renderToStaticMarkup(createElement(ExecutionStatusPanel, { status: current }));

    expect(html).toContain("<dl");
    expect(html).toContain("尚未执行主网预检");
    expect(html).toContain("私有 WS");
    expect(html).toContain("BTCUSDT 缺少有效止损保护");
    expect(html).toContain("role=\"alert\"");
  });

  it("底层健康门控失败时不得显示预检通过", () => {
    const current = status("LIVE_MAINNET");
    current.preflight = { ready: true, reasons: [], checkedAt: new Date().toISOString() };
    current.reasons = ["私有 WS 未连接"];
    const html = renderToStaticMarkup(createElement(ExecutionStatusPanel, { status: current }));

    expect(html).not.toContain(">通过</span>");
    expect(html).toContain("私有 WS 未连接");
  });
});
