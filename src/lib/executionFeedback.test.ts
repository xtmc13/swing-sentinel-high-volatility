import { describe, expect, it } from "vitest";

describe("执行结果用户反馈", () => {
  it("平仓按 ok、alreadyClosed、unsettled 分支，失败不伪装成 0 PnL 成功", async () => {
    const feedback = await import("./executionFeedback").catch(() => null);
    expect(feedback).not.toBeNull();
    if (!feedback) return;

    expect(feedback.closeExecutionFeedback({ ok: true, reason: "人工平仓", pnl: 0, unsettled: false, alreadyClosed: false })).toMatchObject({
      tone: "success",
      message: "平仓完成，净盈亏 0.00 USDT",
    });
    expect(feedback.closeExecutionFeedback({ ok: false, reason: "持仓不存在或已关闭", unsettled: false, alreadyClosed: true })).toMatchObject({ tone: "info" });
    const failed = feedback.closeExecutionFeedback({ ok: false, reason: "无法取得新鲜平仓价格：盘口陈旧", unsettled: true, alreadyClosed: false });
    expect(failed.tone).toBe("error");
    expect(failed.message).toContain("盘口陈旧");
    expect(failed.message).toContain("未结算");
    expect(failed.message).not.toContain("0.00 USDT");
  });

  it("紧急停止和重置展示未结算数量与真实原因", async () => {
    const feedback = await import("./executionFeedback").catch(() => null);
    expect(feedback).not.toBeNull();
    if (!feedback) return;
    const result = {
      ok: false,
      paused: true,
      settled: ["settled-id"],
      unsettled: [{ positionId: "open-id", symbol: "BTCUSDT", reason: "盘口陈旧" }],
    };

    const emergency = feedback.bulkExecutionFeedback("紧急停止", result);
    const reset = feedback.bulkExecutionFeedback("模拟账户重置", result);
    expect(emergency).toMatchObject({ tone: "error" });
    expect(reset).toMatchObject({ tone: "error" });
    expect(emergency.message).toContain("未结算 1 笔");
    expect(emergency.message).toContain("盘口陈旧");
    expect(reset.message).toContain("未结算 1 笔");
    expect(feedback.bulkExecutionFeedback("模拟账户重置", { ...result, ok: true, unsettled: [] }).tone).toBe("success");
  });
});
