/**
 * Decimal numbers and arithmetic for cases where JavaScript `number` rounding
 * is not precise enough. A `BigDecimal` stores digits as a `bigint` plus a
 * decimal scale, which lets the module parse, compare, add, subtract, multiply,
 * divide, round, and format decimal values such as money, quantities, and
 * measurements.
 *
 * @since 2.0.0
 */

import * as Equal from "./Equal.ts"
import * as Equ from "./Equivalence.ts"
import { dual } from "./Function.ts"
import * as Hash from "./Hash.ts"
import { type Inspectable, NodeInspectSymbol } from "./Inspectable.ts"
import * as Option from "./Option.ts"
import * as order from "./Order.ts"
import type { Ordering } from "./Ordering.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"

const DEFAULT_PRECISION = 100
const FINITE_INT_REGEXP = /^[+-]?\d+$/

const TypeId = "~effect/BigDecimal"

/**
 * Represents an arbitrary precision decimal number.
 *
 * **When to use**
 *
 * Use when decimal arithmetic needs to avoid JavaScript floating point
 * representation errors.
 *
 * **Example** (Inspecting BigDecimal storage)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const d = BigDecimal.fromStringUnsafe("123.45")
 *
 * console.log(d.value) // 12345n
 * console.log(d.scale) // 2
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface BigDecimal extends Equal.Equal, Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly value: bigint
  readonly scale: number
  /** @internal */
  normalized?: BigDecimal
}

const BigDecimalProto: Omit<BigDecimal, "value" | "scale" | "normalized"> = {
  [TypeId]: TypeId,
  [Hash.symbol](this: BigDecimal): number {
    const normalized = normalize(this)
    return Hash.combine(Hash.hash(normalized.value), Hash.number(normalized.scale))
  },
  [Equal.symbol](this: BigDecimal, that: unknown): boolean {
    return isBigDecimal(that) && equals(this, that)
  },
  toString(this: BigDecimal) {
    return `BigDecimal(${format(this)})`
  },
  toJSON(this: BigDecimal) {
    return {
      _id: "BigDecimal",
      value: String(this.value),
      scale: this.scale
    }
  },
  [NodeInspectSymbol](this: BigDecimal) {
    return this.toJSON()
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
} as const

/**
 * Checks whether a given value is a `BigDecimal`.
 *
 * **When to use**
 *
 * Use to validate unknown input and narrow it to `BigDecimal`.
 *
 * **Example** (Checking BigDecimal values)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const decimal = BigDecimal.fromNumber(123.45)
 * console.log(BigDecimal.isBigDecimal(decimal)) // true
 * console.log(BigDecimal.isBigDecimal(123.45)) // false
 * console.log(BigDecimal.isBigDecimal("123.45")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isBigDecimal = (u: unknown): u is BigDecimal => hasProperty(u, TypeId)

/**
 * Creates a `BigDecimal` from a `bigint` value and a scale.
 *
 * **When to use**
 *
 * Use to construct a decimal directly from its unscaled integer value and
 * decimal scale.
 *
 * **Example** (Creating decimals from bigint and scale)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * // Create 123.45 (12345 with scale 2)
 * const decimal = BigDecimal.make(12345n, 2)
 * console.log(BigDecimal.format(decimal)) // "123.45"
 *
 * // Create 42 (42 with scale 0)
 * const integer = BigDecimal.make(42n, 0)
 * console.log(BigDecimal.format(integer)) // "42"
 * ```
 *
 * @see {@link fromBigInt} for constructing an integer decimal from a `bigint`
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = (value: bigint, scale: number): BigDecimal => {
  const o = Object.create(BigDecimalProto)
  o.value = value
  o.scale = scale
  return o
}

/**
 * Internal function used to create pre-normalized `BigDecimal`s.
 *
 * @internal
 */
export const makeNormalizedUnsafe = (value: bigint, scale: number): BigDecimal => {
  if (value !== bigint0 && value % bigint10 === bigint0) {
    throw new RangeError("Value must be normalized")
  }

  const o = make(value, scale)
  o.normalized = o
  return o
}

const bigint0 = BigInt(0)
const bigint1 = BigInt(1)
const bigint_1 = BigInt(-1)
const bigint2 = BigInt(2)
const bigint5 = BigInt(5)
const bigint_5 = BigInt(-5)
const bigint10 = BigInt(10)
const zero = makeNormalizedUnsafe(bigint0, 0)
const one = makeNormalizedUnsafe(bigint1, 0)

/**
 * Normalizes a given `BigDecimal` by removing trailing zeros.
 *
 * **When to use**
 *
 * Use to canonicalize decimals that have equivalent values but different
 * internal scales.
 *
 * **Example** (Normalizing trailing zeros)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.normalize(BigDecimal.fromStringUnsafe("123.00000")),
 *   BigDecimal.normalize(BigDecimal.make(123n, 0))
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.normalize(BigDecimal.fromStringUnsafe("12300000")),
 *   BigDecimal.normalize(BigDecimal.make(123n, -5))
 * )
 * ```
 *
 * @see {@link format} for rendering normalized decimals as strings
 *
 * @category scaling
 * @since 2.0.0
 */
export const normalize = (self: BigDecimal): BigDecimal => {
  if (self.normalized === undefined) {
    if (self.value === bigint0) {
      self.normalized = zero
    } else {
      const digits = `${self.value}`

      let trail = 0
      for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] === "0") {
          trail++
        } else {
          break
        }
      }

      if (trail === 0) {
        self.normalized = self
      }

      const value = BigInt(digits.substring(0, digits.length - trail))
      const scale = self.scale - trail
      self.normalized = makeNormalizedUnsafe(value, scale)
    }
  }

  return self.normalized
}

/**
 * Changes a `BigDecimal` to the specified scale.
 *
 * **When to use**
 *
 * Use to change how many decimal places are represented by a `BigDecimal`.
 *
 * **Details**
 *
 * Increasing the scale appends decimal zeros. Decreasing the scale discards
 * digits beyond the target scale by `bigint` division, which truncates toward
 * zero.
 *
 * **Example** (Scaling decimal precision)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const decimal = BigDecimal.fromNumberUnsafe(123.45)
 *
 * // Increase scale (add more precision)
 * const scaled = BigDecimal.scale(decimal, 4)
 * console.log(BigDecimal.format(scaled)) // "123.4500"
 *
 * // Decrease scale (reduce precision, rounds down)
 * const reduced = BigDecimal.scale(decimal, 1)
 * console.log(BigDecimal.format(reduced)) // "123.4"
 * ```
 *
 * @see {@link round} for changing scale with configurable rounding
 *
 * @category scaling
 * @since 2.0.0
 */
