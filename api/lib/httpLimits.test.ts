import { describe, expect, it } from "vitest";
import { isCredentialMutationPath } from "./httpLimits";

describe("credential request body limit routing", () => {
  it.each([
    "/api/trpc/credentials.save",
    "/api/trpc/credentials.delete",
    "/api/trpc/trading.saveSettings,credentials.save",
    "/api/trpc/credentials.delete,trading.dashboard",
  ])("limits credential mutation path %s", (path) => {
    expect(isCredentialMutationPath(path)).toBe(true);
  });

  it.each([
    "/api/trpc/credentials.status",
    "/api/trpc/trading.saveSettings",
    "/api/trpc/trading.saveSettings,credentials.status",
  ])("does not classify non-mutation path %s as a credential write", (path) => {
    expect(isCredentialMutationPath(path)).toBe(false);
  });
});
