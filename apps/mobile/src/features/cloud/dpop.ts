import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { p256 } from "@noble/curves/nist";
import { DpopProof } from "@t3tools/client-runtime/relay";
import { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Layer from "effect/Layer";

export class CloudDpopError extends Data.TaggedError("CloudDpopError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
      digestHex: (algorithm, data) => Effect.map(digest(algorithm, data), Hex.encode),
    }),
  ),
);

type DpopPrivateJwk = typeof DpopPrivateJwkSchema.Type;

export interface DpopProofKeyPair {
  readonly privateJwk: DpopPrivateJwk;
  readonly publicJwk: DpopPublicJwk;
}

const DPOP_PROOF_KEY_STORAGE_KEY = "t3code.cloud.dpop-proof-key";

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Base64Url.decode(value));
}

function sha256Digest(
  data: Uint8Array,
  message: string,
): Effect.Effect<Uint8Array, CloudDpopError, Digest.Digest> {
  return Digest.Digest.pipe(
    Effect.flatMap((service) => service.digest(Digest.sha256, data)),
    Effect.mapError(cloudDpopError(message)),
  );
}

function secureRandomBytes(
  byteCount: number,
  message: string,
): Effect.Effect<Uint8Array, CloudDpopError, SecureRandom.SecureRandom> {
  return SecureRandom.SecureRandom.pipe(
    Effect.flatMap((random) => random.randomBytes(byteCount)),
    Effect.mapError(cloudDpopError(message)),
  );
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
  function* (): Effect.fn.Return<
    DpopProofKeyPair,
    CloudDpopError,
    SecureRandom.SecureRandom | Digest.Digest
  > {
    let privateKey: Uint8Array;
    do {
      privateKey = yield* secureRandomBytes(
        p256.CURVE.nByteLength,
        "Could not generate DPoP key pair randomness.",
      );
    } while (!p256.utils.isValidPrivateKey(privateKey));
    const publicJwk = yield* Effect.try({
      try: () => publicJwkFromUncompressedPublicKey(p256.getPublicKey(privateKey, false)),
      catch: cloudDpopError("Generated DPoP public key is invalid."),
    });
    return { privateJwk: privateJwkFromPrivateKey(privateKey, publicJwk), publicJwk };
  },
);

export const loadOrCreateDpopProofKeyPair = Effect.fn("dpop.loadOrCreateDpopProofKeyPair")(
  function* (): Effect.fn.Return<
    DpopProofKeyPair,
    CloudDpopError,
    SecureRandom.SecureRandom | Digest.Digest
  > {
    const stored = yield* Effect.tryPromise({
      try: () => SecureStore.getItemAsync(DPOP_PROOF_KEY_STORAGE_KEY),
      catch: cloudDpopError("Could not read the DPoP proof key."),
    });
    if (stored) {
      const storedPrivateJwk = yield* decodeDpopPrivateJwkJson(stored).pipe(
        Effect.mapError(cloudDpopError("Stored DPoP proof key is invalid.")),
      );
      const restored = yield* Effect.try({
        try: () => {
          const privateKey = base64UrlToBytes(storedPrivateJwk.d);
          const publicJwk = publicJwkFromUncompressedPublicKey(
            p256.getPublicKey(privateKey, false),
          );
          if (publicJwk.x !== storedPrivateJwk.x || publicJwk.y !== storedPrivateJwk.y) {
            throw new Error("Stored DPoP key does not match its public key.");
          }
          return { privateJwk: storedPrivateJwk, publicJwk };
        },
        catch: cloudDpopError("Stored DPoP proof key is invalid."),
      });
      return restored;
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

/** The installation's DPoP key, signing with @noble/curves over an Expo SHA-256 digest. */
export const loadOrCreateProofKey = Effect.fn("dpop.loadOrCreateProofKey")(function* () {
  const digest = yield* Digest.Digest;
  const keyPair = yield* loadOrCreateDpopProofKeyPair();
  const privateKey = yield* Effect.try({
    try: () => base64UrlToBytes(keyPair.privateJwk.d),
    catch: cloudDpopError("Could not import DPoP private key."),
  });
  return {
    publicJwk: keyPair.publicJwk,
    sign: (signingInput) =>
      sha256Digest(signingInput, "Could not hash DPoP signing input.").pipe(
        Effect.provideService(Digest.Digest, digest),
        Effect.flatMap((hash) =>
          Effect.try({
            try: () => p256.sign(hash, privateKey, { prehash: false }).toCompactRawBytes(),
            catch: cloudDpopError("Could not sign DPoP proof."),
          }),
        ),
        Effect.mapError(
          (cause) => new DpopProof.DpopProofError({ message: "Could not sign DPoP proof.", cause }),
        ),
      ),
  } satisfies DpopProof.DpopProofKey;
});
