import { assert, describe, it } from "@effect/vitest";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";

import { SecureChannelError } from "./secureChannel.ts";
import {
  makeSecureHttpClientSession,
  makeSecureHttpExchange,
  type SecureHttpInnerRequest,
  verifySecureHttpKey,
} from "./secureHttp.ts";

const layer = Layer.mergeAll(
  Aead.layerWebCrypto,
  Kdf.layerWebCrypto,
  KeyAgreement.layerWebCrypto,
  Digest.layerWebCrypto,
  Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const ENVIRONMENT_ID = "environment-1";

const makeEnvironment = Effect.fnUntraced(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.orDie(signature.generateKeyPair(Signature.ed25519));
  const identityKey = yield* Effect.orDie(Signature.toBytes(pair.publicKey));
  const exchange = yield* makeSecureHttpExchange({
    environmentId: ENVIRONMENT_ID,
    issuedAt: "2026-11-24T00:00:00.000Z",
    identity: {
      publicKey: identityKey,
      sign: (message) =>
        signature
          .sign(pair.privateKey, message)
          .pipe(
            Effect.mapError((cause) => new SecureChannelError({ reason: "crypto_failure", cause })),
          ),
    },
  });
  const exchangePublicKey = verifySecureHttpKey({
    pinned: identityKey,
    environmentId: ENVIRONMENT_ID,
    key: exchange.key,
  });
  assert.isDefined(exchangePublicKey);
  const client = yield* makeSecureHttpClientSession(exchangePublicKey!);
  return { identityKey, exchange, client };
});

const request: SecureHttpInnerRequest = {
  method: "POST",
  url: "https://environment.example/api/auth/websocket-ticket/rpc",
  headers: { authorization: "DPoP token", dpop: "proof", "content-type": "application/json" },
  body: new TextEncoder().encode('{"hello":"world"}'),
};

const flip = (bytes: Uint8Array, index: number) => {
  const copy = bytes.slice();
  copy[index]! ^= 0x01;
  return copy;
};

describe("secureHttp", () => {
  it.effect("round-trips a request and its response", () =>
    Effect.gen(function* () {
      const { exchange, client } = yield* makeEnvironment();
      const sealed = yield* client.seal(request);
      const opened = yield* exchange.open(sealed.envelope);
      assert.deepStrictEqual(
        { ...opened.request, body: [...opened.request.body] },
        { ...request, body: [...request.body] },
      );
      const response = yield* sealed.open(
        yield* opened.seal({
          status: 201,
          headers: { "content-type": "text/plain" },
          body: new TextEncoder().encode("ok"),
        }),
      );
      assert.strictEqual(response.status, 201);
      assert.deepStrictEqual(response.headers, { "content-type": "text/plain" });
      assert.strictEqual(new TextDecoder().decode(response.body), "ok");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an envelope or response with any byte changed", () =>
    Effect.gen(function* () {
      const { exchange, client } = yield* makeEnvironment();
      const sealed = yield* client.seal(request);
      const indexes = [0, 7, 8, 40, 72, 73, 88, 89, sealed.envelope.length - 1];
      for (const index of indexes) {
        const error = yield* Effect.flip(exchange.open(flip(sealed.envelope, index)));
        assert.include(
          ["unknown_key", "decryption_failed", "crypto_failure"],
          error.reason,
          `byte ${index}`,
        );
      }
      assert.strictEqual(
        (yield* Effect.flip(exchange.open(sealed.envelope.subarray(0, 50)))).reason,
        "malformed_message",
      );
      const response = yield* (yield* exchange.open(sealed.envelope)).seal({
        status: 200,
        headers: {},
        body: new Uint8Array(4),
      });
      for (const index of [0, 11, 12, response.length - 1]) {
        assert.strictEqual(
          (yield* Effect.flip(sealed.open(flip(response, index)))).reason,
          "decryption_failed",
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("cannot open a response with another request's keys", () =>
    Effect.gen(function* () {
      const { exchange, client } = yield* makeEnvironment();
      const first = yield* client.seal(request);
      const second = yield* client.seal(request);
      const response = yield* (yield* exchange.open(first.envelope)).seal({
        status: 200,
        headers: {},
        body: new Uint8Array(0),
      });
      assert.strictEqual((yield* Effect.flip(second.open(response))).reason, "decryption_failed");
      assert.strictEqual((yield* first.open(response)).status, 200);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("seals each response to a replayed envelope with its own nonce", () =>
    Effect.gen(function* () {
      const { exchange, client } = yield* makeEnvironment();
      const sealed = yield* client.seal(request);
      const response = { status: 200, headers: {}, body: new Uint8Array(8) };
      const first = yield* (yield* exchange.open(sealed.envelope)).seal(response);
      const replayed = yield* (yield* exchange.open(sealed.envelope)).seal(response);
      assert.notDeepEqual([...first.subarray(0, 12)], [...replayed.subarray(0, 12)]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names a key the environment no longer holds", () =>
    Effect.gen(function* () {
      const before = yield* makeEnvironment();
      const restarted = yield* makeEnvironment();
      const sealed = yield* before.client.seal(request);
      assert.strictEqual(
        (yield* Effect.flip(restarted.exchange.open(sealed.envelope))).reason,
        "unknown_key",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a forged or wrongly signed exchange key", () =>
    Effect.gen(function* () {
      const { identityKey, exchange } = yield* makeEnvironment();
      const other = yield* makeEnvironment();
      const verify = (overrides: {
        readonly pinned?: Uint8Array;
        readonly environmentId?: string;
        readonly key?: Partial<typeof exchange.key>;
      }) =>
        verifySecureHttpKey({
          pinned: overrides.pinned ?? identityKey,
          environmentId: overrides.environmentId ?? ENVIRONMENT_ID,
          key: { ...exchange.key, ...overrides.key },
        });
      assert.isDefined(verify({}));
      assert.isUndefined(verify({ pinned: other.identityKey }));
      assert.isUndefined(verify({ environmentId: "environment-2" }));
      assert.isUndefined(verify({ key: { issuedAt: "2027-01-01T00:00:00.000Z" } }));
      assert.isUndefined(verify({ key: { publicKey: other.exchange.key.publicKey } }));
      assert.isUndefined(verify({ key: { signature: other.exchange.key.signature } }));
      const signature = Base64Url.decode(exchange.key.signature);
      assert.isTrue(signature._tag === "Success");
      if (signature._tag === "Success") {
        assert.isUndefined(
          verify({ key: { signature: Base64Url.encode(flip(signature.success, 3)) } }),
        );
      }
      assert.isUndefined(verify({ key: { publicKey: "not base64!" } }));
    }).pipe(Effect.provide(layer)),
  );
});
