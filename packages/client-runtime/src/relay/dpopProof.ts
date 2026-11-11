// RFC 9449 DPoP proofs for relay requests. Platforms supply the key: web keeps a
// non-extractable WebCrypto key, mobile signs with the platform's P-256 through a native module.
import { normalizeDpopHtu, type DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import {
  ManagedRelayDpopKeyLoadError,
  ManagedRelayDpopProofCreationError,
  ManagedRelayDpopSigner,
} from "./managedRelay.ts";

export class DpopProofError extends Schema.TaggedError<DpopProofError>()("DpopProofError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A P-256 proof key. `sign` returns the raw `r‖s` ES256 signature over the JWS signing input. */
export interface DpopProofKey {
  readonly publicJwk: DpopPublicJwk;
  readonly sign: (signingInput: Uint8Array) => Effect.Effect<Uint8Array, DpopProofError>;
}

const utf8 = (value: string) => new TextEncoder().encode(value);
const encodeSegment = (value: unknown) => Base64Url.encode(utf8(JSON.stringify(value)));

const sha256Base64Url = (data: Uint8Array) =>
  Effect.flatMap(Digest.Digest, (digest) => digest.digest(Digest.sha256, data)).pipe(
    Effect.map(Base64Url.encode),
  );

/** RFC 7638 thumbprint: SHA-256 over the required members in lexicographic order. */
export const thumbprint = (jwk: DpopPublicJwk) =>
  sha256Base64Url(utf8(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));

export const createProof = Effect.fn("DpopProof.createProof")(function* (input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string | undefined;
  readonly key: DpopProofKey;
}) {
  const htu = normalizeDpopHtu(input.url);
  if (htu === null) return yield* new DpopProofError({ message: "DPoP URL is invalid." });
  const random = yield* SecureRandom.SecureRandom;
  const header = encodeSegment({ typ: "dpop+jwt", alg: "ES256", jwk: input.key.publicJwk });
  const payload = encodeSegment({
    htm: input.method.toUpperCase(),
    htu,
    jti: yield* random.uuidV4(),
    iat: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
    ...(input.accessToken ? { ath: yield* sha256Base64Url(utf8(input.accessToken)) } : {}),
  });
  const signature = yield* input.key.sign(utf8(`${header}.${payload}`));
  return `${header}.${payload}.${Base64Url.encode(signature)}`;
});

/** A relay DPoP signer that loads its key once and keeps it; a failed load is retried. */
export const layerSigner = <E, R>(options: {
  readonly keyStore: ManagedRelayDpopKeyLoadError["keyStore"];
  readonly loadOrCreateKey: Effect.Effect<DpopProofKey, E, R>;
}) =>
  Layer.effect(
    ManagedRelayDpopSigner,
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const digest = yield* Digest.Digest;
      const context = yield* Effect.context<R>();
      const keyCache = yield* Cache.makeWith(
        () =>
          options.loadOrCreateKey.pipe(
            Effect.flatMap((key) =>
              thumbprint(key.publicJwk).pipe(Effect.map((value) => ({ key, thumbprint: value }))),
            ),
            Effect.provideService(Digest.Digest, digest),
            Effect.provideContext(context),
          ),
        {
          capacity: 1,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
        },
      );
      const loadKey = Cache.get(keyCache, undefined);
      return ManagedRelayDpopSigner.of({
        thumbprint: loadKey.pipe(
          Effect.map((loaded) => loaded.thumbprint),
          Effect.mapError(
            (cause) => new ManagedRelayDpopKeyLoadError({ keyStore: options.keyStore, cause }),
          ),
          Effect.withSpan("managedRelayDpopSigner.loadThumbprint"),
        ),
        createProof: Effect.fn("managedRelayDpopSigner.createProof")(function* (input) {
          const creationError = (cause: unknown) =>
            new ManagedRelayDpopProofCreationError({ method: input.method, url: input.url, cause });
          const loaded = yield* loadKey.pipe(Effect.mapError(creationError));
          return yield* createProof({ ...input, key: loaded.key }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, random),
            Effect.provideService(Digest.Digest, digest),
            Effect.mapError(creationError),
          );
        }),
      });
    }),
  );
