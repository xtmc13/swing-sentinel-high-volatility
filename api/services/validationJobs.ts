import type { ValidationJobView } from "@contracts/validation";
import { runValidationReport } from "./validation";
import type { PortfolioTimeframe } from "./portfolioBacktest";

const scope = globalThis as typeof globalThis & {
  __swingValidationJobs?: Map<string, ValidationJobView>;
  __swingValidationJobTerminalAt?: Map<string, number>;
};
const jobs = scope.__swingValidationJobs ??= new Map<string, ValidationJobView>();
const terminalAt = scope.__swingValidationJobTerminalAt ??= new Map<string, number>();
const TERMINAL_JOB_TTL_MS = 15 * 60 * 1000;
const MAX_TERMINAL_JOBS = 50;

function pruneTerminalJobs(now = Date.now()) {
  for (const [id, completedAt] of terminalAt) {
    if (now - completedAt >= TERMINAL_JOB_TTL_MS || !jobs.has(id)) {
      jobs.delete(id);
      terminalAt.delete(id);
    }
  }
  const excess = [...terminalAt.entries()]
    .sort((left, right) => left[1] - right[1])
    .slice(0, Math.max(0, terminalAt.size - MAX_TERMINAL_JOBS));
  for (const [id] of excess) {
    jobs.delete(id);
    terminalAt.delete(id);
  }
}

export function startValidationJob(symbols: string[], timeframe: PortfolioTimeframe, bars: number): ValidationJobView {
  pruneTerminalJobs();
  if ([...jobs.values()].some((job) => job.status === "RUNNING")) {
    throw new Error("已有一个样本外验证任务运行中，请等待完成后再启动");
  }
  const id = crypto.randomUUID();
  const job: ValidationJobView = {
    id,
    status: "RUNNING",
    progress: "等待加载历史行情",
    createdAt: new Date().toISOString(),
    error: null,
    report: null,
  };
  jobs.set(id, job);
  void (async () => {
    try {
      const report = await runValidationReport(symbols, timeframe, bars, {
        onProgress: (progress) => { job.progress = progress; },
      });
      job.report = report;
      job.status = "COMPLETE";
      job.progress = "验证报告已生成并保存";
    } catch (error) {
      job.status = "FAILED";
      job.error = error instanceof Error ? error.message : String(error);
      job.progress = "验证失败";
    }
    terminalAt.set(id, Date.now());
    pruneTerminalJobs();
  })();
  return job;
}

export function getValidationJob(id: string): ValidationJobView | null {
  pruneTerminalJobs();
  return jobs.get(id) ?? null;
}
