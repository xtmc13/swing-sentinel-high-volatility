import Decimal from "decimal.js";

const ExactDecimal = Decimal.clone({
  precision: 80,
  toExpNeg: -1000,
  toExpPos: 1000,
});

export type DecimalString = string;

function parse(value: DecimalString): Decimal {
  if (typeof value !== "string") throw new Error("Invalid decimal");
  const parsed = new ExactDecimal(value);
  if (!parsed.isFinite()) throw new Error("Invalid decimal");
  return parsed;
}

function format(value: Decimal): DecimalString {
  return value.toFixed();
}

export function decimal(value: DecimalString): DecimalString {
  return format(parse(value));
}

export function addDecimals(...values: DecimalString[]): DecimalString {
  return format(values.reduce((sum, value) => sum.plus(parse(value)), new ExactDecimal(0)));
}

export function subtractDecimals(left: DecimalString, right: DecimalString): DecimalString {
  return format(parse(left).minus(parse(right)));
}

export function multiplyDecimals(left: DecimalString, right: DecimalString): DecimalString {
  return format(parse(left).times(parse(right)));
}

export function divideDecimals(left: DecimalString, right: DecimalString): DecimalString {
  const divisor = parse(right);
  if (divisor.isZero()) throw new Error("Division by zero");
  return format(parse(left).div(divisor));
}

export function compareDecimals(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  const comparison = parse(left).comparedTo(parse(right));
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
}

function stepValue(step: DecimalString): Decimal {
  const parsed = parse(step);
  if (!parsed.gt(0)) throw new Error("Step must be positive");
  return parsed;
}

export function floorToStep(value: DecimalString, step: DecimalString): DecimalString {
  const increment = stepValue(step);
  return format(parse(value).div(increment).toDecimalPlaces(0, ExactDecimal.ROUND_FLOOR).times(increment));
}

export function ceilToStep(value: DecimalString, step: DecimalString): DecimalString {
  const increment = stepValue(step);
  return format(parse(value).div(increment).toDecimalPlaces(0, ExactDecimal.ROUND_CEIL).times(increment));
}

export function isMultipleOfStep(value: DecimalString, step: DecimalString): boolean {
  return parse(value).mod(stepValue(step)).isZero();
}
