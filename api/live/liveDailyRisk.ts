import { eq } from "drizzle-orm";
import { liveDailyRisk } from "@db/schema";
import type { LiveDatabase } from "./livePersistence";

export interface LiveDailyRiskSnapshot {
  dayStartEquity: number;
  dailyLocked: boolean;
}

export interface LiveDailyRisk {
  evaluate(dayKey: string, equity: number, dailyLossLimitPct: number): Promise<LiveDailyRiskSnapshot>;
}

export class DrizzleLiveDailyRisk implements LiveDailyRisk {
  private readonly db: LiveDatabase;

  constructor(db: LiveDatabase) {
    this.db = db;
  }

  async evaluate(dayKey: string, equity: number, dailyLossLimitPct: number): Promise<LiveDailyRiskSnapshot> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !Number.isFinite(equity) || equity <= 0
      || !Number.isFinite(dailyLossLimitPct) || dailyLossLimitPct < 0) {
      throw new Error("Invalid LIVE daily risk input");
    }
    return this.db.transaction(async (tx) => {
      const locked = await tx.select().from(liveDailyRisk).where(eq(liveDailyRisk.dayKey, dayKey)).for("update");
      if (!locked[0]) {
        await tx.insert(liveDailyRisk).values({ dayKey, dayStartEquity: String(equity), dailyLocked: false })
          .onDuplicateKeyUpdate({ set: { dayKey } });
      }
      const current = locked[0] ?? (await tx.select().from(liveDailyRisk)
        .where(eq(liveDailyRisk.dayKey, dayKey)).for("update"))[0];
      const dayStartEquity = Number(current?.dayStartEquity);
      if (!current || !Number.isFinite(dayStartEquity) || dayStartEquity <= 0) {
        throw new Error("LIVE daily risk baseline is unavailable");
      }
      const todayPnlPct = (equity - dayStartEquity) / dayStartEquity * 100;
      const dailyLocked = current.dailyLocked || todayPnlPct <= -dailyLossLimitPct;
      if (dailyLocked !== current.dailyLocked) {
        await tx.update(liveDailyRisk).set({ dailyLocked }).where(eq(liveDailyRisk.dayKey, dayKey));
      }
      return { dayStartEquity, dailyLocked };
    });
  }
}
