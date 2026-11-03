import { describe, expect, it } from "vitest";
import type { LiveDatabase } from "./livePersistence";
import { DrizzleLiveDailyRisk } from "./liveDailyRisk";

function database() {
  let row: { dayKey: string; dayStartEquity: string; dailyLocked: boolean } | null = null;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ for: async () => row ? [{ ...row }] : [] }),
      }),
    }),
    insert: () => ({
      values: (value: typeof row) => ({
        onDuplicateKeyUpdate: async () => {
          row ??= value;
        },
      }),
    }),
    update: () => ({
      set: (value: { dailyLocked: boolean }) => ({
        where: async () => {
          if (row) row = { ...row, dailyLocked: value.dailyLocked };
        },
      }),
    }),
  };
  const db = {
    transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as LiveDatabase;
  return { db, row: () => row };
}

describe("persistent LIVE daily risk", () => {
  it("keeps the UTC baseline and daily lock across adapter restarts", async () => {
    const h = database();
    const first = new DrizzleLiveDailyRisk(h.db);

    await expect(first.evaluate("2027-01-15", 1000, 2)).resolves.toEqual({
      dayStartEquity: 1000, dailyLocked: false,
    });
    await expect(first.evaluate("2027-01-15", 979, 2)).resolves.toEqual({
      dayStartEquity: 1000, dailyLocked: true,
    });

    const restarted = new DrizzleLiveDailyRisk(h.db);
    await expect(restarted.evaluate("2027-01-15", 990, 2)).resolves.toEqual({
      dayStartEquity: 1000, dailyLocked: true,
    });
    expect(h.row()).toMatchObject({ dayKey: "2027-01-15", dayStartEquity: "1000", dailyLocked: true });
  });
});
