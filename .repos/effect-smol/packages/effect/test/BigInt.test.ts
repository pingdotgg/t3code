import * as BigInt from "effect/BigInt"
import { describe, it } from "vitest"
import { assertNone, assertSome, strictEqual } from "./utils/assert.ts"

describe("BigInt", () => {
  it("re-exports the global BigInt constructor", () => {
    strictEqual(BigInt.Equivalence(1n, 1n), true)
    strictEqual(BigInt.Equivalence(1n, 2n), false)
  })

  it("divide returns some for non-zero divisors in data-first and data-last forms", () => {
    assertSome(BigInt.divide(6n, 3n), 2n)
    assertNone(BigInt.divide(6n, 0n))
    strictEqual(BigInt.divideUnsafe(6n, 3n), 2n)
  })

  it("sqrt returns integer square roots", () => {
    assertSome(BigInt.sqrt(4n), 2n)
    assertNone(BigInt.sqrt(-1n))
  })

  it("toNumber converts bigints in the safe integer range", () => {
    assertSome(BigInt.toNumber(42n), 42)
    assertNone(BigInt.toNumber(BigInt.BigInt(Number.MAX_SAFE_INTEGER) + 1n))
  })

  it("toNumber returns none outside the safe integer range", () => {
    assertSome(BigInt.fromString("42"), 42n)
    assertNone(BigInt.fromString(" "))
    assertNone(BigInt.fromString("a"))
  })

  it("fromNumber converts safe integers to bigint", () => {
    assertSome(BigInt.fromNumber(42), 42n)
    assertNone(BigInt.fromNumber(Number.MAX_SAFE_INTEGER + 1))
  })

  it("fromNumber returns none for unsafe or non-integral numbers", () => {
    strictEqual(BigInt.ReducerSum.combine(1n, 2n), 3n)
    strictEqual(BigInt.ReducerSum.combine(BigInt.ReducerSum.initialValue, 2n), 2n)
    strictEqual(BigInt.ReducerSum.combine(2n, BigInt.ReducerSum.initialValue), 2n)
  })

  it("ReducerMultiply combines values with one as the identity", () => {
    strictEqual(BigInt.ReducerMultiply.combine(2n, 3n), 6n)
    strictEqual(BigInt.ReducerMultiply.combine(BigInt.ReducerMultiply.initialValue, 2n), 2n)
    strictEqual(BigInt.ReducerMultiply.combine(2n, BigInt.ReducerMultiply.initialValue), 2n)
  })

  it("CombinerMax returns the larger bigint", () => {
    strictEqual(BigInt.CombinerMax.combine(1n, 2n), 2n)
  })

  it("CombinerMin returns the smaller bigint", () => {
    strictEqual(BigInt.CombinerMin.combine(1n, 2n), 1n)
  })
})
