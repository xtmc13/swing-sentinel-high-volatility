import { eq } from "drizzle-orm";
import { getDb } from "./connection";
import { volatilityStates } from "@db/schema";
import type { VolatilityState } from "@contracts/trading";

function availableNumber(value: number | null) {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function getVolatilityState(symbol: string): Promise<VolatilityState | null> {
  const rows = await getDb().select().from(volatilityStates).where(eq(volatilityStates.symbol, symbol)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    symbol: row.symbol,
    mode: row.mode === "HIGH" || row.mode === "EXTREME" ? row.mode : "NORMAL",
    confirmationCount: row.confirmationCount,
    stableSince: row.stableSince,
    metrics: {
      atrQuantile: availableNumber(row.atrQuantile),
      tickSigma: availableNumber(row.tickSigma),
      spreadRatio: availableNumber(row.spreadRatio),
    },
    lastDataAt: availableNumber(row.lastDataAt),
    version: row.version,
  };
}

export async function saveVolatilityState(state: VolatilityState): Promise<void> {
  const values = {
    symbol: state.symbol,
    mode: state.mode,
    confirmationCount: state.confirmationCount,
    stableSince: state.stableSince !== null && Number.isFinite(state.stableSince) && state.stableSince >= 0
      ? state.stableSince : null,
    atrQuantile: availableNumber(state.metrics.atrQuantile),
    tickSigma: availableNumber(state.metrics.tickSigma),
    spreadRatio: availableNumber(state.metrics.spreadRatio),
    lastDataAt: availableNumber(state.lastDataAt),
    version: state.version,
  };
  await getDb().insert(volatilityStates).values(values).onDuplicateKeyUpdate({
    set: {
      mode: values.mode,
      confirmationCount: values.confirmationCount,
      stableSince: values.stableSince,
      atrQuantile: values.atrQuantile,
      tickSigma: values.tickSigma,
      spreadRatio: values.spreadRatio,
      lastDataAt: values.lastDataAt,
      version: values.version,
    },
  });
}
