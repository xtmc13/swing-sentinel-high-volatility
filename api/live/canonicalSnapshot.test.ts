import { describe, expect, it } from "vitest";
import { canonicalSnapshot } from "./canonicalSnapshot";

describe("canonical signed snapshot comparison", () => {
  it("ignores object property order while preserving array order", () => {
    const first = { account: { available: "10", assets: [{ asset: "USDT", wallet: "10" }] }, mode: { dual: true, multi: false } };
    const reordered = { mode: { multi: false, dual: true }, account: { assets: [{ wallet: "10", asset: "USDT" }], available: "10" } };

    expect(canonicalSnapshot(first)).toBe(canonicalSnapshot(reordered));
    expect(canonicalSnapshot([1, 2])).not.toBe(canonicalSnapshot([2, 1]));
  });
});
