import type { ExecutionStatus } from "@contracts/trading";

function health(value: boolean, yes: string, no: string) {
  return <span className={value ? "data-live" : "data-negative"}>{value ? yes : no}</span>;
}

export default function ExecutionStatusPanel({ status }: { status: ExecutionStatus }) {
  const live = status.executionMode === "LIVE_MAINNET";
  const rows = [
    ["主网总开关", status.environmentEnabled ? "已开启" : "未开启"],
    ["Armed", status.armed ? "已授权" : "未授权"],
    ["真实执行适配器", status.adapterConfigured ? "已配置" : "未配置"],
    ["凭据", status.credentialsConfigured ? "已配置（内容不显示）" : "凭据未配置"],
    ["未结持仓／意图／订单", `${status.outstanding.openPositions} / ${status.outstanding.pendingIntents} / ${status.outstanding.unfinishedOrders}`],
    ["私有 WS", `${status.privateWs.connected ? "已连接" : "未连接"} · 重连 ${status.privateWs.reconnects} 次`],
    ["对账", `${status.reconciliation.healthy ? "正常" : !status.reconciliation.configured ? "未配置" : !status.reconciliation.running ? "未运行" : "陈旧或存在严重问题"} · 未解决 ${status.reconciliation.openIssues} 项`],
    ["动量检测", status.momentum.reason],
  ];
  return (
    <section className="panel" aria-labelledby="execution-status-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1a2540] px-4 py-3">
        <div><div className="terminal-label">EXECUTION READINESS</div><h2 id="execution-status-title" className="mt-1 text-[13px]">执行状态与主网就绪</h2></div>
        <span className={`border px-2 py-1 text-[10px] ${live ? "border-[#7f1d1d] text-[#fca5a5]" : "border-[#155e75] text-[#67e8f9]"}`}>
          {live ? "LIVE · 真实" : "PAPER · 模拟"}
        </span>
      </div>
      <div className="p-4">
        <dl className="grid gap-x-4 gap-y-3 text-[10px] sm:grid-cols-2">
          {rows.map(([label, value]) => <div key={label}><dt className="text-[#8290aa]">{label}</dt><dd className="mt-1 leading-5 text-[#c5d0df]">{value}</dd></div>)}
        </dl>
        <div className="mt-4 border-t border-[#141f33] pt-3 text-[10px] leading-5">
          <div className="mb-1 flex justify-between gap-3"><span className="text-[#8290aa]">完整预检</span>{live ? health(status.preflight.ready && status.reasons.length === 0, "通过", "未通过") : <span className="text-[#8290aa]">不适用</span>}</div>
          {status.preflight.reasons.length > 0 && <p className="reading text-[#a8b5c8]">{status.preflight.reasons.join("；")}</p>}
          {live && status.reasons.length > 0 && <p className="reading mt-2 text-[#fbbf24]">提交门控：{status.reasons.join("；")}</p>}
        </div>
        {status.missingProtections.length > 0 && <div className="mt-3 border border-[#7f1d1d] bg-[#1c1015] px-3 py-2 text-[10px] leading-5 text-[#fca5a5]" role="alert">{status.missingProtections.join("；")}</div>}
      </div>
    </section>
  );
}
