import { createHmac } from "node:crypto";
import type { DecimalString } from "./decimal";

export const BINANCE_MAINNET_REST_URL = "https://fapi.binance.com";
export const BINANCE_MAINNET_PRIVATE_WS_URL = "wss://fstream.binance.com/ws";

export function privateUserDataStreamUrl(listenKey: string): string {
  return `${BINANCE_MAINNET_PRIVATE_WS_URL}/${encodeURIComponent(listenKey)}`;
}

type QueryValue = string | number | boolean | undefined;
type QueryParams = Record<string, QueryValue>;

export interface BinanceSignedClientOptions {
  apiKey: string;
  apiSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  recvWindow?: number;
  maxRateLimitRetries?: number;
}

export class BinanceSignedError extends Error {
  readonly status?: number;
  readonly code?: number;

  constructor(message: string, details: { status?: number; code?: number } = {}) {
    super(message);
    this.name = "BinanceSignedError";
    this.status = details.status;
    this.code = details.code;
  }
}

export interface BinanceAccountAsset {
  asset: string;
  walletBalance: DecimalString;
  availableBalance: DecimalString;
  crossWalletBalance?: DecimalString;
}

export interface BinanceAccountResponse {
  assets: BinanceAccountAsset[];
  [key: string]: unknown;
}

export interface BinancePositionRisk {
  symbol: string;
  positionAmt: DecimalString;
  entryPrice: DecimalString;
  markPrice: DecimalString;
  liquidationPrice: DecimalString;
  leverage: DecimalString;
  marginType: string;
  isolatedWallet?: DecimalString;
  [key: string]: unknown;
}

export interface BinanceLeverageBracket {
  symbol: string;
  brackets: Array<{
    bracket: number;
    initialLeverage: number;
    notionalCap: DecimalString;
    notionalFloor: DecimalString;
    maintMarginRatio: DecimalString;
    cum: DecimalString;
  }>;
  [key: string]: unknown;
}

export interface BinanceSymbolContract {
  symbol: string;
  pair: string;
  contractType: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  filters: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface BinanceExchangeInfoResponse {
  symbols: BinanceSymbolContract[];
  [key: string]: unknown;
}

export interface BinancePositionSideResponse {
  dualSidePosition: boolean;
}

export interface BinanceMultiAssetsMarginResponse {
  multiAssetsMargin: boolean;
}

export interface BinanceOpenOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  price: DecimalString;
  origQty: DecimalString;
  executedQty: DecimalString;
  status: string;
  side: string;
  type: string;
  reduceOnly?: boolean;
  [key: string]: unknown;
}

export interface BinanceUserTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: string;
  price: DecimalString;
  qty: DecimalString;
  realizedPnl: DecimalString;
  commission: DecimalString;
  commissionAsset: string;
  time: number;
  buyer: boolean;
  maker: boolean;
  [key: string]: unknown;
}

export interface BinanceIncome {
  symbol: string;
  incomeType: string;
  income: DecimalString;
  asset: string;
  info?: string;
  time: number;
  tranId: number;
  tradeId?: string;
  [key: string]: unknown;
}

export interface UserTradesParams {
  symbol: string;
  startTime?: number;
  endTime?: number;
  fromId?: number;
  limit?: number;
}

export interface IncomeParams {
  symbol?: string;
  incomeType?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

export interface PlaceOrderRequest {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP_MARKET";
  quantity: DecimalString;
  price?: DecimalString;
  stopPrice?: DecimalString;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  reduceOnly?: boolean;
  newClientOrderId?: string;
}

export interface CancelOrderRequest {
  symbol: string;
  orderId?: number;
  origClientOrderId?: string;
}

export interface LiveOrderGateway {
  placeOrder(request: PlaceOrderRequest): Promise<unknown>;
  cancelOrder(request: CancelOrderRequest): Promise<unknown>;
}

export class BinanceSignedClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly recvWindow: number;
  private readonly maxRateLimitRetries: number;
  private offsetMs: number | null = null;
  private timeSync: Promise<void> | null = null;

  constructor(options: BinanceSignedClientOptions) {
    if (!options.apiKey.trim() || !options.apiSecret.trim()) throw new Error("API credentials required");
    const recvWindow = options.recvWindow ?? 5000;
    if (!Number.isInteger(recvWindow) || recvWindow < 1 || recvWindow > 5000) {
      throw new Error("recvWindow must be an integer between 1 and 5000");
    }
    const maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
    if (!Number.isSafeInteger(maxRateLimitRetries) || maxRateLimitRetries < 0 || maxRateLimitRetries > 10) {
      throw new Error("maxRateLimitRetries must be a safe integer between 0 and 10");
    }
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.recvWindow = recvWindow;
    this.maxRateLimitRetries = maxRateLimitRetries;
  }

  get serverTimeOffsetMs(): number | null {
    return this.offsetMs;
  }

  async syncServerTime(): Promise<void> {
    const localTime = this.now();
    const response = await this.perform<{ serverTime: number }>("GET", "/fapi/v1/time", {}, false, false, 0);
    if (!Number.isFinite(response.serverTime)) throw new BinanceSignedError("Binance returned an invalid server time");
    this.offsetMs = response.serverTime - localTime;
  }

