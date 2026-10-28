import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("回测公开入口", () => {
  it("新单标的回测委托修正后的组合引擎，旧结果仍由统一查询读取", async () => {
    const source = await readFile(new URL("./tradingRouter.ts", import.meta.url), "utf8");

    expect(source).not.toContain("runHistoricalBacktest");
    expect(source).toMatch(/runBacktest:[\s\S]*?runPortfolioBacktest\(\[input\.symbol\], input\.timeframe, input\.bars\)/);
    expect(source).toMatch(/backtests:[\s\S]*?JSON\.parse\(row\.resultJson\)/);
  });
});
