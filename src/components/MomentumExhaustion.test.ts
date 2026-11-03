import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Opportunity } from "@contracts/trading";

async function loadDisplay() {
  return import("./MomentumExhaustion").catch(() => null);
}

describe("机会扫描动能衰竭展示", () => {
  it("展示衰竭评分、多周期共振、保护动作、结构状态和现有判断依据", async () => {
    const display = await loadDisplay();
    expect(display).not.toBeNull();
    if (!display) return;

    const momentumExhaustion: NonNullable<Opportunity["momentumExhaustion"]> = {
      score: 72,
      resonanceCount: 2,
      resonant: true,
      protection: "TIGHTEN",
      structureBreak: true,
    };
    const html = renderToStaticMarkup(createElement(display.OpportunityMomentumExhaustion, {
      momentumExhaustion,
      reasons: ["4H／1H 方向共振", "价格创新高但RSI未确认"],
    }));

    expect(html).toContain("72/100");
    expect(html).toContain("2/3 周期");
    expect(html).toContain("多周期共振");
    expect(html).toContain("收紧保护");
    expect(html).toContain("结构破位");
    expect(html).toContain("价格创新高但RSI未确认");
  });

  it("兼容旧扫描结果并提示重新扫描", async () => {
    const display = await loadDisplay();
    expect(display).not.toBeNull();
    if (!display) return;

    const html = renderToStaticMarkup(createElement(display.OpportunityMomentumExhaustion, {
      momentumExhaustion: undefined,
      reasons: ["等待 5M 触发"],
    }));

    expect(html).toContain("暂无动能衰竭数据");
    expect(html).toContain("立即扫描");
    expect(html).not.toContain("undefined");
  });
});

describe("组合回测动能衰竭诊断", () => {
  it("展示事件时间、合约、方向、评分、共振、保护和结构状态", async () => {
    const display = await loadDisplay();
    const component = display?.MomentumExhaustionDiagnostics;
    expect(component).toBeTypeOf("function");
    if (!component) return;

    const html = renderToStaticMarkup(createElement(component, {
      events: [{
        time: Date.UTC(2026, 0, 2, 3, 4, 5),
        symbol: "BTCUSDT",
        side: "SHORT" as const,
        score: 81,
        resonanceCount: 2,
        protection: "REDUCE_CANDIDATE",
        structureBreak: true,
      }],
    }));

    expect(html).toContain("03:04:05");
    expect(html).toContain("BTCUSDT");
    expect(html).toContain("做空");
    expect(html).toContain("81/100");
    expect(html).toContain("2/3 周期");
    expect(html).toContain("减仓候选");
    expect(html).toContain("结构破位");
  });

  it("样本无保护事件时提示运行组合回测", async () => {
    const display = await loadDisplay();
    const component = display?.MomentumExhaustionDiagnostics;
    expect(component).toBeTypeOf("function");
    if (!component) return;

    const html = renderToStaticMarkup(createElement(component, { events: [] }));

    expect(html).toContain("未记录动能衰竭保护事件");
    expect(html).toContain("运行组合回测");
  });

  it("兼容没有动能衰竭字段的旧组合回测结果", async () => {
    const display = await loadDisplay();
    const component = display?.MomentumExhaustionDiagnostics;
    expect(component).toBeTypeOf("function");
    if (!component) return;

    const html = renderToStaticMarkup(createElement(component, { events: undefined }));

    expect(html).toContain("暂无动能衰竭诊断");
    expect(html).toContain("运行组合回测");
    expect(html).not.toContain("undefined");
  });
});
