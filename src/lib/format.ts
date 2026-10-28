export function formatNumber(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const digits = value >= 1000 ? 2 : value >= 10 ? 3 : value >= 0.1 ? 5 : 7;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatCompact(value: number) {
  if (!Number.isFinite(value)) return "—";
  return Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function formatPercent(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${formatNumber(value, digits)}%`;
}

export function formatTime(value: string | Date | null, withDate = false) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    timeZone: "UTC", hour12: false,
    month: withDate ? "2-digit" : undefined, day: withDate ? "2-digit" : undefined,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function formatAge(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const milliseconds = Math.max(0, value);
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

export function formatMissedMessages(value: number | null) {
  return value === null ? "N/A" : `${value} 条`;
}

export function sideLabel(side: "LONG" | "SHORT") { return side === "LONG" ? "做多" : "做空"; }
export function sideColor(side: "LONG" | "SHORT") { return side === "LONG" ? "data-positive" : "data-negative"; }
