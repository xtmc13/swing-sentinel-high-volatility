import { describe, expect, it } from "vitest";
import {
  decryptBinanceCredentials,
  encryptBinanceCredentials,
  type EncryptedBinanceCredentials,
} from "./credentialCrypto";

const apiKey = "A".repeat(64);
const apiSecret = "s3".repeat(32);
const masterKey = Buffer.alloc(32, 7).toString("base64");
const env = { CREDENTIAL_ENCRYPTION_KEY: masterKey };

function encrypted(): EncryptedBinanceCredentials {
  return encryptBinanceCredentials({ apiKey, apiSecret }, env);
}

describe("Binance credential encryption", () => {
  it("roundtrips both credentials using AES-256-GCM fields without plaintext", () => {
    const result = encrypted();

    expect(result).toMatchObject({ keyVersion: 1 });
    expect(Buffer.from(result.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(result.tag, "base64")).toHaveLength(16);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(apiSecret);
    expect(decryptBinanceCredentials(result, env)).toEqual({ apiKey, apiSecret });
  });

  it("uses a fresh IV and ciphertext for identical credentials", () => {
    const first = encrypted();
    const second = encrypted();

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it.each(["ciphertext", "iv", "tag"] as const)("rejects a modified %s", (field) => {
    const original = encrypted();
    const raw = Buffer.from(original[field], "base64");
    raw[0] = raw[0] ^ 1;

    expect(() => decryptBinanceCredentials({ ...original, [field]: raw.toString("base64") }, env))
      .toThrow("Unable to decrypt Binance MAINNET credentials");
  });

  it("rejects a modified key version", () => {
    expect(() => decryptBinanceCredentials({ ...encrypted(), keyVersion: 2 }, env))
      .toThrow("Unable to decrypt Binance MAINNET credentials");
  });

  it("rejects a wrong master key without leaking either plaintext value", () => {
    const wrongKey = Buffer.alloc(32, 8).toString("base64");
    let failure: unknown;
    try {
      decryptBinanceCredentials(encrypted(), { CREDENTIAL_ENCRYPTION_KEY: wrongKey });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure)).not.toContain(apiKey);
    expect(JSON.stringify(failure)).not.toContain(apiSecret);
  });

  it.each([undefined, "", "not-a-key", Buffer.alloc(31).toString("base64")])(
    "fails closed with a configuration error for missing or invalid key %s",
    (value) => {
      expect(() => encryptedWith(value)).toThrow(
        "CREDENTIAL_ENCRYPTION_KEY must contain exactly 32 bytes as base64 or 64 hexadecimal characters",
      );
      expect(() => decryptBinanceCredentials(encrypted(), { CREDENTIAL_ENCRYPTION_KEY: value }))
        .toThrow("CREDENTIAL_ENCRYPTION_KEY");
    },
  );

  it("accepts a 32-byte hexadecimal master key", () => {
    const hex = "ab".repeat(32);
    const result = encryptBinanceCredentials({ apiKey, apiSecret }, { CREDENTIAL_ENCRYPTION_KEY: hex });

    expect(decryptBinanceCredentials(result, { CREDENTIAL_ENCRYPTION_KEY: hex })).toEqual({ apiKey, apiSecret });
  });
});

function encryptedWith(value: string | undefined): EncryptedBinanceCredentials {
  return encryptBinanceCredentials({ apiKey, apiSecret }, { CREDENTIAL_ENCRYPTION_KEY: value });
}
