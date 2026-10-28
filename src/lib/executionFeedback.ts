export interface CloseExecutionResult {
  ok: boolean;
  reason: string;
  pnl?: number;
  unsettled: boolean;
  alreadyClosed: boolean;
}

export interface BulkExecutionResult {
  ok: boolean;
  paused: boolean;
  settled: string[];
  unsettled: { positionId: string; symbol: string; reason: string }[];
}

export function closeExecutionFeedback(result: CloseExecutionResult) {
  if (result.ok) {
    return {
      tone: "success" as const,
      message: result.pnl === undefined ? result.reason : `平仓完成，净盈亏 ${result.pnl.toFixed(2)} USDT`,
    };
  }
  if (result.alreadyClosed) return { tone: "info" as const, message: "持仓已关闭，无需重复平仓" };
  return {
    tone: "error" as const,
    message: `${result.reason}${result.unsettled ? "；持仓仍未结算" : ""}`,
  };
}

export function bulkExecutionFeedback(operation: string, result: BulkExecutionResult) {
  if (!result.ok || result.unsettled.length) {
    const reasons = result.unsettled.map((item) => `${item.symbol}：${item.reason}`).join("；");
    return {
      tone: "error" as const,
      message: `${operation}未完成：自动交易已暂停，已结算 ${result.settled.length} 笔，未结算 ${result.unsettled.length} 笔${reasons ? `；${reasons}` : ""}`,
    };
  }
  return {
    tone: "success" as const,
    message: `${operation}完成：自动交易已暂停，已结算 ${result.settled.length} 笔`,
  };
}
