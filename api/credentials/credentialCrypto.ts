import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { LiveCredentials, ServerEnvironment } from "../live/liveConfig";

export const BINANCE_CREDENTIAL_KEY_VERSION = 1;

export interface EncryptedBinanceCredentials {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

const CONFIGURATION_ERROR = "CREDENTIAL_ENCRYPTION_KEY must contain exactly 32 bytes as base64 or 64 hexadecimal characters";
const DECRYPTION_ERROR = "Unable to decrypt Binance MAINNET credentials";

function masterKey(env: ServerEnvironment): Buffer {
  const configured = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!configured) throw new Error(CONFIGURATION_ERROR);
  if (/^[a-fA-F0-9]{64}$/.test(configured)) return Buffer.from(configured, "hex");
  const decoded = Buffer.from(configured, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== configured) throw new Error(CONFIGURATION_ERROR);
  return decoded;
}

function authenticationData(keyVersion: number): Buffer {
  return Buffer.from(`BINANCE_MAINNET:credentials:v${keyVersion}`, "utf8");
}

export function encryptBinanceCredentials(
  credentials: LiveCredentials,
  env: ServerEnvironment = process.env,
): EncryptedBinanceCredentials {
  const key = masterKey(env);
  const iv = randomBytes(12);
  const keyVersion = BINANCE_CREDENTIAL_KEY_VERSION;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(authenticationData(keyVersion));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

export function decryptBinanceCredentials(
  encrypted: EncryptedBinanceCredentials,
  env: ServerEnvironment = process.env,
): LiveCredentials {
  const key = masterKey(env);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAAD(authenticationData(encrypted.keyVersion));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid credential payload");
    const credentials = parsed as Record<string, unknown>;
    if (typeof credentials.apiKey !== "string" || !/^[A-Za-z0-9]{64}$/.test(credentials.apiKey)
      || typeof credentials.apiSecret !== "string" || !/^[A-Za-z0-9]{64}$/.test(credentials.apiSecret)) {
      throw new Error("invalid credential payload");
    }
    return { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret };
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
}
