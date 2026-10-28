import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Layers3, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { useTerminal } from "@/components/terminal-context";
import type { BacktestResult, PortfolioBacktestResult } from "@contracts/trading";
import { formatNumber, formatPercent, formatPrice, formatTime, sideColor, sideLabel } from "@/lib/format";

function isPortfolioResult(result: BacktestResult): result is PortfolioBacktestResult {
  return result.symbol === "PORTFOLIO";
}

export default function ReviewPage() {
  const { data } = useTerminal();
  const eligibleMarkets = data.markets.filter((market) => market.eligible).slice(0, 20);
  const [mode, setMode] = useState<"SINGLE" | "PORTFOLIO">("SINGLE");
  const [symbol, setSymbol] = useState(() => eligibleMarkets[0]?.symbol ?? "");
  const [portfolioSymbols, setPortfolioSymbols] = useState<string[]>(() => eligibleMarkets.slice(0, 3).map((market) => market.symbol));
  const [timeframe, setTimeframe] = useState<"5m" | "15m">("15m");
  const [bars, setBars] = useState(600);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const portfolio = result && isPortfolioResult(result) ? result : null;
  const history = trpc.trading.backtests.useQuery();
  const runs = (history.data ?? []) as BacktestResult[];
  const run = trpc.trading.runBacktest.useMutation({
    onSuccess: (backtest) => { setResult(backtest); toast.success(`回测完成：${backtest.totalTrades} 笔交易`); void history.refetch(); },
    onError: (error) => toast.error(error.message),
  });
  const runPortfolio = trpc.trading.runPortfolioBacktest.useMutation({
    onSuccess: (backtest) => { setResult(backtest); toast.success(`组合回测完成：${backtest.symbols.length} 个合约，${backtest.totalTrades} 笔交易`); void history.refetch(); },
    onError: (error) => toast.error(error.message),
  });
  const remove = trpc.trading.deleteBacktest.useMutation({
    onSuccess: async (_, input) => { if (result?.id === input.id) setResult(null); await history.refetch(); toast.success("回测记录已删除"); },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="p-3 sm:p-5 xl:p-6">
      <div className="mb-5">
        <div className="terminal-label mb-1">EVENT-DRIVEN VALIDATION / POST-TRADE REVIEW</div>
        <h1 className="text-xl font-semibold tracking-[-0.04em] sm:text-2xl">回测与复盘</h1>
        <p className="reading mt-1 max-w-3xl text-[13px] leading-6 text-[#91a0b8]">回测用于发现执行与参数缺陷，不用于寻找“百分百盈利”组合。结果包含费用和滑点，并保守处理同一根 K 线内的止盈止损冲突。</p>
      </div>

      <div className="mb-3 grid grid-cols-2 border border-[#1a2540] bg-[#0c1220] lg:grid-cols-4">
        {[
          ["模拟已平仓", `${data.metrics.totalTrades} 笔`, `平均 ${data.metrics.avgHoldingMinutes.toFixed(0)} 分钟`],
          ["模拟胜率", `${formatNumber(data.metrics.winRate)}%`, "不作为唯一目标"],
          [" Profit Factor", data.metrics.profitFactor >= 999 ? "∞" : formatNumber(data.metrics.profitFactor), "总盈利 / 总亏损"],
          ["最大回撤", `${formatNumber(data.metrics.maxDrawdown)}%`, `费用 ${formatNumber(data.metrics.totalFees)} USDT`],
        ].map(([label, value, note], index) => <div key={label} className={`p-4 ${index > 0 ? "border-l" : ""} border-[#1a2540] ${index === 2 ? "max-lg:border-l-0 max-lg:border-t" : ""} ${index === 3 ? "max-lg:border-t" : ""}`}><div className="terminal-label">{label}</div><div className="mt-2 text-lg font-semibold">{value}</div><div className="mt-1 text-[9px] text-[#8290aa]">{note}</div></div>)}
      </div>

      <section className="panel mb-3 p-4" aria-labelledby="backtest-entry-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="backtest-entry-title" className="terminal-label">BACKTEST INPUT</h2>
          <div className="flex border border-[#263650]" role="group" aria-label="回测类型">
            <button type="button" aria-pressed={mode === "SINGLE"} onClick={() => setMode("SINGLE")} className={`min-h-9 px-3 text-[10px] ${mode === "SINGLE" ? "bg-[#162337] text-[#22d3ee]" : "text-[#8290aa]"}`}>单标的</button>
            <button type="button" aria-pressed={mode === "PORTFOLIO"} onClick={() => setMode("PORTFOLIO")} className={`min-h-9 px-3 text-[10px] ${mode === "PORTFOLIO" ? "bg-[#162337] text-[#22d3ee]" : "text-[#8290aa]"}`}><Layers3 size={12} className="mr-1 inline" aria-hidden="true" />多标的组合</button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {mode === "SINGLE" ? <label className="min-w-[180px] flex-1"><span className="terminal-label">回测合约</span><select className="terminal-input mt-2" value={symbol} onChange={(event) => setSymbol(event.target.value)}>{eligibleMarkets.map((market) => <option key={market.symbol} value={market.symbol}>{market.symbol} · {market.maxLeverage}×</option>)}</select></label> : <div className="min-w-[240px] flex-1"><label htmlFor="portfolio-symbols" className="terminal-label">组合合约（1–10 个）</label><select id="portfolio-symbols" multiple size={5} aria-describedby="portfolio-symbols-hint" aria-invalid={portfolioSymbols.length > 10} className="terminal-input mt-2 !h-auto" value={portfolioSymbols} onChange={(event) => setPortfolioSymbols(Array.from(event.target.selectedOptions, (option) => option.value))}>{eligibleMarkets.map((market) => <option key={market.symbol} value={market.symbol}>{market.symbol} · {market.maxLeverage}×</option>)}</select><p id="portfolio-symbols-hint" className={`reading mt-2 text-[10px] ${portfolioSymbols.length > 10 ? "data-negative" : "text-[#8290aa]"}`}>已选择 {portfolioSymbols.length}/10；使用 Ctrl / Shift 可多选。组合共享权益、风险预算、三态与日损。</p></div>}
          <label><span className="terminal-label">执行周期</span><select className="terminal-input mt-2 !w-32" value={timeframe} onChange={(event) => setTimeframe(event.target.value as "5m" | "15m")}><option value="5m">5 分钟</option><option value="15m">15 分钟</option></select></label>
          <label><span className="terminal-label">K线数量</span><select className="terminal-input mt-2 !w-32" value={bars} onChange={(event) => setBars(Number(event.target.value))}><option value={300}>300 根</option><option value={600}>600 根</option><option value={1000}>1000 根</option></select></label>
          {mode === "SINGLE" ? <button type="button" className="btn-primary" disabled={!symbol || run.isPending} onClick={() => run.mutate({ symbol, timeframe, bars })}><Play size={14} aria-hidden="true" />{run.isPending ? "正在回测" : "运行单标的回测"}</button> : <button type="button" className="btn-primary" disabled={!portfolioSymbols.length || portfolioSymbols.length > 10 || runPortfolio.isPending} onClick={() => runPortfolio.mutate({ symbols: portfolioSymbols, timeframe, bars })}><Play size={14} aria-hidden="true" />{runPortfolio.isPending ? "正在组合回测" : "运行组合回测"}</button>}
        </div>
      </section>

      {result ? (
        <>
          <section className="panel mb-3">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1a2540] px-4 py-3"><div><div className="terminal-label">BACKTEST RESULT</div><h2 className="mt-1 text-[13px]">{result.symbol} · {result.timeframe} · {result.bars} 根K线</h2>{portfolio && <p className="reading mt-1 text-[10px] text-[#8290aa]">{portfolio.symbols.join(" / ")}</p>}</div><div className={`text-lg font-semibold ${result.netPnl >= 0 ? "data-positive" : "data-negative"}`}>{result.netPnl >= 0 ? "+" : ""}{formatNumber(result.netPnl)} USDT <span className="text-[11px]">({formatPercent(result.returnPct)})</span></div></div>
            <div className="grid grid-cols-2 border-b border-[#1a2540] md:grid-cols-3 xl:grid-cols-6">
              {[
                ["期末权益", formatNumber(result.finalEquity)], ["交易次数", `${result.totalTrades}`], ["胜率", `${formatNumber(result.winRate)}%`],
                ["Profit Factor", result.profitFactor >= 999 ? "∞" : formatNumber(result.profitFactor)], ["最大回撤", `${formatNumber(result.maxDrawdown)}%`], ["总费用", formatNumber(result.totalFees)],
              ].map(([label, value]) => <div key={label} className="border-r border-t border-[#141f33] p-3"><div className="terminal-label">{label}</div><div className="mt-1 text-[14px]">{value}</div></div>)}
            </div>
            {portfolio && <dl className="grid grid-cols-2 border-b border-[#1a2540] bg-[#080e19] md:grid-cols-5">{[
              ["组合合约", `${portfolio.symbols.length} 个`],
              ["历史资金费", `${formatNumber(portfolio.totalFunding)} USDT`],
              ["风险拒绝", `${portfolio.riskRejections.length} 次`],
              ["三态迁移", `${portfolio.transitions.length} 次`],
              ["日损锁定", `${portfolio.dailyLossLocks.length} 次`],
            ].map(([label, value]) => <div key={label} className="border-r border-[#141f33] p-3"><dt className="terminal-label">{label}</dt><dd className="mt-1 text-[12px]">{value}</dd></div>)}</dl>}
            <div className="h-[280px] p-3" role="img" aria-label={`${result.symbol} 回测权益曲线；期末权益 ${formatNumber(result.finalEquity)} USDT，最大回撤 ${formatNumber(result.maxDrawdown)}%`}>
              {result.equityCurve.length > 1 ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={result.equityCurve} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}><defs><linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={0.22} /><stop offset="100%" stopColor="#22d3ee" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#1a2540" vertical={false} /><XAxis dataKey="time" tickFormatter={(time) => new Date(time * 1000).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", timeZone: "UTC" })} stroke="#596983" fontSize={9} tickLine={false} /><YAxis domain={["auto", "auto"]} stroke="#596983" fontSize={9} tickLine={false} axisLine={false} width={70} tickFormatter={(value) => formatNumber(value, 0)} /><Tooltip contentStyle={{ background: "#0c1220", border: "1px solid #263650", borderRadius: 0, fontSize: 11 }} labelFormatter={(time) => `${formatTime(new Date(Number(time) * 1000).toISOString(), true)} UTC`} formatter={(value) => [`${formatNumber(Number(value))} USDT`, "权益"]} /><Area type="monotone" dataKey="equity" stroke="#22d3ee" strokeWidth={1.5} fill="url(#equityFill)" isAnimationActive={false} /></AreaChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center text-[11px] text-[#8290aa]">没有足够权益数据绘制曲线</div>}
            </div>
            <div className="border-t border-[#1a2540] p-4"><div className="terminal-label mb-2">回测假设与限制</div><ul className="reading grid gap-1 text-[10px] leading-5 text-[#91a0b8] md:grid-cols-2">{result.assumptions.map((assumption) => <li key={assumption}>· {assumption}</li>)}</ul></div>
          </section>

          {portfolio && <section className="panel mb-3" aria-labelledby="portfolio-diagnostics-title">
            <div className="border-b border-[#1a2540] px-4 py-3"><div className="terminal-label">PORTFOLIO DIAGNOSTICS</div><h2 id="portfolio-diagnostics-title" className="mt-1 text-[13px]">逐币结果与组合事件</h2></div>
            <div className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#22d3ee]" tabIndex={0} role="region" aria-labelledby="portfolio-symbol-caption">
              <table className="w-full min-w-[560px] text-left text-[11px]">
                <caption id="portfolio-symbol-caption" className="sr-only">组合内每个合约的交易数与净盈亏</caption>
                <thead><tr className="border-b border-[#1a2540] text-[9px] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">合约</th><th scope="col" className="px-3 py-3 font-normal">交易数</th><th scope="col" className="px-3 py-3 font-normal">净盈亏</th></tr></thead>
                <tbody>{portfolio.symbols.map((symbol) => { const trades = portfolio.tradesBySymbol[symbol] ?? []; const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0); return <tr key={symbol} className="border-b border-[#141f33]"><th scope="row" className="px-4 py-3 font-medium">{symbol}</th><td className="px-3 py-3">{trades.length}</td><td className={`px-3 py-3 ${pnl >= 0 ? "data-positive" : "data-negative"}`}>{pnl >= 0 ? "+" : ""}{formatNumber(pnl)} USDT</td></tr>; })}</tbody>
              </table>
            </div>
            <div className="grid md:grid-cols-2 xl:grid-cols-4">
              <section className="border-b border-[#141f33] p-4 md:border-r"><h3 className="terminal-label">资金费结算</h3><ul className="mt-3 space-y-2 text-[9px]">{portfolio.funding.slice(-6).reverse().map((item, index) => <li key={`${item.time}-${item.symbol}-${index}`} className="flex justify-between gap-2"><span>{item.symbol} · {formatTime(new Date(item.time))}</span><span className={item.amount >= 0 ? "data-positive" : "data-negative"}>{item.amount >= 0 ? "+" : ""}{formatNumber(item.amount, 4)}</span></li>)}{!portfolio.funding.length && <li className="text-[#8290aa]">样本内无资金费结算</li>}</ul></section>
              <section className="border-b border-[#141f33] p-4 xl:border-r"><h3 className="terminal-label">风险拒绝</h3><ul className="mt-3 space-y-2 text-[9px]">{portfolio.riskRejections.slice(-6).reverse().map((item, index) => <li key={`${item.time}-${item.symbol}-${index}`}><div className="text-[#8290aa]">{item.symbol} · {formatTime(new Date(item.time))}</div><div className="reading mt-1 leading-4">{item.reason}</div></li>)}{!portfolio.riskRejections.length && <li className="text-[#8290aa]">样本内无风险拒绝</li>}</ul></section>
              <section className="border-b border-[#141f33] p-4 md:border-r"><h3 className="terminal-label">三态迁移</h3><ul className="mt-3 space-y-2 text-[9px]">{portfolio.transitions.slice(-6).reverse().map((item, index) => <li key={`${item.time}-${item.symbol}-${item.version}-${index}`}><div>{item.symbol} · {item.from} → {item.to}</div><div className="mt-1 text-[#8290aa]">{formatTime(new Date(item.time))} · v{item.version}</div></li>)}{!portfolio.transitions.length && <li className="text-[#8290aa]">样本内无三态迁移</li>}</ul></section>
              <section className="border-b border-[#141f33] p-4"><h3 className="terminal-label">日损与数据缺口</h3><ul className="mt-3 space-y-2 text-[9px]">{portfolio.dailyLossLocks.map((item) => <li key={`${item.day}-${item.time}`} className="data-warning">{item.day} · 日损锁定 · 权益 {formatNumber(item.equity)}</li>)}{portfolio.dataGaps.map((gap) => <li key={gap} className="data-negative">{gap}</li>)}{!portfolio.dailyLossLocks.length && !portfolio.dataGaps.length && <li className="text-[#8290aa]">无日损锁定或数据缺口</li>}</ul></section>
            </div>
          </section>}

          <section className="panel mb-3">
            <div className="border-b border-[#1a2540] px-4 py-3"><h2 className="terminal-label">BACKTEST TRADES</h2></div>
            <div className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#22d3ee]" tabIndex={0} role="region" aria-labelledby="backtest-trades-caption"><table className="w-full min-w-[760px] text-left text-[11px]"><caption id="backtest-trades-caption" className="sr-only">回测逐笔交易、净盈亏和退出原因</caption><thead><tr className="border-b border-[#1a2540] text-[9px] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">时间</th><th scope="col" className="px-3 py-3 font-normal">合约</th><th scope="col" className="px-3 py-3 font-normal">方向</th><th scope="col" className="px-3 py-3 font-normal">进场／退出</th><th scope="col" className="px-3 py-3 font-normal">净盈亏</th><th scope="col" className="hidden px-3 py-3 font-normal md:table-cell">持仓分钟</th><th scope="col" className="px-3 py-3 font-normal">退出原因</th></tr></thead><tbody>{result.trades.map((trade) => <tr key={trade.id} className="border-b border-[#141f33]"><th scope="row" className="px-4 py-3 font-normal text-[#8290aa]">{formatTime(trade.closedAt, true)}</th><td className="px-3 py-3">{trade.symbol}</td><td className={`px-3 py-3 ${sideColor(trade.side)}`}>{sideLabel(trade.side)}</td><td className="px-3 py-3">{formatPrice(trade.entryPrice)}<span className="text-[#596983]"> → </span>{formatPrice(trade.exitPrice)}</td><td className={`px-3 py-3 ${trade.pnl >= 0 ? "data-positive" : "data-negative"}`}>{trade.pnl >= 0 ? "+" : ""}{formatNumber(trade.pnl)}</td><td className="hidden px-3 py-3 md:table-cell">{trade.holdingMinutes.toFixed(0)}</td><td className="reading px-3 py-3 text-[#a8b5c8]">{trade.exitReason}</td></tr>)}</tbody></table>{!result.trades.length && <div className="m-4 border border-dashed border-[#263650] p-8 text-center text-[11px] text-[#8290aa]">该样本没有符合全部条件的交易。这是有效回测结果，不应通过放宽未来数据来强行制造交易。</div>}</div>
          </section>
        </>
      ) : <section className="panel mb-3 border-dashed p-10 text-center"><div className="text-[12px] text-[#c5d0df]">选择合约并运行一次真实K线回测</div><p className="reading mx-auto mt-2 max-w-xl text-[11px] leading-5 text-[#8290aa]">也可以从下方历史记录读取已保存结果。样本无交易会如实显示，不自动伪造收益曲线。</p></section>}

      <section className="panel">
        <div className="border-b border-[#1a2540] px-4 py-3"><div className="terminal-label">SAVED RUNS</div><h2 className="mt-1 text-[13px]">已保存回测</h2></div>
        <div>{runs.map((saved) => <div key={saved.id} className="flex flex-wrap items-center gap-3 border-b border-[#141f33] px-4 py-3"><button className="flex min-h-11 flex-1 flex-wrap items-center gap-3 text-left" onClick={() => setResult(saved)}><span className="text-[12px]">{saved.symbol}</span><span className="text-[10px] text-[#8290aa]">{saved.timeframe} · {saved.bars} 根</span><span className={`text-[11px] ${saved.netPnl >= 0 ? "data-positive" : "data-negative"}`}>{saved.netPnl >= 0 ? "+" : ""}{formatNumber(saved.netPnl)} USDT</span><span className="text-[9px] text-[#596983]">{formatTime(saved.createdAt, true)} UTC</span></button><button className="btn-secondary !min-h-9 !px-2" onClick={() => { if (window.confirm("删除这条回测记录？")) remove.mutate({ id: saved.id }); }} aria-label={`删除 ${saved.symbol} 回测`}><Trash2 size={13} /></button></div>)}{!runs.length && <div className="p-5 text-center text-[10px] text-[#8290aa]">暂无保存的回测</div>}</div>
      </section>
    </div>
  );
}
