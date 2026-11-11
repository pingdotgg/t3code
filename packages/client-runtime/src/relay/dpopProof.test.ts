import { describe, expect, it } from "@effect/vitest";
import { DpopPublicJwk, verifyDpopProof } from "@t3tools/shared/dpop";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as DpopProof from "./dpopProof.ts";

const decodePublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

const layer = Layer.mergeAll(Digest.layerWebCrypto, Signature.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

// Mirrors the web adapter: a non-extractable WebCrypto key signed through Signature.
const webCryptoProofKey = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.promise(
    () =>
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
  );
  const publicJwk = yield* Effect.promise(() =>
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ).pipe(Effect.flatMap(decodePublicJwk), Effect.orDie);
  const privateKey = yield* Signature.privateKeyFromCryptoKey(
    Signature.ecdsaP256,
    pair.privateKey,
  ).pipe(Effect.orDie);
  return {
    publicJwk,
    sign: (data) => signature.sign(privateKey, data).pipe(Effect.orDie),
  } satisfies DpopProof.DpopProofKey;
});

describe("DpopProof", () => {
  it.effect("creates proofs the relay verifier accepts, with htu normalized and ath bound", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);
      const key = yield* webCryptoProofKey;
      const thumbprint = yield* DpopProof.thumbprint(key.publicJwk);
      const url = "https://relay.example.test/v1/environments/env-1/connect?debug=1#ignored";
      const proof = yield* DpopProof.createProof({
        method: "post",
        url,
        accessToken: "relay-access-token",
        key,
      });

      expect(
        verifyDpopProof({
          proof,
          method: "POST",
          url,
          expectedThumbprint: thumbprint,
          expectedAccessToken: "relay-access-token",
          nowEpochSeconds: 1_700_000_000,
        }),
      ).toMatchObject({ ok: true, thumbprint });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects an unparseable URL before signing", () =>
    Effect.gen(function* () {
      const key = yield* webCryptoProofKey;
      const error = yield* Effect.flip(
        DpopProof.createProof({ method: "GET", url: "not a url", key }),
      );
      expect(error.message).toBe("DPoP URL is invalid.");
    }).pipe(Effect.provide(layer)),
  );
});
