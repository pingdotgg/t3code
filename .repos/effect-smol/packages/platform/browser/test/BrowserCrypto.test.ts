import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Layer } from "effect"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"

const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const uuidV7Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
  if (array instanceof Uint8Array) {
    for (let i = 0; i < array.length; i++) {
      array[i] = i & 0xff
    }
  }
  return array
}

describe("BrowserCrypto", () => {
  it.effect("generates random bytes at and above the getRandomValues limit", () => {
    const chunks: Array<number> = []

    return Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      for (const size of [65_536, 65_537, 70_000]) {
        const bytes = yield* crypto.randomBytes(size)
        assert.strictEqual(bytes.length, size)
        assert.strictEqual(bytes[0], 0)
        assert.strictEqual(bytes[size - 1], (size - 1) & 0xff)
      }
      assert.deepStrictEqual(chunks, [65_536, 65_536, 1, 65_536, 4_464])
    }).pipe(Effect.provide(BrowserCrypto.layer.pipe(
      Layer.provide(Layer.succeed(BrowserCrypto.WebCrypto, {
        ...crypto,
        getRandomValues<T extends ArrayBufferView | null>(array: T): T {
          if (array !== null) {
            assert.ok(array.byteLength <= 65_536)
            chunks.push(array.byteLength)
          }
          return getRandomValues(array)
        }
      }))
    )))
  })

  it.effect("generates UUIDv4 values from getRandomValues", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const uuid = yield* crypto.randomUUIDv4
      assert.strictEqual(uuid, "00010203-0405-4607-8809-0a0b0c0d0e0f")
      assert.match(uuid, uuidV4Regex)
    }).pipe(Effect.provide(BrowserCrypto.layer.pipe(
      Layer.provide(Layer.succeed(BrowserCrypto.WebCrypto, {
        ...crypto,
        getRandomValues
      }))
    ))))

  it.effect("generates UUIDv7 values from getRandomValues and the Clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0x0123456789ab)
      const crypto = yield* Crypto.Crypto
      const uuid = yield* crypto.randomUUIDv7
      assert.strictEqual(uuid, "01234567-89ab-7607-8809-0a0b0c0d0e0f")
      assert.match(uuid, uuidV7Regex)
    }).pipe(Effect.provide(BrowserCrypto.layer.pipe(
      Layer.provide(Layer.succeed(BrowserCrypto.WebCrypto, {
        ...crypto,
        getRandomValues
      }))
    ))))

  it.effect("computes digests with subtle crypto", () => {
    const buffer = new ArrayBuffer(3)
    new Uint8Array(buffer).set([1, 2, 3])

    return Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const digest = yield* crypto.digest("SHA-256", new Uint8Array(buffer))
      assert.deepStrictEqual(digest, new Uint8Array([1, 2, 3]))
    }).pipe(
      Effect.provide(BrowserCrypto.layer.pipe(
        Layer.provide(Layer.succeed(BrowserCrypto.WebCrypto, {
          ...crypto,
          subtle: {
            ...crypto.subtle,
            digest() {
              return Promise.resolve(buffer)
            }
          }
        }))
      ))
    )
  })
})
