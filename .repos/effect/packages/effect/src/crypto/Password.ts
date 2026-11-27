/**
 * Password storage: hash passwords into self-describing PHC strings and verify
 * them later.
 *
 * The {@link Password} service hashes with one configured algorithm, Argon2id
 * or PBKDF2 from `Kdf`, and returns a PHC string such as
 * `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>` that carries the algorithm,
 * its costs, and the salt. Verification reads them back from the string, so
 * hashes made under an older policy keep verifying, and `needsRehash` tells
 * you when to replace them. {@link decode} and {@link encode} convert between
 * PHC strings and {@link PasswordHash} values without a service.
 *
 * **Gotchas**
 *
 * - Passwords are UTF-8 encoded without Unicode normalization, matching other
 *   PHC implementations. Normalize them yourself before hashing and verifying
 *   if users type them on different platforms.
 * - `verify` runs whatever costs the stored hash states. Stored hashes are
 *   trusted input: to verify hashes from an untrusted source, {@link decode}
 *   them and check the algorithm first.
 * - Argon2id needs a `Kdf` layer that provides it, such as
 *   `NodeCrypto.layerKdf`. Use PBKDF2 on WebCrypto-only runtimes.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Context from "../Context.ts"
import * as Effect from "../Effect.ts"
import * as Base64 from "../encoding/Base64.ts"
import * as Layer from "../Layer.ts"
import * as Redacted from "../Redacted.ts"
import * as Result from "../Result.ts"
import * as CryptoError from "./CryptoError.ts"
import * as Digest from "./Digest.ts"
import * as internal from "./internal/webCrypto.ts"
import * as Kdf from "./Kdf.ts"
import * as Mac from "./Mac.ts"
import * as SecureRandom from "./SecureRandom.ts"

/**
 * A password hashing algorithm: Argon2id or PBKDF2.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Algorithm = Kdf.Argon2id | Kdf.Pbkdf2

/**
 * A password hash with the algorithm and salt that produced it.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface PasswordHash {
  readonly algorithm: Algorithm
  readonly salt: Uint8Array
  readonly hash: Uint8Array
}

const digests: Record<string, Digest.Algorithm> = {
  sha1: Digest.sha1,
  sha256: Digest.sha256,
  sha384: Digest.sha384,
  sha512: Digest.sha512
}
const number = "(0|[1-9][0-9]*)"
const b64 = "([A-Za-z0-9+/]+)"
const argon2idPattern = new RegExp(`^\\$argon2id\\$v=19\\$m=${number},t=${number},p=${number}\\$${b64}\\$${b64}$`)
const pbkdf2Pattern = new RegExp(
  `^\\$pbkdf2-(${Object.keys(digests).join("|")})\\$i=${number}(?:,l=${number})?\\$${b64}\\$${b64}$`
)

const invalid = (description: string) =>
  internal.fail("Password", "decode", new CryptoError.InvalidArgument({ description }))

// PHC B64 is standard Base64 without padding. Re-encoding rejects
// non-canonical trailing bits.
const decodeB64 = (input: string): Uint8Array | undefined => {
  const bytes = Base64.decodeLenient(input)
  return Result.isSuccess(bytes) && Base64.encodeUnpadded(bytes.success) === input ? bytes.success : undefined
}

/**
 * Parses a PHC string into a {@link PasswordHash}.
 *
 * **Details**
 *
 * Accepts `$argon2id$v=19$m=<memory>,t=<passes>,p=<parallelism>$<salt>$<hash>`
 * and `$pbkdf2-<sha1|sha256|sha384|sha512>$i=<iterations>[,l=<length>]$<salt>$<hash>`,
 * where `l`, when present, must equal the hash length. Salt and hash are
 * Base64 without padding, and numbers are safe integers in decimal without
 * leading zeros.
 * Anything else, including other Argon2 versions and variants, bcrypt, and
 * scrypt, fails with an `InvalidArgument` reason. Costs are range-checked
 * when deriving, not here.
 *
 * **Example** (Reading the costs of a stored hash)
 *
 * ```ts import.meta.vitest
 * import { Effect } from "effect"
 * import { Password } from "effect/crypto"
 *
 * const stored = "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc"
 * const decoded = Effect.runSync(Password.decode(stored))
 * decoded.algorithm.name // => "argon2id"
 * Password.encode(decoded) === stored // => true
 * ```
 *
 * @stability unstable
 * @category encoding
 * @since 4.1.5
 */
export const decode = (phc: string): Effect.Effect<PasswordHash, CryptoError.CryptoError> =>
  Effect.suspend((): Effect.Effect<PasswordHash, CryptoError.CryptoError> => {
    const argon2id = argon2idPattern.exec(phc)
    const match = argon2id ?? pbkdf2Pattern.exec(phc)
    if (match === null) return invalid("expected an argon2id (v=19) or pbkdf2 PHC string")
    const salt = decodeB64(match[match.length - 2])
    const hash = decodeB64(match[match.length - 1])
    if (salt === undefined || hash === undefined) return invalid("salt and hash must be unpadded Base64")
    const costs = (argon2id === null ? match.slice(2, 4) : match.slice(1, 4)).map((n) =>
      n === undefined ? undefined : Number(n)
    )
    if (!costs.every((n) => n === undefined || Number.isSafeInteger(n))) return invalid("costs must be safe integers")
    if (argon2id !== null) {
      const [memory, passes, parallelism] = costs as Array<number>
      return Effect.succeed({ algorithm: Kdf.argon2id({ memory, passes, parallelism }), salt, hash })
    }
    const [iterations, length] = costs
    if (length !== undefined && length !== hash.length) return invalid("l must equal the hash length")
    return Effect.succeed({ algorithm: Kdf.pbkdf2({ hash: digests[match[1]], iterations: iterations! }), salt, hash })
  })

