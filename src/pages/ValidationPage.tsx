import { useEffect, useMemo, useRef, useState } from "react";
import { Database, Download, FlaskConical, LoaderCircle, Play } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { useTerminal } from "@/components/terminal-context";
import type { ValidationReport, ValidationMetrics } from "@contracts/validation";
import type { SignalEvaluation } from "@contracts/trading";
import { formatNumber, formatTime } from "@/lib/format";
import { downloadCsv, signalsToCsv } from "@/lib/csv";

function MetricsCards({ metrics, sample }: { metrics: ValidationMetrics; sample: string }) {
  const cards = [
    ["样本区间", sample, "独立样本外口径"],
    ["READY 信号", `${metrics.totalSignals}`, `成交 ${metrics.filledSignals} · 拒绝 ${metrics.rejectedSignals}`],
    ["可成交率", `${formatNumber(metrics.fillRatePct)}%`, "信号到实际开仓"],
    ["净期望 / 笔", `${formatNumber(metrics.expectancy)} USDT`, `${metrics.totalTrades} 笔已平仓`],
    ["胜率", `${formatNumber(metrics.winRatePct)}%`, `平均净R ${formatNumber(metrics.averageR)}`],
    ["Profit Factor", metrics.profitFactor >= 999 ? "∞" : formatNumber(metrics.profitFactor), `净盈亏 ${formatNumber(metrics.netPnl)} USDT`],
    ["最大回撤", `${formatNumber(metrics.maxDrawdownPct)}%`, `费用 ${formatNumber(metrics.totalFees)} · 资金费 ${formatNumber(metrics.totalFunding)}`],
    ["MFE / MAE", `${formatNumber(metrics.averageMfeR)} / ${formatNumber(metrics.averageMaeR)}R`, `成交偏差 ${formatNumber(metrics.averageFillDeviationBps)} bps`],
  ];
  return <div className="grid grid-cols-2 border border-[#1a2540] bg-[#0c1220] md:grid-cols-4">{cards.map(([label, value, note], index) => <div key={label} className={`border-[#141f33] p-4 ${index % 2 ? "border-l" : ""} ${index > 1 ? "border-t md:border-t-0" : ""} ${index > 0 ? "md:border-l" : ""} ${index > 3 ? "md:border-t" : ""}`}><div className="terminal-label">{label}</div><div className="mt-2 text-lg font-semibold text-[#dce5f1]">{value}</div><div className="mt-1 text-[9px] leading-4 text-[#8290aa]">{note}</div></div>)}</div>;
}

