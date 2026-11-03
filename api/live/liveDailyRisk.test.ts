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
  let transactions = 0;
  const db = {
    transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      return operation(tx);
    },
  } as unknown as LiveDatabase;
  return { db, row: () => row, transactions: () => transactions };
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

  it.each([0, Number.NaN])("treats unavailable equity %s as locked no-data without persisting a baseline", async (equity) => {
    const h = database();
    const risk = new DrizzleLiveDailyRisk(h.db);

    await expect(risk.evaluate("2027-01-15", equity, 2)).resolves.toEqual({
      dayStartEquity: 0,
      dailyLocked: true,
    });
    expect(h.row()).toBeNull();
    expect(h.transactions()).toBe(0);
  });

  it("still rejects negative equity and invalid risk settings", async () => {
    const h = database();
    const risk = new DrizzleLiveDailyRisk(h.db);

    await expect(risk.evaluate("2027-01-15", -1, 2)).rejects.toThrow("Invalid LIVE daily risk input");
    await expect(risk.evaluate("2027-01-15", 1000, Number.NaN)).rejects.toThrow("Invalid LIVE daily risk input");
    expect(h.transactions()).toBe(0);
  });
});
