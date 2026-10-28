import type {
  MarketQuality,
  TradingSettings,
  VolatilityMetrics,
  VolatilityMode,
  VolatilityState,
} from "@contracts/trading";

export interface EvaluateVolatilityInput {
  symbol: string;
  settings: TradingSettings;
  quality: MarketQuality;
  currentAtr: number;
  atrBaseline: number[];
  currentTickReturn: number;
  tickReturnBaseline: number[];
  currentSpreadBps: number;
  spreadBaselineBps: number[];
}

export interface VolatilityEvaluation extends VolatilityState {
  reasons: string[];
}

function percentile(values: number[], current: number) {
  return values.filter((value) => value <= current).length / values.length;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function tickSigma(values: number[], current: number, minimum: number) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sigma = Math.max(Math.sqrt(variance), minimum);
  return sigma > 0 ? Math.abs(current - mean) / sigma : current === mean ? 0 : Number.POSITIVE_INFINITY;
}

export function evaluateVolatility(
  input: EvaluateVolatilityInput,
  previous: VolatilityState | null,
  now: number,
): VolatilityEvaluation {
  const atrBaseline = input.atrBaseline.filter((value) => Number.isFinite(value) && value >= 0);
  const tickBaseline = input.tickReturnBaseline.filter(Number.isFinite);
  const spreadBaseline = input.spreadBaselineBps.filter((value) => Number.isFinite(value) && value > 0);
  const reasons: string[] = [];
  let target: VolatilityMode = "NORMAL";

  const atrQuantile = Number.isFinite(input.currentAtr) && input.currentAtr >= 0 && atrBaseline.length > 0
    ? percentile(atrBaseline, input.currentAtr)
    : null;
  const sigma = Number.isFinite(input.currentTickReturn) && tickBaseline.length >= 2
    ? tickSigma(tickBaseline, input.currentTickReturn, input.settings.minTickVolatility)
    : null;
  const spreadMedian = spreadBaseline.length > 0 ? median(spreadBaseline) : null;
  const spreadRatio = Number.isFinite(input.currentSpreadBps) && input.currentSpreadBps >= 0 && spreadMedian
    ? input.currentSpreadBps / spreadMedian
    : null;
  const metrics: VolatilityMetrics = { atrQuantile, tickSigma: sigma, spreadRatio };

  let isExtreme = false;
  if (!input.quality.valid) {
    isExtreme = true;
    reasons.push(...input.quality.reasons);
  }
  if (atrBaseline.length < input.settings.atrBaselineMinSamples) {
    isExtreme = true;
    reasons.push("ATR基线样本不足");
  }
  if (spreadBaseline.length < input.settings.spreadBaselineMinSamples) {
    isExtreme = true;
    reasons.push("点差基线样本不足");
  }
  if (tickBaseline.length < 2 || sigma === null || !Number.isFinite(sigma)) {
    isExtreme = true;
    reasons.push("跳动波动样本无效");
  }
  if (atrQuantile === null) {
    isExtreme = true;
    reasons.push("ATR数据无效");
  }
  if (spreadRatio === null) {
    isExtreme = true;
    reasons.push("点差数据无效");
  }
  if (input.currentSpreadBps > input.settings.maxSpreadBps) {
    isExtreme = true;
    reasons.push("点差超过硬上限");
  }
  if (atrQuantile !== null && atrQuantile * 100 + 1e-12 >= input.settings.atrExtremePercentile) {
    isExtreme = true;
    reasons.push("ATR达到极端分位");
  }
  if (sigma !== null && sigma + 1e-12 >= input.settings.tickExtremeSigma) {
    isExtreme = true;
    reasons.push("1M跳动达到极端倍数");
  }

  if (isExtreme) {
    target = "EXTREME";
  } else {
    if (atrQuantile !== null && atrQuantile * 100 + 1e-12 >= input.settings.atrHighPercentile) {
      target = "HIGH";
      reasons.push("ATR达到高分位");
    }
    if (sigma !== null && sigma + 1e-12 >= input.settings.tickHighSigma) {
      target = "HIGH";
      reasons.push("1M跳动达到高波动倍数");
    }
    if (spreadRatio !== null && spreadRatio + 1e-12 >= 2) {
      target = "HIGH";
      reasons.push("点差达到近期中位数两倍");
    }
  }

  const previousMode = previous?.mode ?? "NORMAL";
  let mode = previousMode;
  let confirmationCount = previous?.confirmationCount ?? 0;
  let stableSince = previous?.stableSince ?? null;
  let version = previous?.version ?? 0;

  if (target === "EXTREME") {
    mode = "EXTREME";
    confirmationCount = 0;
    stableSince = null;
  } else if (previousMode === "NORMAL" && target === "HIGH") {
    confirmationCount += 1;
    stableSince = null;
    mode = confirmationCount >= input.settings.highVolatilityConfirmations ? "HIGH" : "NORMAL";
  } else if (target === "HIGH") {
    stableSince = null;
  } else if (previousMode === "NORMAL") {
    mode = "NORMAL";
    confirmationCount = 0;
    stableSince = null;
  } else {
    stableSince = previous?.stableSince ?? now;
    confirmationCount = 0;
    if (now - stableSince >= input.settings.stableRecoverySeconds * 1000) {
      mode = "NORMAL";
      stableSince = null;
      reasons.push("连续稳定后恢复正常");
    } else {
      reasons.push("稳定恢复观察中");
    }
  }

  if (mode !== previousMode) version += 1;
  return {
    symbol: input.symbol,
    mode,
    confirmationCount,
    stableSince,
    metrics,
    lastDataAt: now,
    version,
    reasons,
  };
}
