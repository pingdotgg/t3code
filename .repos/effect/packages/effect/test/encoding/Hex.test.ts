import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import type * as EncodingError from "effect/encoding/EncodingError"
import * as Hex from "effect/encoding/Hex"
import { describeWithFallback } from "../utils/encoding.ts"

const assertRandom = (length: number, expectedLength: number): void => {
  const value = Hex.random(length)
  assert.strictEqual(value.length, expectedLength)
  assert.match(value, /^[0-9a-f]*$/)
}

describeWithFallback("Hex", () => {
  it("encodes strings and bytes as lowercase hexadecimal", () => {
    assert.strictEqual(Hex.encode("hello"), "68656c6c6f")
    assert.strictEqual(Hex.encode(new Uint8Array([72, 101, 108, 108, 111])), "48656c6c6f")
  })

  it("decodes mixed-case bytes and UTF-8 strings", () => {
    assert.deepStrictEqual(
      Result.getOrThrow(Hex.decode("48656C6c6F")),
      new Uint8Array([72, 101, 108, 108, 111])
    )
    assert.strictEqual(Result.getOrThrow(Hex.decodeString("f09f918b")), "👋")
  })

  it("preserves a leading U+FEFF when round-tripping strings", () => {
    assert.strictEqual(Result.getOrThrow(Hex.decodeString(Hex.encode("\uFEFFa"))), "\uFEFFa")
  })

  it("rejects odd lengths and non-hexadecimal characters", () => {
    const oddLength = Hex.decode("abc")
    assert.isTrue(Result.isFailure(oddLength))
    if (Result.isFailure(oddLength)) {
      assert.strictEqual(oddLength.failure.kind, "Decode")
      assert.strictEqual(oddLength.failure.module, "Hex")
      assert.strictEqual(oddLength.failure.input, "abc")
    }

    assert.isTrue(Result.isFailure(Hex.decode("zz")))
  })

  it("round trips every byte value", () => {
    // 600 bytes encode to more than 1,024 characters, the long-input decoder cutoff
    for (const length of [256, 600]) {
      const bytes = Uint8Array.from({ length }, (_, i) => i & 0xff)
      const encoded = Hex.encode(bytes)
      assert.strictEqual(encoded, Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""))
      assert.deepStrictEqual(Result.getOrThrow(Hex.decode(encoded)), bytes)
      assert.deepStrictEqual(Result.getOrThrow(Hex.decode(encoded.toUpperCase())), bytes)
    }
  })

  it("reports the decoding failure", () => {
    const long = "00".repeat(64)
    // Past the long-input decoder cutoff
    const longer = "00".repeat(600)
    const vectors: ReadonlyArray<readonly [string, string]> = [
      ["abc", "Length must be a multiple of 2, but is 3"],
      [`${long}0`, "Length must be a multiple of 2, but is 129"],
      // Lengths count UTF-8 bytes
      ["\u00e9", "Invalid input"],
      ["0g", "Invalid input"],
      ["0 ", "Invalid input"],
      [`${long}0g`, "Invalid input"],
      [`${longer}0g`, "Invalid input"],
      [`${longer}\u00e90`, "Length must be a multiple of 2, but is 1203"]
    ]
    for (const [input, message] of vectors) {
      const results: ReadonlyArray<Result.Result<unknown, EncodingError.EncodingError>> = [
        Hex.decode(input),
        Hex.decodeString(input)
      ]
      for (const result of results) {
        assert.isTrue(Result.isFailure(result), input)
        if (Result.isFailure(result)) {
          const { kind, module } = result.failure
          assert.deepStrictEqual(
            { kind, module, input: result.failure.input, message: result.failure.message },
            { kind: "Decode", module: "Hex", input, message }
          )
        }
      }
    }
  })

  describe("random", () => {
    it("generates lowercase hexadecimal words", () => {
      assertRandom(0, 0)
      assertRandom(8, 8)
      assertRandom(16, 16)
      assertRandom(32, 32)
    })

    it("rounds non-negative lengths down to multiples of 8", () => {
      assertRandom(7, 0)
      assertRandom(15.9, 8)
      assertRandom(23, 16)
    })

    it("uses unsigned 32-bit coercion without validation", () => {
      assertRandom(Number.NaN, 0)
      assertRandom(Number.POSITIVE_INFINITY, 0)
      assertRandom(2 ** 32, 0)
      assertRandom(2 ** 32 + 8, 8)
    })
  })
})
