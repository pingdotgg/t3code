/**
 * Exact rational numbers for ratios that decimal arithmetic cannot represent.
 * A `Rational` stores a `bigint` numerator and denominator in lowest terms, so
 * values such as one third survive multiplication, comparison and compounding
 * without rounding. Use `BigDecimal` for decimal quantities such as money, and
 * `Rational` when a ratio must stay exact until an explicit conversion.
 *
 * @stability unstable
 * @since 4.1.3
 */

import * as BigDecimal from "./BigDecimal.ts"
import * as BI from "./BigInt.ts"
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

const TypeId = "~effect/Rational"

const bigint0 = BigInt(0)
const bigint1 = BigInt(1)
const bigint2 = BigInt(2)
const bigint10 = BigInt(10)
const FRACTION_REGEXP = /^([+-]?\d+)(?:\/([+-]?\d+))?$/
const QUOTIENT_BITS = 64
const MANTISSA_BITS = 53
const MIN_SUBNORMAL_EXPONENT = -1074

/**
 * Represents an exact rational number as a reduced fraction.
 *
 * **Details**
 *
 * Every `Rational` is kept in canonical form: the numerator and denominator
 * share no common factor, the denominator is positive, and zero is `0/1`.
 * Two rationals are equal exactly when their fields are equal.
 *
 * **Example** (Inspecting Rational storage)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * const r = Rational.makeUnsafe(6n, -4n)
 *
 * r.numerator // => -3n
 * r.denominator // => 2n
 * ```
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface Rational extends Equal.Equal, Pipeable, Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly numerator: bigint
  readonly denominator: bigint
}

const RationalProto: Omit<Rational, "numerator" | "denominator"> = {
  [TypeId]: TypeId,
  [Hash.symbol](this: Rational): number {
    return Hash.combine(Hash.hash(this.numerator), Hash.hash(this.denominator))
  },
  [Equal.symbol](this: Rational, that: unknown): boolean {
    return isRational(that) && Equivalence(this, that)
  },
  toString(this: Rational) {
    return `Rational(${format(this)})`
  },
  toJSON(this: Rational) {
    return {
      _id: "Rational",
      numerator: String(this.numerator),
      denominator: String(this.denominator)
    }
  },
  [NodeInspectSymbol](this: Rational) {
    return this.toJSON()
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
} as const

// Both arguments must already be coprime with a positive denominator.
const canonical = (numerator: bigint, denominator: bigint): Rational => {
  const rational = Object.create(RationalProto)
  rational.numerator = numerator
  rational.denominator = denominator
  return rational
}

// `denominator` must be non-zero.
const reduce = (numerator: bigint, denominator: bigint): Rational => {
  if (denominator < bigint0) {
    numerator = -numerator
    denominator = -denominator
  }
  const divisor = BI.gcd(numerator, denominator)
  return canonical(numerator / divisor, denominator / divisor)
}

// Both pairs must already be coprime with positive denominators. The sum can only
// share factors with the denominators' gcd (Knuth, TAOCP vol. 2, §4.5.1).
const sumCoprime = (n1: bigint, d1: bigint, n2: bigint, d2: bigint): Rational => {
  const g = BI.gcd(d1, d2)
  if (g === bigint1) {
    return canonical(n1 * d2 + n2 * d1, d1 * d2)
  }
  const t = n1 * (d2 / g) + n2 * (d1 / g)
  const e = BI.gcd(t, g)
  return canonical(t / e, (d1 / g) * (d2 / e))
}

// Both pairs must already be coprime with positive denominators. Canonical fractions share factors
// only crosswise, so cancelling those first leaves the products coprime (Knuth, TAOCP vol. 2, §4.5.1).
const multiplyCoprime = (n1: bigint, d1: bigint, n2: bigint, d2: bigint): Rational => {
  const g1 = BI.gcd(n1, d2)
  const g2 = BI.gcd(n2, d1)
  return canonical((n1 / g1) * (n2 / g2), (d1 / g2) * (d2 / g1))
}

const zero = canonical(bigint0, bigint1)
const one = canonical(bigint1, bigint1)

/**
 * Checks whether a given value is a `Rational`.
 *
 * **Example** (Checking Rational values)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.isRational(Rational.fromBigInt(1n)) // => true
 * Rational.isRational("1/3") // => false
 * ```
 *
 * @stability unstable
 * @category guards
 * @since 4.1.3
 */
