import type { LiveReadiness } from "@contracts/trading";

export type ServerEnvironment = Record<string, string | undefined>;
export type AssertCurrentLiveAdmission = () => Promise<void>;

export interface LiveCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface LivePublicStatus {
  credentialsConfigured: boolean;
}

function configuredCredentials(env: ServerEnvironment): LiveCredentials | null {
  const apiKey = env.BINANCE_MAINNET_API_KEY;
  const apiSecret = env.BINANCE_MAINNET_API_SECRET;
  if (!apiKey?.trim() || !apiSecret?.trim()) return null;
  return { apiKey, apiSecret };
}

export function liveTradingEnabled(env: ServerEnvironment): boolean {
  return env.LIVE_TRADING_ENABLED === "true";
}

export function createLiveAdmissionGuard(
  env: ServerEnvironment,
  runPreflight: () => Promise<LiveReadiness>,
  now: () => number = Date.now,
): AssertCurrentLiveAdmission {
  return async () => {
    if (!liveTradingEnabled(env)) throw new Error("LIVE_TRADING_ENABLED 未开启");
    const preflight = await runPreflight();
    const checkedAt = preflight.checkedAt === null ? Number.NaN : Date.parse(preflight.checkedAt);
    if (!preflight.ready || !Number.isFinite(checkedAt) || checkedAt > now() || now() - checkedAt > 10_000) {
      throw new Error(`当前主网预检未通过或已陈旧：${preflight.reasons.join("；") || "检查时间无效"}`);
    }
  };
}

export function getLivePublicStatus(env: ServerEnvironment): LivePublicStatus {
  return { credentialsConfigured: configuredCredentials(env) !== null };
}

export function createLiveAdapter<T>(
  env: ServerEnvironment,
  factory: (credentials: LiveCredentials) => T,
): T {
  const credentials = configuredCredentials(env);
  if (!liveTradingEnabled(env) || !credentials) {
    throw new Error("Live adapter is disabled or credentials are not configured");
  }
  return factory(credentials);
}

export async function hasConfiguredLiveCredentials(
  env: ServerEnvironment,
  loadStoredStatus: () => Promise<{ configured: boolean }>,
): Promise<LivePublicStatus> {
  if (configuredCredentials(env)) return { credentialsConfigured: true };
  return { credentialsConfigured: (await loadStoredStatus()).configured };
}

export async function createStoredLiveAdapter<T>(
  env: ServerEnvironment,
  loadStored: () => Promise<LiveCredentials | null>,
  factory: (credentials: LiveCredentials) => T,
): Promise<T> {
  if (!liveTradingEnabled(env)) {
    throw new Error("Live adapter is disabled or credentials are not configured");
  }
  const credentials = configuredCredentials(env) ?? await loadStored();
  if (!credentials) throw new Error("Live adapter is disabled or credentials are not configured");
  return factory(credentials);
}
