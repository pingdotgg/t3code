import { assert, describe, it } from "@effect/vitest"
import * as Utf8 from "effect/internal/utf8"

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const decode = (bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

describe("Utf8", () => {
  it.each(Array.from({ length: 34 }, (_, i) => i))("decodes a %i-byte slice like TextDecoder", (length) => {
    const bytes = Uint8Array.from({ length: length + 2 }, (_, i) => 0x21 + i)
    const start = 1
    const end = start + length
    bytes[0] = bytes[end] = 0xFF

    assert.strictEqual(Utf8.decode(bytes, start, end), decode(bytes.subarray(start, end)))
    for (let i = start; i < end; i++) {
      const ascii = bytes[i]
      bytes[i] = 0x80
      assert.strictEqual(
        Utf8.decode(bytes, start, end),
        decode(bytes.subarray(start, end)),
        `non-ASCII byte at offset ${i - start}`
      )
      bytes[i] = ascii
    }
  })
})
