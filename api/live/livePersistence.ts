import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { liveIntents, tradingSettings } from "@db/schema";
import type { Side } from "@contracts/trading";
import { addDecimals, type DecimalString } from "./decimal";
import type { LiveIntentReservation } from "./liveRisk";

export type LiveDatabase = MySql2Database<Record<string, unknown>>;
export type LiveTransaction = Parameters<Parameters<LiveDatabase["transaction"]>[0]>[0];

export interface CreateLiveIntentInput {
  id: string;
  signalId: string;
  symbol: string;
  side: Side;
  quantity: DecimalString;
  limitPrice: DecimalString;
  stopPrice: DecimalString;
  liquidationPrice: DecimalString;
  leverage: number;
  notional: DecimalString;
  reservedMargin: DecimalString;
  reservedRisk: DecimalString;
  expiresAt: Date;
  workerId: string;
  leaseDurationMs: number;
}

export interface CreateLiveIntentOptions {
  now?: () => number;
  recheckRisk?: (tx: LiveTransaction) => Promise<void>;
}

export type CreateLiveIntentResult =
  | { ok: true; id: string; version: 1 }
  | { ok: false; reason: string };

export interface ClaimLiveIntentInput {
  id: string;
  workerId: string;
  expectedVersion: number;
  leaseDurationMs: number;
}

export type ClaimLiveIntentResult =
  | { ok: true; version: number }
  | { ok: false; reason: string };

function duplicateEntry(error: unknown): boolean {
  const cause = (error as { cause?: unknown })?.cause;
  return (error as { code?: unknown })?.code === "ER_DUP_ENTRY"
    || (cause !== undefined && duplicateEntry(cause));
}

function validLease(workerId: string, leaseDurationMs: number): boolean {
  return workerId.trim().length > 0 && Number.isSafeInteger(leaseDurationMs) && leaseDurationMs > 0;
}

export async function createLiveIntent(
  db: LiveDatabase,
  input: CreateLiveIntentInput,
  options: CreateLiveIntentOptions = {},
): Promise<CreateLiveIntentResult> {
  const nowProvider = options.now ?? Date.now;
  const now = nowProvider();
  if (!input.id || !input.signalId || !validLease(input.workerId, input.leaseDurationMs)) {
    return { ok: false, reason: "意图标识或 worker lease 无效" };
  }
  if (!Number.isSafeInteger(input.expiresAt.getTime()) || input.expiresAt.getTime() <= now) {
    return { ok: false, reason: "意图已过期" };
  }
  try {
    const created = await db.transaction(async (tx) => {
      const settingsLock = await tx.select({ id: tradingSettings.id }).from(tradingSettings)
        .where(eq(tradingSettings.id, 1)).for("update");
      if (!settingsLock[0]) throw new Error("Trading settings are missing");
      await options.recheckRisk?.(tx);
      if (input.expiresAt.getTime() <= nowProvider()) return false;
      await tx.insert(liveIntents).values({
        id: input.id,
        signalId: input.signalId,
        symbol: input.symbol,
        side: input.side,
        quantity: input.quantity,
        limitPrice: input.limitPrice,
        stopPrice: input.stopPrice,
        liquidationPrice: input.liquidationPrice,
        leverage: input.leverage,
        notional: input.notional,
        reservedMargin: input.reservedMargin,
        reservedRisk: input.reservedRisk,
        version: 1,
        expiresAt: input.expiresAt,
        leaseOwner: input.workerId,
        leaseExpiresAt: new Date(now + input.leaseDurationMs),
      });
      return true;
    });
    if (!created) return { ok: false, reason: "意图在提交前复核时已过期" };
    return { ok: true, id: input.id, version: 1 };
  } catch (error) {
    if (duplicateEntry(error)) return { ok: false, reason: "signalId 或意图 ID 已存在" };
    throw error;
  }
}

export async function claimLiveIntent(
  db: LiveDatabase,
  input: ClaimLiveIntentInput,
  options: { now?: () => number } = {},
): Promise<ClaimLiveIntentResult> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || !validLease(input.workerId, input.leaseDurationMs)) {
    return { ok: false, reason: "版本或 worker lease 无效" };
  }
  const now = (options.now ?? Date.now)();
  const result = await db.update(liveIntents).set({
    leaseOwner: input.workerId,
    leaseExpiresAt: new Date(now + input.leaseDurationMs),
    version: sql`${liveIntents.version} + 1`,
  }).where(and(
    eq(liveIntents.id, input.id),
    eq(liveIntents.version, input.expectedVersion),
    eq(liveIntents.status, "PENDING_SEND"),
    gt(liveIntents.expiresAt, new Date(now)),
    or(
      isNull(liveIntents.leaseExpiresAt),
      lte(liveIntents.leaseExpiresAt, new Date(now)),
      eq(liveIntents.leaseOwner, input.workerId),
    ),
  ));
  const header = Array.isArray(result) ? result[0] : result;
  const affectedRows = Number((header as { affectedRows?: number } | null)?.affectedRows ?? 0);
  if (affectedRows !== 1) return { ok: false, reason: "意图版本、状态、过期时间或 lease 已变化" };
  return { ok: true, version: input.expectedVersion + 1 };
}

const TERMINAL_INTENT_STATUSES = new Set(["FILLED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"]);

export async function getLiveIntentReservations(
  db: LiveDatabase,
  now = Date.now(),
): Promise<LiveIntentReservation> {
  const rows = await db.select({
    status: liveIntents.status,
    expiresAt: liveIntents.expiresAt,
    margin: liveIntents.reservedMargin,
    risk: liveIntents.reservedRisk,
  }).from(liveIntents);
  const active = rows.filter((row) => !TERMINAL_INTENT_STATUSES.has(row.status)
    && (row.status !== "PENDING_SEND" || row.expiresAt.getTime() > now));
  return {
    margin: addDecimals(...active.map((row) => row.margin)),
    risk: addDecimals(...active.map((row) => row.risk)),
  };
}
