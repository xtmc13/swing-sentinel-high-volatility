import { describe, expect, it } from "vitest";
import type { SignalEvaluation } from "@contracts/trading";
import { signalsToCsv } from "./csv";

const signal: SignalEvaluation = {
  id: "BTCUSDT-LONG-1", symbol: "BTCUSDT", side: "LONG", signalCloseTime: 1,
  decisionTime: 2, expectedEntry: 100, actualEntry: 101, fillDeviationBps: 10,
  status: "FILLED", reason: "已成交", entryTime: 2, exitTime: 3, pnl: 4,
  rMultiple: 0.5, mfeR: 1.2, maeR: -0.4,
};

describe("信号 CSV 导出", () => {
  it("保留信号与结果字段并防护表格公式注入", () => {
    const csv = signalsToCsv([signal, { ...signal, id: "ETHUSDT-SHORT-2", symbol: "ETHUSDT", side: "SHORT", reason: "=HYPERLINK(\"bad\")", actualEntry: null, status: "REJECTED" }]);
    expect(csv).toContain("BTCUSDT-LONG-1");
    expect(csv).toContain("mfe_r,mae_r");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain(",-0.4");
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });
});
