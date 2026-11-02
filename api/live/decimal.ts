export type DecimalString = string;

export type DecimalRoundingMode = "ROUND_DOWN" | "ROUND_UP" | "ROUND_HALF_UP";

export interface DivisionOptions {
  decimalPlaces: number;
  roundingMode: DecimalRoundingMode;
}

interface ScaledDecimal {
  units: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function parse(value: DecimalString): ScaledDecimal {
  if (typeof value !== "string") throw new Error("Invalid decimal");
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new Error("Invalid decimal");

  const exponent = match[5] === undefined ? 0 : Number(match[5]);
  if (!Number.isSafeInteger(exponent)) throw new Error("Invalid decimal");
  const integer = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  let scale = fraction.length - exponent;
  if (!Number.isSafeInteger(scale)) throw new Error("Invalid decimal");

  let units = BigInt(`${integer}${fraction}` || "0");
  if (match[1] === "-") units = -units;
  if (scale < 0) {
    units *= pow10(-scale);
    scale = 0;
  }
  return { units, scale };
}

function format(value: ScaledDecimal): DecimalString {
  if (value.units === 0n) return "0";
  const sign = value.units < 0n ? "-" : "";
  const digits = (value.units < 0n ? -value.units : value.units).toString();
  if (value.scale === 0) return `${sign}${digits}`;
  const padded = digits.padStart(value.scale + 1, "0");
  const whole = padded.slice(0, -value.scale);
  const fraction = padded.slice(-value.scale).replace(/0+$/, "");
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

function aligned(left: ScaledDecimal, right: ScaledDecimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.units * pow10(scale - left.scale),
    right.units * pow10(scale - right.scale),
    scale,
  ];
}

function resultScale(scale: number): number {
  if (!Number.isSafeInteger(scale) || scale < 0) throw new Error("Invalid decimal");
  return scale;
}

export function decimal(value: DecimalString): DecimalString {
  return format(parse(value));
}

export function addDecimals(...values: DecimalString[]): DecimalString {
  const result = values.reduce<ScaledDecimal>((sum, value) => {
    const parsed = parse(value);
    const [left, right, scale] = aligned(sum, parsed);
    return { units: left + right, scale };
  }, { units: 0n, scale: 0 });
  return format(result);
}

export function subtractDecimals(left: DecimalString, right: DecimalString): DecimalString {
  const [leftUnits, rightUnits, scale] = aligned(parse(left), parse(right));
  return format({ units: leftUnits - rightUnits, scale });
}

export function multiplyDecimals(left: DecimalString, right: DecimalString): DecimalString {
  const leftValue = parse(left);
  const rightValue = parse(right);
  return format({
    units: leftValue.units * rightValue.units,
    scale: resultScale(leftValue.scale + rightValue.scale),
  });
}

function roundQuotient(numerator: bigint, denominator: bigint, mode: DecimalRoundingMode): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || mode === "ROUND_DOWN") return quotient;

  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const shouldRoundAway = mode === "ROUND_UP" || absoluteRemainder * 2n >= absoluteDenominator;
  if (!shouldRoundAway) return quotient;
  const awayFromZero = (numerator > 0n) === (denominator > 0n) ? 1n : -1n;
  return quotient + awayFromZero;
}

export function divideDecimals(
  left: DecimalString,
  right: DecimalString,
  options: DivisionOptions,
): DecimalString {
  if (!options || !Number.isSafeInteger(options.decimalPlaces) || options.decimalPlaces < 0
    || !["ROUND_DOWN", "ROUND_UP", "ROUND_HALF_UP"].includes(options.roundingMode)) {
    throw new Error("Invalid division options");
  }
  const dividend = parse(left);
  const divisor = parse(right);
  if (divisor.units === 0n) throw new Error("Division by zero");

  const numeratorScale = divisor.scale + options.decimalPlaces;
  resultScale(numeratorScale);
  let numerator = dividend.units;
  let denominator = divisor.units;
  if (numeratorScale >= dividend.scale) numerator *= pow10(numeratorScale - dividend.scale);
  else denominator *= pow10(dividend.scale - numeratorScale);
  return format({
    units: roundQuotient(numerator, denominator, options.roundingMode),
    scale: options.decimalPlaces,
  });
}

export function compareDecimals(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  const [leftUnits, rightUnits] = aligned(parse(left), parse(right));
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function stepValue(step: DecimalString): ScaledDecimal {
  const parsed = parse(step);
  if (parsed.units <= 0n) throw new Error("Step must be positive");
  return parsed;
}

function floorRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  if (numerator % denominator !== 0n && (numerator < 0n) !== (denominator < 0n)) return quotient - 1n;
  return quotient;
}

function ceilRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  if (numerator % denominator !== 0n && (numerator < 0n) === (denominator < 0n)) return quotient + 1n;
  return quotient;
}

export function floorToStep(value: DecimalString, step: DecimalString): DecimalString {
  const [units, increment, scale] = aligned(parse(value), stepValue(step));
  return format({ units: floorRatio(units, increment) * increment, scale });
}

export function ceilToStep(value: DecimalString, step: DecimalString): DecimalString {
  const [units, increment, scale] = aligned(parse(value), stepValue(step));
  return format({ units: ceilRatio(units, increment) * increment, scale });
}

export function isMultipleOfStep(value: DecimalString, step: DecimalString): boolean {
  const [units, increment] = aligned(parse(value), stepValue(step));
  return units % increment === 0n;
}