export const isRational = (u: unknown): u is Rational => hasProperty(u, TypeId)

/**
 * Creates a `Rational` from a numerator and denominator, returning
 * `Option.none()` when the denominator is zero.
 *
 * **Details**
 *
 * The result is reduced to lowest terms with a positive denominator, so
 * `make(6n, -4n)` and `make(-3n, 2n)` produce the same value.
 *
 * **Example** (Creating rationals safely)
 *
 * ```ts import.meta.vitest
 * import { Option, Rational } from "effect"
 *
 * Rational.make(6n, -4n) // => Option.some(Rational.makeUnsafe(-3n, 2n))
 * Rational.make(1n, 0n) // => Option.none()
 * ```
 *
 * @see {@link makeUnsafe} for throwing on a zero denominator
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const make = (numerator: bigint, denominator: bigint): Option.Option<Rational> =>
  denominator === bigint0 ? Option.none() : Option.some(reduce(numerator, denominator))

/**
 * Creates a `Rational` from a numerator and denominator.
 *
 * **Gotchas**
 *
 * Throws a `RangeError` if the denominator is zero.
 *
 * **Example** (Creating rationals from bigint pairs)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.format(Rational.makeUnsafe(2n, 6n)) // => "1/3"
 * ```
 *
 * @see {@link make} for returning `Option.none` on a zero denominator
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const makeUnsafe = (numerator: bigint, denominator: bigint): Rational => {
  if (denominator === bigint0) {
    throw new RangeError("Denominator must be non-zero")
  }
  return reduce(numerator, denominator)
}

/**
 * Creates an integer `Rational` from a `bigint`.
 *
 * **Example** (Creating rationals from bigint)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.format(Rational.fromBigInt(-3n)) // => "-3/1"
 * ```
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const fromBigInt = (n: bigint): Rational => canonical(n, bigint1)

/**
 * Converts a `BigDecimal` to the exact `Rational` it denotes.
 *
 * **When to use**
 *
 * Use as the exact route from decimal text: `0.1` becomes `1/10`, which
 * {@link fromNumber} cannot produce.
 *
 * **Example** (Converting decimals exactly)
 *
 * ```ts import.meta.vitest
 * import { BigDecimal, Rational } from "effect"
 *
 * Rational.fromBigDecimal(BigDecimal.fromStringUnsafe("-12.50")) // => Rational.makeUnsafe(-25n, 2n)
 * ```
 *
 * @see {@link toBigDecimal} for the rounded conversion back
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const fromBigDecimal = (n: BigDecimal.BigDecimal): Rational => {
  const normalized = BigDecimal.normalize(n)
  return normalized.scale >= 0
    ? reduce(normalized.value, bigint10 ** BigInt(normalized.scale))
    : canonical(normalized.value * bigint10 ** BigInt(-normalized.scale), bigint1)
}

/**
 * Creates a `Rational` from a finite `number`, returning `Option.none()` for
 * `NaN`, `+Infinity` and `-Infinity`.
 *
 * **Details**
 *
 * The result is the exact binary value of the number, not its decimal display.
 * Negative zero becomes `0/1`.
 *
 * **Gotchas**
 *
 * `0.1` is not one tenth: the nearest double is `3602879701896397 / 2^55`, and
 * that is the value this function returns. Use {@link fromBigDecimal} with a
 * decimal string when the decimal reading is intended.
 *
 * **Example** (Creating rationals from numbers)
 *
 * ```ts import.meta.vitest
 * import { Option, Rational } from "effect"
 *
 * Rational.fromNumber(0.75) // => Option.some(Rational.makeUnsafe(3n, 4n))
 * Rational.fromNumber(NaN) // => Option.none()
 * ```
 *
 * @see {@link fromNumberUnsafe} for throwing when the number is not finite
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const fromNumber = (n: number): Option.Option<Rational> => {
  if (!Number.isFinite(n)) {
    return Option.none()
  }
  if (n === 0) {
    return Option.some(zero)
  }
  // Doubling is exact, and a finite double becomes integral within 1074 steps.
  let scaled = n
  let exponent = 0
  while (!Number.isInteger(scaled)) {
    scaled *= 2
    exponent++
  }
  return Option.some(reduce(BigInt(scaled), bigint1 << BigInt(exponent)))
}

/**
 * Creates a `Rational` from a finite `number`.
 *
 * **Gotchas**
 *
 * Throws a `RangeError` if the number is not finite. See {@link fromNumber}
 * for why `0.1` does not become one tenth.
 *
 * **Example** (Creating rationals from trusted numbers)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.fromNumberUnsafe(0.5) // => Rational.makeUnsafe(1n, 2n)
 * ```
 *
 * @see {@link fromNumber} for returning `Option.none` when the number is not finite
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const fromNumberUnsafe = (n: number): Rational =>
  Option.getOrThrowWith(fromNumber(n), () => new RangeError(`Number must be finite, got ${n}`))

/**
 * Parses an integer or fraction string into a `Rational` safely.
 *
 * **Details**
 *
 * Accepts `[+-]digits` or `[+-]digits/[+-]digits`. Reducible fractions and
 * negative denominators are normalized. Whitespace, decimal points, exponents,
 * the empty string and a zero denominator produce `Option.none()`.
 *
 * **Example** (Parsing fraction strings)
 *
 * ```ts import.meta.vitest
 * import { Option, Rational } from "effect"
 *
 * Rational.fromString("-4/-6") // => Option.some(Rational.makeUnsafe(2n, 3n))
 * Rational.fromString("3") // => Option.some(Rational.fromBigInt(3n))
 * Rational.fromString("1.5") // => Option.none()
 * ```
 *
 * @see {@link fromStringUnsafe} for parsing that throws on invalid input
 * @see {@link format} for the inverse operation
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const fromString = (s: string): Option.Option<Rational> => {
  const match = FRACTION_REGEXP.exec(s)
  if (match === null) {
    return Option.none()
  }
  return make(BigInt(match[1]), match[2] === undefined ? bigint1 : BigInt(match[2]))
}

/**
 * Parses an integer or fraction string into a `Rational`.
 *
 * **Gotchas**
 *
 * Throws an `Error` if the string is not a valid fraction. See
 * {@link fromString} for the accepted grammar.
 *
 * **Example** (Parsing trusted fraction strings)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.fromStringUnsafe("6/5") // => Rational.makeUnsafe(6n, 5n)
 * ```
 *
 * @see {@link fromString} for returning `Option.none` on invalid input
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const fromStringUnsafe = (s: string): Rational =>
  Option.getOrThrowWith(fromString(s), () => new Error(`Invalid rational string: ${s}`))

/**
 * Adds two rationals exactly.
 *
 * **Example** (Adding rationals)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.sum(Rational.makeUnsafe(1n, 3n), Rational.makeUnsafe(1n, 6n)) // => Rational.makeUnsafe(1n, 2n)
 * ```
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const sum: {
  (that: Rational): (self: Rational) => Rational
  (self: Rational, that: Rational): Rational
} = dual(
  2,
  (self: Rational, that: Rational): Rational =>
    sumCoprime(self.numerator, self.denominator, that.numerator, that.denominator)
)

/**
 * Sums all rationals in an iterable, returning zero for an empty collection.
 *
 * **Example** (Summing rationals)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * const third = Rational.makeUnsafe(1n, 3n)
 *
 * Rational.sumAll([third, third, third]) // => Rational.fromBigInt(1n)
 * ```
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const sumAll = (collection: Iterable<Rational>): Rational => {
  let out = zero
  for (const n of collection) {
    out = sum(out, n)
  }
  return out
}

/**
 * Subtracts `that` from `self` exactly.
 *
 * **Example** (Subtracting rationals)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.subtract(Rational.fromBigInt(1n), Rational.makeUnsafe(1n, 3n)) // => Rational.makeUnsafe(2n, 3n)
 * ```
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const subtract: {
  (that: Rational): (self: Rational) => Rational
  (self: Rational, that: Rational): Rational
} = dual(
  2,
  (self: Rational, that: Rational): Rational =>
    sumCoprime(self.numerator, self.denominator, -that.numerator, that.denominator)
)

/**
 * Multiplies two rationals exactly.
 *
 * **Example** (Multiplying rationals)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.multiply(Rational.makeUnsafe(1n, 3n), Rational.fromBigInt(3n)) // => Rational.fromBigInt(1n)
 * ```
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const multiply: {
  (that: Rational): (self: Rational) => Rational
  (self: Rational, that: Rational): Rational
} = dual(
  2,
  (self: Rational, that: Rational): Rational =>
    multiplyCoprime(self.numerator, self.denominator, that.numerator, that.denominator)
)

/**
 * Multiplies all rationals in an iterable, returning one for an empty
 * collection.
 *
 * **Example** (Compounding ratios)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.multiplyAll([Rational.makeUnsafe(3n, 2n), Rational.makeUnsafe(4n, 3n)]) // => Rational.fromBigInt(2n)
 * ```
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const multiplyAll = (collection: Iterable<Rational>): Rational => {
  let out = one
  for (const n of collection) {
    if (n.numerator === bigint0) {
      return zero
    }
    out = multiply(out, n)
  }
  return out
}

/**
 * Divides `self` by `that`, returning `Option.none()` when `that` is zero.
 *
 * **Example** (Dividing rationals safely)
 *
 * ```ts import.meta.vitest
 * import { Option, Rational } from "effect"
 *
 * const third = Rational.makeUnsafe(1n, 3n)
 *
 * Rational.divide(third, Rational.fromBigInt(3n)) // => Option.some(Rational.makeUnsafe(1n, 9n))
 * Rational.divide(third, Rational.fromBigInt(0n)) // => Option.none()
 * ```
 *
 * @see {@link divideUnsafe} for division that throws when the divisor is zero
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const divide: {
  (that: Rational): (self: Rational) => Option.Option<Rational>
  (self: Rational, that: Rational): Option.Option<Rational>
} = dual(
  2,
  (self: Rational, that: Rational): Option.Option<Rational> =>
    that.numerator === bigint0
      ? Option.none()
      : Option.some(
        that.numerator < bigint0
          ? multiplyCoprime(self.numerator, self.denominator, -that.denominator, -that.numerator)
          : multiplyCoprime(self.numerator, self.denominator, that.denominator, that.numerator)
      )
)

/**
 * Divides `self` by `that`.
 *
 * **Gotchas**
 *
 * Throws a `RangeError` if the divisor is zero.
 *
 * **Example** (Dividing rationals)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.divideUnsafe(Rational.makeUnsafe(-2n, 3n), Rational.makeUnsafe(4n, 9n)) // => Rational.makeUnsafe(-3n, 2n)
 * ```
 *
 * @see {@link divide} for division that returns `Option.none` when the divisor is zero
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const divideUnsafe: {
  (that: Rational): (self: Rational) => Rational
  (self: Rational, that: Rational): Rational
} = dual(
  2,
  (self: Rational, that: Rational): Rational => Option.getOrThrowWith(divide(self, that), divisionByZero)
)

const divisionByZero = () => new RangeError("Division by zero")

/**
 * Raises a rational to an integer power, returning `Option.none()` for zero
 * raised to a negative exponent.
 *
 * **Details**
 *
 * A negative exponent inverts the fraction before raising it, and any value
 * to the power zero is one, including zero itself.
 *
 * **Gotchas**
 *
 * The exponent must be a safe integer. Anything else, including `0.5`, `NaN`
 * and `Infinity`, throws a `RangeError` instead of being rounded.
 *
 * **Example** (Raising to integer powers)
 *
 * ```ts import.meta.vitest
 * import { Option, Rational } from "effect"
 *
 * Rational.pow(Rational.makeUnsafe(1n, 3n), -1) // => Option.some(Rational.fromBigInt(3n))
 * Rational.pow(Rational.fromBigInt(0n), -1) // => Option.none()
 * ```
 *
 * @see {@link powUnsafe} for throwing when zero is raised to a negative exponent
 * @see {@link nthRoot} for the inverse of a power
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const pow: {
  (exponent: number): (self: Rational) => Option.Option<Rational>
  (self: Rational, exponent: number): Option.Option<Rational>
} = dual(2, (self: Rational, exponent: number): Option.Option<Rational> => {
  if (!Number.isSafeInteger(exponent)) {
    throw new RangeError(`Exponent must be a safe integer, got ${exponent}`)
  }
  if (exponent === 0) {
    return Option.some(one)
  }
  if (exponent > 0) {
    const e = BigInt(exponent)
    return Option.some(canonical(self.numerator ** e, self.denominator ** e))
  }
  if (self.numerator === bigint0) {
    return Option.none()
  }
  // Powers of coprime integers stay coprime, so only the sign needs fixing.
  const e = BigInt(-exponent)
  const numerator = self.numerator ** e
  const denominator = self.denominator ** e
  return Option.some(numerator < bigint0 ? canonical(-denominator, -numerator) : canonical(denominator, numerator))
})

/**
 * Raises a rational to an integer power.
 *
 * **Gotchas**
 *
 * Throws a `RangeError` for zero raised to a negative exponent, and for an
 * exponent that is not a safe integer.
 *
 * **Example** (Compounding a ratio)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * // Twelve pure fifths overshoot seven octaves by the Pythagorean comma.
 * Rational.powUnsafe(Rational.makeUnsafe(3n, 2n), 12) // => Rational.makeUnsafe(531441n, 4096n)
 * ```
 *
 * @see {@link pow} for returning `Option.none` when zero is raised to a negative exponent
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const powUnsafe: {
  (exponent: number): (self: Rational) => Rational
  (self: Rational, exponent: number): Rational
} = dual(2, (self: Rational, exponent: number): Rational => Option.getOrThrowWith(pow(self, exponent), divisionByZero))

// A root of magnitude at most one is exact only when it equals `n`, which avoids raising it to a huge degree.
const exactRoot = (n: bigint, degree: number): Option.Option<bigint> =>
  Option.filter(BI.nthRoot(n, degree), (r) => (BI.abs(r) <= bigint1 ? r : r ** BigInt(degree)) === n)

/**
 * Takes the exact n-th root of a rational, returning `Option.none()` when the
 * root is not rational.
 *
 * **Details**
 *
 * A rational in lowest terms is the n-th power of a rational exactly when its
 * numerator and denominator are n-th powers of integers. An odd degree also
 * takes the root of a negative rational. Returns `Option.none()` when the
 * degree is even and the rational negative, or when the root is irrational.
 *
 * **Gotchas**
 *
 * The degree must be a positive safe integer. Anything else, including `0`,
 * `0.5`, `NaN` and `Infinity`, throws a `RangeError` instead of being rounded.
 *
 * **Example** (Taking exact roots)
 *
 * ```ts import.meta.vitest
 * import { Option, Rational } from "effect"
 *
 * Rational.nthRoot(Rational.makeUnsafe(8n, 27n), 3) // => Option.some(Rational.makeUnsafe(2n, 3n))
 * Rational.nthRoot(Rational.makeUnsafe(-8n, 27n), 3) // => Option.some(Rational.makeUnsafe(-2n, 3n))
 * Rational.nthRoot(Rational.fromBigInt(2n), 2) // => Option.none()
 * ```
 *
 * @see {@link nthRootUnsafe} for throwing when the root is not rational
 * @see {@link pow} for integer powers
 *
 * @stability unstable
 * @category math
 * @since 4.1.5
 */