/**
 * Formats a {@link PasswordHash} as a PHC string.
 *
 * **Details**
 *
 * PBKDF2 hashes always include the `l` parameter.
 *
 * @stability unstable
 * @category encoding
 * @since 4.1.5
 */
export const encode = (hash: PasswordHash): string => {
  const length = hash.algorithm._tag === "Pbkdf2" ? `,l=${hash.hash.length}` : ""
  return `$${params(hash.algorithm)}${length}$${Base64.encodeUnpadded(hash.salt)}$${Base64.encodeUnpadded(hash.hash)}`
}

// The identifier and costs, which are what `needsRehash` compares.
const params = (algorithm: Algorithm): string =>
  algorithm._tag === "Argon2id"
    ? `argon2id$v=19$m=${algorithm.memory},t=${algorithm.passes},p=${algorithm.parallelism}`
    : `pbkdf2-${Digest.nameSuffix(algorithm.hash).toLowerCase()}$i=${algorithm.iterations}`

/**
 * Service that hashes and verifies passwords as PHC strings.
 *
 * **Example** (Hashing and verifying a password)
 *
 * ```ts import.meta.vitest
 * import { Effect, Layer } from "effect"
 * import { Digest, Kdf, Password, SecureRandom } from "effect/crypto"
 *
 * const program = Effect.gen(function*() {
 *   const passwords = yield* Password.Password
 *   const stored = yield* passwords.hash("hunter2")
 *   return yield* passwords.verify("hunter2", stored)
 * })
 *
 * const layer = Password.layer({ algorithm: Kdf.pbkdf2({ hash: Digest.sha256, iterations: 1_000 }) }).pipe(
 *   Layer.provide([Kdf.layerWebCrypto, SecureRandom.layerWebCrypto])
 * )
 * const valid = await Effect.runPromise(program.pipe(Effect.provide(layer)))
 * valid // => true
 * ```
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class Password extends Context.Service<Password, {
  /**
   * Hashes a password with the configured algorithm, a 16-byte random salt,
   * and a 32-byte output, returning the PHC string.
   */
  readonly hash: (password: string | Redacted.Redacted) => Effect.Effect<string, CryptoError.CryptoError>

  /**
   * Checks a password against a stored PHC string, using the algorithm and
   * salt it records. A wrong password is `false`; a malformed stored hash
   * fails with an `InvalidArgument` reason.
   */
  readonly verify: (
    password: string | Redacted.Redacted,
    hash: string
  ) => Effect.Effect<boolean, CryptoError.CryptoError>

  /**
   * Whether a stored PHC string differs from what `hash` would produce now:
   * another algorithm or cost, or a salt or output length other than 16 and
   * 32 bytes. Rehash the password after a successful `verify` when it is.
   */
  readonly needsRehash: (hash: string) => Effect.Effect<boolean, CryptoError.CryptoError>
}>()("effect/crypto/Password") {}

const saltLength = 16
const hashLength = 32
const encoder = new TextEncoder()

const toBytes = (password: string | Redacted.Redacted): Uint8Array =>
  encoder.encode(Redacted.isRedacted(password) ? Redacted.value(password) : password)

/**
 * Layer that provides {@link Password}, hashing new passwords with
 * `algorithm`.
 *
 * **Details**
 *
 * There is no default algorithm. `Kdf.argon2id()` and `Kdf.pbkdf2Sha256`
 * carry recommended costs; Argon2id fails with an `Unsupported` reason from
 * `Kdf` when the `Kdf` layer does not provide it.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = (options: {
  readonly algorithm: Algorithm
}): Layer.Layer<Password, never, Kdf.Kdf | SecureRandom.SecureRandom> =>
  Layer.effect(
    Password,
    Effect.gen(function*() {
      const kdf = yield* Kdf.Kdf
      const random = yield* SecureRandom.SecureRandom
      return Password.of({
        hash: Effect.fnUntraced(function*(password) {
          const salt = yield* random.randomBytes(saltLength)
          const hash = yield* kdf.derive(options.algorithm, toBytes(password), { salt, length: hashLength })
          return encode({ algorithm: options.algorithm, salt, hash })
        }),
        verify: Effect.fnUntraced(function*(password, stored) {
          const { algorithm, hash, salt } = yield* decode(stored)
          const derived = yield* kdf.derive(algorithm, toBytes(password), { salt, length: hash.length })
          return Mac.timingSafeEqual(derived, hash)
        }),
        needsRehash: (stored) =>
          Effect.map(
            decode(stored),
            ({ algorithm, hash, salt }) =>
              params(algorithm) !== params(options.algorithm) || salt.length !== saltLength ||
              hash.length !== hashLength
          )
      })
    })
  )
