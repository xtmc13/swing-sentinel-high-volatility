import { eq } from "drizzle-orm";
import { liveControls } from "@db/schema";
import { getDb } from "../queries/connection";
import { getOutstandingOrderCounts, getSettings } from "../queries/trading";
import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import { createProductionLiveRuntime } from "./productionRuntime";
import { createBinanceProductionLiveServices } from "./productionServices";

export const productionLiveRuntime = createProductionLiveRuntime({
  env: process.env,
  getSettings,
  getLiveControls: async () => {
    const rows = await getDb().select().from(liveControls).where(eq(liveControls.id, 1)).limit(1);
    return { armed: rows[0]?.armed ?? false };
  },
  hasOutstandingLiveRisk: async () => {
    const [counts, positions] = await Promise.all([
      getOutstandingOrderCounts(),
      new DrizzleLiveOrderStore(getDb()).listOpenPositions(),
    ]);
    return positions.length > 0 || counts.pendingIntents > 0 || counts.unfinishedOrders > 0;
  },
  createServices: () => createBinanceProductionLiveServices({ env: process.env, db: getDb() }),
});

export function stopProductionLiveServices(): Promise<void> {
  return productionLiveRuntime.stop();
}
