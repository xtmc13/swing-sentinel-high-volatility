import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (name === "APP_SECRET" && value && process.env.NODE_ENV === "production" && value.length < 32) {
    throw new Error("APP_SECRET must contain at least 32 characters in production");
  }
  return value ?? "";
}

export const env = {
  // Bearer token for administrative mutations; APP_ID was never used.
  appSecret: required("APP_SECRET"),
  isProduction: process.env.NODE_ENV === "production",
  databaseUrl: required("DATABASE_URL"),
};
