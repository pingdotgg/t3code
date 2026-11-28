import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";

const PREFIX = "v1:";
const NONCE_BYTES = 12;

export class SealedEmailFailed extends Schema.TaggedError<SealedEmailFailed>()(
  "SealedEmailFailed",
  {
    reason: Schema.Literals(["bad-key", "malformed", "crypto"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isSealedEmailFailed = Schema.is(SealedEmailFailed);
const wrapCrypto = (cause: unknown) =>
  isSealedEmailFailed(cause) ? cause : new SealedEmailFailed({ reason: "crypto", cause });

const importKey = (secret: Redacted.Redacted<string>) => {
  const bytes = Base64.decode(Redacted.value(secret).trim());
  if (Result.isFailure(bytes) || bytes.success.length !== 32) {
    // ACCOUNT_EMAIL_KEY must be 32 bytes, base64-encoded.
    return Effect.fail(new SealedEmailFailed({ reason: "bad-key" }));
  }
  return Aead.key(Aead.aes256Gcm, bytes.success);
};

// The user id is the additional data, so an address sealed for one account can't be moved to
// another. Random nonces are safe here: far fewer than 2^32 addresses are sealed under one key.
export const seal = Effect.fn("relay.sealed_email.seal")(function* (
  secret: Redacted.Redacted<string>,
  input: { readonly userId: string; readonly email: string },
) {
  const aead = yield* Aead.Aead;
  const random = yield* SecureRandom.SecureRandom;
  const key = yield* importKey(secret);
  const nonce = yield* random.randomBytes(NONCE_BYTES);
  const ciphertext = yield* aead.encrypt(key, new TextEncoder().encode(input.email), {
    nonce,
    aad: new TextEncoder().encode(input.userId),
  });
  const sealed = new Uint8Array(NONCE_BYTES + ciphertext.length);
  sealed.set(nonce);
  sealed.set(ciphertext, NONCE_BYTES);
  return PREFIX + Base64.encode(sealed);
}, Effect.mapError(wrapCrypto));

export const open = Effect.fn("relay.sealed_email.open")(function* (
  secret: Redacted.Redacted<string>,
  input: { readonly userId: string; readonly sealed: string },
) {
  if (!input.sealed.startsWith(PREFIX)) {
    return yield* new SealedEmailFailed({ reason: "malformed" });
  }
  const bytes = Base64.decode(input.sealed.slice(PREFIX.length));
  if (Result.isFailure(bytes) || bytes.success.length <= NONCE_BYTES) {
    return yield* new SealedEmailFailed({ reason: "malformed" });
  }
  const aead = yield* Aead.Aead;
  const key = yield* importKey(secret);
  const plaintext = yield* aead.decrypt(key, bytes.success.subarray(NONCE_BYTES), {
    nonce: bytes.success.subarray(0, NONCE_BYTES),
    aad: new TextEncoder().encode(input.userId),
  });
  return new TextDecoder().decode(plaintext);
}, Effect.mapError(wrapCrypto));