export const scale: {
  (scale: number): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, scale: number): BigDecimal
} = dual(2, (self: BigDecimal, scale: number): BigDecimal => {
  if (scale > self.scale) {
    return make(self.value * bigint10 ** BigInt(scale - self.scale), scale)
  }

  if (scale < self.scale) {
    return make(self.value / bigint10 ** BigInt(self.scale - scale), scale)
  }

  return self
})

/**
 * Provides an addition operation on `BigDecimal`s.
 *
 * **When to use**
 *
 * Use when you need a decimal addition function for piping or higher-order APIs
 * while preserving decimal precision.
 *
 * **Example** (Adding decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.sum(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   BigDecimal.fromStringUnsafe("5")
 * )
 * ```
 *
 * @see {@link sumAll} for summing an iterable of `BigDecimal` values
 *
 * @category math
 * @since 2.0.0
 */
export const sum: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, that: BigDecimal): BigDecimal => {
  if (that.value === bigint0) {
    return self
  }

  if (self.value === bigint0) {
    return that
  }

  if (self.scale > that.scale) {
    return make(scale(that, self.scale).value + self.value, self.scale)
  }

  if (self.scale < that.scale) {
    return make(scale(self, that.scale).value + that.value, that.scale)
  }

  return make(self.value + that.value, self.scale)
})

/**
 * Takes an `Iterable` of `BigDecimal`s and returns their sum as a single `BigDecimal`.
 *
 * **When to use**
 *
 * Use when you need to aggregate decimal quantities with decimal precision
 * instead of converting through JavaScript numbers.
 *
 * **Example** (Adding multiple decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.sumAll([BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3"), BigDecimal.fromStringUnsafe("4")]),
 *   BigDecimal.fromStringUnsafe("9")
 * )
 * ```
 *
 * @see {@link sum} for adding two `BigDecimal` values
 *
 * @category math
 * @since 3.16.0
 */
export const sumAll = (collection: Iterable<BigDecimal>): BigDecimal => {
  let out: BigDecimal = zero
  for (const n of collection) {
    out = sum(out, n)
  }
  return out
}

/**
 * Provides a multiplication operation on `BigDecimal`s.
 *
 * **When to use**
 *
 * Use to multiply two `BigDecimal` values.
 *
 * **Example** (Multiplying decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.multiply(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   BigDecimal.fromStringUnsafe("6")
 * )
 * ```
 *
 * @see {@link multiplyAll} for multiplying an iterable of `BigDecimal` values
 *
 * @category math
 * @since 2.0.0
 */
export const multiply: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, that: BigDecimal): BigDecimal => {
  if (that.value === bigint0 || self.value === bigint0) {
    return zero
  }

  return make(self.value * that.value, self.scale + that.scale)
})

/**
 * Takes an `Iterable` of `BigDecimal`s and returns their multiplication as a single `BigDecimal`.
 *
 * **When to use**
 *
 * Use to multiply all `BigDecimal` values in an iterable.
 *
 * **Example** (Multiplying multiple decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.multiplyAll([BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3"), BigDecimal.fromStringUnsafe("4")]),
 *   BigDecimal.fromStringUnsafe("24")
 * )
 * ```
 *
 * @see {@link multiply} for multiplying two `BigDecimal` values
 *
 * @category math
 * @since 4.0.0
 */
export const multiplyAll = (collection: Iterable<BigDecimal>): BigDecimal => {
  let out: BigDecimal = one
  for (const n of collection) {
    if (n.value === bigint0) {
      return zero
    }
    out = multiply(out, n)
  }
  return out
}

/**
 * Provides a subtraction operation on `BigDecimal`s.
 *
 * **When to use**
 *
 * Use to subtract one `BigDecimal` value from another.
 *
 * **Example** (Subtracting decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.subtract(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   BigDecimal.fromStringUnsafe("-1")
 * )
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const subtract: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, that: BigDecimal): BigDecimal => {
  if (that.value === bigint0) {
    return self
  }

  if (self.value === bigint0) {
    return make(-that.value, that.scale)
  }

  if (self.scale > that.scale) {
    return make(self.value - scale(that, self.scale).value, self.scale)
  }

  if (self.scale < that.scale) {
    return make(scale(self, that.scale).value - that.value, that.scale)
  }

  return make(self.value - that.value, self.scale)
})

/**
 * Internal function used for arbitrary precision division.
 */
const divideWithPrecision = (
  num: bigint,
  den: bigint,
  scale: number,
  precision: number
): BigDecimal => {
  const numNegative = num < bigint0
  const denNegative = den < bigint0
  const negateResult = numNegative !== denNegative

  num = numNegative ? -num : num
  den = denNegative ? -den : den

  // Shift digits until numerator is larger than denominator (set scale appropriately).
  while (num < den) {
    num *= bigint10
    scale++
  }

  // First division.
  let quotient = num / den
  let remainder = num % den

  if (remainder === bigint0) {
    // No remainder, return immediately.
    return make(negateResult ? -quotient : quotient, scale)
  }

  // The quotient is guaranteed to be non-negative at this point. No need to consider sign.
  let count = `${quotient}`.length

  // Shift the remainder by 1 decimal; The quotient will be 1 digit upon next division.
  remainder *= bigint10
  while (remainder !== bigint0 && count < precision) {
    const q = remainder / den
    const r = remainder % den
    quotient = quotient * bigint10 + q
    remainder = r * bigint10

    count++
    scale++
  }

  if (remainder !== bigint0) {
    // Round final number with remainder.
    quotient += roundTerminal(remainder / den)
  }

  return make(negateResult ? -quotient : quotient, scale)
}

/**
 * Internal function used for rounding.
 *
 * Returns 1 if the most significant digit is >= 5, otherwise 0.
 *
 * This is used after dividing a number by a power of ten and rounding the last digit.
 *
 * @internal
 */
export const roundTerminal = (n: bigint): bigint => {
  const pos = n >= bigint0 ? 0 : 1
  return Number(`${n}`[pos]) < 5 ? bigint0 : bigint1
}

