import { eq, notInArray } from "drizzle-orm";
import { liveControls, liveIntents, liveOrders } from "@db/schema";
import { getDb } from "../queries/connection";
import { getSettings, TERMINAL_EXECUTION_STATUSES } from "../queries/trading";
import { binanceCredentialStore } from "../credentials/binanceCredentialStore";
import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import { createProductionLiveRuntime } from "./productionRuntime";
import { createBinanceProductionLiveServicesFromStore } from "./productionServices";
import { hasConfiguredLiveCredentials } from "./liveConfig";

export const productionLiveRuntime = createProductionLiveRuntime({
  env: process.env,
  getSettings,
  getLiveControls: async () => {
    const rows = await getDb().select().from(liveControls).where(eq(liveControls.id, 1)).limit(1);
    return { armed: rows[0]?.armed ?? false };
  },
  hasOutstandingLiveRisk: async () => {
    const db = getDb();
    const terminal = [...TERMINAL_EXECUTION_STATUSES];
    const [positions, intents, orders] = await Promise.all([
      new DrizzleLiveOrderStore(db).listOpenPositions(),
      db.select({ status: liveIntents.status }).from(liveIntents).where(notInArray(liveIntents.status, terminal)),
      db.select({ status: liveOrders.status }).from(liveOrders).where(notInArray(liveOrders.status, terminal)),
    ]);
    return positions.length > 0 || intents.length > 0 || orders.length > 0;
  },
  credentialsConfigured: async () => (
    await hasConfiguredLiveCredentials(process.env, () => binanceCredentialStore.status())
  ).credentialsConfigured,
  createServices: () => createBinanceProductionLiveServicesFromStore({ env: process.env, db: getDb() }),
});

export function stopProductionLiveServices(): Promise<void> {
  return productionLiveRuntime.stop();
}
