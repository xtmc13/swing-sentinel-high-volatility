import { describe, expect, it } from "vitest";
import {
  addDecimals,
  ceilToStep,
  compareDecimals,
  decimal,
  divideDecimals,
  floorToStep,
  isMultipleOfStep,
  multiplyDecimals,
  subtractDecimals,
} from "./decimal";

describe("exact decimal accounting", () => {
  it("adds and subtracts without binary floating point error", () => {
    expect(addDecimals("0.1", "0.2", "0.3")).toBe("0.6");
    expect(subtractDecimals("0.3", "0.1")).toBe("0.2");
    expect(addDecimals("99999999999999999999.1", "0.2")).toBe("99999999999999999999.3");
    expect(addDecimals("99999999999999999999.1", "0.9")).toBe("100000000000000000000");
  });

  it("calculates notional and fees exactly", () => {
    expect(multiplyDecimals("12345.678901", "0.00075")).toBe("9.25925917575");
    expect(divideDecimals("1", "8")).toBe("0.125");
  });

  it("normalizes decimal strings without exponent notation", () => {
    expect(decimal("1.2300")).toBe("1.23");
    expect(decimal("1e-7")).toBe("0.0000001");
    expect(decimal("-0.000")).toBe("0");
  });

  it("compares values beyond double precision", () => {
    expect(compareDecimals("0.00000000000000000001", "0")).toBe(1);
    expect(compareDecimals("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareDecimals("1.00", "1")).toBe(0);
  });

  it("rounds to exchange price and quantity steps exactly", () => {
    expect(floorToStep("1.239", "0.01")).toBe("1.23");
    expect(ceilToStep("1.231", "0.005")).toBe("1.235");
    expect(floorToStep("0.123456789", "0.000001")).toBe("0.123456");
    expect(isMultipleOfStep("1.235", "0.005")).toBe(true);
    expect(isMultipleOfStep("1.236", "0.005")).toBe(false);
  });

  it("fails closed for invalid values and zero divisors or steps", () => {
    expect(() => decimal("NaN")).toThrow("Invalid decimal");
    expect(() => decimal("Infinity")).toThrow("Invalid decimal");
    expect(() => decimal(0.1 as unknown as string)).toThrow("Invalid decimal");
    expect(() => divideDecimals("1", "0")).toThrow("Division by zero");
    expect(() => floorToStep("1", "0")).toThrow("Step must be positive");
    expect(() => ceilToStep("1", "-0.1")).toThrow("Step must be positive");
  });
});
