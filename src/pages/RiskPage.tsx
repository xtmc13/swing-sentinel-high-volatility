import { useState } from "react";
import { OctagonAlert, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { useTerminal } from "@/components/terminal-context";
import type { TradingSettings } from "@contracts/trading";
import { formatTime } from "@/lib/format";
import { bulkExecutionFeedback } from "@/lib/executionFeedback";
import ExecutionStatusPanel from "@/components/ExecutionStatusPanel";
import BinanceCredentialForm from "@/components/BinanceCredentialForm";

function NumberField({ label, value, suffix, step = 0.1, min = 0, max, onChange }: { label: string; value: number; suffix: string; step?: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <label className="block"><span className="terminal-label">{label}</span><span className="relative mt-2 block"><input type="number" className="terminal-input pr-16" value={value} step={step} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /><span className="pointer-events-none absolute right-3 top-3 text-[10px] text-[#596983]">{suffix}</span></span></label>;
}

export default function RiskPage() {
  const { data } = useTerminal();
  return <RiskPageContent key={JSON.stringify(data.settings)} />;
}

function RiskPageContent() {
  const { data, refresh } = useTerminal();
  const [form, setForm] = useState<TradingSettings>(data.settings);
  const [confirmationPhrase, setConfirmationPhrase] = useState("");
  const [canary, setCanary] = useState({
    symbol: "BTCUSDT", side: "LONG" as "LONG" | "SHORT", limitPrice: "", stopPrice: "",
    confirmationPhrase: "",
  });
  const save = trpc.trading.saveSettings.useMutation({
    onSuccess: async () => { toast.success("风险与执行参数已保存，下一轮扫描生效"); refresh(); },
    onError: (error) => toast.error(error.message),
  });
  const setMode = trpc.trading.setExecutionMode.useMutation({
    onSuccess: async (result) => { toast.success(`执行模式已切换为 ${result.executionMode === "LIVE_MAINNET" ? "LIVE · 真实" : "PAPER · 模拟"}`); refresh(); },
    onError: (error) => toast.error(error.message),
  });
  const setControls = trpc.trading.setLiveControls.useMutation({
    onSuccess: async (result) => {
      toast.success(result.armed ? "主网已 armed；每次提交仍重新执行全部门控" : "主网已 disarm");
      setConfirmationPhrase("");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const manualCanary = trpc.trading.manualCanary.useMutation({
    onSuccess: async (result) => {
      if (result.ok) toast.success(`真实 canary 已提交；等待成交回报：${result.reason}`);
      else toast.error(`canary 未提交：${result.reason}`);
      setCanary((current) => ({ ...current, confirmationPhrase: "" }));
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const emergency = trpc.trading.emergencyStop.useMutation({
    onSuccess: async (result) => { const feedback = bulkExecutionFeedback("紧急停止", result); toast[feedback.tone](feedback.message); refresh(); },
    onError: (error) => toast.error(error.message),
  });
  const reset = trpc.trading.reset.useMutation({
    onSuccess: async (result) => { const feedback = bulkExecutionFeedback("账户重置", result); toast[feedback.tone](feedback.message); refresh(); },
    onError: (error) => toast.error(error.message),
  });
  const update = <K extends keyof TradingSettings>(key: K, value: TradingSettings[K]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);
  const modeCounts = {
    NORMAL: data.volatilityStates.filter((state) => state.mode === "NORMAL").length,
    HIGH: data.volatilityStates.filter((state) => state.mode === "HIGH").length,
    EXTREME: data.volatilityStates.filter((state) => state.mode === "EXTREME").length,
  };
  const submit = () => {
    if (form.totalMarginCapPct < form.marginPerTradePct) { toast.error("总保证金上限不能低于单笔保证金上限"); return; }
    if (form.atrHighPercentile > form.atrExtremePercentile) { toast.error("ATR 高波动分位不能高于极端分位"); return; }
    if (form.tickHighSigma > form.tickExtremeSigma) { toast.error("跳动高波动倍数不能高于极端倍数"); return; }
    save.mutate(form);
  };

  return (
    <div className="p-3 sm:p-5 xl:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div><div className="terminal-label mb-1">PRE-TRADE RISK / EXECUTION CONTROL</div><h1 className="text-xl font-semibold tracking-[-0.04em] sm:text-2xl">风险与执行</h1><p className="reading mt-1 max-w-3xl text-[13px] leading-6 text-[#91a0b8]">杠杆不决定仓位。系统先由止损距离计算风险数量，再受保证金、持仓数量、最小下单单位和强平缓冲约束。</p></div>
        <button type="button" className="btn-primary" disabled={!dirty || save.isPending} onClick={submit}><Save size={14} aria-hidden="true" />{save.isPending ? "保存中" : "保存参数"}</button>
      </div>

      <section className="mb-3 grid grid-cols-3 border border-[#1a2540] bg-[#0c1220]" aria-label="当前三态数量">
        {([
          ["NORMAL", "正常", "data-live"],
          ["HIGH", "高波动", "data-warning"],
          ["EXTREME", "极端", "data-negative"],
        ] as const).map(([mode, label, tone], index) => <div key={mode} className={`p-4 ${index > 0 ? "border-l border-[#1a2540]" : ""}`}><div className="terminal-label">{mode} · {label}</div><div className={`mt-2 text-xl font-semibold ${tone}`}>{modeCounts[mode]}</div><div className="mt-1 text-[9px] text-[#8290aa]">已评估 {data.volatilityStates.length} 个合约</div></div>)}
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <section className="panel p-4 sm:p-5">
            <div className="mb-5 flex items-center justify-between"><div><div className="terminal-label">POSITION SIZING</div><h2 className="mt-1 text-[13px]">仓位与组合预算</h2></div><ShieldCheck size={18} className="data-live" aria-hidden="true" /></div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField label="单笔风险预算" value={form.riskPerTradePct} suffix="% 权益" step={0.05} min={0.05} max={2} onChange={(value) => update("riskPerTradePct", value)} />
              <NumberField label="单笔保证金上限" value={form.marginPerTradePct} suffix="% 权益" step={0.1} min={0.1} max={10} onChange={(value) => update("marginPerTradePct", value)} />
              <NumberField label="最大持仓数" value={form.maxPositions} suffix="个" step={1} min={1} max={10} onChange={(value) => update("maxPositions", Math.round(value))} />
              <NumberField label="总保证金上限" value={form.totalMarginCapPct} suffix="% 权益" step={0.5} min={1} max={30} onChange={(value) => update("totalMarginCapPct", value)} />
              <NumberField label="每日亏损熔断" value={form.dailyLossLimitPct} suffix="% 权益" step={0.5} min={0.5} max={10} onChange={(value) => update("dailyLossLimitPct", value)} />
              <NumberField label="组合总止损风险" value={form.portfolioStopRiskPct} suffix="% 权益" step={0.05} min={0.05} max={10} onChange={(value) => update("portfolioStopRiskPct", value)} />
              <NumberField label="高相关同方向风险" value={form.correlatedDirectionRiskPct} suffix="% 权益" step={0.05} min={0.05} max={10} onChange={(value) => update("correlatedDirectionRiskPct", value)} />
              <NumberField label="相关性阈值" value={form.correlationThreshold} suffix="绝对值" step={0.05} min={0} max={1} onChange={(value) => update("correlationThreshold", value)} />
              <NumberField label="相关性窗口" value={form.correlationWindow} suffix="根 15M" step={1} min={20} max={500} onChange={(value) => update("correlationWindow", Math.round(value))} />
              <label className="block"><span className="terminal-label">自动交易</span><span className="mt-2 flex min-h-11 items-center justify-between border border-[#263650] bg-[#080e19] px-3 text-[11px]"><span>{form.autoTrade ? "允许自动开仓" : "仅管理现有持仓"}</span><input type="checkbox" className="h-4 w-4 accent-[#22d3ee]" checked={form.autoTrade} onChange={(event) => update("autoTrade", event.target.checked)} /></span></label>
            </div>
            <div className="mt-5 border border-[#1a2540] bg-[#080e19] p-4 text-[11px] leading-6 text-[#a8b5c8]">
              <div className="mb-2 text-[#22d3ee]">实际数量 = min（风险预算数量，单笔保证金数量，组合剩余保证金数量）</div>
              风险预算数量 = 账户权益 × {form.riskPerTradePct}% ÷（止损距离＋双边费用与滑点）。数量还会按币安合约步长向下取整，不足最小下单单位则放弃交易。
            </div>
          </section>

          <section className="panel p-4 sm:p-5">
            <div className="terminal-label">THREE-STATE VOLATILITY</div><h2 className="mb-2 mt-1 text-[13px]">三态基线与确认</h2>
            <p className="reading mb-5 text-[10px] leading-5 text-[#8290aa]">HIGH 只缩减新增风险并加快风险检查；EXTREME 立即禁止新开仓。参数是待回测校准的工程默认值，不代表最优策略。</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField label="ATR 基线时长" value={form.atrBaselineDays} suffix="天 5M" step={1} min={1} max={30} onChange={(value) => update("atrBaselineDays", Math.round(value))} />
              <NumberField label="ATR 最少样本" value={form.atrBaselineMinSamples} suffix="根" step={1} min={2016} max={100000} onChange={(value) => update("atrBaselineMinSamples", Math.round(value))} />
              <NumberField label="ATR 高波动分位" value={form.atrHighPercentile} suffix="P" step={1} min={50} max={100} onChange={(value) => update("atrHighPercentile", value)} />
              <NumberField label="ATR 极端分位" value={form.atrExtremePercentile} suffix="P" step={1} min={50} max={100} onChange={(value) => update("atrExtremePercentile", value)} />
              <NumberField label="1M 高波动倍数" value={form.tickHighSigma} suffix="σ" step={0.5} min={0.1} max={20} onChange={(value) => update("tickHighSigma", value)} />
              <NumberField label="1M 极端倍数" value={form.tickExtremeSigma} suffix="σ" step={0.5} min={0.1} max={20} onChange={(value) => update("tickExtremeSigma", value)} />
              <NumberField label="最小跳动波动" value={form.minTickVolatility} suffix="收益率" step={0.0001} min={0} max={1} onChange={(value) => update("minTickVolatility", value)} />
              <NumberField label="HIGH 连续确认" value={form.highVolatilityConfirmations} suffix="次" step={1} min={1} max={10} onChange={(value) => update("highVolatilityConfirmations", Math.round(value))} />
              <NumberField label="恢复稳定时长" value={form.stableRecoverySeconds} suffix="秒" step={1} min={1} max={3600} onChange={(value) => update("stableRecoverySeconds", Math.round(value))} />
              <NumberField label="HIGH 风险倍率" value={form.highVolatilityRiskMultiplier} suffix="×" step={0.05} min={0.05} max={1} onChange={(value) => update("highVolatilityRiskMultiplier", value)} />
              <NumberField label="点差最少样本" value={form.spreadBaselineMinSamples} suffix="个" step={1} min={120} max={10000} onChange={(value) => update("spreadBaselineMinSamples", Math.round(value))} />
            </div>
          </section>

          <section className="panel p-4 sm:p-5">
            <div className="terminal-label">FRESHNESS & SCHEDULING</div><h2 className="mb-5 mt-1 text-[13px]">数据新鲜度与检查频率</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField label="正常扫描间隔" value={form.normalScanIntervalSeconds} suffix="秒" step={1} min={5} max={3600} onChange={(value) => update("normalScanIntervalSeconds", Math.round(value))} />
              <NumberField label="保护态风险检查" value={form.highRiskCheckIntervalSeconds} suffix="秒" step={1} min={1} max={300} onChange={(value) => update("highRiskCheckIntervalSeconds", Math.round(value))} />
              <NumberField label="信号有效期" value={form.maxSignalAgeSeconds} suffix="秒" step={1} min={1} max={300} onChange={(value) => update("maxSignalAgeSeconds", Math.round(value))} />
              <NumberField label="盘口／标记过期" value={form.bookStaleSeconds} suffix="秒" step={1} min={1} max={60} onChange={(value) => update("bookStaleSeconds", Math.round(value))} />
              <NumberField label="1M 数据过期" value={form.candleStaleSeconds} suffix="秒" step={1} min={1} max={600} onChange={(value) => update("candleStaleSeconds", Math.round(value))} />
            </div>
          </section>

          <section className="panel p-4 sm:p-5">
            <div className="terminal-label">LEVERAGE & LIQUIDATION BUFFER</div><h2 className="mb-5 mt-1 text-[13px]">杠杆模式</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block"><span className="terminal-label">模式</span><select className="terminal-input mt-2" value={form.leverageMode} onChange={(event) => update("leverageMode", event.target.value as TradingSettings["leverageMode"])}><option value="SYMBOL_MAX">标的上限（仅 PAPER）</option><option value="FIXED">FIXED · 校验账户实际值</option><option value="ACCOUNT_CONFIGURED">ACCOUNT_CONFIGURED · 使用账户实际值</option></select></label>
              <NumberField label="FIXED 目标杠杆" value={form.fixedLeverage} suffix="×" step={1} min={1} onChange={(value) => update("fixedLeverage", Math.round(value))} />
            </div>
            {data.account && <div className="mt-4 border border-[#1a2540] bg-[#080e19] p-4 text-[11px] leading-6">
              <div className="terminal-label">签名账户实际配置</div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1"><span>{data.account.dualSide ? "DUAL" : "ONE-WAY"}</span><span>{data.account.multiAssets ? "MULTI-ASSETS" : "SINGLE-ASSET"}</span></div>
              {Object.entries(data.account.symbolLeverages ?? {}).map(([symbol, leverage]) => <div key={symbol} className="mt-1 flex justify-between gap-3"><span>{symbol} · {data.account?.symbolMarginTypes?.[symbol] ?? "UNKNOWN"}</span><span>{leverage}×</span></div>)}
              {data.positions.filter((position) => position.liquidationPriceSource).map((position) => <div key={position.id} className="mt-1 flex justify-between gap-3"><span>{position.symbol} 强平价来源</span><span>{position.liquidationPriceSource}</span></div>)}
            </div>}
            <div className="reading mt-4 border-l-2 border-[#fbbf24] bg-[#17150e] px-4 py-3 text-[11px] leading-6 text-[#d8c68e]">LIVE 使用签名 positionRisk 的逐 symbol 实际杠杆，并受目标名义价值档位约束；不会自动修改交易所杠杆。SYMBOL_MAX 仅保留 PAPER 旧行为。止损与强平缓冲、费用和最小名义价值检查仍然强制执行。</div>
          </section>

          <section className="panel p-4 sm:p-5">
            <div className="terminal-label">UNIVERSE & FRICTION</div><h2 className="mb-5 mt-1 text-[13px]">流动性门槛与模拟摩擦</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField label="24H 成交额门槛" value={form.minQuoteVolume} suffix="USDT" step={1000000} min={0} onChange={(value) => update("minQuoteVolume", value)} />
              <NumberField label="最大点差" value={form.maxSpreadBps} suffix="bps" step={0.5} min={0.1} max={100} onChange={(value) => update("maxSpreadBps", value)} />
              <NumberField label="扫描合约数量" value={form.universeSize} suffix="个" step={1} min={2} max={150} onChange={(value) => update("universeSize", Math.round(value))} />
              <NumberField label="单边模拟吃单费" value={form.takerFeeBps} suffix="bps" step={0.5} min={0} max={20} onChange={(value) => update("takerFeeBps", value)} />
              <NumberField label="单边基础滑点" value={form.slippageBps} suffix="bps" step={0.5} min={0} max={30} onChange={(value) => update("slippageBps", value)} />
            </div>
          </section>
        </div>

        <aside className="space-y-3">
          <BinanceCredentialForm />
          <ExecutionStatusPanel status={data.execution} />
          <section className="panel p-4" aria-labelledby="execution-controls-title">
            <h2 id="execution-controls-title" className="terminal-label">EXECUTION CONTROL</h2>
            <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="执行模式">
              <button type="button" className="btn-secondary !px-2 !text-[10px]" disabled={setMode.isPending || data.settings.executionMode === "PAPER"} onClick={() => setMode.mutate({ executionMode: "PAPER" })}>PAPER · 模拟</button>
              <button type="button" className="btn-secondary !px-2 !text-[10px] !text-[#fca5a5]" disabled={setMode.isPending || data.settings.executionMode === "LIVE_MAINNET"} onClick={() => { if (window.confirm("切换到 LIVE 只选择真实账户视图，不会自动 armed；确认继续？")) setMode.mutate({ executionMode: "LIVE_MAINNET" }); }}>LIVE · 真实</button>
            </div>
            <p className="reading mt-3 text-[10px] leading-5 text-[#8290aa]">切换前必须没有未结持仓、意图或订单。手动 canary 不需要开启自动交易，但仍需主网模式、环境总开关、armed、适配器和完整预检。</p>
            {data.execution.armed ? (
              <button type="button" className="btn-danger mt-3 w-full" disabled={setControls.isPending} onClick={() => setControls.mutate({ armed: false })}>立即 disarm</button>
            ) : (
              <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); setControls.mutate({ armed: true, confirmationPhrase }); }}>
                <label className="block"><span className="terminal-label">确认短语</span><input className="terminal-input mt-2 !text-[11px]" required value={confirmationPhrase} onChange={(event) => setConfirmationPhrase(event.target.value)} placeholder="ARM LIVE MAINNET" /></label>
                <button type="submit" className="btn-danger w-full" disabled={setControls.isPending || data.settings.executionMode !== "LIVE_MAINNET" || confirmationPhrase !== "ARM LIVE MAINNET"}>{setControls.isPending ? "正在预检" : "通过全部预检并 armed"}</button>
              </form>
            )}
          </section>
          {data.settings.executionMode === "LIVE_MAINNET" && <section className="panel p-4" aria-labelledby="manual-canary-title">
            <h2 id="manual-canary-title" className="terminal-label">CONTROLLED REAL CANARY</h2>
            <p className="reading mt-3 text-[10px] leading-5 text-[#d8c68e]">这会提交一笔真实 IOC 限价单。数量由签名账户与全部风控计算；不会开启自动交易，也不保证成交。</p>
            <form className="mt-3 space-y-3" onSubmit={(event) => {
              event.preventDefault();
              manualCanary.mutate({
                symbol: canary.symbol,
                side: canary.side,
                limitPrice: Number(canary.limitPrice),
                stopPrice: Number(canary.stopPrice),
                confirmationPhrase: canary.confirmationPhrase,
              });
            }}>
              <label className="block"><span className="terminal-label">白名单合约</span><input className="terminal-input mt-2 !text-[11px]" required pattern="[A-Z0-9]{5,20}" value={canary.symbol} onChange={(event) => setCanary({ ...canary, symbol: event.target.value.toUpperCase() })} /></label>
              <label className="block"><span className="terminal-label">方向</span><select className="terminal-input mt-2" value={canary.side} onChange={(event) => setCanary({ ...canary, side: event.target.value as "LONG" | "SHORT" })}><option value="LONG">LONG</option><option value="SHORT">SHORT</option></select></label>
              <label className="block"><span className="terminal-label">IOC 限价</span><input className="terminal-input mt-2 !text-[11px]" type="number" required min="0" step="any" value={canary.limitPrice} onChange={(event) => setCanary({ ...canary, limitPrice: event.target.value })} /></label>
              <label className="block"><span className="terminal-label">原始止损</span><input className="terminal-input mt-2 !text-[11px]" type="number" required min="0" step="any" value={canary.stopPrice} onChange={(event) => setCanary({ ...canary, stopPrice: event.target.value })} /></label>
              <label className="block"><span className="terminal-label">确认短语</span><input className="terminal-input mt-2 !text-[11px]" required value={canary.confirmationPhrase} onChange={(event) => setCanary({ ...canary, confirmationPhrase: event.target.value })} placeholder="SUBMIT LIVE CANARY" /></label>
              <button type="submit" className="btn-danger w-full" disabled={manualCanary.isPending || !data.execution.armed
                || !(Number(canary.limitPrice) > 0) || !(Number(canary.stopPrice) > 0)
                || (canary.side === "LONG" ? Number(canary.stopPrice) >= Number(canary.limitPrice) : Number(canary.stopPrice) <= Number(canary.limitPrice))
                || canary.confirmationPhrase !== "SUBMIT LIVE CANARY"}>{manualCanary.isPending ? "正在执行完整门控" : "提交真实 canary IOC"}</button>
            </form>
          </section>}
          <section className="panel border-[#66343c] p-4">
            <div className="flex items-center gap-2 text-[#f87171]"><OctagonAlert size={16} aria-hidden="true" /><h2 className="terminal-label !text-[#f87171]">EMERGENCY CONTROL</h2></div>
            <p className="reading mt-3 text-[11px] leading-5 text-[#a8b5c8]">紧急停止会关闭自动开仓，并按当前{data.settings.executionMode === "LIVE_MAINNET" ? "真实主网" : "模拟"}市价退出所有持仓。未结算结果会明确显示为失败。</p>
            <button type="button" className="btn-danger mt-4 w-full" disabled={emergency.isPending} onClick={() => { if (window.confirm(`确认暂停自动交易并退出全部${data.settings.executionMode === "LIVE_MAINNET" ? "真实" : "模拟"}持仓？`)) emergency.mutate(); }}>紧急停止并全部平仓</button>
            {data.settings.executionMode === "PAPER" && <button type="button" className="btn-secondary mt-2 w-full" disabled={reset.isPending} onClick={() => { if (window.confirm("确认把账户重置为 100,000 USDT？历史订单与复盘记录会保留。")) reset.mutate(); }}><RotateCcw size={13} aria-hidden="true" />重置账户</button>}
          </section>

          <section className="panel p-4">
            <h2 className="terminal-label">CURRENT GUARDRAILS</h2>
            <div className="mt-3 space-y-3 text-[10px]">
              {[
                ["单笔风险", `${data.settings.riskPerTradePct}%`], ["组合止损风险", `${data.settings.portfolioStopRiskPct}%`],
                ["高相关同方向", `${data.settings.correlatedDirectionRiskPct}%`], ["总保证金", `${data.settings.totalMarginCapPct}%`],
                ["持仓上限", `${data.settings.maxPositions} 个`], ["日损熔断", `-${data.settings.dailyLossLimitPct}%`],
                ["时间退出", "72 小时"], ["目标退出", "2.2R"], ["强平检查", "开仓前强制"],
              ].map(([label, value]) => <div key={label} className="flex justify-between border-b border-[#141f33] pb-2"><span className="text-[#8290aa]">{label}</span><span>{value}</span></div>)}
            </div>
          </section>

          <section className="panel">
            <div className="border-b border-[#1a2540] px-4 py-3"><h2 className="terminal-label">RISK REJECTIONS</h2></div>
            <div className="max-h-[360px] overflow-y-auto">{data.events.filter((event) => event.category === "风险拒绝" || event.category === "熔断").slice(0, 12).map((event) => <div key={event.id} className="border-b border-[#141f33] p-4"><div className="flex justify-between text-[9px]"><span className="data-warning">{event.symbol ?? "SYSTEM"}</span><span className="text-[#596983]">{formatTime(event.createdAt)}</span></div><p className="reading mt-2 text-[10px] leading-5 text-[#a8b5c8]">{event.message}</p></div>)}{!data.events.some((event) => event.category === "风险拒绝" || event.category === "熔断") && <div className="p-5 text-center text-[10px] text-[#8290aa]">暂无风险拒绝记录</div>}</div>
          </section>
        </aside>
      </div>
    </div>
  );
}
