import type { ExecutionMode, ExecutionStatus } from "@contracts/trading";

export function executionEngineActive(
  settings: { executionMode: ExecutionMode; autoTrade: boolean },
  status: Pick<ExecutionStatus, "canSubmit">,
): boolean {
  return settings.autoTrade && (settings.executionMode === "PAPER" || status.canSubmit);
}
