import { ShieldAlert } from "lucide-react";
import type { MomentumExhaustionEvent, Opportunity } from "@contracts/trading";
import { formatTime, sideColor, sideLabel } from "@/lib/format";

const protectionLabels: Record<string, string> = {
  NONE: "无需保护",
  WARN: "衰竭预警",
  TIGHTEN: "收紧保护",
  REDUCE_CANDIDATE: "减仓候选",
  EXIT_CANDIDATE: "平仓候选",
};

export function OpportunityMomentumExhaustion({ momentumExhaustion, reasons }: {
  momentumExhaustion: Opportunity["momentumExhaustion"];
  reasons: string[];
}) {
  if (!momentumExhaustion) {
    return (
      <div className="min-w-[180px] space-y-1 text-[9px] text-[#8290aa]">
        <div>暂无动能衰竭数据</div>
        <div className="reading">旧扫描结果仍可使用；点击“立即扫描”更新。</div>
        <div className="reading leading-4 text-[#91a0b8]">{reasons.join(" · ")}</div>
      </div>
    );
  }

  const protectionTone = momentumExhaustion.protection === "NONE"
    ? "data-positive"
    : momentumExhaustion.protection === "EXIT_CANDIDATE" ? "data-negative" : "data-warning";

  return (
    <div className="min-w-[190px] space-y-1" aria-label="动能衰竭分析">
      <div className="flex items-baseline gap-2">
        <span className={`text-[12px] font-medium ${momentumExhaustion.score >= 70 ? "data-negative" : momentumExhaustion.score >= 30 ? "data-warning" : "data-live"}`}>
          {momentumExhaustion.score}/100
        </span>
        <span className="text-[9px] text-[#8290aa]">{momentumExhaustion.resonanceCount}/3 周期</span>
        <span className={`text-[9px] ${momentumExhaustion.resonant ? "data-warning" : "text-[#596983]"}`}>
          {momentumExhaustion.resonant ? "多周期共振" : "未形成共振"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[9px]">
        <span className={`inline-flex items-center gap-1 ${protectionTone}`}>
          <ShieldAlert size={11} aria-hidden="true" />
          {protectionLabels[momentumExhaustion.protection] ?? momentumExhaustion.protection}
        </span>
        <span className={momentumExhaustion.structureBreak ? "data-negative" : "text-[#8290aa]"}>
          {momentumExhaustion.structureBreak ? "结构破位" : "结构未破位"}
        </span>
      </div>
      <div className="reading max-w-[300px] text-[9px] leading-4 text-[#91a0b8]">{reasons.join(" · ")}</div>
    </div>
  );
}

export function MomentumExhaustionDiagnostics({ events }: {
  events: MomentumExhaustionEvent[] | undefined;
}) {
  return (
    <section className="border-t border-[#141f33]" aria-labelledby="momentum-exhaustion-title">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldAlert size={13} className="data-warning" aria-hidden="true" />
          <h3 id="momentum-exhaustion-title" className="terminal-label">动能衰竭保护</h3>
        </div>
        <span className="text-[9px] text-[#8290aa]">{events?.length ?? 0} 次 · 仅作诊断，不自动调整仓位</span>
      </div>
      {events === undefined ? (
        <div className="mx-4 mb-4 border border-dashed border-[#263650] p-5 text-center text-[10px] text-[#8290aa]">
          暂无动能衰竭诊断；旧回测结果仍可使用，运行组合回测即可生成。
        </div>
      ) : events.length === 0 ? (
        <div className="mx-4 mb-4 border border-dashed border-[#263650] p-5 text-center text-[10px] text-[#8290aa]">
          样本内未记录动能衰竭保护事件；运行组合回测可更新诊断。
        </div>
      ) : (
        <div className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#22d3ee]" tabIndex={0} role="region" aria-labelledby="momentum-exhaustion-caption">
          <table className="w-full min-w-[760px] text-left text-[10px]">
            <caption id="momentum-exhaustion-caption" className="sr-only">组合回测最近六次动能衰竭保护事件</caption>
            <thead>
              <tr className="border-y border-[#1a2540] text-[9px] text-[#8290aa]">
                <th scope="col" className="px-4 py-2 font-normal">时间</th>
                <th scope="col" className="px-3 py-2 font-normal">合约</th>
                <th scope="col" className="px-3 py-2 font-normal">方向</th>
                <th scope="col" className="px-3 py-2 font-normal">衰竭评分／共振</th>
                <th scope="col" className="px-3 py-2 font-normal">保护</th>
                <th scope="col" className="px-3 py-2 font-normal">结构</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(-6).reverse().map((item, index) => (
                <tr key={`${item.time}-${item.symbol}-${item.side}-${index}`} className="border-b border-[#141f33] last:border-b-0">
                  <td className="px-4 py-3 text-[#8290aa]">{formatTime(new Date(item.time), true)} UTC</td>
                  <th scope="row" className="px-3 py-3 font-medium">{item.symbol}</th>
                  <td className={`px-3 py-3 ${sideColor(item.side)}`}>{sideLabel(item.side)}</td>
                  <td className="px-3 py-3"><span className={item.score >= 70 ? "data-negative" : "data-warning"}>{item.score}/100</span><span className="ml-2 text-[9px] text-[#8290aa]">{item.resonanceCount}/3 周期</span></td>
                  <td className={`px-3 py-3 ${item.protection === "EXIT_CANDIDATE" ? "data-negative" : "data-warning"}`}>{protectionLabels[item.protection] ?? item.protection}</td>
                  <td className={`px-3 py-3 ${item.structureBreak ? "data-negative" : "text-[#8290aa]"}`}>{item.structureBreak ? "结构破位" : "结构未破位"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
