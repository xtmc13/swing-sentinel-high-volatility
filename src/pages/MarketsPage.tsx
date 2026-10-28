import { useMemo, useState } from "react";
import { ArrowDownUp, Search } from "lucide-react";
import { useNavigate } from "react-router";
import { useTerminal } from "@/components/terminal-context";
import VolatilityBadge from "@/components/VolatilityBadge";
import { formatAge, formatCompact, formatPercent, formatPrice } from "@/lib/format";

export default function MarketsPage() {
  const { data, setSelectedSymbol } = useTerminal();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [eligibleOnly, setEligibleOnly] = useState(true);
  const [sort, setSort] = useState<"volume" | "spread" | "change">("volume");
  const markets = useMemo(() => {
    const filtered = data.markets.filter((market) => (!eligibleOnly || market.eligible) && market.symbol.includes(query.trim().toUpperCase()));
    return [...filtered].sort((a, b) => sort === "volume" ? b.quoteVolume - a.quoteVolume : sort === "spread" ? a.spreadBps - b.spreadBps : b.change24h - a.change24h);
  }, [data.markets, eligibleOnly, query, sort]);
  const stateBySymbol = useMemo(() => new Map(data.volatilityStates.map((state) => [state.symbol, state])), [data.volatilityStates]);
  const eligible = data.markets.filter((market) => market.eligible);
  const medianSpread = eligible.length ? [...eligible].sort((a, b) => a.spreadBps - b.spreadBps)[Math.floor(eligible.length / 2)].spreadBps : 0;

  return (
    <div className="p-3 sm:p-5 xl:p-6">
      <div className="mb-5">
        <div className="terminal-label mb-1">DYNAMIC LIQUIDITY UNIVERSE</div>
        <h1 className="text-xl font-semibold tracking-[-0.04em] sm:text-2xl">流动性交易池</h1>
        <p className="reading mt-1 max-w-3xl text-[13px] leading-6 text-[#91a0b8]">不写死币种。系统只评估交易中的 USDT 永续，并按 24 小时成交额、实时点差和价格有效性动态排序；筛选不合格不会进入自动扫描。</p>
      </div>

      <div className="mb-3 grid grid-cols-2 border border-[#1a2540] bg-[#0c1220] lg:grid-cols-4">
        {[
          ["合格合约", `${eligible.length}`, "当前数据源"],
          ["合格池成交额", formatCompact(eligible.reduce((sum, market) => sum + market.quoteVolume, 0)), "24H USDT"],
          ["点差中位数", `${medianSpread.toFixed(2)} bps`, `上限 ${data.settings.maxSpreadBps} bps`],
          ["成交额门槛", formatCompact(data.settings.minQuoteVolume), "可在风险页调整"],
        ].map(([label, value, note], index) => <div key={label} className={`p-4 ${index > 0 ? "border-l" : ""} border-[#1a2540] ${index === 2 ? "max-lg:border-l-0 max-lg:border-t" : ""} ${index === 3 ? "max-lg:border-t" : ""}`}><div className="terminal-label">{label}</div><div className="mt-2 text-lg font-semibold">{value}</div><div className="mt-1 text-[9px] text-[#8290aa]">{note}</div></div>)}
      </div>

      <section className="panel" aria-labelledby="markets-table-title">
        <div className="flex flex-wrap items-center gap-3 border-b border-[#1a2540] p-3">
          <h2 id="markets-table-title" className="sr-only">合约流动性、三态与行情质量</h2>
          <label className="relative min-w-[220px] flex-1"><span className="sr-only">搜索合约</span><Search size={14} className="absolute left-3 top-3.5 text-[#596983]" aria-hidden="true" /><input className="terminal-input !pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索合约，例如 BTC / SOL" /></label>
          <div className="flex border border-[#263650]" role="group" aria-label="合约筛选范围">
            <button type="button" aria-pressed={eligibleOnly} onClick={() => setEligibleOnly(true)} className={`min-h-11 px-4 text-[11px] ${eligibleOnly ? "bg-[#162337] text-[#22d3ee]" : "text-[#8290aa]"}`}>合格池</button>
            <button type="button" aria-pressed={!eligibleOnly} onClick={() => setEligibleOnly(false)} className={`min-h-11 px-4 text-[11px] ${!eligibleOnly ? "bg-[#162337] text-[#22d3ee]" : "text-[#8290aa]"}`}>全部</button>
          </div>
          <label className="flex items-center gap-2 text-[10px] text-[#8290aa]"><ArrowDownUp size={13} aria-hidden="true" /><span>排序</span><select className="terminal-input !w-auto" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="volume">按成交额</option><option value="spread">按点差</option><option value="change">按涨跌幅</option></select></label>
        </div>
        <div className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#22d3ee]" tabIndex={0} role="region" aria-labelledby="markets-table-caption">
          <table className="w-full min-w-[1220px] border-collapse text-left text-[11px]">
            <caption id="markets-table-caption" className="sr-only">每币三态、数据年龄、波动指标与流动性筛选状态</caption>
            <thead className="bg-[#0c1220]"><tr className="border-b border-[#1a2540] text-[9px] uppercase tracking-[0.12em] text-[#8290aa]"><th scope="col" className="px-4 py-3 font-normal">合约</th><th scope="col" className="px-3 py-3 font-normal">三态／质量</th><th scope="col" className="px-3 py-3 font-normal">数据年龄</th><th scope="col" className="px-3 py-3 font-normal">ATR／跳动／点差</th><th scope="col" className="px-3 py-3 font-normal">最新／标记</th><th scope="col" className="px-3 py-3 font-normal">24H 涨跌</th><th scope="col" className="px-3 py-3 font-normal">24H 成交额</th><th scope="col" className="px-3 py-3 font-normal">点差</th><th scope="col" className="px-3 py-3 font-normal">资金费率</th><th scope="col" className="px-3 py-3 font-normal">模拟杠杆</th><th scope="col" className="px-3 py-3 font-normal">筛选状态</th></tr></thead>
            <tbody>{markets.map((market) => {
              const state = stateBySymbol.get(market.symbol);
              const quality = data.marketQuality[market.symbol];
              return (
                <tr key={market.symbol} className="border-b border-[#141f33] transition-colors duration-150 hover:bg-[#101a2a]">
                  <th scope="row" className="px-4 py-3 font-normal"><button type="button" onClick={() => { setSelectedSymbol(market.symbol); navigate("/"); }} className="min-h-8 text-left hover:text-[#22d3ee]"><span className="block font-medium text-[#dce5f1]">{market.baseAsset}<span className="text-[#596983]">/USDT</span></span><span className="block text-[9px] text-[#8290aa]">流动性 {market.liquidityScore.toFixed(0)}</span></button></th>
                  <td className="px-3 py-3"><VolatilityBadge mode={state?.mode ?? null} /><div className={`reading mt-1 max-w-[170px] text-[9px] ${quality?.valid === false ? "data-negative" : "text-[#8290aa]"}`}>{quality ? (quality.valid ? "行情有效" : quality.reasons.join(" · ")) : "等待行情质量"}</div></td>
                  <td className="px-3 py-3 text-[9px] leading-5 text-[#91a0b8]"><div>盘口 {formatAge(quality?.bookAgeMs ?? null)}</div><div>标记 {formatAge(quality?.markAgeMs ?? null)}</div><div>1M {formatAge(quality?.candleAgeMs ?? null)}</div></td>
                  <td className="px-3 py-3 text-[9px] leading-5"><div>ATR {state?.metrics.atrQuantile == null ? "—" : `P${(state.metrics.atrQuantile * 100).toFixed(1)}`}</div><div>跳动 {state?.metrics.tickSigma == null ? "—" : `${state.metrics.tickSigma.toFixed(2)}σ`}</div><div>点差比 {state?.metrics.spreadRatio?.toFixed(2) ?? "—"}×</div></td>
                  <td className="px-3 py-3"><div>{formatPrice(market.price)}</div><div className="text-[9px] text-[#8290aa]">M {formatPrice(market.markPrice)}</div></td>
                  <td className={`px-3 py-3 ${market.change24h >= 0 ? "data-positive" : "data-negative"}`}>{formatPercent(market.change24h)}</td>
                  <td className="px-3 py-3">{formatCompact(market.quoteVolume)}</td>
                  <td className={`px-3 py-3 ${market.spreadBps > data.settings.maxSpreadBps ? "data-negative" : ""}`}>{market.spreadBps.toFixed(2)} bps</td>
                  <td className="px-3 py-3">{formatPercent(market.fundingRate * 100, 4)}</td>
                  <td className="px-3 py-3"><span className="data-warning">{market.maxLeverage}×</span></td>
                  <td className="px-3 py-3"><span className={market.eligible ? "data-positive" : "data-negative"}>{market.eligible ? "合格" : "排除"}</span><div className="reading mt-1 max-w-[140px] text-[9px] text-[#8290aa]">{market.filterReason}</div></td>
                </tr>
              );
            })}</tbody>
          </table>
          {!markets.length && <div className="m-4 border border-dashed border-[#263650] p-8 text-center text-[11px] text-[#8290aa]">没有匹配合约。可清空搜索或切换到“全部”。</div>}
        </div>
      </section>
    </div>
  );
}
