import * as NodeCrypto from "node:crypto";

import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { ApnsCredentials } from "../Config.ts";

export class ApnsJwtEncodingError extends Schema.TaggedErrorClass<ApnsJwtEncodingError>()(
  "ApnsJwtEncodingError",
  {
    component: Schema.Literals(["header", "payload"]),
    teamId: Schema.String,
    keyId: Schema.String,
    issuedAtUnixSeconds: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode APNs JWT ${this.component} for key ${this.keyId}.`;
  }
}

export class ApnsJwtSigningError extends Schema.TaggedErrorClass<ApnsJwtSigningError>()(
  "ApnsJwtSigningError",
  {
    teamId: Schema.String,
    keyId: Schema.String,
    issuedAtUnixSeconds: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sign APNs JWT for key ${this.keyId}.`;
  }
}

export type ApnsJwtError = ApnsJwtEncodingError | ApnsJwtSigningError;

const encodeApnsJwtHeaderJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      alg: Schema.Literal("ES256"),
      kid: Schema.String,
    }),
  ),
);
const encodeApnsJwtPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      iss: Schema.String,
      iat: Schema.Number,
    }),
  ),
);

export interface ApnsJwtSigningInput {
  readonly teamId: ApnsCredentials["teamId"];
  readonly keyId: ApnsCredentials["keyId"];
  readonly privateKey: ApnsCredentials["privateKey"];
  readonly issuedAtUnixSeconds: number;
}

export const makeApnsJwt = Effect.fn("relay.apns.make_jwt")(function* (input: ApnsJwtSigningInput) {
  const headerJson = yield* encodeApnsJwtHeaderJson({ alg: "ES256", kid: input.keyId }).pipe(
    Effect.mapError(
      (cause) =>
        new ApnsJwtEncodingError({
          component: "header",
          teamId: input.teamId,
          keyId: input.keyId,
          issuedAtUnixSeconds: input.issuedAtUnixSeconds,
          cause,
        }),
    ),
  );
  const payloadJson = yield* encodeApnsJwtPayloadJson({
    iss: input.teamId,
    iat: input.issuedAtUnixSeconds,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ApnsJwtEncodingError({
          component: "payload",
          teamId: input.teamId,
          keyId: input.keyId,
          issuedAtUnixSeconds: input.issuedAtUnixSeconds,
          cause,
        }),
    ),
  );

  const privateKey = Redacted.value(input.privateKey);
  const header = Encoding.encodeBase64Url(headerJson);
  const payload = Encoding.encodeBase64Url(payloadJson);
  const signingInput = `${header}.${payload}`;

  return yield* Effect.try({
    try: () => {
      // Deterministic ES256 (RFC 6979 via noble) instead of node's randomized
      // signer: identical (key, iat) yields the byte-identical JWT on every
      // worker isolate, so the fleet presents one stable provider token to
      // APNs without any shared storage. Node crypto only converts the PEM to
      // the raw scalar noble signs with.
      const scalar = apnsSigningScalar(privateKey);
      const signature = p256
        .sign(sha256(new TextEncoder().encode(signingInput)), scalar, { prehash: false })
        .toCompactRawBytes();
      return `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
    },
    catch: (cause) =>
      new ApnsJwtSigningError({
        teamId: input.teamId,
        keyId: input.keyId,
        issuedAtUnixSeconds: input.issuedAtUnixSeconds,
        cause,
      }),
  });
});

// PEM parsing is pure and the key set is static per deployment; memoize the
// extracted P-256 scalar so signing never re-parses the PKCS8 document.
const signingScalarCache = new Map<string, Uint8Array>();

function apnsSigningScalar(privateKeyPem: string): Uint8Array {
  const cached = signingScalarCache.get(privateKeyPem);
  if (cached) {
    return cached;
  }
  const jwk = NodeCrypto.createPrivateKey(privateKeyPem.replace(/\\n/g, "\n")).export({
    format: "jwk",
  });
  if (jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    throw new Error("APNs signing key is not a P-256 private key.");
  }
  const scalar = Result.getOrThrowWith(
    Encoding.decodeBase64Url(jwk.d),
    () => new Error("APNs signing key scalar is not valid base64url."),
  );
  signingScalarCache.set(privateKeyPem, scalar);
  return scalar;
}

// Fingerprint the key material so rotated credentials never reuse a JWT
// signed by the previous key.
export function apnsProviderTokenCacheKey(input: {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: ApnsCredentials["privateKey"];
}): string {
  const keyFingerprint = NodeCrypto.createHash("sha256")
    .update(Redacted.value(input.privateKey))
    .digest("hex")
    .slice(0, 16);
  return `${input.teamId}:${input.keyId}:${keyFingerprint}`;
}
