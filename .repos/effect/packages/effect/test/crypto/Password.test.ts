import { assert, describe, it } from "@effect/vitest"
import * as Digest from "effect/crypto/Digest"
import * as Kdf from "effect/crypto/Kdf"
import * as Password from "effect/crypto/Password"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import { assertReason } from "../utils/crypto.ts"

const argon2 = "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc"

describe("Password", () => {
  it.effect("stores PBKDF2 parameters with the hash and detects when they need updating", () => {
    const algorithm = Kdf.pbkdf2({ hash: Digest.sha256, iterations: 2 })
    const random = SecureRandom.make((size) => Uint8Array.from({ length: size }, (_, i) => i))
    return Effect.gen(function*() {
      const passwords = yield* Password.Password
      const stored = yield* passwords.hash("password")
      // node:crypto pbkdf2Sync("password", salt, 2, 32, "sha256"), salt bytes 0..15.
      assert.strictEqual(
        stored,
        "$pbkdf2-sha256$i=2,l=32$AAECAwQFBgcICQoLDA0ODw$oP/TQpLk59UZ7g8lEk4MW5SB2IvkD0Zi62y0ueQ/n0E"
      )
      assert.isTrue(yield* passwords.verify("password", stored))
      assert.isFalse(yield* passwords.verify("wrong", stored))
      assert.isFalse(yield* passwords.needsRehash(stored))
      assert.isTrue(yield* passwords.needsRehash(stored.replace("i=2", "i=3")))
    }).pipe(
      Effect.provide(Password.layer({ algorithm })),
      Effect.provide(Kdf.layerWebCrypto),
      Effect.provideService(SecureRandom.SecureRandom, random)
    )
  })

  it.effect("round-trips canonical Argon2id and rejects malformed strings", () =>
    Effect.gen(function*() {
      assert.strictEqual(Password.encode(yield* Password.decode(argon2)), argon2)
      for (
        const malformed of [
          argon2 + "=",
          argon2.replace("t=2", "t=02"),
          argon2.replace("t=2", "t=9007199254740993"),
          argon2.replace("v=19", "v=16"),
          argon2.replace("argon2id", "argon2i"),
          argon2.slice(0, argon2.lastIndexOf("$"))
        ]
      ) {
        const error = yield* Effect.flip(Password.decode(malformed))
        assert.strictEqual(error.module, "Password")
        assertReason(error, "InvalidArgument")
      }
    }))
})