/**
 * Divides `BigDecimal`s safely.
 *
 * **When to use**
 *
 * Use to divide `BigDecimal` values while representing division by zero as
 * `Option.none`.
 *
 * **Details**
 *
 * If the dividend is not a multiple of the divisor, the result will be a `BigDecimal` value
 * with up to the default division precision. If the divisor is `0`, the result
 * will be `Option.none()`.
 *
 * **Example** (Dividing decimals safely)
 *
 * ```ts
 * import { BigDecimal, Option } from "effect"
 *
 * console.log(
 *   Option.getOrThrow(
 *     BigDecimal.divide(
 *       BigDecimal.fromStringUnsafe("6"),
 *       BigDecimal.fromStringUnsafe("3")
 *     )
 *   )
 * ) // BigDecimal(2)
 * console.log(
 *   Option.getOrThrow(
 *     BigDecimal.divide(
 *       BigDecimal.fromStringUnsafe("6"),
 *       BigDecimal.fromStringUnsafe("4")
 *     )
 *   )
 * ) // BigDecimal(1.5)
 * console.log(
 *   Option.isNone(
 *     BigDecimal.divide(
 *       BigDecimal.fromStringUnsafe("6"),
 *       BigDecimal.fromStringUnsafe("0")
 *     )
 *   )
 * ) // true
 * ```
 *
 * @see {@link divideUnsafe} for division that throws when the divisor is zero
 * @see {@link remainder} for the decimal remainder operation
 *
 * @category math
 * @since 2.0.0
 */
export const divide: {
  (that: BigDecimal): (self: BigDecimal) => Option.Option<BigDecimal>
  (self: BigDecimal, that: BigDecimal): Option.Option<BigDecimal>
} = dual(2, (self: BigDecimal, that: BigDecimal): Option.Option<BigDecimal> => {
  if (that.value === bigint0) {
    return Option.none()
  }

  if (self.value === bigint0) {
    return Option.some(zero)
  }

  const scale = self.scale - that.scale
  if (self.value === that.value) {
    return Option.some(make(bigint1, scale))
  }

  return Option.some(divideWithPrecision(self.value, that.value, scale, DEFAULT_PRECISION))
})

/**
 * Provides an unsafe division operation on `BigDecimal`s.
 *
 * **When to use**
 *
 * Use when you need to divide `BigDecimal` values where the divisor is known
 * to be non-zero, so division by zero should be a thrown exception.
 *
 * **Details**
 *
 * If the dividend is not a multiple of the divisor, the result will be a `BigDecimal` value
 * with up to the default division precision.
 *
 * **Gotchas**
 *
 * Throws a `RangeError` if the divisor is `0`.
 *
 * **Example** (Dividing decimals unsafely)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * console.log(BigDecimal.divideUnsafe(BigDecimal.fromStringUnsafe("6"), BigDecimal.fromStringUnsafe("3"))) // BigDecimal(2)
 * console.log(BigDecimal.divideUnsafe(BigDecimal.fromStringUnsafe("6"), BigDecimal.fromStringUnsafe("4"))) // BigDecimal(1.5)
 * ```
 *
 * @see {@link divide} for division that returns `Option.none` when the divisor is zero
 *
 * @category math
 * @since 4.0.0
 */
export const divideUnsafe: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, that: BigDecimal): BigDecimal => {
  if (that.value === bigint0) {
    throw new RangeError("Division by zero")
  }

  if (self.value === bigint0) {
    return zero
  }

  const scale = self.scale - that.scale
  if (self.value === that.value) {
    return make(bigint1, scale)
  }
  return divideWithPrecision(self.value, that.value, scale, DEFAULT_PRECISION)
})

/**
 * Provides an `Order` instance for `BigDecimal` that allows comparing and sorting BigDecimal values.
 *
 * **When to use**
 *
 * Use when you need to sort or compare decimal values through APIs that accept
 * an ordering instance.
 *
 * **Example** (Comparing decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const a = BigDecimal.fromNumberUnsafe(1.5)
 * const b = BigDecimal.fromNumberUnsafe(2.3)
 * const c = BigDecimal.fromNumberUnsafe(1.5)
 *
 * console.log(BigDecimal.Order(a, b)) // -1 (a < b)
 * console.log(BigDecimal.Order(b, a)) // 1 (b > a)
 * console.log(BigDecimal.Order(a, c)) // 0 (a === c)
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Order: order.Order<BigDecimal> = order.make((self, that) => {
  const scmp = order.Number(sign(self), sign(that))
  if (scmp !== 0) {
    return scmp
  }

  if (self.scale > that.scale) {
    return order.BigInt(self.value, scale(that, self.scale).value)
  }

  if (self.scale < that.scale) {
    return order.BigInt(scale(self, that.scale).value, that.value)
  }

  return order.BigInt(self.value, that.value)
})

/**
 * Returns `true` if the first argument is less than the second, otherwise `false`.
 *
 * **When to use**
 *
 * Use to test whether one `BigDecimal` is strictly less than another.
 *
 * **Example** (Checking less-than comparisons)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.isLessThan(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   true
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.isLessThan(BigDecimal.fromStringUnsafe("3"), BigDecimal.fromStringUnsafe("3")),
 *   false
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.isLessThan(BigDecimal.fromStringUnsafe("4"), BigDecimal.fromStringUnsafe("3")),
 *   false
 * )
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isLessThan: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = order.isLessThan(Order)

/**
 * Checks whether a given `BigDecimal` is less than or equal to the provided one.
 *
 * **When to use**
 *
 * Use to test whether one `BigDecimal` is less than or equal to another.
 *
 * **Example** (Checking less-than-or-equal comparisons)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.isLessThanOrEqualTo(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   true
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.isLessThanOrEqualTo(BigDecimal.fromStringUnsafe("3"), BigDecimal.fromStringUnsafe("3")),
 *   true
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.isLessThanOrEqualTo(BigDecimal.fromStringUnsafe("4"), BigDecimal.fromStringUnsafe("3")),
 *   false
 * )
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isLessThanOrEqualTo: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = order.isLessThanOrEqualTo(Order)

/**
 * Returns `true` if the first argument is greater than the second, otherwise `false`.
 *
 * **When to use**
 *
 * Use to test whether one `BigDecimal` is strictly greater than another.
 *
 * **Example** (Checking greater-than comparisons)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.isGreaterThan(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   false
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.isGreaterThan(BigDecimal.fromStringUnsafe("3"), BigDecimal.fromStringUnsafe("3")),
 *   false
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.isGreaterThan(BigDecimal.fromStringUnsafe("4"), BigDecimal.fromStringUnsafe("3")),
 *   true
 * )
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isGreaterThan: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = order.isGreaterThan(Order)

/**
 * Checks whether a given `BigDecimal` is greater than or equal to the provided one.
 *
 * **When to use**
 *
 * Use to test whether one `BigDecimal` is greater than or equal to another.
 *
 * **Example** (Checking greater-than-or-equal comparisons)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.isGreaterThanOrEqualTo(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   false
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.isGreaterThanOrEqualTo(BigDecimal.fromStringUnsafe("3"), BigDecimal.fromStringUnsafe("3")),
 *   true
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.isGreaterThanOrEqualTo(BigDecimal.fromStringUnsafe("4"), BigDecimal.fromStringUnsafe("3")),
 *   true
 * )
 * ```
 *
 * @category predicates
 * @since 4.0.0
 */
