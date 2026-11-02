import { afterEach, describe, expect, it, vi } from "vitest";
import type { ValidationReport } from "@contracts/validation";
import { runValidationReport } from "./validation";
import { getValidationJob, startValidationJob } from "./validationJobs";

vi.mock("./validation", () => ({ runValidationReport: vi.fn() }));

const report = { id: "persisted-validation-report" } as ValidationReport;

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(runValidationReport).mockReset();
});

describe("验证任务内存保留", () => {
  it("限制终态任务数量并按 TTL 清理，同时保留运行中的轮询", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    vi.mocked(runValidationReport).mockResolvedValue(report);
    const ids: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const job = startValidationJob(["BTCUSDT"], "15m", 30);
      ids.push(job.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(job.status).toBe("COMPLETE");
    }

    expect(getValidationJob(ids[0])).toBeNull();
    expect(getValidationJob(ids[50])?.report).toBe(report);

    let finishRunning!: (value: ValidationReport) => void;
    vi.mocked(runValidationReport).mockImplementationOnce(() => new Promise((resolve) => { finishRunning = resolve; }));
    const running = startValidationJob(["ETHUSDT"], "15m", 30);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);

    expect(getValidationJob(ids[50])).toBeNull();
    expect(getValidationJob(running.id)?.status).toBe("RUNNING");

    finishRunning(report);
    await vi.advanceTimersByTimeAsync(0);
    expect(getValidationJob(running.id)?.status).toBe("COMPLETE");
  });
});
