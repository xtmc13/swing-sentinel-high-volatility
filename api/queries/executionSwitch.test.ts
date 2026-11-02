import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import {
  executionIntents,
  executionOrders,
  liveIntents,
  liveOrders,
  livePositions,
  positions,
  simulationAccounts,
  tradingSettings,
} from "@db/schema";
import { saveSettings, switchExecutionModeAtomic } from "./trading";

const database = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
  events: [] as string[],
  updates: [] as Record<string, unknown>[],
}));

function rowsFor(table: unknown) {
  return database.rows.get(table) ?? [];
}

function nameFor(table: unknown) {
  if (table === simulationAccounts) return "account";
  if (table === tradingSettings) return "settings";
  if (table === positions) return "positions";
  if (table === executionIntents) return "intents";
  if (table === executionOrders) return "orders";
  if (table === livePositions) return "livePositions";
  if (table === liveIntents) return "liveIntents";
  if (table === liveOrders) return "liveOrders";
  return "unknown";
}

vi.mock("./connection", () => ({
  getDb: () => {
    const query = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const name = nameFor(table);
            const rows = rowsFor(table);
            const result = {
              orderBy: async () => rows,
              limit: () => ({
                for: async () => {
                  database.events.push(`lock-${name}`);
                  return rows;
                },
                then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => (
                  Promise.resolve(rows).then(resolve, reject)
                ),
              }),
              then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => (
                Promise.resolve(rows).then(resolve, reject)
              ),
            };
            if (["positions", "intents", "orders", "livePositions", "liveIntents", "liveOrders"].includes(name)) {
              database.events.push(`read-${name}`);
            }
            return result;
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            database.events.push(`update-${nameFor(table)}`);
            database.updates.push(values);
          },
        }),
      }),
    };
    return {
      ...query,
      transaction: async (callback: (tx: typeof query) => unknown) => callback(query),
    };
  },
}));

function reset(options: {
  positions?: unknown[];
  intents?: unknown[];
  orders?: unknown[];
  livePositions?: unknown[];
  liveIntents?: unknown[];
  liveOrders?: unknown[];
} = {}) {
  database.rows.clear();
  database.events.length = 0;
  database.updates.length = 0;
  database.rows.set(simulationAccounts, [{ id: 1 }]);
  database.rows.set(tradingSettings, [{ ...DEFAULT_SETTINGS, id: 1, updatedAt: new Date() }]);
  database.rows.set(positions, options.positions ?? []);
  database.rows.set(executionIntents, options.intents ?? []);
  database.rows.set(executionOrders, options.orders ?? []);
  database.rows.set(livePositions, options.livePositions ?? []);
  database.rows.set(liveIntents, options.liveIntents ?? []);
  database.rows.set(liveOrders, options.liveOrders ?? []);
}

describe("原子执行模式切换", () => {
  it("账户锁内重读风险后才写入新模式", async () => {
    reset();

    await expect(switchExecutionModeAtomic("LIVE_MAINNET")).resolves.toMatchObject({
      executionMode: "LIVE_MAINNET",
    });

    expect(database.events).toEqual([
      "lock-account",
      "lock-settings",
      "read-positions",
      "read-livePositions",
      "read-intents",
      "read-orders",
      "read-liveIntents",
      "read-liveOrders",
      "update-settings",
    ]);
    expect(database.updates[0]).toMatchObject({ executionMode: "LIVE_MAINNET" });
  });

  it("锁内发现 pending intent 时拒绝且不写设置", async () => {
    reset({ intents: [{ status: "PENDING_SEND" }] });

    await expect(switchExecutionModeAtomic("PAPER")).rejects.toThrow("未结");
    expect(database.events).not.toContain("update-settings");
  });

  it.each([
    { name: "live intent", rows: { liveIntents: [{ status: "PENDING_SEND" }] } },
    { name: "live order", rows: { liveOrders: [{ status: "NEW" }] } },
    { name: "live position", rows: { livePositions: [{ status: "OPEN" }] } },
  ])("锁内发现 $name 时拒绝切换", async ({ rows }) => {
    reset(rows);

    await expect(switchExecutionModeAtomic("PAPER")).rejects.toThrow("未结");
    expect(database.events).not.toContain("update-settings");
  });

  it("普通保存不能覆盖 executionMode", async () => {
    reset();

    await saveSettings({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" });

    expect(database.updates).toHaveLength(1);
    expect(database.updates[0]).not.toHaveProperty("executionMode");
  });
});