export const isGreaterThanOrEqualTo: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = order.isGreaterThanOrEqualTo(Order)

/**
 * Checks whether a `BigDecimal` is between a `minimum` and `maximum` value (inclusive).
 *
 * **When to use**
 *
 * Use to test whether a `BigDecimal` falls inside an inclusive range.
 *
 * **Example** (Checking decimal ranges)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * const between = BigDecimal.between({
 *   minimum: BigDecimal.fromStringUnsafe("1"),
 *   maximum: BigDecimal.fromStringUnsafe("5")
 * })
 *
 * assert.deepStrictEqual(between(BigDecimal.fromStringUnsafe("3")), true)
 * assert.deepStrictEqual(between(BigDecimal.fromStringUnsafe("0")), false)
 * assert.deepStrictEqual(between(BigDecimal.fromStringUnsafe("6")), false)
 * ```
 *
 * @see {@link clamp} for forcing a `BigDecimal` into an inclusive range
 *
 * @category predicates
 * @since 2.0.0
 */
export const between: {
  (options: {
    minimum: BigDecimal
    maximum: BigDecimal
  }): (self: BigDecimal) => boolean
  (self: BigDecimal, options: {
    minimum: BigDecimal
    maximum: BigDecimal
  }): boolean
} = order.isBetween(Order)

/**
 * Restricts the given `BigDecimal` to be within the range specified by the `minimum` and `maximum` values.
 *
 * **When to use**
 *
 * Use to force a `BigDecimal` into an inclusive range.
 *
 * **Details**
 *
 * If the `BigDecimal` is less than the `minimum` value, the function returns
 * the `minimum` value. If it is greater than the `maximum` value, the function
 * returns the `maximum` value. Otherwise, it returns the original `BigDecimal`.
 *
 * **Example** (Clamping decimals to a range)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * const clamp = BigDecimal.clamp({
 *   minimum: BigDecimal.fromStringUnsafe("1"),
 *   maximum: BigDecimal.fromStringUnsafe("5")
 * })
 *
 * assert.deepStrictEqual(
 *   clamp(BigDecimal.fromStringUnsafe("3")),
 *   BigDecimal.fromStringUnsafe("3")
 * )
 * assert.deepStrictEqual(
 *   clamp(BigDecimal.fromStringUnsafe("0")),
 *   BigDecimal.fromStringUnsafe("1")
 * )
 * assert.deepStrictEqual(
 *   clamp(BigDecimal.fromStringUnsafe("6")),
 *   BigDecimal.fromStringUnsafe("5")
 * )
 * ```
 *
 * @see {@link between} for checking whether a `BigDecimal` is already inside a range
 *
 * @category math
 * @since 2.0.0
 */
export const clamp: {
  (options: {
    minimum: BigDecimal
    maximum: BigDecimal
  }): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, options: {
    minimum: BigDecimal
    maximum: BigDecimal
  }): BigDecimal
} = order.clamp(Order)

/**
 * Returns the minimum between two `BigDecimal`s.
 *
 * **When to use**
 *
 * Use to select the smaller of two `BigDecimal` values.
 *
 * **Example** (Selecting the smaller decimal)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.min(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   BigDecimal.fromStringUnsafe("2")
 * )
 * ```
 *
 * @see {@link max} for selecting the larger value
 *
 * @category math
 * @since 2.0.0
 */
export const min: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = order.min(Order)

/**
 * Returns the maximum between two `BigDecimal`s.
 *
 * **When to use**
 *
 * Use to select the larger of two `BigDecimal` values.
 *
 * **Example** (Selecting the larger decimal)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.max(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("3")),
 *   BigDecimal.fromStringUnsafe("3")
 * )
 * ```
 *
 * @see {@link min} for selecting the smaller value
 *
 * @category math
 * @since 2.0.0
 */
export const max: {
  (that: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, that: BigDecimal): BigDecimal
} = order.max(Order)

/**
 * Determines the sign of a given `BigDecimal`.
 *
 * **When to use**
 *
 * Use to classify a `BigDecimal` as negative, zero, or positive.
 *
 * **Example** (Reading decimal signs)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.sign(BigDecimal.fromStringUnsafe("-5")), -1)
 * assert.deepStrictEqual(BigDecimal.sign(BigDecimal.fromStringUnsafe("0")), 0)
 * assert.deepStrictEqual(BigDecimal.sign(BigDecimal.fromStringUnsafe("5")), 1)
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const sign = (n: BigDecimal): Ordering => n.value === bigint0 ? 0 : n.value < bigint0 ? -1 : 1

/**
 * Determines the absolute value of a given `BigDecimal`.
 *
 * **When to use**
 *
 * Use to remove the sign from a `BigDecimal` while preserving its magnitude.
 *
 * **Example** (Calculating absolute values)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.abs(BigDecimal.fromStringUnsafe("-5")), BigDecimal.fromStringUnsafe("5"))
 * assert.deepStrictEqual(BigDecimal.abs(BigDecimal.fromStringUnsafe("0")), BigDecimal.fromStringUnsafe("0"))
 * assert.deepStrictEqual(BigDecimal.abs(BigDecimal.fromStringUnsafe("5")), BigDecimal.fromStringUnsafe("5"))
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const abs = (n: BigDecimal): BigDecimal => n.value < bigint0 ? make(-n.value, n.scale) : n

/**
 * Provides a negate operation on `BigDecimal`s.
 *
 * **When to use**
 *
 * Use to flip the sign of a `BigDecimal`.
 *
 * **Example** (Negating decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.negate(BigDecimal.fromStringUnsafe("3")), BigDecimal.fromStringUnsafe("-3"))
 * assert.deepStrictEqual(BigDecimal.negate(BigDecimal.fromStringUnsafe("-6")), BigDecimal.fromStringUnsafe("6"))
 * ```
 *
 * @category math
 * @since 2.0.0
 */
export const negate = (n: BigDecimal): BigDecimal => make(-n.value, n.scale)

