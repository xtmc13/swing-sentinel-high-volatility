import { and, eq, gt, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { liveControls, liveIntents, liveOrders, tradingSettings, volatilityStates } from "@db/schema";
import type { AssertCurrentLiveAdmission } from "./liveConfig";
import type { Side, StrategyType, VolatilityMode } from "@contracts/trading";
import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  isMultipleOfStep,
  multiplyDecimals,
  type DecimalString,
} from "./decimal";
import type { LiveIntentReservation } from "./liveRisk";

export type LiveDatabase = MySql2Database<Record<string, unknown>>;
export type LiveTransaction = Parameters<Parameters<LiveDatabase["transaction"]>[0]>[0];

export interface CreateLiveIntentInput {
  id: string;
  signalId: string;
  strategyType?: StrategyType;
  breakoutPrice?: DecimalString;
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

export interface LiveFinalGateContext {
  mode: VolatilityMode;
  highVolatilityRiskMultiplier: number;
}

export interface CreateLiveIntentOptions {
  finalGate: (tx: LiveTransaction, context: LiveFinalGateContext) => Promise<LiveFinalGateResult>;
  requireAutoTrade?: boolean;
  assertCurrentAdmission?: AssertCurrentLiveAdmission;
}

export type CreateLiveIntentResult =
  | { ok: true; id: string; version: 1; emergencyGeneration: number }
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

export async function loadLiveIntentMetadata(
  db: Pick<LiveDatabase, "select">,
  order: { intentId: string },
): Promise<Pick<CreateLiveIntentInput, "signalId" | "strategyType" | "breakoutPrice">> {
  const rows = await db.select({
    signalId: liveIntents.signalId,
    strategyType: liveIntents.strategyType,
    breakoutPrice: liveIntents.breakoutPrice,
  }).from(liveIntents).where(eq(liveIntents.id, order.intentId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error("Live position intent is missing");
  return {
    signalId: row.signalId,
    strategyType: row.strategyType === "MOMENTUM" ? "MOMENTUM" : "SWING",
    breakoutPrice: row.breakoutPrice ?? undefined,
  };
}

function duplicateEntry(error: unknown): boolean {
  const cause = (error as { cause?: unknown })?.cause;
  return (error as { code?: unknown })?.code === "ER_DUP_ENTRY"
    || (cause !== undefined && duplicateEntry(cause));
}

function validLease(workerId: string, leaseDurationMs: number): boolean {
  return workerId.trim().length > 0 && Number.isSafeInteger(leaseDurationMs) && leaseDurationMs > 0;
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
      || compareDecimals(approval.reservedMargin, "0") <= 0 || compareDecimals(approval.reservedRisk, "0") <= 0) {
      return "final gate 数量、名义价值、margin 或 opening risk 无效";
    }
    const expectedNotional = multiplyDecimals(approval.quantity, input.limitPrice);
    if (compareDecimals(approval.notional, expectedNotional) !== 0) {
      return "final gate notional 与 quantity*limitPrice 不一致";
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

export async function lockLiveControls(tx: LiveTransaction): Promise<{ armed: boolean; generation: number }> {
  const selection = { armed: liveControls.armed, generation: liveControls.emergencyGeneration };
  const locked = await tx.select(selection).from(liveControls).where(eq(liveControls.id, 1)).for("update");
  if (locked[0]) return locked[0];
  await tx.insert(liveControls).values({ id: 1 });
  const inserted = await tx.select(selection).from(liveControls).where(eq(liveControls.id, 1)).for("update");
  if (!inserted[0]) throw new Error("Live controls are missing");
  return inserted[0];
}

export async function lockEmergencyGeneration(tx: LiveTransaction): Promise<number> {
  return (await lockLiveControls(tx)).generation;
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
      const settingsLock = await tx.select({
        id: tradingSettings.id,
        executionMode: tradingSettings.executionMode,
        autoTrade: tradingSettings.autoTrade,
        highVolatilityRiskMultiplier: tradingSettings.highVolatilityRiskMultiplier,
      }).from(tradingSettings).where(eq(tradingSettings.id, 1)).for("update");
      if (!settingsLock[0]) throw new Error("Trading settings are missing");
      if (settingsLock[0].executionMode !== "LIVE_MAINNET") {
        return { ok: false, reason: "只有 LIVE_MAINNET 模式可以创建 live 意图" };
      }
      if (options.requireAutoTrade && !settingsLock[0].autoTrade) {
        return { ok: false, reason: "自动交易已暂停" };
      }
      const controls = await lockLiveControls(tx);
      if (!controls.armed) return { ok: false, reason: "主网执行未 armed" };
      if (!options.assertCurrentAdmission) return { ok: false, reason: "缺少当前环境/预检授权" };
      await options.assertCurrentAdmission();
      const stateLock = await tx.select({ mode: volatilityStates.mode }).from(volatilityStates)
        .where(eq(volatilityStates.symbol, input.symbol)).for("update");
      const mode = stateLock[0]?.mode === "HIGH" || stateLock[0]?.mode === "EXTREME"
        ? stateLock[0].mode
        : stateLock[0]?.mode === "NORMAL" ? "NORMAL" : null;
      if (!mode) return { ok: false, reason: "缺少当前波动状态，禁止开仓" };
      const emergencyGeneration = controls.generation;

      const approval = await options.finalGate(tx, {
        mode,
        highVolatilityRiskMultiplier: settingsLock[0].highVolatilityRiskMultiplier,
      });
      if (!approval.approved) return { ok: false, reason: approval.reason };
      const now = await databaseNow(tx);
      const invalidApproval = approvalError(input, approval, now);
      if (invalidApproval) return { ok: false, reason: invalidApproval };

      await tx.insert(liveIntents).values({
        id: input.id,
        signalId: input.signalId,
        strategyType: input.strategyType ?? "SWING",
        manualCanary: options.requireAutoTrade === false,
        breakoutPrice: input.breakoutPrice ?? null,
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
        expiresAt: sql`FROM_UNIXTIME(${input.expiresAt.getTime()} / 1000)`,
        leaseOwner: input.workerId,
        leaseExpiresAt: sql`DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ${input.leaseDurationMs * 1000} MICROSECOND)`,
      });
      return { ok: true, id: input.id, version: 1, emergencyGeneration };
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
  void _options;
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || !validLease(input.workerId, input.leaseDurationMs)) {
    return { ok: false, reason: "版本或 worker lease 无效" };
  }
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

export interface AssertLiveSubmissionInput {
  intentId: string;
  expectedGeneration: number;
  assertCurrentAdmission?: AssertCurrentLiveAdmission;
}

export function liveSubmissionPermitted(input: {
  armed: boolean;
  executionMode: string;
  autoTrade: boolean;
  manualCanary: boolean;
  generation: number;
  expectedGeneration: number;
  intentStatus: string;
}): boolean {
  return input.armed
    && input.executionMode === "LIVE_MAINNET"
    && (input.autoTrade || input.manualCanary)
    && input.generation === input.expectedGeneration
    && ["PENDING_SEND", "SUBMITTING"].includes(input.intentStatus);
}

export async function assertLiveSubmission(
  db: LiveDatabase,
  input: AssertLiveSubmissionInput,
): Promise<void> {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new Error("Invalid emergency generation");
  }
  await db.transaction(async (tx) => {
    const settings = await tx.select({ autoTrade: tradingSettings.autoTrade, executionMode: tradingSettings.executionMode }).from(tradingSettings)
      .where(eq(tradingSettings.id, 1)).for("update");
    const controls = await lockLiveControls(tx);
    const intent = await tx.select({ status: liveIntents.status, manualCanary: liveIntents.manualCanary }).from(liveIntents)
      .where(eq(liveIntents.id, input.intentId)).for("update");
    if (!liveSubmissionPermitted({
      armed: controls.armed,
      executionMode: settings[0]?.executionMode ?? "MISSING",
      autoTrade: settings[0]?.autoTrade ?? false,
      manualCanary: intent[0]?.manualCanary ?? false,
      generation: controls.generation,
      expectedGeneration: input.expectedGeneration,
      intentStatus: intent[0]?.status ?? "MISSING",
    })) {
      throw new Error("Live submission changed after emergency or pause");
    }
    if (!input.assertCurrentAdmission) throw new Error("缺少当前环境/预检授权");
    await input.assertCurrentAdmission();
  });
}

async function invalidateLiveAdmission(db: LiveDatabase, pauseAutoTrade: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: tradingSettings.id }).from(tradingSettings)
      .where(eq(tradingSettings.id, 1)).for("update");
    await lockLiveControls(tx);
    if (pauseAutoTrade) await tx.update(tradingSettings).set({ autoTrade: false }).where(eq(tradingSettings.id, 1));
    await tx.update(liveControls).set({
      armed: false,
      emergencyGeneration: sql`${liveControls.emergencyGeneration} + 1`,
    }).where(eq(liveControls.id, 1));
    await tx.update(liveIntents).set({ status: "CANCEL" })
      .where(inArray(liveIntents.status, ["PENDING_SEND", "SUBMITTING"]));
    await tx.update(liveOrders).set({ status: "CANCEL" })
      .where(inArray(liveOrders.status, ["PENDING_SEND", "SUBMITTING"]));
  });
}

