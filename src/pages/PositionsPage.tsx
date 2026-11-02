import { useState } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useTerminal } from "@/components/terminal-context";
import { formatNumber, formatPrice, formatTime, sideColor, sideLabel } from "@/lib/format";
import { closeExecutionFeedback } from "@/lib/executionFeedback";

export default function PositionsPage() {
  const { data, refresh } = useTerminal();
  const [tab, setTab] = useState<"orders" | "trades">("orders");
  const live = data.settings.executionMode === "LIVE_MAINNET";
  const close = trpc.trading.closePosition.useMutation({
    onSuccess: async (result) => { const feedback = closeExecutionFeedback(result); toast[feedback.tone](feedback.message); refresh(); },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="p-3 sm:p-5 xl:p-6">
      <div className="mb-5">
        <div className="terminal-label mb-1">ORDER MANAGEMENT / POSITION LEDGER</div>
        <h1 className="text-xl font-semibold tracking-[-0.04em] sm:text-2xl">订单与持仓</h1>
        <p className="reading mt-1 text-[13px] text-[#91a0b8]">{live ? "LIVE · 真实主网账户、持仓和订单；状态与成交来自持久化回报，不代表未确认成功。" : "PAPER · 本地模拟订单、成交费用和持仓账务保持一致；刷新页面不会丢失数据库记录。"}</p>
      </div>

      <div className="mb-3 grid grid-cols-2 border border-[#1a2540] bg-[#0c1220] lg:grid-cols-4">
        {[
          ["当前持仓", `${data.positions.length} / ${data.settings.maxPositions}`, "组合数量上限"],
          ["占用保证金", formatNumber(data.account.usedMargin), "USDT"],
          ["持仓浮动盈亏", `${data.account.unrealizedPnl >= 0 ? "+" : ""}${formatNumber(data.account.unrealizedPnl)}`, "USDT"],
          [live ? "模拟历史费用（非 LIVE）" : "历史累计费用", formatNumber(data.metrics.totalFees), "USDT"],
        ].map(([label, value, note], index) => <div key={label} className={`p-4 ${index > 0 ? "border-l" : ""} border-[#1a2540] ${index === 2 ? "max-lg:border-l-0 max-lg:border-t" : ""} ${index === 3 ? "max-lg:border-t" : ""}`}><div className="terminal-label">{label}</div><div className={`mt-2 text-lg font-semibold ${index === 2 ? (!data.account.valuationValid ? "data-warning" : data.account.unrealizedPnl >= 0 ? "data-positive" : "data-negative") : ""}`}>{value}</div><div className="mt-1 text-[9px] text-[#8290aa]">{note}</div></div>)}
      </div>

      <section className="panel mb-3">
        <div className="border-b border-[#1a2540] px-4 py-3"><div className="terminal-label">ACTIVE EXPOSURE</div><h2 className="mt-1 text-[13px]">当前永续持仓</h2></div>
        <div className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#22d3ee]" tabIndex={0} role="region" aria-labelledby="active-positions-caption">
          <table className="w-full min-w-[760px] border-collapse text-left text-[11px]">
            <caption id="active-positions-caption" className="sr-only">当前永续持仓、风险价格、浮动盈亏与操作</caption>
            <thead><tr className="border-b border-[#1a2540] text-[9px] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">合约／方向</th><th scope="col" className="px-3 py-3 font-normal">数量</th><th scope="col" className="hidden px-3 py-3 font-normal md:table-cell">进场／标记</th><th scope="col" className="hidden px-3 py-3 font-normal lg:table-cell">止损／目标</th><th scope="col" className="px-3 py-3 font-normal">保证金／杠杆</th><th scope="col" className="px-3 py-3 font-normal">浮动盈亏</th><th scope="col" className="px-3 py-3 font-normal">操作</th></tr></thead>
            <tbody>{data.positions.map((position) => <tr key={position.id} className="border-b border-[#141f33]"><th scope="row" className="px-4 py-3 font-normal"><div>{position.symbol}</div><div className={`text-[9px] ${sideColor(position.side)}`}>{sideLabel(position.side)}</div></th><td className="px-3 py-3">{position.qty}</td><td className="hidden px-3 py-3 md:table-cell"><div>{formatPrice(position.entryPrice)}</div><div className="text-[9px] text-[#8290aa]">{formatPrice(position.markPrice)}</div></td><td className="hidden px-3 py-3 lg:table-cell"><div className="data-negative">{formatPrice(position.stopPrice)}</div><div className="data-positive">{formatPrice(position.targetPrice)}</div></td><td className="px-3 py-3"><div>{formatNumber(position.margin)}</div><div className="data-warning text-[9px]">{position.leverage}×</div></td><td className={`px-3 py-3 ${!position.valuationValid ? "data-warning" : position.unrealizedPnl >= 0 ? "data-positive" : "data-negative"}`}><div>{position.unrealizedPnl >= 0 ? "+" : ""}{formatNumber(position.unrealizedPnl)}</div><div className="text-[9px]">{formatNumber(position.unrealizedPct)}% 保证金</div></td><td className="px-3 py-3"><button className="btn-secondary !min-h-9 !px-2 !text-[10px]" disabled={close.isPending} onClick={() => { if (window.confirm(`确认按${live ? "真实主网" : "模拟"}市价平掉 ${position.symbol}？`)) close.mutate({ positionId: position.id }); }}><X size={12} />{live ? "真实平仓" : "模拟平仓"}</button></td></tr>)}</tbody>
          </table>
          {!data.positions.length && <div className="m-4 border border-dashed border-[#263650] p-8 text-center text-[11px] text-[#8290aa]">当前没有活跃持仓。</div>}
        </div>
      </section>

      <section className="panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1a2540] px-4 py-3">
          <h2 className="terminal-label">EXECUTION HISTORY</h2>
          <div className="flex border border-[#263650]" role="group" aria-label="执行历史类型"><button type="button" aria-pressed={tab === "orders"} onClick={() => setTab("orders")} className={`min-h-9 px-4 text-[10px] ${tab === "orders" ? "bg-[#162337] text-[#22d3ee]" : "text-[#8290aa]"}`}>订单流水</button><button type="button" aria-pressed={tab === "trades"} onClick={() => setTab("trades")} className={`min-h-9 px-4 text-[10px] ${tab === "trades" ? "bg-[#162337] text-[#22d3ee]" : "text-[#8290aa]"}`}>已平仓</button></div>
        </div>
        <div className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#22d3ee]" tabIndex={0} role="region" aria-label={tab === "orders" ? "订单流水表格" : "已平仓交易表格"}>
          {tab === "orders" ? live ? (
            <table className="w-full min-w-[940px] text-left text-[11px]"><caption className="sr-only">真实主网订单状态、成交数量、成交均价和费用</caption><thead><tr className="border-b border-[#1a2540] text-[9px] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">时间 UTC</th><th scope="col" className="px-3 py-3 font-normal">合约／方向</th><th scope="col" className="px-3 py-3 font-normal">类型</th><th scope="col" className="px-3 py-3 font-normal">已成交／原数量</th><th scope="col" className="px-3 py-3 font-normal">成交均价／限价</th><th scope="col" className="px-3 py-3 font-normal">手续费</th><th scope="col" className="px-3 py-3 font-normal">真实状态</th></tr></thead><tbody>{data.liveOrders.map((order) => <tr key={order.id} className="border-b border-[#141f33]"><th scope="row" className="px-4 py-3 font-normal text-[#8290aa]">{formatTime(order.createdAt, true)}</th><td className="px-3 py-3"><div>{order.symbol}</div><div className={`text-[9px] ${sideColor(order.side)}`}>{sideLabel(order.side)}{order.reduceOnly ? " · reduceOnly" : ""}</div></td><td className="px-3 py-3">{order.type}</td><td className="px-3 py-3">{order.executedQuantity} / {order.originalQuantity}</td><td className="px-3 py-3"><div>{order.averagePrice}</div><div className="text-[9px] text-[#8290aa]">{order.price}</div></td><td className="px-3 py-3">{order.commission}</td><td className={`px-3 py-3 ${order.status === "FILLED" ? "data-positive" : "data-warning"}`}>{order.status}</td></tr>)}</tbody></table>
          ) : (
            <table className="w-full min-w-[760px] text-left text-[11px]"><caption className="sr-only">模拟订单时间、合约、成交价格、费用与状态</caption><thead><tr className="border-b border-[#1a2540] text-[9px] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">时间 UTC</th><th scope="col" className="px-3 py-3 font-normal">合约</th><th scope="col" className="px-3 py-3 font-normal">用途／方向</th><th scope="col" className="px-3 py-3 font-normal">数量</th><th scope="col" className="px-3 py-3 font-normal">成交价</th><th scope="col" className="px-3 py-3 font-normal">手续费</th><th scope="col" className="px-3 py-3 font-normal">状态</th></tr></thead><tbody>{data.orders.map((order) => <tr key={order.id} className="border-b border-[#141f33]"><th scope="row" className="px-4 py-3 font-normal text-[#8290aa]">{formatTime(order.createdAt, true)}</th><td className="px-3 py-3">{order.symbol}</td><td className="px-3 py-3"><span className={order.purpose === "OPEN" ? "data-live" : "data-warning"}>{order.purpose}</span><span className={`ml-2 ${sideColor(order.side)}`}>{sideLabel(order.side)}</span></td><td className="px-3 py-3">{order.qty}</td><td className="px-3 py-3">{formatPrice(order.price)}</td><td className="px-3 py-3">{formatNumber(order.fee, 4)}</td><td className="px-3 py-3 data-positive">{order.status}</td></tr>)}</tbody></table>
          ) : <table className="w-full min-w-[760px] text-left text-[11px]"><caption className="sr-only">{live ? "模拟历史已平仓交易（非当前 LIVE 账户）" : "模拟已平仓交易、净盈亏、费用与退出原因"}</caption><thead><tr className="border-b border-[#1a2540] text-[9px] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">平仓时间</th><th scope="col" className="px-3 py-3 font-normal">合约／方向</th><th scope="col" className="hidden px-3 py-3 font-normal md:table-cell">进场／退出</th><th scope="col" className="px-3 py-3 font-normal">净盈亏</th><th scope="col" className="hidden px-3 py-3 font-normal lg:table-cell">费用／资金费</th><th scope="col" className="hidden px-3 py-3 font-normal sm:table-cell">持仓时间</th><th scope="col" className="px-3 py-3 font-normal">退出原因</th></tr></thead><tbody>{data.trades.map((trade) => <tr key={trade.id} className="border-b border-[#141f33]"><th scope="row" className="px-4 py-3 font-normal text-[#8290aa]">{formatTime(trade.closedAt, true)}</th><td className="px-3 py-3"><div>{trade.symbol}</div><div className={`text-[9px] ${sideColor(trade.side)}`}>{sideLabel(trade.side)}</div></td><td className="hidden px-3 py-3 md:table-cell"><div>{formatPrice(trade.entryPrice)}</div><div className="text-[#8290aa]">{formatPrice(trade.exitPrice)}</div></td><td className={`px-3 py-3 ${trade.pnl >= 0 ? "data-positive" : "data-negative"}`}>{trade.pnl >= 0 ? "+" : ""}{formatNumber(trade.pnl)}<div className="text-[9px]">{formatNumber(trade.returnPct)}%</div></td><td className="hidden px-3 py-3 lg:table-cell"><div>{formatNumber(trade.fees, 4)}</div><div className={`text-[9px] ${(trade.fundingPnl ?? 0) >= 0 ? "data-positive" : "data-negative"}`}>资金费 {formatNumber(trade.fundingPnl ?? 0, 4)}</div></td><td className="hidden px-3 py-3 sm:table-cell">{trade.holdingMinutes.toFixed(0)} 分钟</td><td className="reading px-3 py-3 text-[#a8b5c8]">{trade.exitReason}</td></tr>)}</tbody></table>}
          {((tab === "orders" && (live ? !data.liveOrders.length : !data.orders.length)) || (tab === "trades" && !data.trades.length)) && <div className="m-4 border border-dashed border-[#263650] p-8 text-center text-[11px] text-[#8290aa]">{tab === "orders" && live ? "尚无真实订单记录；未提交或 UNKNOWN 不会被显示为成功。" : "尚无模拟历史记录。"}</div>}
        </div>
      </section>
      {live && <section className="panel mt-3" aria-labelledby="unsettled-title">
        <div className="border-b border-[#1a2540] px-4 py-3"><h2 id="unsettled-title" className="terminal-label">UNSETTLED / RECONCILIATION</h2></div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="未结意图和对账问题">
          <table className="w-full min-w-[640px] text-left text-[11px]"><caption className="sr-only">真实未结意图与未解决对账问题</caption><thead><tr className="border-b border-[#1a2540] text-[9px] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">类型</th><th scope="col" className="px-3 py-3 font-normal">合约</th><th scope="col" className="px-3 py-3 font-normal">状态／严重度</th><th scope="col" className="px-3 py-3 font-normal">说明</th></tr></thead><tbody>
            {data.unsettledIntents.map((intent) => <tr key={intent.id} className="border-b border-[#141f33]"><th scope="row" className="px-4 py-3 font-normal">未结意图</th><td className="px-3 py-3">{intent.symbol}</td><td className="px-3 py-3 data-warning">{intent.status}</td><td className="px-3 py-3 font-mono text-[9px]">{intent.id}</td></tr>)}
            {data.reconciliationIssues.filter((issue) => issue.status !== "RESOLVED").map((issue) => <tr key={issue.id} className="border-b border-[#141f33]"><th scope="row" className="px-4 py-3 font-normal">{issue.category}</th><td className="px-3 py-3">{issue.symbol ?? "SYSTEM"}</td><td className="px-3 py-3 data-negative">{issue.severity} · {issue.status}</td><td className="reading px-3 py-3 text-[#a8b5c8]">{issue.message}</td></tr>)}
          </tbody></table>
          {!data.unsettledIntents.length && !data.reconciliationIssues.some((issue) => issue.status !== "RESOLVED") && <div className="p-5 text-center text-[10px] text-[#8290aa]">没有未结意图或未解决对账问题。</div>}
        </div>
      </section>}
    </div>
  );
}
