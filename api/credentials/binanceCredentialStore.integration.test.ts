import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "@db/schema";
import { DrizzleBinanceCredentialStore } from "./binanceCredentialStore";

const testDatabaseUrl = process.env.CREDENTIAL_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeDatabase = testDatabaseUrl ? describe : describe.skip;
const allowedDatabases = new Set([
  "swing_sentinel_credentials_test",
  "swing_sentinel_final_fix1_test",
  "swing_sentinel_task1_test",
  "swing_sentinel_task8_test",
]);
if (testDatabaseUrl && !allowedDatabases.has(new URL(testDatabaseUrl).pathname.slice(1))) {
  throw new Error("Credential integration tests require a dedicated independent test database");
}

const db = testDatabaseUrl ? drizzle(testDatabaseUrl, { mode: "planetscale", schema }) : null;
const env = { CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 23).toString("base64") };
const first = { apiKey: "A".repeat(64), apiSecret: "a".repeat(64) };
const replacement = { apiKey: "B".repeat(64), apiSecret: "b".repeat(64) };

beforeAll(async () => {
  if (!db) return;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../db/migrations", import.meta.url)) });
});

beforeEach(async () => {
  if (!db) return;
  await db.delete(schema.binanceCredentials);
  await db.insert(schema.tradingSettings).values({
    id: 1,
    executionMode: "PAPER",
    momentumEnabled: false,
    autoTrade: false,
  }).onDuplicateKeyUpdate({
    set: { executionMode: "PAPER", momentumEnabled: false, autoTrade: false },
  });
  await db.insert(schema.liveControls).values({ id: 1, armed: false })
    .onDuplicateKeyUpdate({ set: { armed: false } });
});

afterAll(async () => {
  if (db) await db.$client.end();
});

describeDatabase("encrypted Binance credential store", () => {
  it("starts unconfigured and returns only a configured boolean", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleBinanceCredentialStore(db, env);

    expect(await store.status()).toEqual({ configured: false });
    expect(await store.load()).toBeNull();
  });

  it("saves and replaces credentials while storing no plaintext or key fragments", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleBinanceCredentialStore(db, env);

    expect(await store.save(first)).toEqual({ configured: true });
    expect(await store.load()).toEqual(first);
    const firstRows = await db.select().from(schema.binanceCredentials);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({ exchange: "BINANCE", environment: "MAINNET", keyVersion: 1 });
    expect(firstRows[0].createdAt).toBeInstanceOf(Date);
    expect(firstRows[0].updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(firstRows[0])).not.toContain(first.apiKey);
    expect(JSON.stringify(firstRows[0])).not.toContain(first.apiSecret);
    expect(JSON.stringify(firstRows[0])).not.toContain(first.apiKey.slice(0, 8));
    expect(JSON.stringify(firstRows[0])).not.toContain(first.apiSecret.slice(0, 8));

    expect(await store.save(replacement)).toEqual({ configured: true });
    expect(await store.load()).toEqual(replacement);
    expect(await db.select().from(schema.binanceCredentials)).toHaveLength(1);
  });

  it("deletes the stored credential without requiring the encryption key", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleBinanceCredentialStore(db, env);
    await store.save(first);

    const withoutKey = new DrizzleBinanceCredentialStore(db, {});
    expect(await withoutKey.delete()).toEqual({ configured: false });
    expect(await withoutKey.status()).toEqual({ configured: false });
    expect(await db.select().from(schema.binanceCredentials)).toHaveLength(0);
  });

  it("does not change any live trading gate when saving or replacing", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleBinanceCredentialStore(db, env);

    await store.save(first);
    await store.save(replacement);

    const settings = await db.select().from(schema.tradingSettings).where(eq(schema.tradingSettings.id, 1));
    const controls = await db.select().from(schema.liveControls).where(eq(schema.liveControls.id, 1));
    expect(settings[0]).toMatchObject({ executionMode: "PAPER", momentumEnabled: false, autoTrade: false });
    expect(controls[0]).toMatchObject({ armed: false });
  });

  it("fails closed when the stored credential cannot be decrypted", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleBinanceCredentialStore(db, env);
    await store.save(first);
    const wrongKey = new DrizzleBinanceCredentialStore(db, {
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 24).toString("base64"),
    });

    await expect(wrongKey.load()).rejects.toThrow("Unable to decrypt Binance MAINNET credentials");
  });
});
