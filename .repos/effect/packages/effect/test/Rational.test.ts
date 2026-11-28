import { describe, it } from "@effect/vitest"
import {
  assertEquals,
  assertFalse,
  assertNone,
  assertSome,
  assertTrue,
  deepStrictEqual,
  strictEqual,
  throws
} from "@effect/vitest/utils"
import { BigDecimal, Equal, Hash, Option, Rational } from "effect"
import * as fc from "fast-check"
import { inspect } from "node:util"

const $ = Rational.fromStringUnsafe
const third = $("1/3")
const one = Rational.fromBigInt(1n)
const zero = Rational.fromBigInt(0n)

const assertRational = (actual: Rational.Rational, numerator: bigint, denominator: bigint) => {
  strictEqual(actual.numerator, numerator)
  strictEqual(actual.denominator, denominator)
}

describe("Rational", () => {
  it("make normalizes to a canonical form and rejects a zero denominator", () => {
    assertRational(Rational.makeUnsafe(6n, -4n), -3n, 2n)
    assertRational(Rational.makeUnsafe(0n, -7n), 0n, 1n)
    assertRational(Rational.makeUnsafe(-10n, -5n), 2n, 1n)
    assertSome(Rational.make(2n, 6n), third)
    assertNone(Rational.make(1n, 0n))
    throws(() => Rational.makeUnsafe(1n, 0n), new RangeError("Denominator must be non-zero"))

    assertTrue(Rational.isRational(third))
    assertFalse(Rational.isRational(BigDecimal.fromBigInt(1n)))
    assertFalse(Rational.isRational("1/3"))
  })

  it("arithmetic is exact, so a third times three is exactly one", () => {
    assertEquals(Rational.multiply(third, Rational.fromBigInt(3n)), one)
    assertTrue(Rational.equals(Rational.sumAll([third, third, third]), one))
    assertEquals(Rational.sum(third, $("1/6")), $("1/2"))
    assertEquals(Rational.subtract(one, third), $("2/3"))
    assertEquals(Rational.multiplyAll([$("3/2"), $("4/3"), $("-1/2")]), $("-1/1"))
    assertEquals(Rational.sumAll([]), zero)
    assertEquals(Rational.multiplyAll([]), one)
    assertEquals(Rational.negate(third), $("-1/3"))
    assertEquals(Rational.abs($("-1/3")), third)
    strictEqual(Rational.sign($("-1/3")), -1)
    strictEqual(Rational.sign(zero), 0)

    assertSome(Rational.divide(third, Rational.fromBigInt(3n)), $("1/9"))
    assertEquals(Rational.divideUnsafe($("-2/3"), $("4/9")), $("-3/2"))
    assertNone(Rational.divide(third, zero))
    throws(() => Rational.divideUnsafe(third, zero), new RangeError("Division by zero"))
  })

  it("arithmetic preserves canonical fractions with shared factors, signs and zero", () => {
    assertRational(Rational.sum($("1/6"), $("1/10")), 4n, 15n)
    assertRational(Rational.subtract($("1/6"), $("1/10")), 1n, 15n)
    assertRational(Rational.sum(third, $("-1/3")), 0n, 1n)
    assertRational(Rational.subtract(third, third), 0n, 1n)
    assertRational(Rational.multiply($("6/35"), $("14/15")), 4n, 25n)
    assertRational(Rational.divideUnsafe($("6/35"), $("-15/14")), -4n, 25n)
    assertRational(Rational.multiply(zero, third), 0n, 1n)
    assertRational(Rational.divideUnsafe(zero, $("-2/3")), 0n, 1n)
  })

  it("pow takes integer exponents, inverting for negative ones", () => {
    // Twelve pure fifths overshoot seven octaves by the Pythagorean comma.
    const twelveFifths = Rational.powUnsafe($("3/2"), 12)
    assertRational(twelveFifths, 531441n, 4096n)
    assertTrue(Rational.isGreaterThan(twelveFifths, Rational.pow(Rational.fromBigInt(2n), 7).pipe(Option.getOrThrow)))

    assertSome(Rational.pow(third, -1), Rational.fromBigInt(3n))
    assertSome(Rational.pow($("-2/3"), -3), $("-27/8"))
    assertSome(Rational.pow(zero, 0), one)
    assertNone(Rational.pow(zero, -1))
    throws(() => Rational.powUnsafe(zero, -1), new RangeError("Division by zero"))
    for (const exponent of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      throws(() => Rational.pow(third, exponent), new RangeError(`Exponent must be a safe integer, got ${exponent}`))
    }
  })

  it("nthRoot is exact, and none when the root is not rational", () => {
    assertSome(Rational.nthRoot($("8/27"), 3), $("2/3"))
    assertSome(Rational.nthRoot(3)($("-8/27")), $("-2/3"))
    assertRational(Rational.nthRootUnsafe(3)($("-8/27")), -2n, 3n)
    assertNone(Rational.nthRoot($("2"), 2))
    assertNone(Rational.nthRoot($("1/2"), 2))
    assertSome(Rational.nthRoot(zero, Number.MAX_SAFE_INTEGER), zero)
    assertSome(Rational.nthRoot(one, Number.MAX_SAFE_INTEGER), one)
    assertSome(Rational.nthRoot($("-1"), Number.MAX_SAFE_INTEGER), $("-1"))
    assertNone(Rational.nthRoot($("2"), Number.MAX_SAFE_INTEGER))
    assertNone(Rational.nthRoot($("1/2"), Number.MAX_SAFE_INTEGER))
    throws(() => Rational.nthRootUnsafe($("2"), 2), new RangeError("Cannot take a rational root of degree 2 of 2/1"))
  })

  it("nthRoot and nthRootUnsafe require a positive safe integer degree", () => {
    for (const degree of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const root of [Rational.nthRoot, Rational.nthRootUnsafe]) {
        throws(() => root(zero, degree), new RangeError(`Degree must be a positive safe integer, got ${degree}`))
      }
    }
  })

  it("Order, Equivalence, Equal and Hash compare exact values", () => {
    const nearlyThird = Rational.fromBigDecimal(BigDecimal.fromStringUnsafe("0.333333333333333333333333"))
    strictEqual(Rational.Order(third, nearlyThird), 1)
    strictEqual(Rational.Order(nearlyThird, third), -1)
    strictEqual(Rational.Order($("-1/2"), $("-1/3")), -1)
    strictEqual(Rational.Order(Rational.makeUnsafe(2n, 6n), third), 0)
    assertTrue(Rational.Equivalence(Rational.makeUnsafe(-2n, -6n), third))
    assertFalse(Rational.Equivalence(third, nearlyThird))

    assertTrue(Equal.equals(Rational.makeUnsafe(2n, 6n), third))
    assertFalse(Equal.equals(third, nearlyThird))
    assertFalse(Equal.equals(third, "1/3"))
    strictEqual(Hash.hash(Rational.makeUnsafe(2n, 6n)), Hash.hash(third))

    assertTrue(Rational.isLessThan(nearlyThird, third))
    assertTrue(Rational.isLessThanOrEqualTo(third, third))
    assertFalse(Rational.isGreaterThan(third, third))
    assertTrue(Rational.isGreaterThanOrEqualTo(third, nearlyThird))
    assertTrue(Rational.between(third, { minimum: zero, maximum: one }))
    assertEquals(Rational.clamp($("5/2"), { minimum: zero, maximum: one }), one)
    assertEquals(Rational.min(third, nearlyThird), nearlyThird)
    assertEquals(Rational.max(third, nearlyThird), third)
    assertTrue(Rational.isInteger(Rational.makeUnsafe(4n, 2n)))
    assertFalse(Rational.isInteger(third))
    assertTrue(Rational.isZero(Rational.makeUnsafe(0n, 5n)))
    assertTrue(Rational.isNegative($("-1/3")))
    assertTrue(Rational.isPositive(third))
  })

  it("fromBigDecimal is exact for any scale", () => {
    assertRational(Rational.fromBigDecimal(BigDecimal.fromStringUnsafe("0.1")), 1n, 10n)
    assertRational(Rational.fromBigDecimal(BigDecimal.fromStringUnsafe("-12.50")), -25n, 2n)
    assertRational(Rational.fromBigDecimal(BigDecimal.make(15n, -2)), 1500n, 1n)
    assertRational(Rational.fromBigDecimal(BigDecimal.make(0n, 7)), 0n, 1n)
  })

  it("fromNumber encodes the exact IEEE-754 value and rejects non-finite input", () => {
    assertSome(Rational.fromNumber(0.5), $("1/2"))
    assertSome(Rational.fromNumber(-0.75), $("-3/4"))
    // 0.1 is not one tenth: the double nearest to it is 3602879701896397 / 2^55.
    assertSome(Rational.fromNumber(0.1), Rational.makeUnsafe(3602879701896397n, 1n << 55n))
    assertSome(Rational.fromNumber(1e21), Rational.fromBigInt(10n ** 21n))
    assertSome(Rational.fromNumber(Number.MIN_VALUE), Rational.makeUnsafe(1n, 1n << 1074n))
    assertRational(Rational.fromNumberUnsafe(-0), 0n, 1n)
    for (const n of [NaN, Infinity, -Infinity]) {
      assertNone(Rational.fromNumber(n))
      throws(() => Rational.fromNumberUnsafe(n), new RangeError(`Number must be finite, got ${n}`))
    }
  })

  it("toNumberUnsafe rounds the ratio rather than its parts", () => {
    strictEqual(Rational.toNumberUnsafe(third), 1 / 3)
    strictEqual(Rational.toNumberUnsafe($("-2/3")), -2 / 3)
    strictEqual(Rational.toNumberUnsafe(zero), 0)
    // Numerator and denominator are each far beyond Number.MAX_VALUE, the ratio is not.
    strictEqual(Rational.toNumberUnsafe(Rational.makeUnsafe(10n ** 400n + 1n, 3n * 10n ** 400n)), 1 / 3)
    strictEqual(Rational.toNumberUnsafe(Rational.fromBigInt(10n ** 400n)), Infinity)
    strictEqual(Rational.toNumberUnsafe(Rational.makeUnsafe(-1n, 10n ** 400n)), -0)
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (n) => {
        return Rational.toNumberUnsafe(Rational.fromNumberUnsafe(n)) === n
      })
    )
  })

  it("toNumberUnsafe rounds subnormal results once, to nearest with ties to even", () => {
    const minValue = Rational.makeUnsafe(1n, 1n << 1074n)
    // Just above half of Number.MIN_VALUE rounds up to it rather than to zero.
    strictEqual(Rational.toNumberUnsafe(Rational.makeUnsafe(1n, (1n << 1075n) - 1n)), Number.MIN_VALUE)
    strictEqual(Rational.toNumberUnsafe(Rational.makeUnsafe(-1n, (1n << 1075n) - 1n)), -Number.MIN_VALUE)
    // Exactly half of Number.MIN_VALUE is a tie, and zero is the even neighbour.
    strictEqual(Rational.toNumberUnsafe(Rational.makeUnsafe(1n, 1n << 1075n)), 0)
    // 1.5 * Number.MIN_VALUE is a tie between one and two units; two is even.
    strictEqual(Rational.toNumberUnsafe(Rational.makeUnsafe(3n, 1n << 1075n)), 2 * Number.MIN_VALUE)
    // Just below 1.5 * Number.MIN_VALUE rounds down to one unit.
    strictEqual(Rational.toNumberUnsafe(Rational.makeUnsafe(3n * (1n << 60n) - 1n, 1n << 1135n)), Number.MIN_VALUE)
    strictEqual(Rational.toNumberUnsafe(minValue), Number.MIN_VALUE)
  })

  it("toBigDecimal rounds at the supplied scale", () => {
    const decimal = BigDecimal.fromStringUnsafe
    assertEquals(Rational.toBigDecimal(third, { scale: 3 }), decimal("0.333"))
    assertEquals(Rational.toBigDecimal($("2/3"), { scale: 3 }), decimal("0.667"))
    assertEquals(Rational.toBigDecimal($("-1/8"), { scale: 2 }), decimal("-0.13"))
    assertEquals(Rational.toBigDecimal($("-1/8"), { scale: 2, mode: "half-even" }), decimal("-0.12"))
    assertEquals(Rational.toBigDecimal($("-1/8"), { scale: 2, mode: "ceil" }), decimal("-0.12"))
    assertEquals(Rational.toBigDecimal($("1/4"), { scale: 2 }), decimal("0.25"))
    assertEquals(Rational.toBigDecimal(Rational.fromBigInt(1250n), { scale: -2 }), decimal("1300"))
    assertEquals(third.pipe(Rational.toBigDecimal({ scale: 1 })), decimal("0.3"))
    throws(() => Rational.toBigDecimal(third, { scale: 0.5 }), new RangeError("Scale must be a safe integer, got 0.5"))
  })

  it("format and fromString are inverses over canonical fraction strings", () => {
    strictEqual(Rational.format($("6/5")), "6/5")
    strictEqual(Rational.format(zero), "0/1")
    strictEqual(Rational.format(Rational.fromBigInt(-3n)), "-3/1")

    assertSome(Rational.fromString("-4/-6"), $("2/3"))
    assertSome(Rational.fromString("3"), Rational.fromBigInt(3n))
    assertSome(Rational.fromString("+1/3"), third)
    for (const s of ["", " 1/2", "1/0", "1.5", "1/", "/2", "1/2/3", "1e3", "a/b"]) {
      assertNone(Rational.fromString(s))
    }
    throws(() => Rational.fromStringUnsafe("1/0"), new Error("Invalid rational string: 1/0"))

    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt().filter((d) => d !== 0n), (numerator, denominator) => {
        const rational = Rational.makeUnsafe(numerator, denominator)
        return Equal.equals(Rational.fromStringUnsafe(Rational.format(rational)), rational)
      })
    )
  })

  it("toString, toJSON, inspect and pipe", () => {
    strictEqual(String(third), "Rational(1/3)")
    deepStrictEqual(third.toJSON(), { _id: "Rational", numerator: "1", denominator: "3" })
    strictEqual(inspect(third), inspect(third.toJSON()))
    assertEquals(third.pipe(Rational.multiply(Rational.fromBigInt(3n))), one)
  })
})