export const nthRoot: {
  (degree: number): (self: Rational) => Option.Option<Rational>
  (self: Rational, degree: number): Option.Option<Rational>
} = dual(
  2,
  (self: Rational, degree: number): Option.Option<Rational> =>
    Option.flatMap(exactRoot(self.numerator, degree), (numerator) =>
      // Roots of coprime integers stay coprime, and the denominator stays positive.
      Option.map(exactRoot(self.denominator, degree), (denominator) => canonical(numerator, denominator)))
)

/**
 * Takes the exact n-th root of a rational.
 *
 * **Gotchas**
 *
 * Throws a `RangeError` when the root is not rational, or when the degree is
 * not a positive safe integer.
 *
 * **Example** (Undoing a compounded ratio)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.nthRootUnsafe(Rational.makeUnsafe(531441n, 4096n), 12) // => Rational.makeUnsafe(3n, 2n)
 * ```
 *
 * @see {@link nthRoot} for returning `Option.none` when the root is not rational
 * @see {@link powUnsafe} for integer powers
 *
 * @stability unstable
 * @category math
 * @since 4.1.5
 */
export const nthRootUnsafe: {
  (degree: number): (self: Rational) => Rational
  (self: Rational, degree: number): Rational
} = dual(
  2,
  (self: Rational, degree: number): Rational =>
    Option.getOrThrowWith(
      nthRoot(self, degree),
      () => new RangeError(`Cannot take a rational root of degree ${degree} of ${format(self)}`)
    )
)

