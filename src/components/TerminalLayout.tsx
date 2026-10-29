import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import {
  Activity, ChartCandlestick, ChartNoAxesCombined, LayoutDashboard,
  ListFilter, Pause, Play, RefreshCw, Settings2, ShieldCheck, WalletCards,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { formatCompact, formatPercent, formatPrice, formatTime } from "@/lib/format";
import AdminAccess from "@/components/AdminAccess";

const navItems = [
  { to: "/", label: "交易总览", code: "OVERVIEW", icon: LayoutDashboard },
  { to: "/markets", label: "流动性交易池", code: "UNIVERSE", icon: ListFilter },
  { to: "/positions", label: "订单与持仓", code: "POSITIONS", icon: WalletCards },
  { to: "/risk", label: "风险与执行", code: "RISK", icon: ShieldCheck },
  { to: "/review", label: "回测与复盘", code: "REVIEW", icon: ChartNoAxesCombined },
];

export default function TerminalLayout() {
  const navigate = useNavigate();
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [clock, setClock] = useState(new Date());
  const dashboard = trpc.trading.dashboard.useQuery(undefined, { refetchInterval: 15_000, retry: 1 });
  const toggle = trpc.trading.setAutoTrade.useMutation({
    onSuccess: async (result) => {
      toast.success(result.enabled ? "自动交易已恢复" : "自动交易已暂停；现有持仓继续管理");
      await dashboard.refetch();
    },
    onError: (error) => toast.error(error.message),
  });
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const data = dashboard.data;
  const running = data?.settings.autoTrade ?? false;
  const activeSelectedSymbol = data?.markets.some((market) => market.symbol === selectedSymbol)
    ? selectedSymbol
    : data?.markets.find((market) => market.eligible)?.symbol ?? data?.markets[0]?.symbol ?? "";
  const tickerMarkets = data?.markets.filter((market) => market.eligible).slice(0, 8) ?? [];
  const context = data ? {
    data, selectedSymbol: activeSelectedSymbol, setSelectedSymbol,
    refresh: () => void dashboard.refetch(), refreshing: dashboard.isRefetching,
  } : null;

  return (
    <div className="min-h-dvh bg-[#050810] text-[#e7edf7]">
      <div className="scanlines" aria-hidden="true" />
      <header className="sticky top-0 z-30 border-b border-[#1a2540] bg-[#070c15]/95 backdrop-blur-md">
        <div className="flex h-16 items-stretch">
          <button onClick={() => navigate("/")} className="flex shrink-0 items-center gap-3 border-r border-[#1a2540] px-4 text-left lg:w-[264px] lg:px-5" aria-label="返回交易总览">
            <span className="relative flex h-8 w-8 items-center justify-center border border-[#22d3ee] text-[#22d3ee]">
              <ChartCandlestick size={18} strokeWidth={1.7} />
              <span className="status-dot live absolute -right-1 -top-1" />
            </span>
            <span className="hidden min-[420px]:block">
              <span className="block text-[13px] font-semibold tracking-[0.12em]">WAVE//SENTRY</span>
              <span className="block text-[10px] tracking-[0.22em] text-[#8290aa]">波段哨兵 · 永续系统</span>
            </span>
          </button>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 sm:px-5">
            <div className="hidden items-center gap-3 md:flex">
              <span className={`status-dot ${running ? "live data-positive" : "data-warning"}`} />
              <div>
                <div className="text-[11px] font-medium tracking-[0.12em]">{running ? "PAPER ENGINE ACTIVE" : "PAPER ENGINE PAUSED"}</div>
                <div className="text-[10px] text-[#8290aa]">{data?.sourceLabel ?? "正在连接币安期货行情"}</div>
              </div>
            </div>
            <div className="md:hidden">
              <div className="text-[11px] text-[#22d3ee]">{data?.source ?? "CONNECTING"}</div>
              <div className="text-[10px] text-[#8290aa]">模拟交易</div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden text-right sm:block">
                <div className="text-[11px] text-[#c5d0df]">{clock.toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false })} UTC</div>
                <div className="text-[10px] text-[#8290aa]">{data?.lastScanAt ? `扫描 ${formatTime(data.lastScanAt)}` : "等待首次扫描"}</div>
              </div>
              <button className="btn-secondary !min-h-10 !px-3" onClick={() => navigate("/risk")} aria-label="风险参数设置"><Settings2 size={15} /></button>
              <button
                className={running ? "btn-secondary !min-h-10" : "btn-primary !min-h-10"}
                disabled={!data || toggle.isPending}
                onClick={() => toggle.mutate({ enabled: !running })}
              >
                {running ? <Pause size={14} /> : <Play size={14} />}
                <span className="hidden sm:inline">{running ? "暂停" : "启动"}</span>
              </button>
            </div>
          </div>
        </div>
        <div className="h-8 overflow-hidden border-t border-[#1a2540] bg-[#080e19]" aria-label="高流动性合约行情带">
          {tickerMarkets.length ? (
            <div className="ticker-track h-8 items-center">
              {[0, 1].map((copy) => (
                <div key={copy} className="flex h-8 shrink-0 items-center" aria-hidden={copy === 1}>
                  {tickerMarkets.map((market) => (
                    <div key={`${copy}-${market.symbol}`} className="flex items-center gap-2 border-r border-[#1a2540] px-5 text-[10px]">
                      <span className="text-[#c5d0df]">{market.baseAsset}/USDT</span>
                      <span>{formatPrice(market.price)}</span>
                      <span className={market.change24h >= 0 ? "data-positive" : "data-negative"}>{formatPercent(market.change24h)}</span>
                      <span className="text-[#596983]">VOL {formatCompact(market.quoteVolume)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : <div className="flex h-8 items-center px-4 text-[10px] tracking-[0.12em] text-[#8290aa]">MARKET FEED / 正在同步永续合约行情…</div>}
        </div>
      </header>

      <aside className="fixed bottom-0 left-0 top-24 z-20 hidden w-[264px] flex-col border-r border-[#1a2540] bg-[#080d17] lg:flex">
        <nav className="border-b border-[#1a2540] p-3" aria-label="系统导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `group flex min-h-11 items-center gap-3 border-l-2 px-3 text-[12px] transition-colors duration-150 ${isActive ? "border-[#22d3ee] bg-[#101a2a] text-[#22d3ee]" : "border-transparent text-[#91a0b8] hover:bg-[#0d1523] hover:text-[#e7edf7]"}`}>
                <Icon size={16} strokeWidth={1.6} />
                <span className="flex-1">{item.label}</span>
                <span className="text-[8px] tracking-[0.12em] text-[#4f607b] group-hover:text-[#8290aa]">{item.code}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <span className="terminal-label">高流动性交易池</span>
            <span className="text-[10px] text-[#22d3ee]">{data?.markets.filter((market) => market.eligible).length ?? 0}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {data?.markets.filter((market) => market.eligible).slice(0, 12).map((market, index) => (
              <button key={market.symbol} onClick={() => { setSelectedSymbol(market.symbol); navigate("/"); }} className={`flex min-h-[58px] w-full items-center gap-3 border-b border-[#141f33] px-3 text-left transition-colors duration-150 ${selectedSymbol === market.symbol ? "bg-[#101a2a]" : "hover:bg-[#0d1523]"}`}>
                <span className="w-5 text-[9px] text-[#4f607b]">{String(index + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-[#dce5f1]">{market.baseAsset}<span className="text-[#596983]">/USDT</span></span>
                  <span className="block text-[9px] text-[#8290aa]">成交额 {formatCompact(market.quoteVolume)}</span>
                </span>
                <span className="text-right">
                  <span className="block text-[11px]">{formatPrice(market.price)}</span>
                  <span className={`block text-[10px] ${market.change24h >= 0 ? "data-positive" : "data-negative"}`}>{formatPercent(market.change24h)}</span>
                </span>
              </button>
            ))}
            {!data && <div className="p-4 text-[11px] text-[#8290aa]">正在构建交易池…</div>}
          </div>
        </div>
        <div className="border-t border-[#1a2540] p-4 text-[10px] leading-5 text-[#8290aa]">
          <div className="mb-2 flex items-center gap-2 text-[#c5d0df]"><Activity size={13} /> 模拟执行环境</div>
          不会请求 API 密钥，不会发送真实订单。杠杆上限为模拟参数，实际账户档位以币安为准。
        </div>
      </aside>

      <main className="min-w-0 pb-20 lg:ml-[264px] lg:pb-0">
        <AdminAccess />
        {dashboard.isLoading ? (
          <div className="p-4 sm:p-6">
            <div className="terminal-label mb-4">INITIALIZING TRADING LOOP</div>
            <div className="grid gap-3 md:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="panel h-28 animate-pulse" />)}</div>
            <div className="panel mt-3 h-[440px] animate-pulse" />
          </div>
        ) : dashboard.error ? (
          <div className="p-6">
            <div className="panel mx-auto mt-16 max-w-xl p-6">
              <div className="terminal-label data-negative">SYSTEM DEGRADED</div>
              <h1 className="mt-3 text-xl">交易系统暂时无法启动</h1>
              <p className="reading mt-3 text-sm leading-6 text-[#a8b5c8]">{dashboard.error.message}</p>
              <button className="btn-primary mt-5" onClick={() => void dashboard.refetch()}><RefreshCw size={14} />重新连接</button>
            </div>
          </div>
        ) : context ? <Outlet context={context} /> : null}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-[#1a2540] bg-[#080d17]/98 pb-[env(safe-area-inset-bottom)] lg:hidden" aria-label="移动导航">
        {navItems.map((item) => {
          const Icon = item.icon;
          return <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `flex min-h-[62px] flex-col items-center justify-center gap-1 text-[9px] ${isActive ? "text-[#22d3ee]" : "text-[#8290aa]"}`}><Icon size={18} /><span>{item.label.replace("流动性", "").replace("与执行", "")}</span></NavLink>;
        })}
      </nav>
    </div>
  );
}
