/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import {
  initiateSecureChannel,
  respondSecureChannel,
  SecureChannelError,
} from "@t3tools/shared/secureChannel";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createNodeDpopKeysModule, createNodeSecureChannelCryptoModule } from "./dpop.testing";
import * as SecureChannelCrypto from "./secureChannelCrypto";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  digest: (algorithm: string, data: Uint8Array) =>
    Promise.resolve(new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer),
}));

vi.mock("expo-secure-store", () => ({}));
const native = vi.hoisted(() => ({ module: {} }));
vi.mock("expo", () => ({ requireNativeModule: () => native.module }));

const webCrypto = Layer.mergeAll(
  Aead.layerWebCrypto,
  Digest.layerWebCrypto,
  Kdf.layerWebCrypto,
  KeyAgreement.layerWebCrypto,
).pipe(Layer.provide(SecureRandom.layerWebCrypto));

// Identity signatures are covered by the shared protocol tests; this checks the key exchange and frames.
const identity = (publicKey: Uint8Array) => ({
  publicKey,
  sign: () => Effect.succeed(new Uint8Array(64)),
});
const trustAnyone = () => Effect.succeed(true);
const context = new TextEncoder().encode("environment-1");

describe("mobile secure channel crypto", () => {
  it.effect("connects as before on a binary without the native functions", () =>
    Effect.gen(function* () {
      native.module = createNodeDpopKeysModule();
      assert.isUndefined(yield* Effect.promise(SecureChannelCrypto.load));
    }),
  );

  it.effect("runs the handshake and frames against an environment on WebCrypto", () =>
    Effect.gen(function* () {
      native.module = createNodeSecureChannelCryptoModule();
      const mobile = yield* Effect.promise(SecureChannelCrypto.load);
      assert.isDefined(mobile);

      const initiated = yield* initiateSecureChannel({
        context,
        identity: identity(new Uint8Array(65)),
        verifyPeer: trustAnyone,
      }).pipe(Effect.provide(mobile!));
      const responded = yield* respondSecureChannel({
        context,
        identity: identity(new Uint8Array(32)),
        verifyPeer: trustAnyone,
        clientHello: initiated.hello,
      }).pipe(Effect.provide(webCrypto));
      const client = yield* initiated.finish(responded.hello).pipe(Effect.provide(mobile!));
      const environment = yield* responded.accept(client.finish).pipe(Effect.provide(webCrypto));

      const snapshot = NodeCrypto.randomBytes(200_000);
      for (const frame of ["first", snapshot, "third"]) {
        const fromClient = yield* client.channel.seal(frame);
        assert.deepStrictEqual(yield* environment.open(fromClient), frame);
        const fromEnvironment = yield* environment.seal(frame);
        assert.deepStrictEqual(yield* client.channel.open(fromEnvironment), frame);
      }

      const tampered = yield* environment.seal("sealed");
      tampered[0]! ^= 1;
      const failure = yield* Effect.flip(client.channel.open(tampered));
      assert.instanceOf(failure, SecureChannelError);
      assert.strictEqual(failure.reason, "decryption_failed");
    }),
  );
});