/**
 * Negates a rational.
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const negate = (n: Rational): Rational => canonical(-n.numerator, n.denominator)

/**
 * Returns the absolute value of a rational.
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const abs = (n: Rational): Rational => n.numerator < bigint0 ? negate(n) : n

/**
 * Returns the sign of a rational as an `Ordering`.
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const sign = (n: Rational): Ordering => n.numerator === bigint0 ? 0 : n.numerator < bigint0 ? -1 : 1

const compare = (self: Rational, that: Rational): Ordering => {
  // Denominators are positive, so cross-multiplying preserves the ordering.
  const left = self.numerator * that.denominator
  const right = that.numerator * self.denominator
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * An `Order` instance comparing rationals by exact value.
 *
 * **Example** (Comparing rationals)
 *
 * ```ts import.meta.vitest
 * import { BigDecimal, Rational } from "effect"
 *
 * const third = Rational.makeUnsafe(1n, 3n)
 * const nearlyThird = Rational.fromBigDecimal(BigDecimal.fromStringUnsafe("0.3333333333"))
 *
 * Rational.Order(third, nearlyThird) // => 1
 * ```
 *
 * @stability unstable
 * @category instances
 * @since 4.1.3
 */
export const Order: order.Order<Rational> = order.make(compare)

/**
 * An `Equivalence` instance for rationals. Canonical form makes this a field
 * comparison.
 *
 * @stability unstable
 * @category instances
 * @since 4.1.3
 */
