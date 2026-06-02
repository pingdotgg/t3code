/**
 * The `NodeCrypto` module implements Effect's `Crypto` service with
 * Node-compatible `node:crypto` APIs. It exports {@link make} as the concrete
 * service value and {@link layer} for providing that service to programs that
 * need cryptographic random bytes, UUID generation, random values, or SHA
 * digests over `Uint8Array` input.
 *
 * **Common tasks**
 *
 * - Provide {@link layer} in Node-compatible platform packages and tests
 * - Reuse {@link make} when a surrounding layer already manages service
 *   construction
 * - Compute SHA-1, SHA-256, SHA-384, or SHA-512 digests through
 *   `effect/Crypto` after the layer is provided
 *
 * **Gotchas**
 *
 * - Random bytes come from `node:crypto.randomBytes`
 * - Digests use `node:crypto.createHash`; hash failures become platform
 *   errors
 * - SHA-1 is included for interoperability with existing protocols, not for
 *   new security-sensitive designs
 *
 * @since 1.0.0
 */
import * as EffectCrypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as NodeCrypto from "node:crypto"

const toHashAlgorithm = (algorithm: EffectCrypto.DigestAlgorithm): string => {
  switch (algorithm) {
    case "SHA-1":
      return "sha1"
    case "SHA-256":
      return "sha256"
    case "SHA-384":
      return "sha384"
    case "SHA-512":
      return "sha512"
  }
}

const digest: EffectCrypto.Crypto["digest"] = (algorithm, data) =>
  Effect.try({
    try: () => Uint8Array.from(NodeCrypto.createHash(toHashAlgorithm(algorithm)).update(data).digest()),
    catch: (cause) =>
      PlatformError.systemError({
        module: "Crypto",
        method: "digest",
        _tag: "Unknown",
        description: "Could not compute digest",
        cause
      })
  })

/**
 * The default Node.js Crypto service implementation.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make: EffectCrypto.Crypto = EffectCrypto.make({
  randomBytes: NodeCrypto.randomBytes,
  digest
})

/**
 * Layer that provides the Node.js Crypto service implementation.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<EffectCrypto.Crypto> = Layer.succeed(EffectCrypto.Crypto, make)