  account(): Promise<BinanceAccountResponse> {
    return this.signedRequest("GET", "/fapi/v2/account");
  }

  exchangeInfo(symbol?: string): Promise<BinanceExchangeInfoResponse> {
    return this.perform("GET", "/fapi/v1/exchangeInfo", { symbol }, false, false, this.maxRateLimitRetries);
  }

  positionRisk(symbol?: string): Promise<BinancePositionRisk[]> {
    return this.signedRequest("GET", "/fapi/v2/positionRisk", { symbol });
  }

  leverageBracket(symbol?: string): Promise<BinanceLeverageBracket[]> {
    return this.signedRequest("GET", "/fapi/v1/leverageBracket", { symbol });
  }

  positionSide(): Promise<BinancePositionSideResponse> {
    return this.signedRequest("GET", "/fapi/v1/positionSide/dual");
  }

  multiAssetsMargin(): Promise<BinanceMultiAssetsMarginResponse> {
    return this.signedRequest("GET", "/fapi/v1/multiAssetsMargin");
  }

  openOrders(symbol?: string): Promise<BinanceOpenOrder[]> {
    return this.signedRequest("GET", "/fapi/v1/openOrders", { symbol });
  }

  private validateSignedNumericParams(params: UserTradesParams | IncomeParams): void {
    for (const value of [params.startTime, params.endTime]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error("Invalid signed numeric parameters");
      }
    }
    if ("fromId" in params && params.fromId !== undefined
      && (!Number.isSafeInteger(params.fromId) || params.fromId < 0)) {
      throw new Error("Invalid signed numeric parameters");
    }
    if (params.limit !== undefined
      && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 1000)) {
      throw new Error("Invalid signed numeric parameters");
    }
    if (params.startTime !== undefined && params.endTime !== undefined && params.startTime > params.endTime) {
      throw new Error("Invalid signed numeric parameters");
    }
  }

  async userTrades(params: UserTradesParams): Promise<BinanceUserTrade[]> {
    this.validateSignedNumericParams(params);
    return this.signedRequest("GET", "/fapi/v1/userTrades", { ...params });
  }

  async income(params: IncomeParams = {}): Promise<BinanceIncome[]> {
    this.validateSignedNumericParams(params);
    return this.signedRequest("GET", "/fapi/v1/income", { ...params });
  }

  createListenKey(): Promise<{ listenKey: string }> {
    return this.perform("POST", "/fapi/v1/listenKey", {}, false, true, this.maxRateLimitRetries);
  }

  keepAliveListenKey(): Promise<Record<string, never>> {
    return this.perform("PUT", "/fapi/v1/listenKey", {}, false, true, this.maxRateLimitRetries);
  }

  closeListenKey(): Promise<Record<string, never>> {
    return this.perform("DELETE", "/fapi/v1/listenKey", {}, false, true, this.maxRateLimitRetries);
  }

  private async ensureServerTime(): Promise<void> {
    if (this.offsetMs !== null) return;
    if (!this.timeSync) {
      this.timeSync = this.syncServerTime().finally(() => {
        this.timeSync = null;
      });
    }
    await this.timeSync;
  }

  private async signedRequest<T>(method: "GET", path: string, params: QueryParams = {}): Promise<T> {
    await this.ensureServerTime();
    return this.perform<T>(method, path, params, true, true, this.maxRateLimitRetries);
  }

  private async perform<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params: QueryParams,
    signed: boolean,
    withApiKey: boolean,
    retries: number,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) query.append(key, String(value));
      }
      if (signed) {
        query.append("timestamp", String(this.now() + (this.offsetMs ?? 0)));
        query.append("recvWindow", String(this.recvWindow));
        query.append("signature", createHmac("sha256", this.apiSecret).update(query.toString()).digest("hex"));
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      let response: Response;
      try {
        response = await this.fetchImpl(`${BINANCE_MAINNET_REST_URL}${path}${suffix}`, {
          method,
          headers: withApiKey ? { "X-MBX-APIKEY": this.apiKey } : undefined,
        });
      } catch {
        throw new BinanceSignedError("Binance network request failed");
      }

      if (!response.ok) {
        const code = await this.errorCode(response);
        if (response.status === 429 && attempt < retries) {
          await this.sleep(this.rateLimitDelay(response, attempt));
          continue;
        }
        throw new BinanceSignedError(`Binance request failed with status ${response.status}`, {
          status: response.status,
          code,
        });
      }

      try {
        return await response.json() as T;
      } catch {
        throw new BinanceSignedError("Binance returned an invalid JSON response", { status: response.status });
      }
    }
  }

  private async errorCode(response: Response): Promise<number | undefined> {
    try {
      const body = await response.json() as { code?: unknown };
      return typeof body.code === "number" ? body.code : undefined;
    } catch {
      return undefined;
    }
  }

  private rateLimitDelay(response: Response, attempt: number): number {
    const retryAfterSeconds = Number(response.headers.get("Retry-After"));
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 && response.headers.has("Retry-After")) {
      return retryAfterSeconds * 1000;
    }
    return Math.min(250 * 2 ** attempt, 5000);
  }
}
