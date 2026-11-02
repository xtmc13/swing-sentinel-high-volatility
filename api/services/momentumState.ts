import { eq } from "drizzle-orm";
import type { ExecutionMode } from "@contracts/trading";
import { livePositions, momentumFrames, positions } from "@db/schema";
import { getDb } from "../queries/connection";
import { momentumFeatureFrameSchema, type MomentumFeatureFrame } from "./momentum";

export interface MomentumStateStore {
  saveFrame(frame: MomentumFeatureFrame): Promise<void>;
  latestFrame(symbol: string): Promise<MomentumFeatureFrame | null>;
  setExitPending(
    mode: ExecutionMode,
    positionId: string,
    pending: boolean,
    reason?: string,
  ): Promise<void>;
}

function newerFrame(current: MomentumFeatureFrame, incoming: MomentumFeatureFrame): boolean {
  return incoming.event_time > current.event_time
    || (incoming.event_time === current.event_time && incoming.received_time >= current.received_time);
}

export class InMemoryMomentumStateStore implements MomentumStateStore {
  private readonly frames = new Map<string, MomentumFeatureFrame>();

  async saveFrame(frame: MomentumFeatureFrame) {
    const parsed = momentumFeatureFrameSchema.parse(frame);
    const current = this.frames.get(parsed.symbol);
    if (!current || newerFrame(current, parsed)) this.frames.set(parsed.symbol, parsed);
  }

  async latestFrame(symbol: string) {
    const frame = this.frames.get(symbol);
    return frame ? { ...frame } : null;
  }

  async setExitPending() {
    return undefined;
  }
}

function frameValues(frame: MomentumFeatureFrame) {
  return {
    symbol: frame.symbol,
    eventTime: frame.event_time,
    receivedTime: frame.received_time,
    sequence: frame.sequence,
    generation: frame.generation,
    quality: frame.quality,
    configHash: frame.config_hash,
    markPrice: frame.mark_price,
    microprice: frame.microprice,
    spreadBps: frame.spread_bps,
    depthImbalance: frame.depth_imbalance,
    aggressiveBuyVolume: frame.aggressive_buy_volume,
    aggressiveSellVolume: frame.aggressive_sell_volume,
    shortReturn: frame.short_return,
    burstZ: frame.burst_z,
    realizedVolatility: frame.realized_volatility,
  };
}

export class DrizzleMomentumStateStore implements MomentumStateStore {
  async saveFrame(frame: MomentumFeatureFrame) {
    const parsed = momentumFeatureFrameSchema.parse(frame);
    const db = getDb();
    await db.transaction(async (tx) => {
      const current = (await tx.select().from(momentumFrames)
        .where(eq(momentumFrames.symbol, parsed.symbol)).limit(1).for("update"))[0];
      if (current && !newerFrame({
        symbol: current.symbol,
        event_time: current.eventTime,
        received_time: current.receivedTime,
        sequence: current.sequence,
        generation: current.generation,
        quality: momentumFeatureFrameSchema.shape.quality.parse(current.quality),
        config_hash: current.configHash,
        mark_price: current.markPrice,
        microprice: current.microprice,
        spread_bps: current.spreadBps,
        depth_imbalance: current.depthImbalance,
        aggressive_buy_volume: current.aggressiveBuyVolume,
        aggressive_sell_volume: current.aggressiveSellVolume,
        short_return: current.shortReturn,
        burst_z: current.burstZ,
        realized_volatility: current.realizedVolatility,
      }, parsed)) return;
      await tx.insert(momentumFrames).values(frameValues(parsed)).onDuplicateKeyUpdate({
        set: frameValues(parsed),
      });
    });
  }

  async latestFrame(symbol: string): Promise<MomentumFeatureFrame | null> {
    const row = (await getDb().select().from(momentumFrames)
      .where(eq(momentumFrames.symbol, symbol)).limit(1))[0];
    if (!row) return null;
    return momentumFeatureFrameSchema.parse({
      symbol: row.symbol,
      event_time: row.eventTime,
      received_time: row.receivedTime,
      sequence: row.sequence,
      generation: row.generation,
      quality: row.quality,
      config_hash: row.configHash,
      mark_price: row.markPrice,
      microprice: row.microprice,
      spread_bps: row.spreadBps,
      depth_imbalance: row.depthImbalance,
      aggressive_buy_volume: row.aggressiveBuyVolume,
      aggressive_sell_volume: row.aggressiveSellVolume,
      short_return: row.shortReturn,
      burst_z: row.burstZ,
      realized_volatility: row.realizedVolatility,
    });
  }

  async setExitPending(mode: ExecutionMode, positionId: string, pending: boolean, reason?: string) {
    const table = mode === "LIVE_MAINNET" ? livePositions : positions;
    await getDb().update(table).set({ exitPending: pending, exitReason: pending ? reason ?? null : null })
      .where(eq(table.id, positionId));
  }
}

export const drizzleMomentumStateStore = new DrizzleMomentumStateStore();
