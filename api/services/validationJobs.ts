import type { ValidationJobView } from "@contracts/validation";
import { runValidationReport } from "./validation";
import type { PortfolioTimeframe } from "./portfolioBacktest";

const scope = globalThis as typeof globalThis & { __swingValidationJobs?: Map<string, ValidationJobView> };
const jobs = scope.__swingValidationJobs ??= new Map<string, ValidationJobView>();

export function startValidationJob(symbols: string[], timeframe: PortfolioTimeframe, bars: number): ValidationJobView {
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
  })();
  return job;
}

export function getValidationJob(id: string): ValidationJobView | null {
  return jobs.get(id) ?? null;
}
