import { useState } from "react";
import { Activity, GitBranch, Network, Radar, RefreshCw, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { useTerminal } from "@/components/terminal-context";
import MarketChart from "@/components/MarketChart";
import { formatMissedMessages, formatNumber, formatPercent, formatPrice, formatTime, sideColor, sideLabel } from "@/lib/format";
import { closeExecutionFeedback } from "@/lib/executionFeedback";

export default function Home() {
  const { data, selectedSymbol, setSelectedSymbol, refresh } = useTerminal();
  const [interval, setInterval] = useState<"5m" | "15m" | "1h" | "4h">("15m");
  const scan = trpc.trading.scan.useMutation({
    onSuccess: async (result) => {
      toast.success(`扫描完成：${result.filter((item) => item.status === "READY").length} 个可执行机会`);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const close = trpc.trading.closePosition.useMutation({
    onSuccess: async (result) => { const feedback = closeExecutionFeedback(result); toast[feedback.tone](feedback.message); refresh(); },
    onError: (error) => toast.error(error.message),
  });
  const market = data.markets.find((item) => item.symbol === selectedSymbol) ?? data.markets[0];
  const openRisk = data.portfolioRisk.totalRiskPct;
  const transitions = data.events.filter((event) => event.category === "三态迁移");
  const metrics = [
    { label: "模拟账户权益", value: formatNumber(data.account.equity), suffix: data.account.valuationValid ? "USDT" : "估值不可用", tone: !data.account.valuationValid ? "data-warning" : data.account.equity >= 100000 ? "data-positive" : "data-negative" },
    { label: "可用保证金", value: formatNumber(data.account.availableMargin), suffix: "USDT", tone: "text-[#e7edf7]" },
    { label: "今日净盈亏", value: `${data.account.todayPnl >= 0 ? "+" : ""}${formatNumber(data.account.todayPnl)}`, suffix: data.account.dailyLocked ? "当日已锁定" : formatPercent(data.account.todayPnlPct), tone: !data.account.valuationValid ? "data-warning" : data.account.todayPnl >= 0 ? "data-positive" : "data-negative" },
    { label: "当前止损风险", value: formatNumber(openRisk), suffix: "% 权益", tone: openRisk > 1 ? "data-warning" : "data-live" },
  ];

  return (
    <div className="p-3 sm:p-5 xl:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="terminal-label mb-1">SHORT-SWING OPERATIONS / 多合约永续</div>
          <h1 className="text-xl font-semibold tracking-[-0.04em] sm:text-2xl">短波段作战台</h1>
          <p className="reading mt-1 text-[13px] text-[#91a0b8]">高流动性选品 · 4H／1H 定向 · 15M 结构 · 5M 触发 · 组合风险审批</p>
        </div>
        <button className="btn-primary" disabled={scan.isPending} onClick={() => scan.mutate()}>
          {scan.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Radar size={15} />}
          {scan.isPending ? "正在扫描" : "立即扫描"}
        </button>
      </div>

      {data.source === "TESTNET" && (
        <div className="mb-3 flex items-start gap-3 border border-[#55461e] bg-[#17150e] px-4 py-3 text-[11px] leading-5 text-[#fbbf24]">
          <ShieldAlert size={15} className="mt-0.5 shrink-0" />
          <span className="reading">当前连接为币安期货测试网公开行情，并非主网实时盘面。行情与成交只用于系统验证，不代表主网流动性或可实现收益。</span>
        </div>
      )}

      {!data.account.valuationValid && (
        <div className="mb-3 border border-[#7f1d1d] bg-[#1c1015] px-4 py-3 text-[11px] leading-5 text-[#fca5a5]" role="alert">
          持仓估值不可用，页面以“—”显示未知盈亏，不再按开仓价伪装成 0。权益快照已暂停写入。{data.account.valuationIssues.length > 0 && <span className="block mt-1">{data.account.valuationIssues.join("；")}</span>}
        </div>
      )}
      {data.account.dailyLocked && (
        <div className="mb-3 border border-[#55461e] bg-[#17150e] px-4 py-3 text-[11px] text-[#fbbf24]" role="alert">当日亏损熔断已锁存；即使价格恢复，也要到下一 UTC 日才允许新增持仓。</div>
      )}

      <section className="mb-3 grid grid-cols-2 border border-[#1a2540] bg-[#0c1220] xl:grid-cols-4" aria-label="账户关键指标">
        {metrics.map((metric, index) => (
          <div key={metric.label} className={`px-4 py-4 ${index % 2 ? "border-l" : ""} ${index > 1 ? "border-t xl:border-t-0" : ""} ${index > 0 ? "xl:border-l" : ""} border-[#1a2540]`}>
            <div className="terminal-label">{metric.label}</div>
            <div className={`mt-2 truncate text-lg font-semibold tracking-[-0.05em] sm:text-2xl ${metric.tone}`}>{metric.value}</div>
            <div className="mt-1 text-[10px] text-[#8290aa]">{metric.suffix}</div>
          </div>
        ))}
      </section>

      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          {market ? <MarketChart symbol={market.symbol} market={market} interval={interval} onIntervalChange={setInterval} /> : <div className="panel h-[420px]" />}

          <section className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#1a2540] px-4 py-3">
              <div><div className="terminal-label">OPPORTUNITY SCANNER</div><h2 className="mt-1 text-[13px] font-medium">机会与等待队列</h2></div>
              <span className="text-[10px] text-[#8290aa]">{data.lastScanAt ? `${formatTime(data.lastScanAt)} UTC` : "尚未扫描"}</span>
            </div>
            <div className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#22d3ee]" tabIndex={0} role="region" aria-labelledby="opportunity-table-caption">
              <table className="w-full min-w-[720px] border-collapse text-left text-[11px]">
                <caption id="opportunity-table-caption" className="sr-only">当前合约机会、方向、评分、进场与风险</caption>
                <thead><tr className="border-b border-[#1a2540] text-[9px] uppercase tracking-[0.12em] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">合约</th><th scope="col" className="px-3 py-3 font-normal">方向／状态</th><th scope="col" className="px-3 py-3 font-normal">评分</th><th scope="col" className="hidden px-3 py-3 font-normal md:table-cell">进场／失效</th><th scope="col" className="hidden px-3 py-3 font-normal lg:table-cell">判断依据</th><th scope="col" className="px-3 py-3 font-normal">杠杆</th></tr></thead>
                <tbody>
                  {data.opportunities.map((opportunity) => (
                    <tr key={opportunity.id} className={`border-b border-[#141f33] transition-colors duration-150 hover:bg-[#101a2a] ${selectedSymbol === opportunity.symbol ? "bg-[#0f1827]" : ""}`}>
                      <th scope="row" className="px-4 py-3 font-normal"><button type="button" onClick={() => setSelectedSymbol(opportunity.symbol)} className="min-h-8 text-left hover:text-[#22d3ee]"><span className="block font-medium text-[#dce5f1]">{opportunity.symbol.replace("USDT", "")}</span><span className="block text-[9px] text-[#8290aa]">{opportunity.regime}</span></button></th>
                      <td className="px-3 py-3"><span className={sideColor(opportunity.side)}>{sideLabel(opportunity.side)}</span><div className={`mt-1 text-[9px] ${opportunity.status === "READY" ? "data-positive" : opportunity.status === "BLOCKED" ? "data-negative" : "data-warning"}`}>{opportunity.status === "READY" ? "可执行" : opportunity.status === "BLOCKED" ? "已阻断" : "等待中"}</div></td>
                      <td className="px-3 py-3"><span className={opportunity.score >= 70 ? "data-positive" : "text-[#c5d0df]"}>{opportunity.score}</span><span className="text-[#596983]">/100</span></td>
                      <td className="hidden px-3 py-3 md:table-cell"><div>{formatPrice(opportunity.entry)}</div><div className="text-[9px] text-[#f87171]">SL {formatPrice(opportunity.stop)}</div></td>
                      <td className="hidden max-w-[300px] px-3 py-3 text-[10px] leading-5 text-[#91a0b8] lg:table-cell">{opportunity.reasons.join(" · ")}</td>
                      <td className="px-3 py-3"><span className="data-warning">{opportunity.leverage}×</span><div className="text-[9px] text-[#8290aa]">风险 {opportunity.riskPct}%</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.opportunities.length && <div className="m-4 border border-dashed border-[#263650] p-8 text-center"><Radar className="mx-auto mb-3 text-[#4f607b]" size={24} /><div className="text-[12px] text-[#c5d0df]">尚未形成机会队列</div><div className="reading mt-2 text-[11px] text-[#8290aa]">点击“立即扫描”，系统会分析当前高流动性合约；无交易也是有效结果。</div></div>}
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-3">
          <section className="panel">
            <div className="flex items-center justify-between border-b border-[#1a2540] px-4 py-3"><div className="terminal-label">OPEN POSITIONS</div><span className="text-[11px]">{data.positions.length}/{data.settings.maxPositions}</span></div>
            <div className="max-h-[380px] overflow-y-auto">
              {data.positions.map((position) => (
                <div key={position.id} className="border-b border-[#1a2540] p-4">
                  <div className="flex items-center justify-between"><button onClick={() => setSelectedSymbol(position.symbol)} className="text-[12px] font-medium hover:text-[#22d3ee]">{position.symbol}</button><span className={`text-[10px] ${sideColor(position.side)}`}>{sideLabel(position.side)} · {position.leverage}×</span></div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-[10px]"><div><div className="text-[#8290aa]">未实现盈亏</div><div className={`mt-1 text-[14px] ${!position.valuationValid ? "data-warning" : position.unrealizedPnl >= 0 ? "data-positive" : "data-negative"}`}>{position.unrealizedPnl >= 0 ? "+" : ""}{formatNumber(position.unrealizedPnl)}</div></div><div className="text-right"><div className="text-[#8290aa]">保证金</div><div className="mt-1 text-[14px]">{formatNumber(position.margin)}</div></div></div>
                  <div className="mt-3 space-y-1 text-[9px] text-[#91a0b8]"><div className="flex justify-between"><span>进场 {formatPrice(position.entryPrice)}</span><span>标记 {formatPrice(position.markPrice)}</span></div><div className="flex justify-between"><span className="text-[#f87171]">止损 {formatPrice(position.stopPrice)}</span><span className="data-positive">目标 {formatPrice(position.targetPrice)}</span></div><div className="flex justify-between"><span>强平参考 {formatPrice(position.liquidationPrice)}</span><span>{position.holdingMinutes.toFixed(0)} 分钟</span></div></div>
                  <button className="btn-secondary mt-3 w-full !min-h-9 !text-[10px]" disabled={close.isPending} onClick={() => { if (window.confirm(`确认按当前模拟市价平掉 ${position.symbol}？`)) close.mutate({ positionId: position.id }); }}><X size={12} />模拟市价平仓</button>
                </div>
              ))}
              {!data.positions.length && <div className="p-5 text-center"><div className="text-[11px] text-[#c5d0df]">当前无持仓</div><div className="reading mt-2 text-[10px] leading-5 text-[#8290aa]">系统只在机会与风险审批同时通过后开仓。</div></div>}
            </div>
          </section>

          <section className="panel p-4" aria-labelledby="portfolio-risk-title">
            <div className="mb-4 flex items-center justify-between"><h2 id="portfolio-risk-title" className="terminal-label">PORTFOLIO RISK</h2><ShieldAlert size={14} className="data-warning" aria-hidden="true" /></div>
            {[
              { label: "保证金占用", value: data.account.equity > 0 ? data.account.usedMargin / data.account.equity * 100 : 0, cap: data.settings.totalMarginCapPct, display: `${formatNumber(data.account.usedMargin)} USDT` },
              { label: "组合止损风险", value: openRisk, cap: data.settings.portfolioStopRiskPct, display: `${formatNumber(openRisk)}% · ${formatNumber(data.portfolioRisk.totalRisk)} USDT` },
              { label: "日损熔断距离", value: Math.abs(Math.min(0, data.account.todayPnlPct)), cap: data.settings.dailyLossLimitPct, display: `${formatPercent(data.account.todayPnlPct)} / -${data.settings.dailyLossLimitPct}%` },
            ].map((item) => <div key={item.label} className="mb-4 last:mb-0"><div className="mb-2 flex justify-between gap-2 text-[10px]"><span className="text-[#91a0b8]">{item.label}</span><span>{item.display}</span></div><div className="h-1 bg-[#1a2540]" aria-hidden="true"><div className={`h-full ${item.value / item.cap > 0.8 ? "bg-[#f87171]" : "bg-[#22d3ee]"}`} style={{ width: `${Math.min(100, item.value / item.cap * 100)}%` }} /></div><div className="mt-1 text-right text-[8px] text-[#596983]">上限 {item.cap}%</div></div>)}
            <div className="mt-4 border-t border-[#1a2540] pt-3 text-[9px] leading-5 text-[#8290aa]"><div>剩余止损预算 {formatNumber(data.portfolioRisk.remainingTotalRisk)} USDT</div><div>保本后零风险持仓 {data.portfolioRisk.positions.filter((position) => position.breakeven).length} 个</div><div>高相关同方向预算 {formatNumber(data.portfolioRisk.correlatedLimit)} USDT</div></div>
          </section>

          <section className="panel" aria-labelledby="websocket-health-title">
            <div className="flex items-center gap-2 border-b border-[#1a2540] px-4 py-3"><Network size={13} className={data.monitor.sourceHealthy ? "data-live" : "data-negative"} aria-hidden="true" /><h2 id="websocket-health-title" className="terminal-label">WEBSOCKET HEALTH</h2></div>
            <div className="p-4">
              <div className={`mb-3 text-[10px] ${data.monitor.sourceHealthy ? "data-live" : "data-negative"}`}>{data.monitor.running ? "监测运行中" : "监测未运行"} · {data.monitor.sourceHealthy ? "共享源正常" : "共享源降级"}</div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[10px]">
                {[
                  ["连接", `${data.monitor.openConnections}/${data.monitor.connections}`],
                  ["平均／最大延迟", `${formatNumber(data.monitor.averageLatencyMs ?? Number.NaN, 0)} / ${formatNumber(data.monitor.maxLatencyMs ?? Number.NaN, 0)} ms`],
                  ["重连", `${data.monitor.reconnects} 次`],
                  ["丢包", formatMissedMessages(data.monitor.missedMessages)],
                  ["限流", `${data.monitor.rateLimits} 次`],
                  ["降级合约", `${data.monitor.degradedSymbols} 个`],
                  ["消息", `${data.monitor.messages} 条`],
                  ["畸形消息", `${data.monitor.malformedMessages} 条`],
                ].map(([label, value]) => <div key={label}><dt className="text-[#8290aa]">{label}</dt><dd className="mt-1">{value}</dd></div>)}
              </dl>
              <div className="mt-3 border-t border-[#141f33] pt-2 text-[9px] text-[#596983]">最近消息 {data.monitor.lastMessageAt ? `${formatTime(new Date(data.monitor.lastMessageAt))} UTC` : "—"}</div>
            </div>
          </section>

          <section className="panel" aria-labelledby="transition-log-title">
            <div className="flex items-center gap-2 border-b border-[#1a2540] px-4 py-3"><GitBranch size={13} className="data-warning" aria-hidden="true" /><h2 id="transition-log-title" className="terminal-label">VOLATILITY TRANSITIONS</h2></div>
            <ul className="max-h-[280px] overflow-y-auto">
              {transitions.slice(0, 8).map((event) => <li key={event.id} className="border-b border-[#141f33] px-4 py-3"><div className="flex justify-between text-[9px]"><span className={event.level === "ERROR" ? "data-negative" : "data-warning"}>{event.symbol ?? "SYSTEM"}</span><span className="text-[#596983]">{formatTime(event.createdAt)}</span></div><p className="reading mt-1 text-[10px] leading-5 text-[#a8b5c8]">{event.message}</p></li>)}
              {!transitions.length && <li className="p-5 text-center text-[10px] text-[#8290aa]">暂无三态迁移记录</li>}
            </ul>
          </section>

          <section className="panel" aria-labelledby="system-audit-title">
            <div className="flex items-center gap-2 border-b border-[#1a2540] px-4 py-3"><Activity size={13} className="data-live" aria-hidden="true" /><h2 id="system-audit-title" className="terminal-label">SYSTEM AUDIT</h2></div>
            <ul className="max-h-[280px] overflow-y-auto">
              {data.events.slice(0, 8).map((event) => <li key={event.id} className="border-b border-[#141f33] px-4 py-3"><div className="flex justify-between text-[9px]"><span className={event.level === "ERROR" ? "data-negative" : event.level === "WARN" ? "data-warning" : event.level === "SUCCESS" ? "data-positive" : "data-live"}>{event.category}{event.symbol ? ` · ${event.symbol}` : ""}</span><span className="text-[#596983]">{formatTime(event.createdAt)}</span></div><p className="reading mt-1 text-[10px] leading-5 text-[#a8b5c8]">{event.message}</p></li>)}
              {!data.events.length && <li className="p-5 text-center text-[10px] text-[#8290aa]">等待系统事件</li>}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
