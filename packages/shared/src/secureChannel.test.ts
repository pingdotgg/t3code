import { assert, describe, it } from "@effect/vitest";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  initiateSecureChannel,
  respondSecureChannel,
  type SecureChannel,
  SecureChannelError,
  type SecureChannelIdentity,
  type SecureChannelVerifyPeer,
} from "./secureChannel.ts";

const layer = Layer.mergeAll(
  Aead.layerWebCrypto,
  Kdf.layerWebCrypto,
  KeyAgreement.layerWebCrypto,
  Digest.layerWebCrypto,
  Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const bytes = (text: string) => new TextEncoder().encode(text);
const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/** A key pair plus the check the other end runs once it has pinned this public key. */
const makeParty = Effect.fnUntraced(function* (algorithm: Signature.Algorithm) {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.orDie(signature.generateKeyPair(algorithm));
  const publicKey = yield* Effect.orDie(Signature.toBytes(pair.publicKey));
  const identity: SecureChannelIdentity = {
    publicKey,
    sign: (message) =>
      signature
        .sign(pair.privateKey, message)
        .pipe(
          Effect.mapError((cause) => new SecureChannelError({ reason: "crypto_failure", cause })),
        ),
  };
  const pinned: SecureChannelVerifyPeer = (input) =>
    sameBytes(input.publicKey, publicKey)
      ? signature
          .verify(pair.publicKey, input.signature, input.message)
          .pipe(Effect.orElseSucceed(() => false))
      : Effect.succeed(false);
  return { identity, pinned };
});

type Tamper = (message: Uint8Array) => Uint8Array;
const untouched: Tamper = (message) => message;

interface Scenario {
  readonly clientContext?: Uint8Array;
  readonly clientTrusts?: SecureChannelVerifyPeer;
  readonly environmentTrusts?: SecureChannelVerifyPeer;
  /** What the tunnel does to each handshake message on its way through. */
  readonly clientHello?: Tamper;
  readonly environmentHello?: Tamper;
  readonly clientFinish?: Tamper;
}

const context = bytes("environment-1");

const handshake = Effect.fnUntraced(function* (scenario: Scenario = {}) {
  const client = yield* makeParty(Signature.ecdsaP256);
  const environment = yield* makeParty(Signature.ed25519);
  const initiated = yield* initiateSecureChannel({
    context: scenario.clientContext ?? context,
    identity: client.identity,
    verifyPeer: scenario.clientTrusts ?? environment.pinned,
  });
  const responded = yield* respondSecureChannel({
    context,
    identity: environment.identity,
    verifyPeer: scenario.environmentTrusts ?? client.pinned,
    clientHello: (scenario.clientHello ?? untouched)(initiated.hello),
  });
  const finished = yield* initiated.finish(
    (scenario.environmentHello ?? untouched)(responded.hello),
  );
  const environmentChannel = yield* responded.accept(
    (scenario.clientFinish ?? untouched)(finished.finish),
  );
  return {
    client: finished.channel,
    environment: environmentChannel,
    clientPublicKey: client.identity.publicKey,
    environmentPublicKey: environment.identity.publicKey,
  };
});

const flipLastByte: Tamper = (message) => {
  const copy = message.slice();
  copy[copy.length - 1]! ^= 1;
  return copy;
};

// Both hellos start with a tag byte and a two-byte length, then the 65-byte one-time key.
const replaceOneTimeKey =
  (source: Uint8Array): Tamper =>
  (message) => {
    const copy = message.slice();
    copy.set(source.subarray(3, 68), 3);
    return copy;
  };

const anotherClientHello = Effect.gen(function* () {
  const party = yield* makeParty(Signature.ecdsaP256);
  const initiated = yield* initiateSecureChannel({
    context,
    identity: party.identity,
    verifyPeer: () => Effect.succeed(true),
  });
  return initiated.hello;
});

const scenario = (value: Scenario) => Effect.succeed(value);

describe("secureChannel", () => {
  it.effect("carries text and binary frames both ways between pinned peers", () =>
    Effect.gen(function* () {
      const channels = yield* handshake();
      assert.isTrue(sameBytes(channels.client.peerPublicKey, channels.environmentPublicKey));
      assert.isTrue(sameBytes(channels.environment.peerPublicKey, channels.clientPublicKey));

      for (const frame of ["first", "", "ünïcode ✓"]) {
        const sealed = yield* channels.client.seal(frame);
        assert.strictEqual(yield* channels.environment.open(sealed), frame);
      }
      const binary = Uint8Array.of(0, 255, 1, 254);
      const opened = yield* channels.client.open(yield* channels.environment.seal(binary));
      assert.isTrue(opened instanceof Uint8Array && sameBytes(opened, binary));
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    {
      label: "the client pinned a different environment key",
      reason: "peer_rejected",
      changed: Effect.map(makeParty(Signature.ed25519), (other): Scenario => ({
        clientTrusts: other.pinned,
      })),
    },
    {
      label: "the environment expects a different client key",
      reason: "peer_rejected",
      changed: Effect.map(makeParty(Signature.ecdsaP256), (other): Scenario => ({
        environmentTrusts: other.pinned,
      })),
    },
    {
      label: "the two ends disagree on the context",
      reason: "peer_rejected",
      changed: scenario({ clientContext: bytes("environment-2") }),
    },
    {
      label: "the tunnel replaced the client's one-time key",
      reason: "peer_rejected",
      changed: Effect.map(anotherClientHello, (hello): Scenario => ({
        clientHello: replaceOneTimeKey(hello),
      })),
    },
    {
      label: "the tunnel replaced the environment's one-time key",
      reason: "peer_rejected",
      changed: Effect.map(anotherClientHello, (hello): Scenario => ({
        environmentHello: replaceOneTimeKey(hello),
      })),
    },
    {
      label: "the tunnel changed the client's signature",
      reason: "peer_rejected",
      changed: scenario({ clientFinish: flipLastByte }),
    },
  ] as const)("fails the handshake when $label", ({ reason, changed }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(handshake(yield* changed));
      assert.strictEqual(error.reason, reason);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives the two ends different keys when a careless check lets a change through", () =>
    Effect.gen(function* () {
      const channels = yield* handshake({
        environmentTrusts: () => Effect.succeed(true),
        clientFinish: flipLastByte,
      });
      const error = yield* Effect.flip(
        channels.environment.open(yield* channels.client.seal("secret")),
      );
      assert.strictEqual(error.reason, "decryption_failed");
    }).pipe(Effect.provide(layer)),
  );

  interface Channels {
    readonly client: SecureChannel;
    readonly environment: SecureChannel;
  }
  it.effect.each([
    {
      label: "replayed",
      attack: ({ client, environment }: Channels) =>
        Effect.gen(function* () {
          const sealed = yield* client.seal("run tests");
          yield* environment.open(sealed);
          return yield* environment.open(sealed);
        }),
    },
    {
      label: "delivered out of order",
      attack: ({ client, environment }: Channels) =>
        Effect.gen(function* () {
          yield* client.seal("first");
          return yield* environment.open(yield* client.seal("second"));
        }),
    },
    {
      label: "changed in transit",
      attack: ({ client, environment }: Channels) =>
        Effect.gen(function* () {
          return yield* environment.open(flipLastByte(yield* client.seal("rm -rf build")));
        }),
    },
    {
      label: "reflected back to its sender",
      attack: ({ client }: Channels) =>
        Effect.gen(function* () {
          return yield* client.open(yield* client.seal("echo"));
        }),
    },
  ] as const)("refuses a frame that was $label", ({ attack }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(attack(yield* handshake()));
      assert.strictEqual(error.reason, "decryption_failed");
    }).pipe(Effect.provide(layer)),
  );
});
