import * as Aead from "effect/crypto/Aead";
import * as CryptoError from "effect/crypto/CryptoError";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Dpop from "./dpop";

/** T3NativeControls functions for the secure channel. The synchronous ones run once per frame. */
export interface NativeSecureChannelCrypto {
  /** A 32-byte P-256 private scalar followed by its 65-byte uncompressed public point. */
  generateDpopKey(): Promise<Uint8Array>;
  /** Throws when the point is not on P-256. */
  ecdhP256(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  hkdfSha256(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  /** The ciphertext followed by the 16-byte tag. */
  sealAes256Gcm(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Null when the tag does not match. */
  openAes256Gcm(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Uint8Array | null;
}

const FUNCTIONS = [
  "generateDpopKey",
  "ecdhP256",
  "hkdfSha256",
  "sealAes256Gcm",
  "openAes256Gcm",
] as const satisfies ReadonlyArray<keyof NativeSecureChannelCrypto>;

const isComplete = (
  native: Partial<NativeSecureChannelCrypto>,
): native is NativeSecureChannelCrypto =>
  FUNCTIONS.every((name) => typeof native[name] === "function");

const failure = (module: string, method: string, reason: CryptoError.CryptoErrorReason) =>
  new CryptoError.CryptoError({ module, method, reason });

const unsupported = (module: string, method: string, description: string, cause?: unknown) =>
  failure(module, method, new CryptoError.Unsupported({ description, cause }));

const withoutAad = (aad: Uint8Array) => {
  if (aad.length > 0) throw new Error("The native AES-256-GCM takes no additional data.");
};

// Effect builds ECDH private keys only through crypto.subtle, which Hermes lacks. These keys are
// opaque handles: only this service reads the native scalar behind one.
const privateScalars = new WeakMap<object, Uint8Array>();

export const layer = (native: NativeSecureChannelCrypto) =>
  Layer.mergeAll(
    Aead.layerWebCryptoWith({
      implementations: {
        aes256Gcm: {
          encrypt: (key, nonce, plaintext, aad) => {
            withoutAad(aad);
            return native.sealAes256Gcm(key, nonce, plaintext);
          },
          decrypt: (key, nonce, sealed, aad) => {
            withoutAad(aad);
            return native.openAes256Gcm(key, nonce, sealed) ?? undefined;
          },
        },
      },
    }),
    Layer.succeed(
      Kdf.Kdf,
      Kdf.Kdf.of({
        derive: Effect.fn("Kdf.derive")(function* (algorithm, secret, options) {
          if (algorithm.name !== Kdf.hkdfSha256.name) {
            return yield* unsupported("Kdf", "derive", algorithm.name);
          }
          return yield* Effect.try({
            try: () =>
              native.hkdfSha256(
                secret,
                options.salt,
                options.info ?? new Uint8Array(),
                options.length,
              ),
            catch: (cause) => unsupported("Kdf", "derive", String(cause), cause),
          });
        }),
      }),
    ),
    Layer.succeed(
      KeyAgreement.KeyAgreement,
      KeyAgreement.KeyAgreement.of({
        generateKeyPair: Effect.fn("KeyAgreement.generateKeyPair")(function* <
          A extends KeyAgreement.Algorithm,
        >(algorithm: A) {
          if (algorithm.name !== KeyAgreement.ecdhP256.name) {
            return yield* unsupported("KeyAgreement", "generateKeyPair", algorithm.name);
          }
          const pair = yield* Effect.tryPromise({
            try: () => native.generateDpopKey(),
            catch: (cause) => unsupported("KeyAgreement", "generateKeyPair", String(cause), cause),
          });
          const publicKey = yield* KeyAgreement.publicKey(algorithm, pair.subarray(32));
          const privateKey = { algorithm } as KeyAgreement.PrivateKey<A>;
          privateScalars.set(privateKey, pair.slice(0, 32));
          return { privateKey, publicKey };
        }),
        deriveSharedSecret: Effect.fn("KeyAgreement.deriveSharedSecret")(
          function* (privateKey, publicKey) {
            const invalid = (description: string, cause?: unknown) =>
              failure(
                "KeyAgreement",
                "deriveSharedSecret",
                new CryptoError.InvalidKey({ description, cause }),
              );
            const scalar = privateScalars.get(privateKey);
            if (scalar === undefined || publicKey.algorithm.name !== KeyAgreement.ecdhP256.name) {
              return yield* invalid("Expected a P-256 key pair from this layer");
            }
            const point = yield* KeyAgreement.toBytes(publicKey);
            return yield* Effect.try({
              try: () => native.ecdhP256(scalar, point),
              catch: (cause) => invalid("Invalid peer public key", cause),
            });
          },
        ),
        publicKeyOf: Effect.fn("KeyAgreement.publicKeyOf")(function* (privateKey) {
          return yield* unsupported("KeyAgreement", "publicKeyOf", privateKey.algorithm.name);
        }),
      }),
    ),
  ).pipe(Layer.provideMerge(Dpop.layer));

/**
 * The secure channel's crypto, or undefined when the installed binary predates the native
 * functions: JavaScript can update over the air without them, and then connects as before.
 */
export async function load() {
  try {
    const native = (await import("expo")).requireNativeModule<Partial<NativeSecureChannelCrypto>>(
      "T3NativeControls",
    );
    return isComplete(native) ? layer(native) : undefined;
  } catch {
    return undefined;
  }
}