export function disarmLiveExecution(db: LiveDatabase): Promise<void> {
  return invalidateLiveAdmission(db, false);
}

export async function setLiveArmed(
  db: LiveDatabase,
  armed: boolean,
  assertCurrentAdmission?: AssertCurrentLiveAdmission,
): Promise<void> {
  if (!armed) return disarmLiveExecution(db);
  await db.transaction(async (tx) => {
    const settings = await tx.select({ executionMode: tradingSettings.executionMode }).from(tradingSettings)
      .where(eq(tradingSettings.id, 1)).for("update");
    if (settings[0]?.executionMode !== "LIVE_MAINNET") throw new Error("只有 LIVE_MAINNET 模式可以 armed");
    await lockLiveControls(tx);
    if (!assertCurrentAdmission) throw new Error("缺少当前环境/预检授权");
    await assertCurrentAdmission();
    await tx.update(liveControls).set({ armed: true }).where(eq(liveControls.id, 1));
  });
}

export function pauseLiveExecution(db: LiveDatabase): Promise<void> {
  return invalidateLiveAdmission(db, true);
}

const TERMINAL_INTENT_STATUSES = new Set(["FILLED", "CANCEL", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"]);

export async function getLiveIntentReservations(db: LiveDatabase): Promise<LiveIntentReservation> {
  const rows = await db.select({
    margin: liveIntents.reservedMargin,
    risk: liveIntents.reservedRisk,
  }).from(liveIntents).where(and(
    notInArray(liveIntents.status, [...TERMINAL_INTENT_STATUSES]),
    or(
      ne(liveIntents.status, "PENDING_SEND"),
      gt(liveIntents.expiresAt, sql`CURRENT_TIMESTAMP(3)`),
    ),
  ));
  return {
    margin: addDecimals(...rows.map((row) => row.margin)),
    risk: addDecimals(...rows.map((row) => row.risk)),
  };
}
