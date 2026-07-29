/**
 * Defines a platform-independent service for cryptographic operations.
 *
 * Runtime packages provide concrete implementations backed by the host
 * platform's cryptography APIs. This module defines the service interface and a
 * constructor from random-byte and digest primitives. The service provides
 * secure random bytes and numbers, UUIDv4 and UUIDv7 generation, shuffling, and
 * SHA message digests.
 *
 * @since 4.0.0
 */
import * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import * as PlatformError from "./PlatformError.ts"

const TypeId = "~effect/platform/Crypto"

/**
 * Digest algorithms supported by the platform `Crypto` service.
 *
 * **Gotchas**
 *
 * SHA-1 is included for interoperability with existing protocols. Do not use
 * SHA-1 for new security-sensitive designs.
 *
 * **Example** (Using a digest algorithm)
 *
 * ```ts
 * import { Crypto } from "effect"
 *
 * const algorithm: Crypto.DigestAlgorithm = "SHA-256"
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export type DigestAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"

/**
 * Platform-agnostic cryptographic operations.
 *
 * **Details**
 *
 * `Crypto` implementations must use cryptographically secure platform APIs.
 * The random generator helpers are derived by the `make` constructor from
 * the random methods on this service.
 *
 * **Example** (Using cryptographic operations)
 *
 * ```ts
 * import { Crypto, Effect, Layer } from "effect"
 *
 * const TestCrypto = Layer.succeed(
 *   Crypto.Crypto,
 *   Crypto.make({
 *     randomBytes: (size) => new Uint8Array(size),
 *     digest: (_algorithm, data) => Effect.succeed(data)
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const crypto = yield* Crypto.Crypto
 *   const bytes = yield* crypto.randomBytes(16)
 *   const uuidv4 = yield* crypto.randomUUIDv4
 *   const uuidv7 = yield* crypto.randomUUIDv7
 *   const hash = yield* crypto.digest("SHA-256", bytes)
 *   return { uuidv4, uuidv7, hash }
 * })
 *
 * Effect.runPromise(Effect.provide(program, TestCrypto))
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Crypto {
  readonly [TypeId]: typeof TypeId

  /**
   * Generates a random integer in the range Number.MIN_SAFE_INTEGER to
   * Number.MAX_SAFE_INTEGER (both inclusive).
   */
  nextIntUnsafe(): number

  /**
   * Generates a random number in the range 0 (inclusive) to 1 (exclusive).
   */
  nextDoubleUnsafe(): number

  /**
   * Generates cryptographically secure random bytes.
   */
  randomBytes(size: number): Effect.Effect<Uint8Array, PlatformError.PlatformError>

  /**
   * Computes a cryptographic digest for the supplied data.
   */
  digest(
    algorithm: DigestAlgorithm,
    data: Uint8Array
  ): Effect.Effect<Uint8Array, PlatformError.PlatformError>

  /**
   * Generates a cryptographically secure random number between 0 (inclusive)
   * and 1 (exclusive).
   */
  readonly random: Effect.Effect<number>

  /**
   * Generates a cryptographically secure random boolean.
   */
  readonly randomBoolean: Effect.Effect<boolean>

  /**
   * Generates a cryptographically secure random integer between
   * `Number.MIN_SAFE_INTEGER` and `Number.MAX_SAFE_INTEGER` (both inclusive).
   */
  readonly randomInt: Effect.Effect<number>

  /**
   * Generates a cryptographically secure random number between `min`
   * (inclusive) and `max` (exclusive).
   */
  randomBetween(min: number, max: number): Effect.Effect<number>

  /**
   * Generates a cryptographically secure random integer between `min` and `max`.
   *
   * **Details**
   *
   * The lower bound is rounded up with `Math.ceil` and the upper bound is
   * rounded down with `Math.floor`. By default the range is inclusive; set
   * `options.halfOpen: true` to exclude the upper bound.
   */
  randomIntBetween(min: number, max: number, options?: {
    readonly halfOpen?: boolean | undefined
  }): Effect.Effect<number>

  /**
   * Uses the cryptographically secure random generator to shuffle the supplied
   * iterable.
   */
  randomShuffle<A>(elements: Iterable<A>): Effect.Effect<Array<A>>

  /**
   * Generates a cryptographically secure UUIDv4 string.
   */
  readonly randomUUIDv4: Effect.Effect<string, PlatformError.PlatformError>

  /**
   * Generates a cryptographically secure UUIDv7 string.
   */
  readonly randomUUIDv7: Effect.Effect<string, PlatformError.PlatformError>
}

/**
 * Service tag for platform cryptography.
 *
 * **When to use**
 *
 * Use when you need to provide or retrieve the full platform cryptography
 * service from an effect's context.
 *
 * **Details**
 *
 * Providing this service supplies platform-agnostic cryptographic operations
 * such as hashing, UUID generation, and secure random values.
 *
 * @see {@link make} for constructing a Crypto service from primitive operations
 *
 * @category services
 * @since 4.0.0
 */
export const Crypto: Context.Service<Crypto, Crypto> = Context.Service("effect/Crypto")