/**
 * Computes the decimal remainder safely when one operand is divided by a second
 * operand.
 *
 * **When to use**
 *
 * Use to compute a decimal remainder while representing division by zero as
 * `Option.none`.
 *
 * **Details**
 *
 * If the divisor is `0`, the result will be `Option.none()`.
 *
 * **Example** (Computing remainders safely)
 *
 * ```ts
 * import { BigDecimal, Option } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.remainder(
 *     BigDecimal.fromStringUnsafe("2"),
 *     BigDecimal.fromStringUnsafe("2")
 *   ),
 *   Option.some(BigDecimal.fromStringUnsafe("0"))
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.remainder(
 *     BigDecimal.fromStringUnsafe("3"),
 *     BigDecimal.fromStringUnsafe("2")
 *   ),
 *   Option.some(BigDecimal.fromStringUnsafe("1"))
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.remainder(
 *     BigDecimal.fromStringUnsafe("-4"),
 *     BigDecimal.fromStringUnsafe("2")
 *   ),
 *   Option.some(BigDecimal.fromStringUnsafe("0"))
 * )
 * ```
 *
 * @see {@link remainderUnsafe} for remainder calculation that throws when the divisor is zero
 * @see {@link divide} for decimal quotient calculation
 *
 * @category math
 * @since 2.0.0
 */
export const remainder: {
  (divisor: BigDecimal): (self: BigDecimal) => Option.Option<BigDecimal>
  (self: BigDecimal, divisor: BigDecimal): Option.Option<BigDecimal>
} = dual(2, (self: BigDecimal, divisor: BigDecimal): Option.Option<BigDecimal> => {
  if (divisor.value === bigint0) {
    return Option.none()
  }

  const max = Math.max(self.scale, divisor.scale)
  return Option.some(make(scale(self, max).value % scale(divisor, max).value, max))
})

/**
 * Returns the decimal remainder left over when one operand is divided by a
 * non-zero second operand.
 *
 * **When to use**
 *
 * Use when you need to compute a `BigDecimal` remainder with a divisor known to
 * be non-zero and want a plain `BigDecimal` result instead of an `Option`.
 *
 * **Gotchas**
 *
 * Throws a `RangeError` if the divisor is `0`.
 *
 * **Example** (Computing remainders unsafely)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.remainderUnsafe(BigDecimal.fromStringUnsafe("2"), BigDecimal.fromStringUnsafe("2")),
 *   BigDecimal.fromStringUnsafe("0")
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.remainderUnsafe(BigDecimal.fromStringUnsafe("3"), BigDecimal.fromStringUnsafe("2")),
 *   BigDecimal.fromStringUnsafe("1")
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.remainderUnsafe(BigDecimal.fromStringUnsafe("-4"), BigDecimal.fromStringUnsafe("2")),
 *   BigDecimal.fromStringUnsafe("0")
 * )
 * ```
 *
 * @see {@link remainder} for returning `Option.none` when the divisor is zero
 *
 * @category math
 * @since 4.0.0
 */
export const remainderUnsafe: {
  (divisor: BigDecimal): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, divisor: BigDecimal): BigDecimal
} = dual(2, (self: BigDecimal, divisor: BigDecimal): BigDecimal => {
  if (divisor.value === bigint0) {
    throw new RangeError("Division by zero")
  }

  const max = Math.max(self.scale, divisor.scale)
  return make(scale(self, max).value % scale(divisor, max).value, max)
})

/**
 * Provides an `Equivalence` instance for `BigDecimal` that determines equality between BigDecimal values.
 *
 * **When to use**
 *
 * Use when comparing decimal values through APIs that accept an equivalence
 * relation.
 *
 * **Example** (Checking decimal equivalence)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const a = BigDecimal.fromStringUnsafe("1.50")
 * const b = BigDecimal.fromStringUnsafe("1.5")
 * const c = BigDecimal.fromStringUnsafe("2.0")
 *
 * console.log(BigDecimal.Equivalence(a, b)) // true (1.50 === 1.5)
 * console.log(BigDecimal.Equivalence(a, c)) // false (1.50 !== 2.0)
 * ```
 *
 * @category instances
 * @since 2.0.0
 */
export const Equivalence: Equ.Equivalence<BigDecimal> = Equ.make((self, that) => {
  if (self.scale > that.scale) {
    return scale(that, self.scale).value === self.value
  }

  if (self.scale < that.scale) {
    return scale(self, that.scale).value === that.value
  }

  return self.value === that.value
})

/**
 * Checks whether two `BigDecimal`s are equal.
 *
 * **When to use**
 *
 * Use to compare two `BigDecimal` values for numeric equality.
 *
 * **Example** (Checking decimal equality)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const a = BigDecimal.fromStringUnsafe("1.5")
 * const b = BigDecimal.fromStringUnsafe("1.50")
 * const c = BigDecimal.fromStringUnsafe("2.0")
 *
 * console.log(BigDecimal.equals(a, b)) // true
 * console.log(BigDecimal.equals(a, c)) // false
 * ```
 *
 * @see {@link Equivalence} for passing decimal equality to APIs that require an `Equivalence`
 *
 * @category predicates
 * @since 2.0.0
 */
export const equals: {
  (that: BigDecimal): (self: BigDecimal) => boolean
  (self: BigDecimal, that: BigDecimal): boolean
} = dual(2, (self: BigDecimal, that: BigDecimal): boolean => Equivalence(self, that))

