import { and, eq } from "drizzle-orm";
import type { ExecutionMode } from "@contracts/trading";
import { executionOrders, liveOrders, livePositions, momentumFrames, positions } from "@db/schema";
import { getDb } from "../queries/connection";
import { momentumFeatureFrameSchema, type MomentumFeatureFrame } from "./momentum";

export interface MomentumStateStore {
  saveFrame(frame: MomentumFeatureFrame): Promise<void>;
  latestFrame(symbol: string): Promise<MomentumFeatureFrame | null>;
  claimExit(
    mode: ExecutionMode,
    positionId: string,
    reason: string,
    claimId: string,
    now: number,
    leaseMs: number,
  ): Promise<boolean>;
  markExitSubmitted(mode: ExecutionMode, positionId: string, claimId: string): Promise<void>;
  releaseExit(mode: ExecutionMode, positionId: string, claimId: string): Promise<void>;
}

function newerFrame(current: MomentumFeatureFrame, incoming: MomentumFeatureFrame): boolean {
  return incoming.event_time > current.event_time
    || (incoming.event_time === current.event_time && incoming.received_time >= current.received_time);
}

interface ExitClaim {
  claimId: string;
  claimedAt: number;
  submitted: boolean;
}

export class InMemoryMomentumStateStore implements MomentumStateStore {
  private readonly frames = new Map<string, MomentumFeatureFrame>();
  private readonly exits = new Map<string, ExitClaim>();

  async saveFrame(frame: MomentumFeatureFrame) {
    const parsed = momentumFeatureFrameSchema.parse(frame);
    const current = this.frames.get(parsed.symbol);
    if (!current || newerFrame(current, parsed)) this.frames.set(parsed.symbol, parsed);
  }

  async latestFrame(symbol: string) {
    const frame = this.frames.get(symbol);
    return frame ? { ...frame } : null;
  }

  async claimExit(
    mode: ExecutionMode,
    positionId: string,
    _reason: string,
    claimId: string,
    now: number,
    leaseMs: number,
  ) {
    const key = `${mode}:${positionId}`;
    const current = this.exits.get(key);
    if (current?.submitted) return false;
    if (current && current.claimId !== claimId && now - current.claimedAt < leaseMs) return false;
    this.exits.set(key, { claimId, claimedAt: now, submitted: false });
    return true;
  }

  async markExitSubmitted(mode: ExecutionMode, positionId: string, claimId: string) {
    const current = this.exits.get(`${mode}:${positionId}`);
    if (current?.claimId === claimId) current.submitted = true;
  }

  async releaseExit(mode: ExecutionMode, positionId: string, claimId: string) {
    const key = `${mode}:${positionId}`;
    if (this.exits.get(key)?.claimId === claimId) this.exits.delete(key);
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

  async claimExit(
    mode: ExecutionMode,
    positionId: string,
    reason: string,
    claimId: string,
    now: number,
    leaseMs: number,
  ): Promise<boolean> {
    const table = mode === "LIVE_MAINNET" ? livePositions : positions;
    return getDb().transaction(async (tx) => {
      const row = (await tx.select().from(table).where(eq(table.id, positionId)).limit(1).for("update"))[0];
      if (!row || row.status !== "OPEN") return false;
      const existingClose = mode === "LIVE_MAINNET"
        ? await tx.select({ id: liveOrders.id }).from(liveOrders).where(and(
          eq(liveOrders.intentId, positionId),
          eq(liveOrders.reduceOnly, true),
          eq(liveOrders.type, "MARKET"),
        )).limit(1)
        : await tx.select({ id: executionOrders.id }).from(executionOrders).where(and(
          eq(executionOrders.positionId, positionId),
          eq(executionOrders.purpose, "CLOSE"),
        )).limit(1);
      if (existingClose.length) return false;
      const claimedAt = row.exitClaimedAt?.getTime();
      const claimBusy = row.exitPending && row.exitClaimId !== claimId && claimedAt !== undefined
        && now - claimedAt < leaseMs;
      if (claimBusy) return false;
      await tx.update(table).set({
        exitPending: true,
        exitReason: reason,
        exitClaimId: claimId,
        exitClaimedAt: new Date(now),
      }).where(eq(table.id, positionId));
      return true;
    });
  }

  async markExitSubmitted(mode: ExecutionMode, positionId: string, claimId: string) {
    void mode;
    void positionId;
    void claimId;
  }

  async releaseExit(mode: ExecutionMode, positionId: string, claimId: string) {
    const table = mode === "LIVE_MAINNET" ? livePositions : positions;
    await getDb().update(table).set({
      exitPending: false,
      exitReason: null,
      exitClaimId: null,
      exitClaimedAt: null,
    }).where(and(eq(table.id, positionId), eq(table.exitClaimId, claimId)));
  }
}

export const drizzleMomentumStateStore = new DrizzleMomentumStateStore();