export const Equivalence: Equ.Equivalence<Rational> = Equ.make((self, that) =>
  self.numerator === that.numerator && self.denominator === that.denominator
)

/**
 * Checks whether two rationals are equal.
 *
 * @see {@link Equivalence} for passing rational equality to APIs that require an `Equivalence`
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const equals: {
  (that: Rational): (self: Rational) => boolean
  (self: Rational, that: Rational): boolean
} = dual(2, (self: Rational, that: Rational): boolean => Equivalence(self, that))

/**
 * Returns `true` if the first argument is less than the second.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const isLessThan: {
  (that: Rational): (self: Rational) => boolean
  (self: Rational, that: Rational): boolean
} = order.isLessThan(Order)

/**
 * Returns `true` if the first argument is less than or equal to the second.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const isLessThanOrEqualTo: {
  (that: Rational): (self: Rational) => boolean
  (self: Rational, that: Rational): boolean
} = order.isLessThanOrEqualTo(Order)

/**
 * Returns `true` if the first argument is greater than the second.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const isGreaterThan: {
  (that: Rational): (self: Rational) => boolean
  (self: Rational, that: Rational): boolean
} = order.isGreaterThan(Order)

/**
 * Returns `true` if the first argument is greater than or equal to the second.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const isGreaterThanOrEqualTo: {
  (that: Rational): (self: Rational) => boolean
  (self: Rational, that: Rational): boolean
} = order.isGreaterThanOrEqualTo(Order)

/**
 * Checks whether a rational lies within an inclusive range.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const between: {
  (options: {
    minimum: Rational
    maximum: Rational
  }): (self: Rational) => boolean
  (self: Rational, options: {
    minimum: Rational
    maximum: Rational
  }): boolean
} = order.isBetween(Order)

/**
 * Restricts a rational to an inclusive range.
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const clamp: {
  (options: {
    minimum: Rational
    maximum: Rational
  }): (self: Rational) => Rational
  (self: Rational, options: {
    minimum: Rational
    maximum: Rational
  }): Rational
} = order.clamp(Order)

/**
 * Returns the smaller of two rationals.
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const min: {
  (that: Rational): (self: Rational) => Rational
  (self: Rational, that: Rational): Rational
} = order.min(Order)

/**
 * Returns the larger of two rationals.
 *
 * @stability unstable
 * @category math
 * @since 4.1.3
 */