/**
 * Creates a `BigDecimal` from a `bigint` value.
 *
 * **When to use**
 *
 * Use to construct an integer `BigDecimal` from a `bigint`.
 *
 * **Example** (Creating decimals from bigint)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * const decimal = BigDecimal.fromBigInt(123n)
 * console.log(BigDecimal.format(decimal)) // "123"
 *
 * const largeBigInt = BigDecimal.fromBigInt(9007199254740991n)
 * console.log(BigDecimal.format(largeBigInt)) // "9007199254740991"
 * ```
 *
 * @see {@link make} for constructing a decimal with an explicit scale
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromBigInt = (n: bigint): BigDecimal => make(n, 0)

/**
 * Creates a `BigDecimal` from a finite `number`.
 *
 * **When to use**
 *
 * Use when you need to convert a trusted finite JavaScript number to a
 * `BigDecimal` and want a plain result instead of an `Option`.
 *
 * **Gotchas**
 *
 * It is not recommended to convert a floating point number to a decimal
 * directly, as the floating point representation may be unexpected. Throws a
 * `RangeError` if the number is not finite (`NaN`, `+Infinity` or `-Infinity`).
 *
 * **Example** (Creating decimals from finite numbers)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.fromNumberUnsafe(123), BigDecimal.make(123n, 0))
 * assert.deepStrictEqual(BigDecimal.fromNumberUnsafe(123.456), BigDecimal.make(123456n, 3))
 * ```
 *
 * @see {@link fromNumber} for returning `Option.none` when the number is not finite
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromNumberUnsafe = (n: number): BigDecimal => {
  return Option.getOrThrowWith(fromNumber(n), () => new RangeError(`Number must be finite, got ${n}`))
}

/**
 * Creates a `BigDecimal` safely from a finite `number`.
 *
 * **When to use**
 *
 * Use to convert a finite JavaScript number to a `BigDecimal` without throwing
 * on invalid input.
 *
 * **Details**
 *
 * Returns `Option.none()` for `NaN`, `+Infinity` or `-Infinity`.
 *
 * **Gotchas**
 *
 * It is not recommended to convert a floating point number to a decimal
 * directly, as the floating point representation may be unexpected.
 *
 * **Example** (Creating decimals from numbers safely)
 *
 * ```ts
 * import { BigDecimal, Option } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.fromNumber(123), Option.some(BigDecimal.make(123n, 0)))
 * assert.deepStrictEqual(
 *   BigDecimal.fromNumber(123.456),
 *   Option.some(BigDecimal.make(123456n, 3))
 * )
 * assert.deepStrictEqual(BigDecimal.fromNumber(Infinity), Option.none())
 * ```
 *
 * @see {@link fromNumberUnsafe} for throwing when the number is not finite
 * @see {@link fromString} for parsing decimal strings directly
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromNumber = (n: number): Option.Option<BigDecimal> => {
  if (!Number.isFinite(n)) {
    return Option.none()
  }

  const string = `${n}`
  if (string.includes("e")) {
    return fromString(string)
  }

  const [lead, trail = ""] = string.split(".")
  return Option.some(make(BigInt(`${lead}${trail}`), trail.length))
}

/**
 * Parses a decimal string into a `BigDecimal` safely.
 *
 * **When to use**
 *
 * Use to parse external decimal text without throwing on invalid input.
 *
 * **Details**
 *
 * Returns `Option.some` for valid decimal or exponent notation and
 * `Option.none` when the string cannot be parsed or would produce an unsafe
 * scale. The empty string parses as zero.
 *
 * **Example** (Parsing decimal strings safely)
 *
 * ```ts
 * import { BigDecimal, Option } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.fromString("123"), Option.some(BigDecimal.make(123n, 0)))
 * assert.deepStrictEqual(
 *   BigDecimal.fromString("123.456"),
 *   Option.some(BigDecimal.make(123456n, 3))
 * )
 * assert.deepStrictEqual(BigDecimal.fromString("123.abc"), Option.none())
 * ```
 *
 * @see {@link fromStringUnsafe} for parsing that throws on invalid input
 * @see {@link fromNumber} for converting finite JavaScript numbers
 *
 * @category constructors
 * @since 2.0.0
 */
export const fromString = (s: string): Option.Option<BigDecimal> => {
  if (s === "") {
    return Option.some(zero)
  }

  let base: string
  let exp: number
  const seperator = s.search(/[eE]/)
  if (seperator !== -1) {
    const trail = s.slice(seperator + 1)
    base = s.slice(0, seperator)
    exp = Number(trail)
    if (base === "" || !Number.isSafeInteger(exp) || !FINITE_INT_REGEXP.test(trail)) {
      return Option.none()
    }
  } else {
    base = s
    exp = 0
  }

  let digits: string
  let offset: number
  const dot = base.search(/\./)
  if (dot !== -1) {
    const lead = base.slice(0, dot)
    const trail = base.slice(dot + 1)
    digits = `${lead}${trail}`
    offset = trail.length
  } else {
    digits = base
    offset = 0
  }

  if (!FINITE_INT_REGEXP.test(digits)) {
    return Option.none()
  }

  const scale = offset - exp
  if (!Number.isSafeInteger(scale)) {
    return Option.none()
  }

  return Option.some(make(BigInt(digits), scale))
}

/**
 * Parses a decimal string into a `BigDecimal`, throwing if the string is
 * invalid.
 *
 * **When to use**
 *
 * Use when you expect decimal text to be valid and want parse errors to throw.
 *
 * **Details**
 *
 * Accepts the same syntax as `fromString`. Use `fromString` when invalid input
 * should be represented as `Option.none` instead of throwing.
 *
 * **Example** (Parsing decimal strings unsafely)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.fromStringUnsafe("123"), BigDecimal.make(123n, 0))
 * assert.deepStrictEqual(BigDecimal.fromStringUnsafe("123.456"), BigDecimal.make(123456n, 3))
 * assert.throws(() => BigDecimal.fromStringUnsafe("123.abc"))
 * ```
 *
 * @see {@link fromString} for returning `Option.none` on invalid input
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromStringUnsafe = (s: string): BigDecimal => {
  return Option.getOrThrowWith(fromString(s), () => new Error(`Invalid numerical string: ${s}`))
}

/**
 * Formats a `BigDecimal` as a string.
 *
 * **When to use**
 *
 * Use to render a `BigDecimal` as plain decimal text when possible.
 *
 * **Details**
 *
 * The value is normalized before formatting. Scientific notation is used when
 * the absolute value of the normalized scale is at least `16`; otherwise plain
 * decimal notation is used.
 *
 * **Example** (Formatting decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.format(BigDecimal.fromStringUnsafe("-5")), "-5")
 * assert.deepStrictEqual(BigDecimal.format(BigDecimal.fromStringUnsafe("123.456")), "123.456")
 * assert.deepStrictEqual(BigDecimal.format(BigDecimal.fromStringUnsafe("-0.00000123")), "-0.00000123")
 * ```
 *
 * @see {@link toExponential} for always rendering scientific notation
 *
 * @category converting
 * @since 2.0.0
 */
export const format = (n: BigDecimal): string => {
  const normalized = normalize(n)
  if (Math.abs(normalized.scale) >= 16) {
    return toExponential(normalized)
  }

  const negative = normalized.value < bigint0
  const absolute = negative ? `${normalized.value}`.substring(1) : `${normalized.value}`

  let before: string
  let after: string

  if (normalized.scale >= absolute.length) {
    before = "0"
    after = "0".repeat(normalized.scale - absolute.length) + absolute
  } else {
    const location = absolute.length - normalized.scale
    if (location > absolute.length) {
      const zeros = location - absolute.length
      before = `${absolute}${"0".repeat(zeros)}`
      after = ""
    } else {
      after = absolute.slice(location)
      before = absolute.slice(0, location)
    }
  }

  const complete = after === "" ? before : `${before}.${after}`
  return negative ? `-${complete}` : complete
}

