import { assert, describe, it } from "@effect/vitest"
import { Encoding } from "effect"

const assertRandomHex = (length: number, expectedLength: number): void => {
  const value = Encoding.randomHex(length)
  assert.strictEqual(value.length, expectedLength)
  assert.match(value, /^[0-9a-f]*$/)
}

describe("Encoding", () => {
  describe("randomHex", () => {
    it("generates lowercase hexadecimal words", () => {
      assertRandomHex(0, 0)
      assertRandomHex(8, 8)
      assertRandomHex(16, 16)
      assertRandomHex(32, 32)
    })

    it("rounds non-negative lengths down to multiples of 8", () => {
      assertRandomHex(7, 0)
      assertRandomHex(15.9, 8)
      assertRandomHex(23, 16)
    })

    it("uses unsigned 32-bit coercion without validation", () => {
      assertRandomHex(Number.NaN, 0)
      assertRandomHex(Number.POSITIVE_INFINITY, 0)
      assertRandomHex(2 ** 32, 0)
      assertRandomHex(2 ** 32 + 8, 8)
    })
  })
})