function ReportView({ report }: { report: ValidationReport }) {
  const exportSignals = (scope: "ALL" | "TEST") => {
    const signals: SignalEvaluation[] = report.segments
      .filter((segment) => scope === "ALL" || segment.segment === "TEST")
      .flatMap((segment) => segment.result.signals);
    if (!signals.length) {
      toast.info("当前范围没有 READY 信号可导出");
      return;
    }
    downloadCsv(`validation-${report.timeframe}-${report.bars}-${scope.toLowerCase()}.csv`, signalsToCsv(signals));
    toast.success(`已导出 ${signals.length} 条信号`);
  };
  return (
    <div className="space-y-3">
      <MetricsCards metrics={report.outOfSample} sample="TEST · 最后 20%" />
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1a2540] px-4 py-3"><div><div className="terminal-label">SEGMENT COMPARISON</div><h2 className="mt-1 text-[13px]">训练、验证与样本外对照</h2></div><div className="flex gap-2"><button type="button" className="btn-secondary !min-h-9 !text-[10px]" onClick={() => exportSignals("TEST")}><Download size={13} />测试集 CSV</button><button type="button" className="btn-secondary !min-h-9 !text-[10px]" onClick={() => exportSignals("ALL")}><Download size={13} />全部信号 CSV</button></div></div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="样本分段指标表"><table className="w-full min-w-[900px] text-left text-[11px]"><thead><tr className="border-b border-[#1a2540] text-[9px] text-[#8290aa]"><th className="px-4 py-3 font-normal">区间</th><th className="px-3 py-3 font-normal">时间 UTC</th><th className="px-3 py-3 font-normal">信号／成交</th><th className="px-3 py-3 font-normal">交易</th><th className="px-3 py-3 font-normal">胜率</th><th className="px-3 py-3 font-normal">净期望</th><th className="px-3 py-3 font-normal">PF</th><th className="px-3 py-3 font-normal">最大回撤</th><th className="px-3 py-3 font-normal">净盈亏</th></tr></thead><tbody>{report.segments.map((segment) => <tr key={segment.segment} className="border-b border-[#141f33]"><th scope="row" className={`px-4 py-3 ${segment.segment === "TEST" ? "text-[#22d3ee]" : "text-[#c5d0df]"}`}>{segment.segment}</th><td className="px-3 py-3 text-[#8290aa]">{formatTime(new Date(segment.startOpenTime), true)}<br />{formatTime(new Date(segment.endCloseTime), true)}</td><td className="px-3 py-3">{segment.metrics.totalSignals} / {segment.metrics.filledSignals}</td><td className="px-3 py-3">{segment.metrics.totalTrades}</td><td className="px-3 py-3">{formatNumber(segment.metrics.winRatePct)}%</td><td className="px-3 py-3">{formatNumber(segment.metrics.expectancy)}</td><td className="px-3 py-3">{segment.metrics.profitFactor >= 999 ? "∞" : formatNumber(segment.metrics.profitFactor)}</td><td className="px-3 py-3">{formatNumber(segment.metrics.maxDrawdownPct)}%</td><td className={`px-3 py-3 ${segment.metrics.netPnl >= 0 ? "data-positive" : "data-negative"}`}>{formatNumber(segment.metrics.netPnl)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel p-4"><div className="terminal-label mb-2">验证口径与限制</div><ul className="reading grid gap-1 text-[10px] leading-5 text-[#91a0b8] md:grid-cols-2">{report.assumptions.map((item) => <li key={item}>· {item}</li>)}</ul></section>
    </div>
  );
}

