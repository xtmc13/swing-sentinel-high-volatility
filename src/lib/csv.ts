import type { SignalEvaluation } from "@contracts/trading";

function cell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  let text = value;
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function iso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

export function signalsToCsv(signals: SignalEvaluation[]): string {
  const header = ["id", "symbol", "side", "signal_close_time", "decision_time", "status", "reason", "expected_entry", "actual_entry", "fill_deviation_bps", "entry_time", "exit_time", "pnl", "r_multiple", "mfe_r", "mae_r"];
  const rows = signals.map((signal) => [
    signal.id,
    signal.symbol,
    signal.side,
    iso(signal.signalCloseTime),
    iso(signal.decisionTime),
    signal.status,
    signal.reason,
    signal.expectedEntry,
    signal.actualEntry,
    signal.fillDeviationBps,
    iso(signal.entryTime),
    iso(signal.exitTime),
    signal.pnl,
    signal.rMultiple,
    signal.mfeR,
    signal.maeR,
  ].map((value) => cell(value)).join(","));
  return `\uFEFF${header.join(",")}\n${rows.join("\n")}`;
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