/**
 * Creates a `Crypto` service from the primitive implementation, deriving the
 * random generator helpers and UUID generation from those primitives.
 *
 * **When to use**
 *
 * Use to build a Crypto service for a platform integration, test layer, or
 * custom runtime from primitive random-byte and digest operations.
 *
 * **Details**
 *
 * The constructor derives random numbers, booleans, integer ranges, shuffling,
 * and UUID generation from `impl.randomBytes`. Digest operations delegate to
 * `impl.digest`.
 *
 * **Gotchas**
 *
 * `impl.randomBytes` must return cryptographically secure bytes of the
 * requested length. UUID formatting mutates the byte array returned for UUID
 * generation, so the implementation should return a fresh array for each call.
 *
 * **Example** (Creating a Crypto service)
 *
 * ```ts
 * import { Crypto, Effect, Layer } from "effect"
 *
 * const TestCrypto = Layer.succeed(
 *   Crypto.Crypto,
 *   Crypto.make({
 *     randomBytes: (size) => new Uint8Array(size),
 *     digest: (_algorithm, data) => Effect.succeed(data)
 *   })
 * )
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  impl: {
    readonly randomBytes: (size: number) => Uint8Array
    readonly digest: (
      algorithm: DigestAlgorithm,
      data: Uint8Array
    ) => Effect.Effect<Uint8Array, PlatformError.PlatformError>
  }
): Crypto => {
  const randomBytesUnsafe = impl.randomBytes

  const randomBytes: Crypto["randomBytes"] = (size) => Effect.map(validateSize("randomBytes", size), randomBytesUnsafe)

  const nextDoubleUnsafe = (): number => {
    const bytes = randomBytesUnsafe(7)
    const value = ((bytes[0] & 0x1f) * 2 ** 48) + (bytes[1] * 2 ** 40) + (bytes[2] * 2 ** 32) +
      (bytes[3] * 2 ** 24) + (bytes[4] * 2 ** 16) + (bytes[5] * 2 ** 8) + bytes[6]
    return value / 2 ** 53
  }

  const nextIntUnsafe = (): number =>
    Math.floor(nextDoubleUnsafe() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) + Number.MIN_SAFE_INTEGER

  return Crypto.of({
    [TypeId]: TypeId,
    randomBytes,
    nextDoubleUnsafe,
    nextIntUnsafe,
    digest: impl.digest,
    random: Effect.sync(() => nextDoubleUnsafe()),
    randomBoolean: Effect.sync(() => nextDoubleUnsafe() > 0.5),
    randomInt: Effect.sync(() => nextIntUnsafe()),
    randomBetween: (min, max) => Effect.sync(() => nextDoubleUnsafe() * (max - min) + min),
    randomIntBetween(min, max, options) {
      const extra = options?.halfOpen === true ? 0 : 1
      return Effect.sync(() => {
        const minInt = Math.ceil(min)
        const maxInt = Math.floor(max)
        return Math.floor(nextDoubleUnsafe() * (maxInt - minInt + extra)) + minInt
      })
    },
    randomShuffle: (elements) =>
      Effect.sync(() => {
        const buffer = Array.from(elements)
        for (let i = buffer.length - 1; i >= 1; i = i - 1) {
          const index = Math.min(i, Math.floor(nextDoubleUnsafe() * (i + 1)))
          const value = buffer[i]!
          buffer[i] = buffer[index]!
          buffer[index] = value
        }
        return buffer
      }),
    randomUUIDv4: Effect.sync(() => formatUUIDv4(randomBytesUnsafe(16))),
    randomUUIDv7: Effect.clockWith((clock) =>
      Effect.succeed(formatUUIDv7(clock.currentTimeMillisUnsafe(), randomBytesUnsafe(16)))
    )
  })
}

const validateSize = (method: string, size: number): Effect.Effect<number, PlatformError.PlatformError> =>
  Number.isSafeInteger(size) && size >= 0
    ? Effect.succeed(size)
    : Effect.fail(PlatformError.badArgument({
      module: "Crypto",
      method,
      description: "size must be a non-negative safe integer"
    }))

const hex = (byte: number): string => byte.toString(16).padStart(2, "0")

const formatUUID = (bytes: Uint8Array): string => {
  const segments = [
    bytes.subarray(0, 4),
    bytes.subarray(4, 6),
    bytes.subarray(6, 8),
    bytes.subarray(8, 10),
    bytes.subarray(10, 16)
  ]

  return segments.map((segment) => Array.from(segment, hex).join("")).join("-")
}

const formatUUIDv4 = (bytes: Uint8Array): string => {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return formatUUID(bytes)
}

const maxUUIDv7Timestamp = 2 ** 48 - 1

const formatUUIDv7 = (timestampMillis: number, bytes: Uint8Array): string => {
  const timestamp = Math.min(Math.max(0, Math.trunc(timestampMillis)), maxUUIDv7Timestamp)

  bytes[0] = Math.floor(timestamp / 2 ** 40)
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff
  bytes[5] = timestamp & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return formatUUID(bytes)
}
