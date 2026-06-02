import { assert, describe, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"

const testCrypto = Crypto.make({
  randomBytes: (size) =>
    size === 7 ? Uint8Array.of(0x18, 0, 0, 0, 0, 0, 0) : Uint8Array.from({ length: size }, (_, i) => i),
  digest: (algorithm, data) => Effect.succeed(Uint8Array.of(data.length, algorithm.length))
})

describe("Crypto", () => {
  it("supports string literal digest algorithms", () => {
    const algorithm: Crypto.DigestAlgorithm = "SHA-256"
    assert.strictEqual(algorithm, "SHA-256")
  })

  it.effect("randomBytes delegates to the service", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const bytes = yield* crypto.randomBytes(4)
      assert.deepStrictEqual(bytes, Uint8Array.of(0, 1, 2, 3))
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("random generators delegate to the service", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const random = yield* crypto.random
      const randomInt = yield* crypto.randomInt
      const randomBoolean = yield* crypto.randomBoolean
      const randomBetween = yield* crypto.randomBetween(10, 20)
      const randomBetweenDecimalBounds = yield* crypto.randomBetween(10.5, 20.5)
      const randomIntBetween = yield* crypto.randomIntBetween(1, 6)
      const randomShuffle = yield* crypto.randomShuffle([1, 2, 3])

      assert.strictEqual(random, 0.75)
      assert.strictEqual(randomInt, 4503599627370497)
      assert.strictEqual(randomBoolean, true)
      assert.strictEqual(randomBetween, 17.5)
      assert.strictEqual(randomBetweenDecimalBounds, 18)
      assert.strictEqual(randomIntBetween, 5)
      assert.deepStrictEqual(randomShuffle, [1, 2, 3])
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("randomIntBetween excludes the upper bound in half-open ranges", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const value = yield* crypto.randomIntBetween(1, 6, { halfOpen: true })
      assert.strictEqual(value, 5)
    }).pipe(Effect.provideService(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(0xff),
        digest: (_algorithm, data) => Effect.succeed(data)
      })
    )))

  it.effect("randomUUIDv4 formats UUID bytes from randomBytes", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const uuid = yield* crypto.randomUUIDv4
      assert.strictEqual(uuid, "00010203-0405-4607-8809-0a0b0c0d0e0f")
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("randomUUIDv7 formats UUID bytes with the Clock timestamp", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0x0123456789ab)
      const crypto = yield* Crypto.Crypto
      const uuid = yield* crypto.randomUUIDv7
      assert.strictEqual(uuid, "01234567-89ab-7607-8809-0a0b0c0d0e0f")
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("digest delegates to the service", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const digest = yield* crypto.digest("SHA-256", Uint8Array.of(1, 2, 3))
      assert.deepStrictEqual(digest, Uint8Array.of(3, "SHA-256".length))
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))

  it.effect("can access a provided custom Crypto service", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const bytes = yield* crypto.randomBytes(1)
      assert.deepStrictEqual(bytes, Uint8Array.of(0))
    }).pipe(Effect.provideService(Crypto.Crypto, testCrypto)))
})