/**
 * Formats a given `BigDecimal` as a `string` in scientific notation.
 *
 * **When to use**
 *
 * Use to render a `BigDecimal` in scientific notation.
 *
 * **Example** (Formatting decimals exponentially)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.toExponential(BigDecimal.make(123456n, -5)), "1.23456e+10")
 * ```
 *
 * @see {@link format} for plain decimal formatting when possible
 *
 * @category converting
 * @since 3.11.0
 */
export const toExponential = (n: BigDecimal): string => {
  if (isZero(n)) {
    return "0e+0"
  }

  const normalized = normalize(n)
  const digits = `${abs(normalized).value}`
  const head = digits.slice(0, 1)
  const tail = digits.slice(1)

  let output = `${isNegative(normalized) ? "-" : ""}${head}`
  if (tail !== "") {
    output += `.${tail}`
  }

  const exp = tail.length - normalized.scale
  return `${output}e${exp >= 0 ? "+" : ""}${exp}`
}

/**
 * Converts a `BigDecimal` to a JavaScript `number`.
 *
 * **When to use**
 *
 * Use when you need a JavaScript number at an interop boundary where precision
 * loss is acceptable.
 *
 * **Gotchas**
 *
 * This conversion is unsafe because the result can lose integer or fractional
 * precision, round to a nearby representable value, or become `Infinity` when
 * the decimal cannot be represented as a finite JavaScript `number`.
 *
 * **Example** (Converting decimals to numbers)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.toNumberUnsafe(BigDecimal.fromStringUnsafe("123.456")), 123.456)
 * ```
 *
 * @see {@link format} for preserving decimal precision as text
 *
 * @category converting
 * @since 4.0.0
 */
export const toNumberUnsafe = (n: BigDecimal): number => Number(format(n))

/**
 * Checks whether a given `BigDecimal` is an integer.
 *
 * **When to use**
 *
 * Use to test whether a `BigDecimal` has no fractional decimal part.
 *
 * **Example** (Checking integer decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.isInteger(BigDecimal.fromStringUnsafe("0")), true)
 * assert.deepStrictEqual(BigDecimal.isInteger(BigDecimal.fromStringUnsafe("1")), true)
 * assert.deepStrictEqual(BigDecimal.isInteger(BigDecimal.fromStringUnsafe("1.1")), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isInteger = (n: BigDecimal): boolean => normalize(n).scale <= 0

/**
 * Checks whether a given `BigDecimal` is `0`.
 *
 * **When to use**
 *
 * Use to test whether a `BigDecimal` is exactly zero.
 *
 * **Example** (Checking zero decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.isZero(BigDecimal.fromStringUnsafe("0")), true)
 * assert.deepStrictEqual(BigDecimal.isZero(BigDecimal.fromStringUnsafe("1")), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isZero = (n: BigDecimal): boolean => n.value === bigint0

/**
 * Checks whether a given `BigDecimal` is negative.
 *
 * **When to use**
 *
 * Use to test whether a `BigDecimal` is less than zero.
 *
 * **Example** (Checking negative decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.isNegative(BigDecimal.fromStringUnsafe("-1")), true)
 * assert.deepStrictEqual(BigDecimal.isNegative(BigDecimal.fromStringUnsafe("0")), false)
 * assert.deepStrictEqual(BigDecimal.isNegative(BigDecimal.fromStringUnsafe("1")), false)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isNegative = (n: BigDecimal): boolean => n.value < bigint0

/**
 * Checks whether a given `BigDecimal` is positive.
 *
 * **When to use**
 *
 * Use to test whether a `BigDecimal` is greater than zero.
 *
 * **Example** (Checking positive decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(BigDecimal.isPositive(BigDecimal.fromStringUnsafe("-1")), false)
 * assert.deepStrictEqual(BigDecimal.isPositive(BigDecimal.fromStringUnsafe("0")), false)
 * assert.deepStrictEqual(BigDecimal.isPositive(BigDecimal.fromStringUnsafe("1")), true)
 * ```
 *
 * @category predicates
 * @since 2.0.0
 */
export const isPositive = (n: BigDecimal): boolean => n.value > bigint0

const isBigDecimalArgs = (args: IArguments) => isBigDecimal(args[0])

/**
 * Rounding modes for `BigDecimal`.
 *
 * **When to use**
 *
 * Use with `round` to choose how discarded digits affect a `BigDecimal`
 * rounded to a target scale.
 *
 * **Details**
 *
 * - `ceil`: round towards positive infinity
 * - `floor`: round towards negative infinity
 * - `to-zero`: round towards zero
 * - `from-zero`: round away from zero
 * - `half-ceil`: round to the nearest neighbor; if equidistant round towards positive infinity
 * - `half-floor`: round to the nearest neighbor; if equidistant round towards negative infinity
 * - `half-to-zero`: round to the nearest neighbor; if equidistant round towards zero
 * - `half-from-zero`: round to the nearest neighbor; if equidistant round away from zero
 * - `half-even`: round to the nearest neighbor; if equidistant round to the neighbor with an even digit
 * - `half-odd`: round to the nearest neighbor; if equidistant round to the neighbor with an odd digit
 *
 * @see {@link round} for configurable rounding with a `RoundingMode`
 * @see {@link ceil} for fixed rounding toward positive infinity
 * @see {@link floor} for fixed rounding toward negative infinity
 * @see {@link truncate} for fixed rounding toward zero
 *
 * @category math
 * @since 3.16.0
 */
export type RoundingMode =
  | "ceil"
  | "floor"
  | "to-zero"
  | "from-zero"
  | "half-ceil"
  | "half-floor"
  | "half-to-zero"
  | "half-from-zero"
  | "half-even"
  | "half-odd"

/**
 * Computes a rounded `BigDecimal` at the given scale with the specified rounding mode.
 *
 * **When to use**
 *
 * Use to round a decimal at a requested scale with an explicit rounding mode.
 *
 * **Example** (Rounding decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.round(BigDecimal.fromStringUnsafe("145"), { mode: "from-zero", scale: -1 }),
 *   BigDecimal.fromStringUnsafe("150")
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.round(BigDecimal.fromStringUnsafe("-14.5")),
 *   BigDecimal.fromStringUnsafe("-15")
 * )
 * ```
 *
 * @see {@link ceil} for fixed rounding toward positive infinity
 * @see {@link floor} for fixed rounding toward negative infinity
 * @see {@link truncate} for fixed rounding toward zero
 *
 * @category math
 * @since 3.16.0
 */
