import { describe, it } from "@effect/vitest"
import {
  assertEquals,
  assertFalse,
  assertNone,
  assertTrue,
  deepStrictEqual,
  strictEqual,
  throws
} from "@effect/vitest/utils"
import { BigDecimal, Equal, Option } from "effect"
import { FastCheck as fc } from "effect/testing"

const $ = BigDecimal.fromStringUnsafe

const assertSomeBigDecimal = (option: Option.Option<BigDecimal.BigDecimal>, expected: BigDecimal.BigDecimal) => {
  if (Option.isNone(option)) {
    throw new Error("Expected Option.some")
  }
  assertEquals(option.value, expected)
}

const assertDivide = (x: string, y: string, z: string) => {
  assertSomeBigDecimal(BigDecimal.divide($(x), $(y)), $(z))
  assertEquals(BigDecimal.divideUnsafe($(x), $(y)), $(z))
}

describe("BigDecimal", () => {
  it("isBigDecimal", () => {
    assertTrue(BigDecimal.isBigDecimal($("0")))
    assertTrue(BigDecimal.isBigDecimal($("987")))
    assertTrue(BigDecimal.isBigDecimal($("123.0")))
    assertTrue(BigDecimal.isBigDecimal($("0.123")))
    assertTrue(BigDecimal.isBigDecimal($("123.456")))
    assertFalse(BigDecimal.isBigDecimal("1"))
    assertFalse(BigDecimal.isBigDecimal(true))
  })

  it("sign", () => {
    strictEqual(BigDecimal.sign($("-5")), -1)
    strictEqual(BigDecimal.sign($("0")), 0)
    strictEqual(BigDecimal.sign($("5")), 1)
    strictEqual(BigDecimal.sign($("-123.456")), -1)
    strictEqual(BigDecimal.sign($("456.789")), 1)
  })

  it("equals", () => {
    assertTrue(BigDecimal.equals($("1"), $("1")))
    assertTrue(BigDecimal.equals($("0.00012300"), $("0.000123")))
    assertTrue(BigDecimal.equals($("5"), $("5.0")))
    assertTrue(BigDecimal.equals($("123.0000"), $("123.00")))
    assertFalse(BigDecimal.equals($("1"), $("2")))
    assertFalse(BigDecimal.equals($("1"), $("1.1")))
    assertFalse(BigDecimal.equals($("1"), $("0.1")))
  })

  it("sum", () => {
    assertEquals(BigDecimal.sum($("2"), $("0")), $("2"))
    assertEquals(BigDecimal.sum($("0"), $("2")), $("2"))
    assertEquals(BigDecimal.sum($("0"), $("0")), $("0"))
    assertEquals(BigDecimal.sum($("2"), $("1")), $("3"))
    assertEquals(BigDecimal.sum($("3.00000"), $("50")), $("53"))
    assertEquals(BigDecimal.sum($("1.23"), $("0.0045678")), $("1.2345678"))
    assertEquals(BigDecimal.sum($("123.456"), $("-123.456")), $("0"))
  })

  it("sumAll", () => {
    assertEquals(BigDecimal.sumAll([]), $("0"))
    assertEquals(BigDecimal.sumAll([$("2"), $("3"), $("4")]), $("9"))
    assertEquals(BigDecimal.sumAll([$("1.5"), $("-1.5")]), $("0"))
  })

  it("multiply", () => {
    assertEquals(BigDecimal.multiply($("3"), $("2")), $("6"))
    assertEquals(BigDecimal.multiply($("3"), $("0")), $("0"))
    assertEquals(BigDecimal.multiply($("3"), $("-1")), $("-3"))
    assertEquals(BigDecimal.multiply($("3"), $("0.5")), $("1.5"))
    assertEquals(BigDecimal.multiply($("3"), $("-2.5")), $("-7.5"))
  })

  it("multiplyAll", () => {
    assertEquals(BigDecimal.multiplyAll([]), $("1"))
    assertEquals(BigDecimal.multiplyAll([$("2"), $("3"), $("4")]), $("24"))
    assertEquals(BigDecimal.multiplyAll([$("2"), $("0"), $("4")]), $("0"))
  })

  it("subtract", () => {
    assertEquals(BigDecimal.subtract($("0"), $("1")), $("-1"))
    assertEquals(BigDecimal.subtract($("2.1"), $("1")), $("1.1"))
    assertEquals(BigDecimal.subtract($("3"), $("1")), $("2"))
    assertEquals(BigDecimal.subtract($("3"), $("0")), $("3"))
    assertEquals(BigDecimal.subtract($("3"), $("-1")), $("4"))
    assertEquals(BigDecimal.subtract($("3"), $("0.5")), $("2.5"))
    assertEquals(BigDecimal.subtract($("3"), $("-2.5")), $("5.5"))
  })

  it("roundTerminal", () => {
    strictEqual(BigDecimal.roundTerminal(0n), 0n)
    strictEqual(BigDecimal.roundTerminal(4n), 0n)
    strictEqual(BigDecimal.roundTerminal(5n), 1n)
    strictEqual(BigDecimal.roundTerminal(9n), 1n)
    strictEqual(BigDecimal.roundTerminal(49n), 0n)
    strictEqual(BigDecimal.roundTerminal(59n), 1n)
    strictEqual(BigDecimal.roundTerminal(99n), 1n)
    strictEqual(BigDecimal.roundTerminal(-4n), 0n)
    strictEqual(BigDecimal.roundTerminal(-5n), 1n)
    strictEqual(BigDecimal.roundTerminal(-9n), 1n)
    strictEqual(BigDecimal.roundTerminal(-49n), 0n)
    strictEqual(BigDecimal.roundTerminal(-59n), 1n)
    strictEqual(BigDecimal.roundTerminal(-99n), 1n)
  })

  it("divide", () => {
    assertDivide("0", "1", "0")
    assertDivide("0", "10", "0")
    assertDivide("2", "1", "2")
    assertDivide("20", "1", "20")
    assertDivide("10", "10", "1")
    assertDivide("100", "10.0", "10")
    assertDivide("20.0", "200", "0.1")
    assertDivide("4", "2", "2.0")
    assertDivide("15", "3", "5.0")
    assertDivide("1", "2", "0.5")
    assertDivide("1", "0.02", "50")
    assertDivide("1", "0.2", "5")
    assertDivide("1.0", "0.02", "50")
    assertDivide("1", "0.020", "50")
    assertDivide("5.0", "4.00", "1.25")
    assertDivide("5.0", "4.000", "1.25")
    assertDivide("5", "4.000", "1.25")
    assertDivide("5", "4", "1.25")
    assertDivide("100", "5", "20")
    assertDivide("-50", "5", "-10")
    assertDivide("200", "-5", "-40.0")
    assertDivide(
      "1",
      "3",
      "0.3333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333"
    )
    assertDivide(
      "-2",
      "-3",
      "0.6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666667"
    )
    assertDivide(
      "-12.34",
      "1.233",
      "-10.00811030008110300081103000811030008110300081103000811030008110300081103000811030008110300081103001"
    )
    assertDivide(
      "125348",
      "352.2283",
      "355.8714617763535752237966114591019517738921035021887792661748076460636467881768727839301952739175132"
    )

    assertNone(BigDecimal.divide($("5"), $("0")))
    throws(() => BigDecimal.divideUnsafe($("5"), $("0")), new RangeError("Division by zero"))
  })

  it("Equivalence", () => {
    assertTrue(BigDecimal.Equivalence($("1"), $("1")))
    assertTrue(BigDecimal.Equivalence($("0.00012300"), $("0.000123")))
    assertTrue(BigDecimal.Equivalence($("5"), $("5.00")))
    assertFalse(BigDecimal.Equivalence($("1"), $("2")))
    assertFalse(BigDecimal.Equivalence($("1"), $("1.1")))
  })

  it("Order", () => {
    strictEqual(BigDecimal.Order($("1"), $("2")), -1)
    strictEqual(BigDecimal.Order($("2"), $("1")), 1)
    strictEqual(BigDecimal.Order($("2"), $("2")), 0)
    strictEqual(BigDecimal.Order($("1"), $("1.1")), -1)
    strictEqual(BigDecimal.Order($("1.1"), $("1")), 1)
    strictEqual(BigDecimal.Order($("0.00012300"), $("0.000123")), 0)
    strictEqual(BigDecimal.Order($("5"), $("5.000")), 0)
    strictEqual(BigDecimal.Order($("5"), $("0.500")), 1)
    strictEqual(BigDecimal.Order($("5"), $("50.00")), -1)
  })

  it("isLessThan", () => {
    assertTrue(BigDecimal.isLessThan($("2"), $("3")))
    assertFalse(BigDecimal.isLessThan($("3"), $("3")))
    assertFalse(BigDecimal.isLessThan($("4"), $("3")))
  })

  it("isLessThanOrEqualTo", () => {
    assertTrue(BigDecimal.isLessThanOrEqualTo($("2"), $("3")))
    assertTrue(BigDecimal.isLessThanOrEqualTo($("3"), $("3")))
    assertFalse(BigDecimal.isLessThanOrEqualTo($("4"), $("3")))
  })

  it("isGreaterThan", () => {
    assertFalse(BigDecimal.isGreaterThan($("2"), $("3")))
    assertFalse(BigDecimal.isGreaterThan($("3"), $("3")))
    assertTrue(BigDecimal.isGreaterThan($("4"), $("3")))
  })

  it("isGreaterThanOrEqualTo", () => {
    assertFalse(BigDecimal.isGreaterThanOrEqualTo($("2"), $("3")))
    assertTrue(BigDecimal.isGreaterThanOrEqualTo($("3"), $("3")))
    assertTrue(BigDecimal.isGreaterThanOrEqualTo($("4"), $("3")))
  })

  it("between", () => {
    assertTrue(BigDecimal.between({ minimum: $("0"), maximum: $("5") })($("3")))
    assertFalse(BigDecimal.between({ minimum: $("0"), maximum: $("5") })($("-1")))
    assertFalse(BigDecimal.between({ minimum: $("0"), maximum: $("5") })($("6")))
    assertFalse(BigDecimal.between({ minimum: $("0.02"), maximum: $("5") })($("0.0123")))
    assertTrue(BigDecimal.between({ minimum: $("0.02"), maximum: $("5") })($("0.05")))

    assertTrue(BigDecimal.between($("3"), { minimum: $("0"), maximum: $("5") }))
  })

  it("clamp", () => {
    assertEquals(BigDecimal.clamp({ minimum: $("0"), maximum: $("5") })($("3")), $("3"))
    assertEquals(BigDecimal.clamp({ minimum: $("0"), maximum: $("5") })($("-1")), $("0"))
    assertEquals(BigDecimal.clamp({ minimum: $("0"), maximum: $("5") })($("6")), $("5"))
    assertEquals(BigDecimal.clamp({ minimum: $("0.02"), maximum: $("5") })($("0.0123")), $("0.02"))

    assertEquals(BigDecimal.clamp($("3"), { minimum: $("0"), maximum: $("5") }), $("3"))
  })

  it("min", () => {
    assertEquals(BigDecimal.min($("2"), $("3")), $("2"))
    assertEquals(BigDecimal.min($("5"), $("0.1")), $("0.1"))
    assertEquals(BigDecimal.min($("0.005"), $("3")), $("0.005"))
    assertEquals(BigDecimal.min($("123.456"), $("1.2")), $("1.2"))
  })

  it("max", () => {
    assertEquals(BigDecimal.max($("2"), $("3")), $("3"))
    assertEquals(BigDecimal.max($("5"), $("0.1")), $("5"))
    assertEquals(BigDecimal.max($("0.005"), $("3")), $("3"))
    assertEquals(BigDecimal.max($("123.456"), $("1.2")), $("123.456"))
  })

  it("abs", () => {
    assertEquals(BigDecimal.abs($("2")), $("2"))
    assertEquals(BigDecimal.abs($("-3")), $("3"))
    assertEquals(BigDecimal.abs($("0.000456")), $("0.000456"))
    assertEquals(BigDecimal.abs($("-0.123")), $("0.123"))
  })

  it("negate", () => {
    assertEquals(BigDecimal.negate($("2")), $("-2"))
    assertEquals(BigDecimal.negate($("-3")), $("3"))
    assertEquals(BigDecimal.negate($("0.000456")), $("-0.000456"))
    assertEquals(BigDecimal.negate($("-0.123")), $("0.123"))
  })

  it("remainder", () => {
    assertSomeBigDecimal(BigDecimal.remainder($("5"), $("2")), $("1"))
    assertSomeBigDecimal(BigDecimal.remainder($("4"), $("2")), $("0"))
    assertSomeBigDecimal(BigDecimal.remainder($("123.456"), $("0.2")), $("0.056"))
    assertNone(BigDecimal.remainder($("5"), $("0")))
  })

  it("unsafeRemainder", () => {
    assertEquals(BigDecimal.remainderUnsafe($("5"), $("2")), $("1"))
    assertEquals(BigDecimal.remainderUnsafe($("4"), $("2")), $("0"))
    assertEquals(BigDecimal.remainderUnsafe($("123.456"), $("0.2")), $("0.056"))
    throws(() => BigDecimal.remainderUnsafe($("5"), $("0")), new RangeError("Division by zero"))
  })

  it("normalize", () => {
    deepStrictEqual(BigDecimal.normalize($("0")), BigDecimal.makeNormalizedUnsafe(0n, 0))
    deepStrictEqual(BigDecimal.normalize($("0.123000")), BigDecimal.makeNormalizedUnsafe(123n, 3))
    deepStrictEqual(BigDecimal.normalize($("123.000")), BigDecimal.makeNormalizedUnsafe(123n, 0))
    deepStrictEqual(BigDecimal.normalize($("-0.000123000")), BigDecimal.makeNormalizedUnsafe(-123n, 6))
    deepStrictEqual(BigDecimal.normalize($("-123.000")), BigDecimal.makeNormalizedUnsafe(-123n, 0))
    deepStrictEqual(BigDecimal.normalize($("12300000")), BigDecimal.makeNormalizedUnsafe(123n, -5))
  })

  it("fromString", () => {
    assertSomeBigDecimal(BigDecimal.fromString("2"), BigDecimal.make(2n, 0))
    assertSomeBigDecimal(BigDecimal.fromString("-2"), BigDecimal.make(-2n, 0))
    assertSomeBigDecimal(BigDecimal.fromString("0.123"), BigDecimal.make(123n, 3))
    assertSomeBigDecimal(BigDecimal.fromString("200"), BigDecimal.make(200n, 0))
    assertSomeBigDecimal(BigDecimal.fromString("20000000"), BigDecimal.make(20000000n, 0))
    assertSomeBigDecimal(BigDecimal.fromString("-20000000"), BigDecimal.make(-20000000n, 0))
    assertSomeBigDecimal(BigDecimal.fromString("2.00"), BigDecimal.make(200n, 2))
    assertSomeBigDecimal(BigDecimal.fromString("0.0000200"), BigDecimal.make(200n, 7))
    assertSomeBigDecimal(BigDecimal.fromString(""), BigDecimal.normalize(BigDecimal.make(0n, 0)))
    assertSomeBigDecimal(BigDecimal.fromString("1e5"), BigDecimal.make(1n, -5))
    assertSomeBigDecimal(BigDecimal.fromString("1E15"), BigDecimal.make(1n, -15))
    assertSomeBigDecimal(BigDecimal.fromString("1e+5"), BigDecimal.make(1n, -5))
    assertSomeBigDecimal(BigDecimal.fromString("1E+15"), BigDecimal.make(1n, -15))
    assertSomeBigDecimal(BigDecimal.fromString("-1.5E3"), BigDecimal.make(-15n, -2))
    assertSomeBigDecimal(BigDecimal.fromString("-1.5e3"), BigDecimal.make(-15n, -2))
    assertSomeBigDecimal(BigDecimal.fromString("-.5e3"), BigDecimal.make(-5n, -2))
    assertSomeBigDecimal(BigDecimal.fromString("-5e3"), BigDecimal.make(-5n, -3))
    assertSomeBigDecimal(BigDecimal.fromString("-5e-3"), BigDecimal.make(-5n, 3))
    assertSomeBigDecimal(BigDecimal.fromString("15e-3"), BigDecimal.make(15n, 3))
    assertSomeBigDecimal(BigDecimal.fromString("0.00002e5"), BigDecimal.make(2n, 0))
    assertSomeBigDecimal(BigDecimal.fromString("0.00002e-5"), BigDecimal.make(2n, 10))
    assertNone(BigDecimal.fromString("0.0000e2e1"))
    assertNone(BigDecimal.fromString("0.1.2"))
  })

  it("format", () => {
    strictEqual(BigDecimal.format($("2")), "2")
    strictEqual(BigDecimal.format($("-2")), "-2")
    strictEqual(BigDecimal.format($("0.123")), "0.123")
    strictEqual(BigDecimal.format($("200")), "200")
    strictEqual(BigDecimal.format($("20000000")), "20000000")
    strictEqual(BigDecimal.format($("-20000000")), "-20000000")
    strictEqual(BigDecimal.format($("2.00")), "2")
    strictEqual(BigDecimal.format($("0.200")), "0.2")
    strictEqual(BigDecimal.format($("0.123000")), "0.123")
    strictEqual(BigDecimal.format($("-456.123")), "-456.123")
    strictEqual(BigDecimal.format(BigDecimal.make(10n, -1)), "100")
    strictEqual(BigDecimal.format(BigDecimal.make(1n, -25)), "1e+25")
    strictEqual(BigDecimal.format(BigDecimal.make(12345n, -25)), "1.2345e+29")
    strictEqual(BigDecimal.format(BigDecimal.make(12345n, 25)), "1.2345e-21")
    strictEqual(BigDecimal.format(BigDecimal.make(-12345n, 20)), "-1.2345e-16")
  })

  it("toJSON()", () => {
    deepStrictEqual(JSON.stringify($("2")), JSON.stringify({ _id: "BigDecimal", value: "2", scale: 0 }))
  })

  it("inspect", () => {
    if (typeof window === "undefined") {
      // oxlint-disable-next-line @typescript-eslint/no-require-imports
      const { inspect } = require("node:util")
      deepStrictEqual(inspect($("2")), inspect({ _id: "BigDecimal", value: "2", scale: 0 }))
    }
  })

  it("toString()", () => {
    strictEqual(String($("2")), "BigDecimal(2)")
  })

  it("Equal.symbol", () => {
    assertTrue(Equal.equals($("2"), $("2")))
  })

  it("pipe()", () => {
    deepStrictEqual($("2").pipe(BigDecimal.multiply($("3"))), $("6"))
  })

  it("scale", () => {
    deepStrictEqual(BigDecimal.scale($("3.0005"), 3), $("3.000"))
  })

  it("fromBigInt", () => {
    deepStrictEqual(BigDecimal.fromBigInt(1n), BigDecimal.make(1n, 0))
  })

  it("fromNumber", () => {
    assertSomeBigDecimal(BigDecimal.fromNumber(123), BigDecimal.make(123n, 0))
    assertSomeBigDecimal(BigDecimal.fromNumber(123.456), BigDecimal.make(123456n, 3))
    assertNone(BigDecimal.fromNumber(Infinity))
  })

  it("toNumberUnsafe", () => {
    strictEqual(BigDecimal.toNumberUnsafe($("123.456")), 123.456)
  })

  it("isInteger", () => {
    assertTrue(BigDecimal.isInteger($("0")))
    assertTrue(BigDecimal.isInteger($("1")))
    assertFalse(BigDecimal.isInteger($("1.1")))
  })

  it("isZero", () => {
    assertTrue(BigDecimal.isZero($("0")))
    assertFalse(BigDecimal.isZero($("1")))
  })

  it("isNegative", () => {
    assertTrue(BigDecimal.isNegative($("-1")))
    assertFalse(BigDecimal.isNegative($("0")))
    assertFalse(BigDecimal.isNegative($("1")))
  })

  it("isPositive", () => {
    assertFalse(BigDecimal.isPositive($("-1")))
    assertFalse(BigDecimal.isPositive($("0")))
    assertTrue(BigDecimal.isPositive($("1")))
  })

  it("digitAt", () => {
    assertEquals(BigDecimal.digitAt($("12.34"), -2), 0n)
    assertEquals(BigDecimal.digitAt($("12.34"), -1), 1n)
    assertEquals(BigDecimal.digitAt($("12.34"), 0), 2n)
    assertEquals(BigDecimal.digitAt($("12.34"), 1), 3n)
    assertEquals(BigDecimal.digitAt($("12.34"), 2), 4n)
    assertEquals(BigDecimal.digitAt($("12.34"), 3), 0n)
  })

  it("round: ceil", () => {
    assertEquals(BigDecimal.ceil($("145"), -1), $("150"))
    assertEquals(BigDecimal.ceil(-1)($("145")), $("150"))
    assertEquals(BigDecimal.ceil($("-14.5")), $("-14"))

    assertEquals(BigDecimal.round($("321.123"), { mode: "ceil", scale: -3 }), $("1000"))
    assertEquals(BigDecimal.round($("145"), { mode: "ceil", scale: -1 }), $("150"))
    assertEquals(BigDecimal.round($("-2.0"), { mode: "ceil", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("-1.9"), { mode: "ceil", scale: 0 }), $("-1"))
    assertEquals(BigDecimal.round($("0.12345678987654321"), { mode: "ceil", scale: 13 }), $("0.1234567898766"))
    assertEquals(BigDecimal.round($("-0.12345678987654321"), { mode: "ceil", scale: 13 }), $("-0.1234567898765"))
  })

  it("round: floor", () => {
    assertEquals(BigDecimal.floor($("145"), -1), $("140"))
    assertEquals(BigDecimal.floor(-1)($("145")), $("140"))
    assertEquals(BigDecimal.floor($("-14.5")), $("-15"))

    assertEquals(BigDecimal.round($("321.123"), { mode: "floor", scale: -3 }), $("0"))
    assertEquals(BigDecimal.round($("145"), { mode: "floor", scale: -1 }), $("140"))
    assertEquals(BigDecimal.round($("-2.1"), { mode: "floor", scale: 0 }), $("-3"))
    assertEquals(BigDecimal.round($("-1.9"), { mode: "floor", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("0.12345678987654321"), { mode: "floor", scale: 13 }), $("0.1234567898765"))
    assertEquals(BigDecimal.round($("-0.12345678987654321"), { mode: "floor", scale: 13 }), $("-0.1234567898766"))
  })

  it("round: to-zero (truncate)", () => {
    assertEquals(BigDecimal.truncate($("145"), -1), $("140"))
    assertEquals(BigDecimal.truncate(-1)($("145")), $("140"))
    assertEquals(BigDecimal.truncate($("-14.5")), $("-14"))

    assertEquals(BigDecimal.round($("321.123"), { mode: "to-zero", scale: -3 }), $("0"))
    assertEquals(BigDecimal.round($("145"), { mode: "to-zero", scale: -1 }), $("140"))
    assertEquals(BigDecimal.round($("-2.1"), { mode: "to-zero", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("-1.9"), { mode: "to-zero", scale: 0 }), $("-1"))
    assertEquals(BigDecimal.round($("0.12345678987654321"), { mode: "to-zero", scale: 13 }), $("0.1234567898765"))
    assertEquals(BigDecimal.round($("-0.12345678987654321"), { mode: "to-zero", scale: 13 }), $("-0.1234567898765"))
  })

  it("round: from-zero", () => {
    assertEquals(BigDecimal.round($("321.123"), { mode: "from-zero", scale: -3 }), $("1000"))
    assertEquals(BigDecimal.round($("145"), { mode: "from-zero", scale: -1 }), $("150"))
    assertEquals(BigDecimal.round($("-2.1"), { mode: "from-zero", scale: 0 }), $("-3"))
    assertEquals(BigDecimal.round($("-1.9"), { mode: "from-zero", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("0.12345678987654321"), { mode: "from-zero", scale: 13 }), $("0.1234567898766"))
    assertEquals(BigDecimal.round($("-0.12345678987654321"), { mode: "from-zero", scale: 13 }), $("-0.1234567898766"))
  })

  it("round: half-ceil", () => {
    assertEquals(BigDecimal.round($("321.123"), { mode: "half-ceil", scale: -3 }), $("0"))
    assertEquals(BigDecimal.round($("145"), { mode: "half-ceil", scale: -1 }), $("150"))
    assertEquals(BigDecimal.round($("-2.5"), { mode: "half-ceil", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("1.95"), { mode: "half-ceil", scale: 1 }), $("2"))
    assertEquals(BigDecimal.round($("-1.95"), { mode: "half-ceil", scale: 1 }), $("-1.9"))
    assertEquals(BigDecimal.round($("0.1234567898765"), { mode: "half-ceil", scale: 12 }), $("0.123456789877"))
    assertEquals(BigDecimal.round($("-0.1234567898765"), { mode: "half-ceil", scale: 12 }), $("-0.123456789876"))
  })

  it("round: half-floor", () => {
    assertEquals(BigDecimal.round($("321.123"), { mode: "half-floor", scale: -3 }), $("0"))
    assertEquals(BigDecimal.round($("145"), { mode: "half-floor", scale: -1 }), $("140"))
    assertEquals(BigDecimal.round($("-2.4"), { mode: "half-floor", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("-2.5"), { mode: "half-floor", scale: 0 }), $("-3"))
    assertEquals(BigDecimal.round($("1.95"), { mode: "half-floor", scale: 1 }), $("1.9"))
    assertEquals(BigDecimal.round($("-1.95"), { mode: "half-floor", scale: 1 }), $("-2"))
    assertEquals(BigDecimal.round($("0.1234567898765"), { mode: "half-floor", scale: 12 }), $("0.123456789876"))
    assertEquals(BigDecimal.round($("-0.1234567898765"), { mode: "half-floor", scale: 12 }), $("-0.123456789877"))
  })

  it("round: half-to-zero", () => {
    assertEquals(BigDecimal.round($("321.123"), { mode: "half-to-zero", scale: -3 }), $("0"))
    assertEquals(BigDecimal.round($("145"), { mode: "half-to-zero", scale: -1 }), $("140"))
    assertEquals(BigDecimal.round($("-2.4"), { mode: "half-to-zero", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("-2.5"), { mode: "half-to-zero", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("1.95"), { mode: "half-to-zero", scale: 1 }), $("1.9"))
    assertEquals(BigDecimal.round($("-1.95"), { mode: "half-to-zero", scale: 1 }), $("-1.9"))
    assertEquals(BigDecimal.round($("0.1234567898765"), { mode: "half-to-zero", scale: 12 }), $("0.123456789876"))
    assertEquals(BigDecimal.round($("-0.1234567898765"), { mode: "half-to-zero", scale: 12 }), $("-0.123456789876"))
  })

  it("round: half-from-zero", () => {
    assertEquals(BigDecimal.round($("321.123"), { mode: "half-from-zero", scale: -3 }), $("0"))
    assertEquals(BigDecimal.round($("145"), { mode: "half-from-zero", scale: -1 }), $("150"))
    assertEquals(BigDecimal.round($("-2.4"), { mode: "half-from-zero", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("-2.5"), { mode: "half-from-zero", scale: 0 }), $("-3"))
    assertEquals(BigDecimal.round($("1.95"), { mode: "half-from-zero", scale: 1 }), $("2"))
    assertEquals(BigDecimal.round($("-1.95"), { mode: "half-from-zero", scale: 1 }), $("-2"))
    assertEquals(BigDecimal.round($("0.1234567898765"), { mode: "half-from-zero", scale: 12 }), $("0.123456789877"))
    assertEquals(BigDecimal.round($("-0.1234567898765"), { mode: "half-from-zero", scale: 12 }), $("-0.123456789877"))
  })

  it("round: half-even", () => {
    assertEquals(BigDecimal.round($("321.123"), { mode: "half-even", scale: -3 }), $("0"))
    assertEquals(BigDecimal.round($("145"), { mode: "half-even", scale: -1 }), $("140"))
    assertEquals(BigDecimal.round($("-2.4"), { mode: "half-even", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("-2.5"), { mode: "half-even", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("1.95"), { mode: "half-even", scale: 1 }), $("2"))
    assertEquals(BigDecimal.round($("-1.95"), { mode: "half-even", scale: 1 }), $("-2"))
    assertEquals(BigDecimal.round($("0.1234567898765"), { mode: "half-even", scale: 12 }), $("0.123456789876"))
    assertEquals(BigDecimal.round($("-0.1234567898765"), { mode: "half-even", scale: 12 }), $("-0.123456789876"))
  })

  it("round: half-odd", () => {
    assertEquals(BigDecimal.round($("321.123"), { mode: "half-even", scale: -3 }), $("0"))
    assertEquals(BigDecimal.round($("145"), { mode: "half-even", scale: -1 }), $("140"))
    assertEquals(BigDecimal.round($("-2.4"), { mode: "half-even", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("-2.5"), { mode: "half-even", scale: 0 }), $("-2"))
    assertEquals(BigDecimal.round($("1.95"), { mode: "half-even", scale: 1 }), $("2"))
    assertEquals(BigDecimal.round($("-1.95"), { mode: "half-even", scale: 1 }), $("-2"))
    assertEquals(BigDecimal.round($("0.1234567898765"), { mode: "half-even", scale: 12 }), $("0.123456789876"))
    assertEquals(BigDecimal.round($("-0.1234567898765"), { mode: "half-even", scale: 12 }), $("-0.123456789876"))
  })
})

// This test is skipped because it is slow. It remains here as an opt-in test for
// debugging or active development of features in the `BigDecimal` module.
describe.skip("Property based testing", () => {
  const zeroArb = fc.constant(BigDecimal.makeNormalizedUnsafe(0n, 0))
  const bigDecimalArb = fc.tuple(fc.bigInt(), fc.integer()).map(([value, scale]) => BigDecimal.make(value, scale))
  const arbWithZero = fc.oneof({ arbitrary: zeroArb, weight: 1 }, { arbitrary: bigDecimalArb, weight: 3 })

  it("unsafeFromString and format should be inverses", () => {
    fc.assert(fc.property(arbWithZero, (bd) => {
      return BigDecimal.equals(BigDecimal.fromStringUnsafe(BigDecimal.format(bd)), bd)
    }))
  })

  it("toExponential should harmonize with Number.prototype.toExponential", () => {
    const actualNumbers = fc.float().filter((n) => Number.isFinite(n))
    fc.assert(fc.property(actualNumbers, (n) => {
      return n.toExponential() === BigDecimal.toExponential(BigDecimal.fromNumberUnsafe(n))
    }))
  })
})
