import { eq } from "drizzle-orm";
import { binanceCredentials } from "@db/schema";
import type { LiveCredentials, ServerEnvironment } from "../live/liveConfig";
import type { LiveDatabase } from "../live/livePersistence";
import { getDb } from "../queries/connection";
import { decryptBinanceCredentials, encryptBinanceCredentials } from "./credentialCrypto";

export interface BinanceCredentialStatus {
  configured: boolean;
}

export interface BinanceCredentialStore {
  status(): Promise<BinanceCredentialStatus>;
  save(credentials: LiveCredentials): Promise<BinanceCredentialStatus>;
  delete(): Promise<BinanceCredentialStatus>;
}

const BINANCE_CREDENTIAL_ID = 1;

export class DrizzleBinanceCredentialStore implements BinanceCredentialStore {
  private readonly db: LiveDatabase;
  private readonly env: ServerEnvironment;

  constructor(db: LiveDatabase, env: ServerEnvironment = process.env) {
    this.db = db;
    this.env = env;
  }

  async status(): Promise<BinanceCredentialStatus> {
    const rows = await this.db.select({ id: binanceCredentials.id }).from(binanceCredentials)
      .where(eq(binanceCredentials.id, BINANCE_CREDENTIAL_ID)).limit(1);
    return { configured: rows.length === 1 };
  }

  async save(credentials: LiveCredentials): Promise<BinanceCredentialStatus> {
    const encrypted = encryptBinanceCredentials(credentials, this.env);
    await this.db.insert(binanceCredentials).values({ id: BINANCE_CREDENTIAL_ID, ...encrypted })
      .onDuplicateKeyUpdate({
        set: { ...encrypted, updatedAt: new Date() },
      });
    return { configured: true };
  }

  async delete(): Promise<BinanceCredentialStatus> {
    await this.db.delete(binanceCredentials).where(eq(binanceCredentials.id, BINANCE_CREDENTIAL_ID));
    return { configured: false };
  }

  async load(): Promise<LiveCredentials | null> {
    const rows = await this.db.select().from(binanceCredentials)
      .where(eq(binanceCredentials.id, BINANCE_CREDENTIAL_ID)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return decryptBinanceCredentials(row, this.env);
  }
}

export const binanceCredentialStore = {
  status: () => new DrizzleBinanceCredentialStore(getDb()).status(),
  save: (credentials: LiveCredentials) => new DrizzleBinanceCredentialStore(getDb()).save(credentials),
  delete: () => new DrizzleBinanceCredentialStore(getDb()).delete(),
  load: () => new DrizzleBinanceCredentialStore(getDb()).load(),
};
