import { Activity, OctagonAlert, TriangleAlert } from "lucide-react";
import type { VolatilityMode } from "@contracts/trading";

const presentation = {
  NORMAL: { label: "NORMAL · 正常", className: "border-[#165b6b] bg-[#0b1c25] text-[#22d3ee]", Icon: Activity },
  HIGH: { label: "HIGH · 高波动", className: "border-[#66521d] bg-[#1b170c] text-[#fbbf24]", Icon: TriangleAlert },
  EXTREME: { label: "EXTREME · 极端", className: "border-[#70353e] bg-[#211016] text-[#f87171]", Icon: OctagonAlert },
} satisfies Record<VolatilityMode, { label: string; className: string; Icon: typeof Activity }>;

export default function VolatilityBadge({ mode }: { mode: VolatilityMode | null }) {
  if (!mode) {
    return <span className="inline-flex items-center border border-[#263650] bg-[#0a111d] px-2 py-1 text-[9px] text-[#8290aa]">等待评估</span>;
  }
  const { label, className, Icon } = presentation[mode];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap border px-2 py-1 text-[9px] ${className}`}>
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}
