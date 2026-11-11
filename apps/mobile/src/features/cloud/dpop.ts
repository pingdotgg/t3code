import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { DpopProof } from "@t3tools/client-runtime/relay";
import { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Layer from "effect/Layer";

export class CloudDpopError extends Schema.TaggedError<CloudDpopError>()("CloudDpopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

function cloudDpopError(message: string) {
  return (cause: unknown) => new CloudDpopError({ message, cause });
}

const DpopPrivateJwkSchema = Schema.Struct({
  ...DpopPublicJwk.fields,
  d: Schema.String,
});

const DpopPrivateJwkJson = Schema.fromJsonString(DpopPrivateJwkSchema);
const decodeDpopPrivateJwkJson = Schema.decodeUnknownEffect(DpopPrivateJwkJson);
const encodeDpopPrivateJwkJson = Schema.encodeEffect(DpopPrivateJwkJson);

function toExpoDigestAlgorithm(algorithm: Digest.Algorithm): ExpoCrypto.CryptoDigestAlgorithm {
  switch (algorithm.name) {
    case "MD5":
      return ExpoCrypto.CryptoDigestAlgorithm.MD5;
    case "SHA-1":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA1;
    case "SHA-256":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA256;
    case "SHA-384":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA384;
    case "SHA-512":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA512;
  }
}

// Hermes has no SubtleCrypto, so Effect's WebCrypto layers cannot back these services.
const digest = (algorithm: Digest.Algorithm, data: Uint8Array) =>
  Effect.promise(async () => {
    const input = new Uint8Array(data.length);
    input.set(data);
    return new Uint8Array(await ExpoCrypto.digest(toExpoDigestAlgorithm(algorithm), input));
  });

export const layer = Layer.mergeAll(
  Layer.succeed(SecureRandom.SecureRandom, SecureRandom.make(ExpoCrypto.getRandomBytes)),
  Layer.succeed(
    Digest.Digest,
    Digest.Digest.of({
      digest,
      digestHex: Effect.fn("Digest.Digest.digestHex")((algorithm, data) =>
        Effect.map(digest(algorithm, data), Hex.encode),
      ),
    }),
  ),
);

type DpopPrivateJwk = typeof DpopPrivateJwkSchema.Type;

export interface DpopProofKeyPair {
  readonly privateJwk: DpopPrivateJwk;
  readonly publicJwk: DpopPublicJwk;
}

const DPOP_PROOF_KEY_STORAGE_KEY = "t3code.cloud.dpop-proof-key";

interface NativeDpopKeys {
  /** A 32-byte private scalar followed by its 65-byte uncompressed public point. */
  generateDpopKey(): Promise<Uint8Array>;
  dpopKeyMatches(privateKey: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
  /** ES256 over the signing input, as the raw 64-byte `r‖s` pair. */
  signDpop(privateKey: Uint8Array, signingInput: Uint8Array): Promise<Uint8Array>;
}

// Platform crypto: in Hermes, @noble/curves blocks JS for about a second on its first P-256 key.
// Imported lazily: loading `expo` at module scope breaks Node tests that import this file.
const nativeDpopKeys = async () =>
  (await import("expo")).requireNativeModule<NativeDpopKeys>("T3NativeControls");

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Base64Url.decode(value));
}

function coordinateBytes(value: string): Uint8Array {
  const bytes = base64UrlToBytes(value);
  if (bytes.length !== 32 || Base64Url.encode(bytes) !== value) {
    throw new Error("DPoP key coordinate is not 32 canonical bytes.");
  }
  return bytes;
}

function uncompressedPublicKeyFromJwk(jwk: DpopPublicJwk): Uint8Array {
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(coordinateBytes(jwk.x), 1);
  publicKey.set(coordinateBytes(jwk.y), 33);
  return publicKey;
}

function publicJwkFromUncompressedPublicKey(publicKey: Uint8Array): DpopPublicJwk {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("Generated DPoP public key is not an uncompressed P-256 point.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: Base64Url.encode(publicKey.slice(1, 33)),
    y: Base64Url.encode(publicKey.slice(33, 65)),
  };
}

function privateJwkFromPrivateKey(
  privateKey: Uint8Array,
  publicJwk: DpopPublicJwk,
): DpopPrivateJwk {
  return { ...publicJwk, d: Base64Url.encode(privateKey) };
}

export const generateDpopProofKeyPair = Effect.fn("dpop.generateDpopProofKeyPair")(
  function* (): Effect.fn.Return<DpopProofKeyPair, CloudDpopError> {
    const key = yield* Effect.tryPromise({
      try: async () => (await nativeDpopKeys()).generateDpopKey(),
      catch: cloudDpopError("Could not generate the DPoP key pair."),
    });
    const publicJwk = yield* Effect.try({
      try: () => publicJwkFromUncompressedPublicKey(key.slice(32)),
      catch: cloudDpopError("Generated DPoP public key is invalid."),
    });
    return { privateJwk: privateJwkFromPrivateKey(key.slice(0, 32), publicJwk), publicJwk };
  },
);

export const loadOrCreateDpopProofKeyPair = Effect.fn("dpop.loadOrCreateDpopProofKeyPair")(
  function* (): Effect.fn.Return<DpopProofKeyPair, CloudDpopError> {
    const stored = yield* Effect.tryPromise({
      try: () => SecureStore.getItemAsync(DPOP_PROOF_KEY_STORAGE_KEY),
      catch: cloudDpopError("Could not read the DPoP proof key."),
    });
    if (stored) {
      const storedPrivateJwk = yield* decodeDpopPrivateJwkJson(stored).pipe(
        Effect.mapError(cloudDpopError("Stored DPoP proof key is invalid.")),
      );
      const { d, ...publicJwk } = storedPrivateJwk;
      const matches = yield* Effect.tryPromise({
        try: async () =>
          (await nativeDpopKeys()).dpopKeyMatches(
            base64UrlToBytes(d),
            uncompressedPublicKeyFromJwk(publicJwk),
          ),
        catch: cloudDpopError("Stored DPoP proof key is invalid."),
      });
      if (!matches) {
        return yield* new CloudDpopError({ message: "Stored DPoP proof key is invalid." });
      }
      return { privateJwk: storedPrivateJwk, publicJwk };
    }
    const generated = yield* generateDpopProofKeyPair();
    const encodedPrivateJwk = yield* encodeDpopPrivateJwkJson(generated.privateJwk).pipe(
      Effect.mapError(cloudDpopError("Could not encode the DPoP proof key.")),
    );
    yield* Effect.tryPromise({
      try: () => SecureStore.setItemAsync(DPOP_PROOF_KEY_STORAGE_KEY, encodedPrivateJwk),
      catch: cloudDpopError("Could not store the DPoP proof key."),
    });
    return generated;
  },
);

/** The installation's DPoP key, signing with the platform's P-256. */
export const loadOrCreateProofKey = Effect.fn("dpop.loadOrCreateProofKey")(function* () {
  const keyPair = yield* loadOrCreateDpopProofKeyPair();
  const privateKey = yield* Effect.try({
    try: () => base64UrlToBytes(keyPair.privateJwk.d),
    catch: cloudDpopError("Could not import DPoP private key."),
  });
  return {
    publicJwk: keyPair.publicJwk,
    sign: (signingInput) =>
      Effect.tryPromise({
        try: async () => (await nativeDpopKeys()).signDpop(privateKey, signingInput),
        catch: (cause) =>
          new DpopProof.DpopProofError({ message: "Could not sign DPoP proof.", cause }),
      }),
  } satisfies DpopProof.DpopProofKey;
});