export const max: {
  (that: Rational): (self: Rational) => Rational
  (self: Rational, that: Rational): Rational
} = order.max(Order)

/**
 * Checks whether a rational is zero.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const isZero = (n: Rational): boolean => n.numerator === bigint0

/**
 * Checks whether a rational is strictly negative.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const isNegative = (n: Rational): boolean => n.numerator < bigint0

/**
 * Checks whether a rational is strictly positive.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const isPositive = (n: Rational): boolean => n.numerator > bigint0

/**
 * Checks whether a rational is an integer, that is, whether its denominator is
 * one.
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.3
 */
export const isInteger = (n: Rational): boolean => n.denominator === bigint1

/**
 * Formats a rational as `numerator/denominator`.
 *
 * **Details**
 *
 * The output is always a fraction in lowest terms, so integers render as
 * `3/1` and zero as `0/1`. It is the inverse of {@link fromString}.
 *
 * **Example** (Formatting rationals)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.format(Rational.makeUnsafe(12n, 10n)) // => "6/5"
 * Rational.format(Rational.fromBigInt(0n)) // => "0/1"
 * ```
 *
 * @stability unstable
 * @category converting
 * @since 4.1.3
 */
export const format = (n: Rational): string => `${n.numerator}/${n.denominator}`

const bitLength = (n: bigint): number => n.toString(2).length