export const round: {
  (options: { scale?: number; mode?: RoundingMode }): (self: BigDecimal) => BigDecimal
  (n: BigDecimal, options?: { scale?: number; mode?: RoundingMode }): BigDecimal
} = dual(isBigDecimalArgs, (self: BigDecimal, options?: { scale?: number; mode?: RoundingMode }): BigDecimal => {
  const mode = options?.mode ?? "half-from-zero"
  const scale = options?.scale ?? 0

  switch (mode) {
    case "ceil":
      return ceil(self, scale)

    case "floor":
      return floor(self, scale)

    case "to-zero":
      return truncate(self, scale)

    case "from-zero":
      return (isPositive(self) ? ceil(self, scale) : floor(self, scale))

    case "half-ceil":
      return floor(sum(self, make(bigint5, scale + 1)), scale)

    case "half-floor":
      return ceil(sum(self, make(bigint_5, scale + 1)), scale)

    case "half-to-zero":
      return isNegative(self)
        ? floor(sum(self, make(bigint5, scale + 1)), scale)
        : ceil(sum(self, make(bigint_5, scale + 1)), scale)

    case "half-from-zero":
      return isNegative(self)
        ? ceil(sum(self, make(bigint_5, scale + 1)), scale)
        : floor(sum(self, make(bigint5, scale + 1)), scale)
  }

  const halfCeil = floor(sum(self, make(bigint5, scale + 1)), scale)
  const halfFloor = ceil(sum(self, make(bigint_5, scale + 1)), scale)
  const digit = digitAt(halfCeil, scale)

  switch (mode) {
    case "half-even":
      return equals(halfCeil, halfFloor) ? halfCeil : (digit % bigint2 === bigint0) ? halfCeil : halfFloor

    case "half-odd":
      return equals(halfCeil, halfFloor) ? halfCeil : (digit % bigint2 === bigint0) ? halfFloor : halfCeil
  }
})

/**
 * Computes a truncated `BigDecimal` at the given scale. This removes fractional digits beyond the scale,
 * rounding toward zero.
 *
 * **When to use**
 *
 * Use when you need to discard fractional digits beyond a scale rather than
 * round half up, half down, or toward an infinity.
 *
 * **Example** (Truncating decimals)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 *
 * console.log(BigDecimal.truncate(BigDecimal.fromStringUnsafe("145"), -1)) // BigDecimal(140)
 * console.log(BigDecimal.truncate(BigDecimal.fromStringUnsafe("-14.5"))) // BigDecimal(-14)
 * ```
 *
 * @see {@link round} for configurable rounding modes
 * @see {@link ceil} for rounding toward positive infinity
 * @see {@link floor} for rounding toward negative infinity
 *
 * @category math
 * @since 3.16.0
 */
export const truncate: {
  (scale: number): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, scale?: number): BigDecimal
} = dual(isBigDecimalArgs, (self: BigDecimal, scale: number = 0): BigDecimal => {
  if (self.scale <= scale) {
    return self
  }

  // BigInt division truncates towards zero
  return make(self.value / (bigint10 ** BigInt(self.scale - scale)), scale)
})

/**
 * Computes the ceiling of a `BigDecimal` at the given scale.
 *
 * **When to use**
 *
 * Use to round a decimal toward positive infinity at a requested scale.
 *
 * **Details**
 *
 * The default scale is `0`. Positive scales keep digits to the right of the
 * decimal point, and negative scales round positions to the left of the decimal
 * point.
 *
 * @see {@link floor} for rounding toward negative infinity
 * @see {@link truncate} for rounding toward zero
 * @see {@link round} for configurable rounding modes
 *
 * **Example** (Rounding decimals up)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.ceil(BigDecimal.fromStringUnsafe("145"), -1),
 *   BigDecimal.fromStringUnsafe("150")
 * )
 * assert.deepStrictEqual(BigDecimal.ceil(BigDecimal.fromStringUnsafe("-14.5")), BigDecimal.fromStringUnsafe("-14"))
 * ```
 *
 * @category math
 * @since 3.16.0
 */
export const ceil: {
  (scale: number): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, scale?: number): BigDecimal
} = dual(isBigDecimalArgs, (self: BigDecimal, scale: number = 0): BigDecimal => {
  const truncated = truncate(self, scale)

  if (isPositive(self) && isLessThan(truncated, self)) {
    return sum(truncated, make(bigint1, scale))
  }

  return truncated
})

/**
 * Internal function used by `round` for `half-even` and `half-odd` rounding modes.
 *
 * Returns the digit at the position of the given `scale` within the `BigDecimal`.
 *
 * @internal
 */
export const digitAt: {
  (scale: number): (self: BigDecimal) => bigint
  (self: BigDecimal, scale: number): bigint
} = dual(2, (self: BigDecimal, scale: number): bigint => {
  if (self.scale < scale) {
    return bigint0
  }

  const scaled = self.value / (bigint10 ** BigInt(self.scale - scale))
  return scaled % bigint10
})

/**
 * Computes the floor of a `BigDecimal` at the given scale.
 *
 * **When to use**
 *
 * Use to round a decimal toward negative infinity at a requested scale.
 *
 * **Example** (Rounding decimals down)
 *
 * ```ts
 * import { BigDecimal } from "effect"
 * import * as assert from "node:assert"
 *
 * assert.deepStrictEqual(
 *   BigDecimal.floor(BigDecimal.fromStringUnsafe("145"), -1),
 *   BigDecimal.fromStringUnsafe("140")
 * )
 * assert.deepStrictEqual(
 *   BigDecimal.floor(BigDecimal.fromStringUnsafe("-14.5")),
 *   BigDecimal.fromStringUnsafe("-15")
 * )
 * ```
 *
 * @see {@link ceil} for rounding toward positive infinity
 * @see {@link truncate} for rounding toward zero
 * @see {@link round} for configurable rounding modes
 *
 * @category math
 * @since 3.16.0
 */
export const floor: {
  (scale: number): (self: BigDecimal) => BigDecimal
  (self: BigDecimal, scale?: number): BigDecimal
} = dual(isBigDecimalArgs, (self: BigDecimal, scale: number = 0): BigDecimal => {
  const truncated = truncate(self, scale)

  if (isNegative(self) && isGreaterThan(truncated, self)) {
    return sum(truncated, make(bigint_1, scale))
  }

  return truncated
})
