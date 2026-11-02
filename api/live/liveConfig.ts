export type ServerEnvironment = Record<string, string | undefined>;

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