export default function ValidationPage() {
  const { data } = useTerminal();
  const markets = useMemo(() => data.markets.filter((market) => market.eligible).slice(0, 20), [data.markets]);
  const [symbols, setSymbols] = useState<string[]>(() => markets.slice(0, 3).map((market) => market.symbol));
  const [timeframe, setTimeframe] = useState<"5m" | "15m">("15m");
  const [bars, setBars] = useState(3000);
  const [jobId, setJobId] = useState("");
  const [historyId, setHistoryId] = useState("");
  const history = trpc.trading.validationReports.useQuery();
  const start = trpc.trading.startValidation.useMutation({
    onSuccess: (job) => { setJobId(job.id); setHistoryId(""); toast.info("长历史验证已在后台启动"); },
    onError: (error) => toast.error(error.message),
  });
  const job = trpc.trading.validationJob.useQuery({ id: jobId }, {
    enabled: Boolean(jobId),
    refetchInterval: (query) => query.state.data?.status === "RUNNING" ? 3000 : false,
  });
  const saved = trpc.trading.validationReport.useQuery({ id: historyId }, { enabled: Boolean(historyId) });
  const refetchHistory = history.refetch;
  const notified = useRef("");
  useEffect(() => {
    if (!job.data || job.data.status === "RUNNING") return;
    const key = `${job.data.id}:${job.data.status}`;
    if (notified.current === key) return;
    notified.current = key;
    if (job.data.status === "COMPLETE" && job.data.report) {
      toast.success("样本外验证报告已生成");
      void refetchHistory();
    } else if (job.data.status === "FAILED") {
      toast.error(job.data.error ?? "验证失败");
    }
  }, [job.data, refetchHistory]);
  const report = historyId ? saved.data ?? null : job.data?.report ?? null;
  const running = job.data?.status === "RUNNING";
  const launch = () => {
    if (!symbols.length || symbols.length > 5) return;
    start.mutate({ symbols, timeframe, bars });
  };
  return (
    <div className="p-3 sm:p-5 xl:p-6">
      <div className="mb-5"><div className="terminal-label mb-1">OUT-OF-SAMPLE VALIDATION</div><h1 className="text-xl font-semibold tracking-[-0.04em] sm:text-2xl">信号准确率与盈利验证</h1><p className="reading mt-1 max-w-3xl text-[13px] leading-6 text-[#91a0b8]">批量长历史回测，按时间顺序拆分训练、验证和样本外区间。统计全部 READY 的成交与拒绝，不把胜率等同于盈利能力。</p></div>
      <section className="panel mb-3 p-4" aria-labelledby="validation-input-title">
        <div className="mb-4 flex items-center gap-2"><FlaskConical size={15} className="text-[#22d3ee]" /><h2 id="validation-input-title" className="terminal-label">VALIDATION INPUT</h2></div>
        <div className="grid gap-3 xl:grid-cols-[minmax(260px,1fr)_180px_180px_auto] xl:items-end">
          <div><label htmlFor="validation-symbols" className="terminal-label">组合合约（1–5 个）</label><select id="validation-symbols" multiple size={5} className="terminal-input mt-2 !h-auto" value={symbols} onChange={(event) => setSymbols(Array.from(event.target.selectedOptions, (option) => option.value))}>{markets.map((market) => <option key={market.symbol} value={market.symbol}>{market.symbol}</option>)}</select><p className="mt-2 text-[10px] text-[#8290aa]">已选择 {symbols.length}/5；使用 Ctrl / Shift 多选。</p></div>
          <label><span className="terminal-label">主时间轴</span><select className="terminal-input mt-2" value={timeframe} onChange={(event) => setTimeframe(event.target.value as "5m" | "15m")}><option value="15m">15 分钟</option><option value="5m">5 分钟</option></select></label>
          <label><span className="terminal-label">历史长度</span><select className="terminal-input mt-2" value={bars} onChange={(event) => setBars(Number(event.target.value))}><option value={900}>900 根 · 快速</option><option value={3000}>3000 根 · 标准</option><option value={6000}>6000 根 · 长历史</option><option value={10000}>10000 根 · 超长</option></select></label>
          <button type="button" className="btn-primary" disabled={!symbols.length || symbols.length > 5 || start.isPending || running} onClick={launch}>{running || start.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}{running ? "正在验证" : "开始样本外验证"}</button>
        </div>
        {jobId && <div className="mt-4 border-t border-[#1a2540] pt-3 text-[11px]"><span className={running ? "data-warning" : job.data?.status === "FAILED" ? "data-negative" : "data-live"}>{job.data?.progress ?? "正在创建任务"}</span><span className="ml-2 text-[#596983]">任务 {jobId.slice(0, 8)}</span>{job.data?.error && <p className="mt-2 data-negative">{job.data.error}</p>}</div>}
      </section>
      {report ? <ReportView report={report} /> : !running && <section className="panel mb-3 border-dashed p-10 text-center"><Database className="mx-auto mb-3 text-[#4f607b]" size={24} /><div className="text-[12px] text-[#c5d0df]">尚未生成验证报告</div><p className="reading mx-auto mt-2 max-w-xl text-[11px] leading-5 text-[#8290aa]">选择合约和时间范围后启动。长历史任务在后台执行，可以继续查看其他页面。</p></section>}
      <section className="panel mt-3"><div className="border-b border-[#1a2540] px-4 py-3"><h2 className="terminal-label">SAVED VALIDATION REPORTS</h2></div><div>{(history.data ?? []).map((savedReport) => <div key={savedReport.id} className="flex flex-wrap items-center gap-3 border-b border-[#141f33] px-4 py-3 text-[11px]"><span className="text-[#22d3ee]">{savedReport.symbols.join(" / ")}</span><span className="text-[#8290aa]">{savedReport.timeframe} · {savedReport.bars} 根</span><span>样本外净期望 {formatNumber(savedReport.outOfSample.expectancy)}</span><span className="text-[#596983]">{formatTime(savedReport.createdAt, true)}</span><button type="button" className="btn-secondary ml-auto !min-h-9 !px-3 !text-[10px]" onClick={() => { setHistoryId(savedReport.id); setJobId(""); }}>载入报告</button></div>)}{!history.data?.length && <div className="p-5 text-center text-[10px] text-[#8290aa]">暂无保存的验证报告</div>}</div></section>
    </div>
  );
}