/**
 * Converts a rational to the nearest JavaScript `number`.
 *
 * **Details**
 *
 * The ratio is rounded as a whole, so a numerator and denominator that each
 * exceed `Number.MAX_VALUE` still produce a finite result when their quotient
 * is finite. Every finite double round-trips through {@link fromNumber}.
 *
 * **Gotchas**
 *
 * This conversion is unsafe because most rationals are not representable as
 * doubles: the result is rounded, and very large magnitudes become
 * `Infinity`.
 *
 * **Example** (Converting rationals to numbers)
 *
 * ```ts import.meta.vitest
 * import { Rational } from "effect"
 *
 * Rational.toNumberUnsafe(Rational.makeUnsafe(1n, 3n)) // => 1 / 3
 * ```
 *
 * @see {@link toBigDecimal} for a conversion with an explicit scale
 *
 * @stability unstable
 * @category converting
 * @since 4.1.3
 */
export const toNumberUnsafe = (n: Rational): number => {
  if (n.numerator === bigint0) {
    return 0
  }
  const negative = n.numerator < bigint0
  let numerator = negative ? -n.numerator : n.numerator
  let denominator = n.denominator
  // Shift so the integer quotient carries more bits than a double mantissa.
  const shift = QUOTIENT_BITS + bitLength(denominator) - bitLength(numerator)
  if (shift > 0) {
    numerator <<= BigInt(shift)
  } else if (shift < 0) {
    denominator <<= BigInt(-shift)
  }
  let quotient = numerator / denominator
  if (quotient * denominator !== numerator) {
    // A sticky bit keeps a truncated remainder from being mistaken for a tie.
    quotient |= bigint1
  }
  // Round once, at the destination precision: 53 bits for normal results, or
  // units of Number.MIN_VALUE for subnormal ones. The quotient has at least 64
  // bits, so at least 11 are dropped.
  const exponent = Math.max(bitLength(quotient) - shift - MANTISSA_BITS, MIN_SUBNORMAL_EXPONENT)
  const drop = BigInt(exponent + shift)
  let rounded = quotient >> drop
  const remainder = quotient & ((bigint1 << drop) - bigint1)
  const half = bigint1 << (drop - bigint1)
  if (remainder > half || (remainder === half && (rounded & bigint1) === bigint1)) {
    rounded += bigint1
  }
  // `rounded` is at most 2^53 and `exponent` is at least -1074, so both the
  // conversion and the power-of-two scaling are exact; overflow gives Infinity.
  const magnitude = Number(rounded) * 2 ** exponent
  return negative ? -magnitude : magnitude
}

