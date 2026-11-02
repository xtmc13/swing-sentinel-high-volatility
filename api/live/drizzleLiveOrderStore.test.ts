import { describe, expect, it } from "vitest";
import { livePositions } from "@db/schema";
import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import type { LiveDatabase } from "./livePersistence";

const openedAt = new Date(1_793_600_000_000);
const positionRow = {
  id: "intent-1",
  symbol: "BTCUSDT",
  side: "LONG",
  status: "OPEN",
  initialQuantity: "2",
  quantity: "2",
  entryPrice: "100",
  markPrice: "101",
  liquidationPrice: "50",
  isolatedWallet: "40",
  leverage: "5",
  maintenanceBracket: 1,
  maintMarginRatio: "0.01",
  cumMaintenance: "0",
  openedAt,
  updatedAt: openedAt,
  closedAt: null,
};

describe("durable live position recovery", () => {
  it("restores the protection stop from the persisted intent rather than zero", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => table === livePositions ? [positionRow] : [{ stopPrice: "99" }],
          }),
        }),
      }),
    } as unknown as LiveDatabase;
    const store = new DrizzleLiveOrderStore(db);

    expect(await store.getPosition("intent-1")).toMatchObject({ stopPrice: "99" });
  });

  it("uses the same persisted stop when listing open positions", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => table === livePositions
          ? { where: async () => [positionRow] }
          : { where: () => ({ limit: async () => [{ stopPrice: "99" }] }) },
      }),
    } as unknown as LiveDatabase;
    const store = new DrizzleLiveOrderStore(db);

    expect(await store.listOpenPositions()).toMatchObject([{ stopPrice: "99" }]);
  });
});
