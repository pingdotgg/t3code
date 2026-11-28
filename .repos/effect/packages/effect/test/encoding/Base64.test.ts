import { assert, describe, it, vi } from "@effect/vitest"
import { Result } from "effect"
import * as Base64 from "effect/encoding/Base64"
import type * as EncodingError from "effect/encoding/EncodingError"
import { describeWithFallback, describeWithoutNatives } from "../utils/encoding.ts"

describeWithFallback("Base64", () => {
  it("encodes and decodes binary subarrays with and without padding", () => {
    const bytes = new Uint8Array([42, 251, 255, 128, 42])
    const vectors = ["", "+w==", "+/8=", "+/+A"]

    for (const [length, encoded] of vectors.entries()) {
      const view = bytes.subarray(1, 1 + length)
      assert.strictEqual(Base64.encode(view), encoded)
      assert.strictEqual(Base64.encodeUnpadded(view), encoded.replace(/=+$/, ""))
      assert.deepStrictEqual(Result.getOrThrow(Base64.decode(encoded)), view)
    }
    assert.deepStrictEqual(bytes, new Uint8Array([42, 251, 255, 128, 42]))
  })

  describe("native toBase64", () => {
    const bytes = Uint8Array.from({ length: 132 }, (_, i) => (i * 151) & 0xff)
    // Offset views with lengths around the native (32) and byte-array (128) cutoffs.
    const views = [31, 32, 33, 34, 127, 128, 129, 130].map((length) => bytes.subarray(1, 1 + length))
    const reference = (view: Uint8Array) => btoa(String.fromCharCode(...view))

    // Replaces `Uint8Array.prototype.toBase64` (or removes it) while `body` runs.
    const withToBase64 = (toBase64: ((this: Uint8Array) => string) | undefined, body: () => void) => {
      const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64")
      Reflect.defineProperty(Uint8Array.prototype, "toBase64", { value: toBase64, configurable: true })
      try {
        body()
      } finally {
        if (descriptor === undefined) Reflect.deleteProperty(Uint8Array.prototype, "toBase64")
        else Reflect.defineProperty(Uint8Array.prototype, "toBase64", descriptor)
      }
    }

    // A stand-in for the native method that records its receivers.
    const spyToBase64 = () => {
      const receivers: Array<Uint8Array> = []
      const toBase64 = function(this: Uint8Array) {
        receivers.push(this)
        return reference(this)
      }
      return { receivers, toBase64 }
    }

    it("is used from 32 bytes", () => {
      const { receivers, toBase64 } = spyToBase64()
      withToBase64(toBase64, () => {
        for (const view of views) assert.strictEqual(Base64.encode(view), reference(view))
      })
      assert.deepStrictEqual(receivers.map((view) => view.length), [32, 33, 34, 127, 128, 129, 130])
    })

    it("is not required", () => {
      withToBase64(undefined, () => {
        for (const view of views) assert.strictEqual(Base64.encode(view), reference(view))
      })
    })

    it("is not read from the input itself", () => {
      const view = Object.assign(bytes.subarray(1, 35), { toBase64: () => "x" })
      for (const toBase64 of [spyToBase64().toBase64, undefined]) {
        withToBase64(toBase64, () => assert.strictEqual(Base64.encode(view), reference(view)))
      }
    })

    it("is not called with a detached buffer", () => {
      const detached = new Uint8Array(32)
      structuredClone(detached.buffer, { transfer: [detached.buffer] })
      const { receivers, toBase64 } = spyToBase64()
      withToBase64(toBase64, () => assert.strictEqual(Base64.encode(detached), ""))
      withToBase64(undefined, () => assert.strictEqual(Base64.encode(detached), ""))
      assert.deepStrictEqual(receivers, [])
    })
  })

  it("encodes strings and bytes", () => {
    assert.strictEqual(Base64.encode("hello"), "aGVsbG8=")
    assert.strictEqual(Base64.encodeUnpadded("hello"), "aGVsbG8")
    assert.strictEqual(Base64.encode(new Uint8Array([72, 101, 108, 108, 111])), "SGVsbG8=")
  })

  it("encodes unpaired surrogates as the UTF-8 replacement character", () => {
    assert.strictEqual(Base64.encode("\uD800"), "77+9")
    assert.strictEqual(Base64.encode("\uDC00"), "77+9")
  })

  it("decodes bytes and UTF-8 strings", () => {
    assert.deepStrictEqual(
      Result.getOrThrow(Base64.decode("SGVs\r\nbG8=")),
      new Uint8Array([72, 101, 108, 108, 111])
    )
    assert.strictEqual(Result.getOrThrow(Base64.decodeString("8J+Riw==")), "👋")
  })

  it("preserves a leading U+FEFF when round-tripping strings", () => {
    assert.strictEqual(Result.getOrThrow(Base64.decodeString(Base64.encode("\uFEFFa"))), "\uFEFFa")
  })

  it("rejects invalid input with format information", () => {
    const invalidLength = Base64.decode("abc")
    assert.isTrue(Result.isFailure(invalidLength))
    if (Result.isFailure(invalidLength)) {
      assert.strictEqual(invalidLength.failure.kind, "Decode")
      assert.strictEqual(invalidLength.failure.module, "Base64")
      assert.strictEqual(invalidLength.failure.input, "abc")
    }

    assert.isTrue(Result.isFailure(Base64.decode("ab=c")))
    assert.isTrue(Result.isFailure(Base64.decode("!!!!")))
  })

  it("round trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const encoded = Base64.encode(bytes)
    assert.deepStrictEqual(Result.getOrThrow(Base64.decode(encoded)), bytes)
    // MIME-style 76-character lines
    assert.deepStrictEqual(Result.getOrThrow(Base64.decode(encoded.replace(/.{76}/g, "$&\r\n"))), bytes)
  })

  it("ignores non-zero trailing bits", () => {
    assert.deepStrictEqual(Result.getOrThrow(Base64.decode("Zh==")), new Uint8Array([102]))
    assert.deepStrictEqual(Result.getOrThrow(Base64.decode("Zm9=")), new Uint8Array([102, 111]))
  })

  it("decodes either alphabet, with or without padding", () => {
    for (const length of [0, 48]) {
      const prefix = "AAAA".repeat(length)
      const bytes = new Uint8Array([...new Uint8Array(length * 3), 251, 255])
      for (const encoded of ["+/8=", "+/8", "-_8=", "-_8"]) {
        assert.deepStrictEqual(Result.getOrThrow(Base64.decodeLenient(prefix + encoded)), bytes)
      }
      assert.deepStrictEqual(Result.getOrThrow(Base64.decodeLenient(prefix + "+w")), bytes.subarray(0, -1))
      assert.strictEqual(Base64.encodeUnpadded(bytes), prefix + "+/8")
    }
  })

  it("rejects invalid lenient input and preserves the original input", () => {
    for (const prefix of ["", "AAAA".repeat(48)]) {
      // The last two mix the alphabets.
      for (const suffix of ["Zm9vY", "Zg=", "-_!\r\n=", "Zg=v", "+_8", "-/8="]) {
        const input = prefix + suffix
        const result = Base64.decodeLenient(input)
        assert.isTrue(Result.isFailure(result), input)
        if (Result.isFailure(result)) {
          const { input: actual, kind, module } = result.failure
          assert.deepStrictEqual({ kind, module, input: actual }, { kind: "Decode", module: "Base64", input })
        }
      }
    }
  })

  it("rejects invalid input with both decoders", () => {
    const length = (length: number) => `Length must be a multiple of 4, but is ${length}`
    const misplacedPadding = "Found a '=' character, but it is not at the end"
    assertFailure("Zg", "Zg", length(2))
    assertFailure("Zg=", "Zg=", length(3))
    assertFailure("Zg\r\n=", "Zg=", length(3))
    assertFailure("Zm 9v", "Zm 9v", length(5))
    assertFailure("Zg=v", "Zg=v", misplacedPadding)
    assertFailure("=Zg=", "=Zg=", misplacedPadding)
    assertFailure("====", "====", misplacedPadding)
    for (const char of ["-", "_", "!", "{", "\u00e9", " ", "\t", "\f"]) {
      assertFailure(`Zm9${char}`, `Zm9${char}`, `Invalid character ${char}`)
      // Long enough for size-gated decoders
      const long = `${"Zm9v".repeat(64)}Zm9${char}`
      assertFailure(long, long, `Invalid character ${char}`)
    }
  })
})

describeWithoutNatives("Base64 Buffer fallback", () => {
  it("encodes and decodes with Buffer", () => {
    const bytes = Uint8Array.from({ length: 96 }, (_, i) => (i * 151) & 0xff)
    const encoded = btoa(String.fromCharCode(...bytes))
    const from = vi.spyOn(Buffer, "from")
    try {
      assert.strictEqual(Base64.encode(bytes), encoded)
      assert.strictEqual(from.mock.calls.length, 1)
      assert.deepStrictEqual(Result.getOrThrow(Base64.decode(encoded)), bytes)
      assert.strictEqual(from.mock.calls.length, 2)
    } finally {
      from.mockRestore()
    }
  })
})

const assertFailure = (raw: string, stripped: string, expected: string) => {
  const results: ReadonlyArray<Result.Result<unknown, EncodingError.EncodingError>> = [
    Base64.decode(raw),
    Base64.decodeString(raw)
  ]
  for (const result of results) {
    assert.isTrue(Result.isFailure(result), raw)
    if (Result.isFailure(result)) {
      const { input, kind, message, module } = result.failure
      assert.deepStrictEqual(
        { kind, module, input, message },
        { kind: "Decode", module: "Base64", input: stripped, message: expected }
      )
    }
  }
}