/**
 * Converts a rational to a `BigDecimal` rounded at the given scale.
 *
 * **Details**
 *
 * `scale` is the number of decimal places to keep; a negative scale rounds to
 * tens, hundreds and so on. `mode` defaults to `"half-from-zero"`, matching
 * `BigDecimal.round`.
 *
 * **Gotchas**
 *
 * Throws a `RangeError` if `scale` is not a safe integer.
 *
 * **Example** (Rounding rationals to decimals)
 *
 * ```ts import.meta.vitest
 * import { BigDecimal, Rational } from "effect"
 *
 * const twoThirds = Rational.makeUnsafe(2n, 3n)
 *
 * Rational.toBigDecimal(twoThirds, { scale: 3 }) // => BigDecimal.fromStringUnsafe("0.667")
 * Rational.toBigDecimal(twoThirds, { scale: 3, mode: "floor" }) // => BigDecimal.fromStringUnsafe("0.666")
 * ```
 *
 * @see {@link fromBigDecimal} for the exact conversion back
 *
 * @stability unstable
 * @category converting
 * @since 4.1.3
 */
export const toBigDecimal: {
  (
    options: { readonly scale: number; readonly mode?: BigDecimal.RoundingMode }
  ): (self: Rational) => BigDecimal.BigDecimal
  (self: Rational, options: { readonly scale: number; readonly mode?: BigDecimal.RoundingMode }): BigDecimal.BigDecimal
} = dual(
  2,
  (
    self: Rational,
    options: { readonly scale: number; readonly mode?: BigDecimal.RoundingMode }
  ): BigDecimal.BigDecimal => {
    const scale = options.scale
    if (!Number.isSafeInteger(scale)) {
      throw new RangeError(`Scale must be a safe integer, got ${scale}`)
    }
    let numerator = self.numerator
    let denominator = self.denominator
    if (scale >= 0) {
      numerator *= bigint10 ** BigInt(scale)
    } else {
      denominator *= bigint10 ** BigInt(-scale)
    }
    const quotient = numerator / denominator
    const remainder = numerator - quotient * denominator
    return BigDecimal.make(quotient + roundingAdjustment(quotient, remainder, denominator, options.mode), scale)
  }
)

// `remainder` carries the sign of the value; returns the unit to add to the truncated quotient.
const roundingAdjustment = (
  quotient: bigint,
  remainder: bigint,
  denominator: bigint,
  mode: BigDecimal.RoundingMode = "half-from-zero"
): bigint => {
  if (remainder === bigint0) {
    return bigint0
  }
  const negative = remainder < bigint0
  const awayFromZero = negative ? -bigint1 : bigint1
  switch (mode) {
    case "to-zero":
      return bigint0
    case "from-zero":
      return awayFromZero
    case "ceil":
      return negative ? bigint0 : bigint1
    case "floor":
      return negative ? -bigint1 : bigint0
  }
  const twiceRemainder = (negative ? -remainder : remainder) * bigint2
  if (twiceRemainder < denominator) {
    return bigint0
  }
  if (twiceRemainder > denominator) {
    return awayFromZero
  }
  switch (mode) {
    case "half-ceil":
      return negative ? bigint0 : bigint1
    case "half-floor":
      return negative ? -bigint1 : bigint0
    case "half-to-zero":
      return bigint0
    case "half-from-zero":
      return awayFromZero
    case "half-even":
      return quotient % bigint2 === bigint0 ? bigint0 : awayFromZero
    case "half-odd":
      return quotient % bigint2 === bigint0 ? awayFromZero : bigint0
  }
}
