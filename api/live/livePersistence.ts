import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { liveIntents, tradingSettings } from "@db/schema";
import type { Side } from "@contracts/trading";
import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  isMultipleOfStep,
  type DecimalString,
} from "./decimal";
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
  tickSize: DecimalString;
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

export type LiveFinalGateResult =
  | {
      approved: true;
      signalId: string;
      quantity: DecimalString;
      notional: DecimalString;
      reservedMargin: DecimalString;
      reservedRisk: DecimalString;
      validUntil: Date;
    }
  | { approved: false; reason: string };

export interface CreateLiveIntentOptions {
  finalGate: (tx: LiveTransaction) => Promise<LiveFinalGateResult>;
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

async function useUtcSession(db: Pick<LiveDatabase, "execute">): Promise<void> {
  await db.execute(sql`SET SESSION time_zone = '+00:00'`);
}

async function databaseNow(db: Pick<LiveDatabase, "execute">): Promise<Date> {
  const result = await db.execute(sql`
    SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) AS db_now_ms
  `);
  const rows = (result as unknown as [Array<{ db_now_ms: string | number }>])[0];
  const milliseconds = Number(rows[0]?.db_now_ms);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Database returned an invalid current time");
  return new Date(milliseconds);
}

function approvalError(
  input: CreateLiveIntentInput,
  approval: Extract<LiveFinalGateResult, { approved: true }>,
  now: Date,
): string | null {
  if (approval.signalId !== input.signalId) return "final gate 批准了其他 signalId";
  if (!Number.isSafeInteger(approval.validUntil.getTime()) || approval.validUntil.getTime() <= now.getTime()) {
    return "final gate 批准结果已陈旧";
  }
  if (input.expiresAt.getTime() <= now.getTime()) return "意图在提交前复核时已过期";
  try {
    if (compareDecimals(approval.quantity, "0") <= 0 || compareDecimals(approval.notional, "0") <= 0
      || compareDecimals(approval.reservedMargin, "0") <= 0 || compareDecimals(approval.reservedRisk, "0") < 0) {
      return "final gate 数量、名义价值、margin 或 risk 无效";
    }
    const expectedMargin = divideDecimals(approval.notional, String(input.leverage), {
      decimalPlaces: 30,
      roundingMode: "ROUND_DOWN",
    });
    if (compareDecimals(approval.reservedMargin, expectedMargin) !== 0) {
      return "final gate margin 与批准的名义价值或杠杆不一致";
    }
  } catch {
    return "final gate 十进制结果无效";
  }
  return null;
}

export async function createLiveIntent(
  db: LiveDatabase,
  input: CreateLiveIntentInput,
  options: CreateLiveIntentOptions,
): Promise<CreateLiveIntentResult> {
  if (!input.id || !input.signalId || !validLease(input.workerId, input.leaseDurationMs)
    || !Number.isSafeInteger(input.expiresAt.getTime()) || !Number.isInteger(input.leverage)
    || input.leverage < 1 || input.leverage > 20) {
    return { ok: false, reason: "意图标识、杠杆、过期时间或 worker lease 无效" };
  }
  if (typeof options?.finalGate !== "function") return { ok: false, reason: "缺少 mandatory final gate" };
  try {
    if (!isMultipleOfStep(input.limitPrice, input.tickSize)) {
      return { ok: false, reason: "limitPrice 不符合 tickSize" };
    }
  } catch {
    return { ok: false, reason: "limitPrice 或 tickSize 无效" };
  }

  try {
    return await db.transaction(async (tx): Promise<CreateLiveIntentResult> => {
      await useUtcSession(tx);
      const settingsLock = await tx.select({
        id: tradingSettings.id,
        executionMode: tradingSettings.executionMode,
      }).from(tradingSettings).where(eq(tradingSettings.id, 1)).for("update");
      if (!settingsLock[0]) throw new Error("Trading settings are missing");
      if (settingsLock[0].executionMode !== "LIVE_MAINNET") {
        return { ok: false, reason: "只有 LIVE_MAINNET 模式可以创建 live 意图" };
      }

      const approval = await options.finalGate(tx);
      if (!approval.approved) return { ok: false, reason: approval.reason };
      const now = await databaseNow(tx);
      const invalidApproval = approvalError(input, approval, now);
      if (invalidApproval) return { ok: false, reason: invalidApproval };

      await tx.insert(liveIntents).values({
        id: input.id,
        signalId: input.signalId,
        symbol: input.symbol,
        side: input.side,
        quantity: approval.quantity,
        limitPrice: input.limitPrice,
        stopPrice: input.stopPrice,
        liquidationPrice: input.liquidationPrice,
        leverage: input.leverage,
        notional: approval.notional,
        reservedMargin: approval.reservedMargin,
        reservedRisk: approval.reservedRisk,
        version: 1,
        expiresAt: input.expiresAt,
        leaseOwner: input.workerId,
        leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
      });
      return { ok: true, id: input.id, version: 1 };
    });
  } catch (error) {
    if (duplicateEntry(error)) return { ok: false, reason: "signalId 或意图 ID 已存在" };
    throw error;
  }
}

export async function claimLiveIntent(
  db: LiveDatabase,
  input: ClaimLiveIntentInput,
  _options: { now?: () => number } = {},
): Promise<ClaimLiveIntentResult> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || !validLease(input.workerId, input.leaseDurationMs)) {
    return { ok: false, reason: "版本或 worker lease 无效" };
  }
  await useUtcSession(db);
  const result = await db.update(liveIntents).set({
    leaseOwner: input.workerId,
    leaseExpiresAt: sql`DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ${input.leaseDurationMs * 1000} MICROSECOND)`,
    version: sql`${liveIntents.version} + 1`,
  }).where(and(
    eq(liveIntents.id, input.id),
    eq(liveIntents.version, input.expectedVersion),
    eq(liveIntents.status, "PENDING_SEND"),
    gt(liveIntents.expiresAt, sql`CURRENT_TIMESTAMP(3)`),
    or(
      isNull(liveIntents.leaseExpiresAt),
      lte(liveIntents.leaseExpiresAt, sql`CURRENT_TIMESTAMP(3)`),
      eq(liveIntents.leaseOwner, input.workerId),
    ),
  ));
  const header = Array.isArray(result) ? result[0] : result;
  const affectedRows = Number((header as { affectedRows?: number } | null)?.affectedRows ?? 0);
  if (affectedRows !== 1) return { ok: false, reason: "意图版本、状态、过期时间或 lease 已变化" };
  return { ok: true, version: input.expectedVersion + 1 };
}

const TERMINAL_INTENT_STATUSES = new Set(["FILLED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"]);

export async function getLiveIntentReservations(db: LiveDatabase): Promise<LiveIntentReservation> {
  await useUtcSession(db);
  const [rows, now] = await Promise.all([
    db.select({
      status: liveIntents.status,
      expiresAt: liveIntents.expiresAt,
      margin: liveIntents.reservedMargin,
      risk: liveIntents.reservedRisk,
    }).from(liveIntents),
    databaseNow(db),
  ]);
  const active = rows.filter((row) => !TERMINAL_INTENT_STATUSES.has(row.status)
    && (row.status !== "PENDING_SEND" || row.expiresAt.getTime() > now.getTime()));
  return {
    margin: addDecimals(...active.map((row) => row.margin)),
    risk: addDecimals(...active.map((row) => row.risk)),
  };
}
