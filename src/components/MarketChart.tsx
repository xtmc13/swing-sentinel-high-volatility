import { useEffect, useMemo, useRef } from "react";
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { trpc } from "@/providers/trpc";
import type { Market } from "@contracts/trading";
import { formatCompact, formatPercent, formatPrice } from "@/lib/format";

function ema(values: number[], period: number) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i++) output.push(values[i] * alpha + output[i - 1] * (1 - alpha));
  return output;
}

interface Props {
  symbol: string;
  market?: Market;
  interval: "5m" | "15m" | "1h" | "4h";
  onIntervalChange: (interval: "5m" | "15m" | "1h" | "4h") => void;
}

export default function MarketChart({ symbol, market, interval, onIntervalChange }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ema20Series = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Series = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const candles = trpc.trading.candles.useQuery({ symbol, interval }, { enabled: Boolean(symbol), refetchInterval: 15_000 });

  useEffect(() => {
    if (!container.current) return;
    const instance = createChart(container.current, {
      width: container.current.clientWidth,
      height: container.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#0c1220" },
        textColor: "#8290aa",
        fontFamily: "JetBrains Mono Variable, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(26,37,64,.55)" },
        horzLines: { color: "rgba(26,37,64,.55)" },
      },
      crosshair: {
        vertLine: { color: "#4f607b", labelBackgroundColor: "#1a2540" },
        horzLine: { color: "#4f607b", labelBackgroundColor: "#1a2540" },
      },
      rightPriceScale: { borderColor: "#1a2540" },
      timeScale: { borderColor: "#1a2540", timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 7 },
      localization: { locale: "zh-CN" },
    });
    candleSeries.current = instance.addSeries(CandlestickSeries, {
      upColor: "#34d399", downColor: "#f87171", borderVisible: false,
      wickUpColor: "#34d399", wickDownColor: "#f87171",
    });
    ema20Series.current = instance.addSeries(LineSeries, { color: "#22d3ee", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    ema50Series.current = instance.addSeries(LineSeries, { color: "#fbbf24", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    volumeSeries.current = instance.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    instance.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = instance;
    const observer = new ResizeObserver(() => {
      if (container.current) instance.applyOptions({ width: container.current.clientWidth, height: container.current.clientHeight });
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); instance.remove(); chart.current = null; };
  }, []);

  const seriesData = useMemo(() => {
    const rows = candles.data ?? [];
    const closes = rows.map((row) => row.close);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    return {
      candles: rows.map((row) => ({ time: row.time as UTCTimestamp, open: row.open, high: row.high, low: row.low, close: row.close })),
      ema20: rows.map((row, index) => ({ time: row.time as UTCTimestamp, value: ema20[index] })),
      ema50: rows.map((row, index) => ({ time: row.time as UTCTimestamp, value: ema50[index] })),
      volume: rows.map((row) => ({ time: row.time as UTCTimestamp, value: row.volume, color: row.close >= row.open ? "rgba(52,211,153,.25)" : "rgba(248,113,113,.22)" })),
    };
  }, [candles.data]);

  useEffect(() => {
    candleSeries.current?.setData(seriesData.candles);
    ema20Series.current?.setData(seriesData.ema20);
    ema50Series.current?.setData(seriesData.ema50);
    volumeSeries.current?.setData(seriesData.volume);
    if (seriesData.candles.length) chart.current?.timeScale().scrollToRealTime();
  }, [seriesData]);

  return (
    <section className="panel min-w-0" aria-label={`${symbol} K线图`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1a2540] px-4 py-3">
        <div className="flex items-baseline gap-3">
          <div>
            <span className="text-[15px] font-semibold">{symbol.replace("USDT", "")}<span className="text-[#596983]">/USDT</span></span>
            <span className="ml-2 text-[9px] tracking-[0.12em] text-[#8290aa]">PERPETUAL</span>
          </div>
          <span className={`text-[15px] ${market && market.change24h >= 0 ? "data-positive" : "data-negative"}`}>{formatPrice(market?.price ?? 0)}</span>
          <span className={`text-[11px] ${market && market.change24h >= 0 ? "data-positive" : "data-negative"}`}>{formatPercent(market?.change24h ?? 0)}</span>
        </div>
        <div className="flex border border-[#263650]">
          {(["5m", "15m", "1h", "4h"] as const).map((item) => (
            <button key={item} onClick={() => onIntervalChange(item)} className={`min-h-9 min-w-11 px-2 text-[11px] transition-colors duration-150 ${interval === item ? "bg-[#162337] text-[#22d3ee]" : "text-[#8290aa] hover:text-[#e7edf7]"}`}>{item}</button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-[#141f33] px-4 py-2 text-[9px] text-[#8290aa]">
        <span>标记 <b className="font-normal text-[#c5d0df]">{formatPrice(market?.markPrice ?? 0)}</b></span>
        <span>点差 <b className="font-normal text-[#c5d0df]">{(market?.spreadBps ?? 0).toFixed(2)} bps</b></span>
        <span>资金费率 <b className="font-normal text-[#c5d0df]">{formatPercent((market?.fundingRate ?? 0) * 100, 4)}</b></span>
        <span>24H 成交额 <b className="font-normal text-[#c5d0df]">{formatCompact(market?.quoteVolume ?? 0)}</b></span>
        <span className="ml-auto"><i className="mr-1 inline-block h-[2px] w-3 bg-[#22d3ee] align-middle" />EMA20 <i className="ml-3 mr-1 inline-block h-[2px] w-3 bg-[#fbbf24] align-middle" />EMA50</span>
      </div>
      <div className="relative h-[360px] sm:h-[420px]">
        <div ref={container} className="absolute inset-0" />
        {candles.isLoading && <div className="absolute inset-0 flex items-center justify-center bg-[#0c1220]/80 text-[11px] tracking-[0.12em] text-[#8290aa]">LOADING MARKET CANDLES…</div>}
        {candles.error && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0c1220] text-center text-[12px] text-[#f87171]"><span>K线加载失败：{candles.error.message}</span><button className="btn-secondary" onClick={() => void candles.refetch()}>重试</button></div>}
      </div>
    </section>
  );
}
