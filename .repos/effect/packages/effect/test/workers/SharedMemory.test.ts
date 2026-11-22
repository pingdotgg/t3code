import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { SharedMemory } from "effect/workers"
import { vi } from "vitest"

describe("SharedMemory", () => {
  for (const [name, value] of [["crossOriginIsolated", false], ["SharedArrayBuffer", undefined]] as const) {
    it("reports unavailable memory when " + name + " is " + value, () => {
      try {
        vi.stubGlobal(name, value)
        assert.isFalse(SharedMemory.isAvailable())
        assert.throws(
          () => SharedMemory.make(Int32Array, 1),
          SharedMemory.SharedMemoryError,
          "Cross-Origin-Opener-Policy"
        )
      } finally {
        vi.unstubAllGlobals()
      }
    })
  }

  describe("schema", () => {
    const Ints = SharedMemory.schema(Int32Array)

    it("accepts shared arrays of the requested kind", () => {
      const data = SharedMemory.make(Int32Array, 2)
      assert.strictEqual(Schema.decodeUnknownSync(Ints)(data), data)
    })

    it("rejects unshared, wrong-kind and serialized arrays", () => {
      for (const data of [new Int32Array(2), SharedMemory.make(Uint32Array, 2), { 0: 0, 1: 0 }]) {
        assert.throws(() => Schema.decodeUnknownSync(Ints)(data), "Int32Array in shared memory")
      }
      assert.throws(() => Schema.encodeUnknownSync(Ints)(new Int32Array(1)))
    })

    it("passes values through the JSON codec untouched", () => {
      const codec = Schema.toCodecJson(Schema.Struct({ data: Ints }))
      const data = SharedMemory.make(Int32Array, 2)
      const encoded = Schema.encodeSync(codec)({ data })
      assert.strictEqual((encoded as { readonly data: unknown }).data, data)
      assert.strictEqual(Schema.decodeUnknownSync(codec)(encoded).data, data)
    })
  })
})
