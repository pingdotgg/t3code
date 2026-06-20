import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { p256 } from "@noble/curves/nist";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
} from "@t3tools/shared/dpop";

export class CloudDpopStorageError extends Schema.TaggedErrorClass<CloudDpopStorageError>()(
  "CloudDpopStorageError",
  {
    operation: Schema.Literals(["read", "decode", "restore", "encode", "write"]),
    storageKey: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile DPoP key storage operation "${this.operation}" failed for key "${this.storageKey}".`;
  }
}

export class CloudDpopKeyError extends Schema.TaggedErrorClass<CloudDpopKeyError>()(
  "CloudDpopKeyError",
  {
    operation: Schema.Literals(["generate-randomness", "derive-public-key"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile DPoP key operation "${this.operation}" failed.`;
  }
}

export class CloudDpopProofError extends Schema.TaggedErrorClass<CloudDpopProofError>()(
  "CloudDpopProofError",
  {
    operation: Schema.Literals([
      "import-private-key",
      "generate-id",
      "normalize-url",
      "encode-header",
      "encode-payload",
      "hash-signing-input",
      "sign",
    ]),
    method: Schema.String,
    url: Schema.String,
    normalizedUrl: Schema.optionalKey(Schema.String),
    thumbprint: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile DPoP proof operation "${this.operation}" failed for ${this.method.toUpperCase()} ${this.url}.`;
  }
}

export const CloudDpopError = Schema.Union([
  CloudDpopStorageError,
  CloudDpopKeyError,
  CloudDpopProofError,
]);
export type CloudDpopError = typeof CloudDpopError.Type;
export const isCloudDpopError = Schema.is(CloudDpopError);

const DpopPrivateJwkSchema = Schema.Struct({
  ...DpopPublicJwk.fields,
  d: Schema.String,
});

const DpopPrivateJwkJson = Schema.fromJsonString(DpopPrivateJwkSchema);
const decodeDpopPrivateJwkJson = Schema.decodeUnknownEffect(DpopPrivateJwkJson);
const encodeDpopPrivateJwkJson = Schema.encodeEffect(DpopPrivateJwkJson);

const DpopJwtHeaderJson = Schema.fromJsonString(
  Schema.Struct({
    typ: Schema.Literal("dpop+jwt"),
    alg: Schema.Literal("ES256"),
    jwk: DpopPublicJwk,
  }),
);

const DpopJwtPayloadJson = Schema.fromJsonString(
  Schema.Struct({
    htm: Schema.String,
    htu: Schema.String,
    jti: Schema.String,
    iat: Schema.Int,
    ath: Schema.optionalKey(Schema.String),
  }),
);

const encodeDpopJwtHeaderJson = Schema.encodeEffect(DpopJwtHeaderJson);
const encodeDpopJwtPayloadJson = Schema.encodeEffect(DpopJwtPayloadJson);

function toExpoDigestAlgorithm(
  algorithm: Crypto.DigestAlgorithm,
): ExpoCrypto.CryptoDigestAlgorithm {
  switch (algorithm) {
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

export const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: ExpoCrypto.getRandomBytes,
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await ExpoCrypto.digest(toExpoDigestAlgorithm(algorithm), input));
      }),
  }),
);

type DpopPrivateJwk = typeof DpopPrivateJwkSchema.Type;

export interface DpopProofKeyPair {
  readonly privateJwk: DpopPrivateJwk;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

const DPOP_PROOF_KEY_STORAGE_KEY = "t3code.cloud.dpop-proof-key";

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Encoding.decodeBase64Url(value));
}

function publicJwkFromUncompressedPublicKey(publicKey: Uint8Array): DpopPublicJwk {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("Generated DPoP public key is not an uncompressed P-256 point.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: Encoding.encodeBase64Url(publicKey.slice(1, 33)),
    y: Encoding.encodeBase64Url(publicKey.slice(33, 65)),
  };
}

function privateJwkFromPrivateKey(
  privateKey: Uint8Array,
  publicJwk: DpopPublicJwk,
): DpopPrivateJwk {
  return { ...publicJwk, d: Encoding.encodeBase64Url(privateKey) };
}

export function generateDpopProofKeyPair(): Effect.Effect<
  DpopProofKeyPair,
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    let privateKey: Uint8Array;
    do {
      privateKey = yield* Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomBytes(p256.CURVE.nByteLength)),
        Effect.mapError(
          (cause) => new CloudDpopKeyError({ operation: "generate-randomness", cause }),
        ),
      );
    } while (!p256.utils.isValidPrivateKey(privateKey));
    const publicJwk = yield* Effect.try({
      try: () => publicJwkFromUncompressedPublicKey(p256.getPublicKey(privateKey, false)),
      catch: (cause) => new CloudDpopKeyError({ operation: "derive-public-key", cause }),
    });
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    return {
      privateJwk: privateJwkFromPrivateKey(privateKey, publicJwk),
      publicJwk,
      thumbprint,
    };
  });
}

export function loadOrCreateDpopProofKeyPair(): Effect.Effect<
  DpopProofKeyPair,
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => SecureStore.getItemAsync(DPOP_PROOF_KEY_STORAGE_KEY),
      catch: (cause) =>
        new CloudDpopStorageError({
          operation: "read",
          storageKey: DPOP_PROOF_KEY_STORAGE_KEY,
          cause,
        }),
    });
    if (stored) {
      const storedPrivateJwk = yield* decodeDpopPrivateJwkJson(stored).pipe(
        Effect.mapError(
          (cause) =>
            new CloudDpopStorageError({
              operation: "decode",
              storageKey: DPOP_PROOF_KEY_STORAGE_KEY,
              cause,
            }),
        ),
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
        catch: (cause) =>
          new CloudDpopStorageError({
            operation: "restore",
            storageKey: DPOP_PROOF_KEY_STORAGE_KEY,
            cause,
          }),
      });
      return {
        ...restored,
        thumbprint: computeDpopJwkThumbprint(restored.publicJwk),
      };
    }
    const generated = yield* generateDpopProofKeyPair();
    const encodedPrivateJwk = yield* encodeDpopPrivateJwkJson(generated.privateJwk).pipe(
      Effect.mapError(
        (cause) =>
          new CloudDpopStorageError({
            operation: "encode",
            storageKey: DPOP_PROOF_KEY_STORAGE_KEY,
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      try: () => SecureStore.setItemAsync(DPOP_PROOF_KEY_STORAGE_KEY, encodedPrivateJwk),
      catch: (cause) =>
        new CloudDpopStorageError({
          operation: "write",
          storageKey: DPOP_PROOF_KEY_STORAGE_KEY,
          cause,
        }),
    });
    return generated;
  });
}

export function createDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
  readonly proofKey?: DpopProofKeyPair;
}): Effect.Effect<
  { readonly proof: string; readonly thumbprint: string },
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    const keyPair = input.proofKey ?? (yield* generateDpopProofKeyPair());
    const privateKey = yield* Effect.try({
      try: () => base64UrlToBytes(keyPair.privateJwk.d),
      catch: (cause) =>
        new CloudDpopProofError({
          operation: "import-private-key",
          method: input.method,
          url: input.url,
          thumbprint: keyPair.thumbprint,
          cause,
        }),
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const jti = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.mapError(
        (cause) =>
          new CloudDpopProofError({
            operation: "generate-id",
            method: input.method,
            url: input.url,
            thumbprint: keyPair.thumbprint,
            cause,
          }),
      ),
    );
    const htu = yield* Effect.try({
      try: () => {
        const parsed = new URL(input.url);
        parsed.hash = "";
        parsed.search = "";
        return parsed.toString();
      },
      catch: (cause) =>
        new CloudDpopProofError({
          operation: "normalize-url",
          method: input.method,
          url: input.url,
          thumbprint: keyPair.thumbprint,
          cause,
        }),
    });
    const header = yield* encodeDpopJwtHeaderJson({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    }).pipe(
      Effect.map(Encoding.encodeBase64Url),
      Effect.mapError(
        (cause) =>
          new CloudDpopProofError({
            operation: "encode-header",
            method: input.method,
            url: input.url,
            normalizedUrl: htu,
            thumbprint: keyPair.thumbprint,
            cause,
          }),
      ),
    );
    const ath = input.accessToken ? computeDpopAccessTokenHash(input.accessToken) : null;
    const payload = yield* encodeDpopJwtPayloadJson({
      htm: input.method.toUpperCase(),
      htu,
      jti,
      iat: Math.floor(nowMs / 1_000),
      ...(ath ? { ath } : {}),
    }).pipe(
      Effect.map(Encoding.encodeBase64Url),
      Effect.mapError(
        (cause) =>
          new CloudDpopProofError({
            operation: "encode-payload",
            method: input.method,
            url: input.url,
            normalizedUrl: htu,
            thumbprint: keyPair.thumbprint,
            cause,
          }),
      ),
    );
    const signatureInputHash = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) =>
        crypto.digest("SHA-256", new TextEncoder().encode(`${header}.${payload}`)),
      ),
      Effect.mapError(
        (cause) =>
          new CloudDpopProofError({
            operation: "hash-signing-input",
            method: input.method,
            url: input.url,
            normalizedUrl: htu,
            thumbprint: keyPair.thumbprint,
            cause,
          }),
      ),
    );
    const signature = yield* Effect.try({
      try: () => p256.sign(signatureInputHash, privateKey, { prehash: false }).toCompactRawBytes(),
      catch: (cause) =>
        new CloudDpopProofError({
          operation: "sign",
          method: input.method,
          url: input.url,
          normalizedUrl: htu,
          thumbprint: keyPair.thumbprint,
          cause,
        }),
    });
    return {
      proof: `${header}.${payload}.${Encoding.encodeBase64Url(signature)}`,
      thumbprint: keyPair.thumbprint,
    };
  });
}
