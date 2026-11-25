import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { DpopPublicJwk } from "@t3tools/shared/dpop";
import { SecureChannelError } from "@t3tools/shared/secureChannel";
import {
  makeSecureEnvironmentSocket,
  SECURE_CHANNEL_CLOSE_CODE,
} from "@t3tools/shared/secureChannelSocket";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import * as Persistence from "../platform/persistence.ts";
import * as DpopProof from "../relay/dpopProof.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { prepareSecureRpcChannel } from "./secureChannel.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodePublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

const crypto = Layer.mergeAll(
  Aead.layerWebCrypto,
  Digest.layerWebCrypto,
  Kdf.layerWebCrypto,
  KeyAgreement.layerWebCrypto,
  Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const proofKey = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.promise(
    () =>
      globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
  );
  const publicJwk = yield* Effect.promise(() =>
    globalThis.crypto.subtle.exportKey("jwk", pair.publicKey),
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

const environmentIdentity = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.orDie(signature.generateKeyPair(Signature.ed25519));
  return {
    publicKey: yield* Effect.orDie(Signature.toBytes(pair.publicKey)),
    sign: (message: Uint8Array) =>
      signature
        .sign(pair.privateKey, message)
        .pipe(
          Effect.mapError((cause) => new SecureChannelError({ reason: "crypto_failure", cause })),
        ),
  };
});

/** Two connected in-memory sockets. Closing either end fails both readers with the close code. */
const socketPair = Effect.gen(function* () {
  type Frame = string | Uint8Array;
  const toEnvironment = yield* Queue.unbounded<Frame, Socket.SocketError>();
  const toClient = yield* Queue.unbounded<Frame, Socket.SocketError>();
  const end = (inbound: typeof toClient, outbound: typeof toClient) =>
    Socket.make({
      reader: Effect.succeed({
        pull: Queue.takeAll(inbound),
        upgrade: Socket.SocketUpgradeError.unsupported,
      }),
      writer: Effect.succeed({
        write: (chunk) =>
          Socket.isCloseEvent(chunk)
            ? Effect.gen(function* () {
                const error = new Socket.SocketError({
                  reason: new Socket.SocketCloseError({ code: chunk.code }),
                });
                yield* Queue.fail(toEnvironment, error);
                yield* Queue.fail(toClient, error);
              })
            : Effect.asVoid(Queue.offer(outbound, chunk)),
        writeAll: (chunks) => Effect.forEach(chunks, (chunk) => Queue.offer(outbound, chunk)),
      }),
    });
  return { client: end(toClient, toEnvironment), environment: end(toEnvironment, toClient) };
});

const setup = Effect.fnUntraced(function* (options: {
  readonly advertised: boolean;
  readonly pinned?: "environment" | "other";
  /** The environment expects another proof key, so it rejects this device's handshake. */
  readonly rejectClient?: boolean;
}) {
  const key = yield* proofKey;
  const environment = yield* environmentIdentity;
  const other = yield* environmentIdentity;
  const pins = new Map<EnvironmentId, Uint8Array>();
  if (options.pinned !== undefined) {
    pins.set(
      ENVIRONMENT_ID,
      options.pinned === "environment" ? environment.publicKey : other.publicKey,
    );
  }
  const signer = DpopProof.layerSigner({
    keyStore: "indexed-db",
    loadOrCreateKey: Effect.succeed(key),
    secureChannelCrypto: crypto,
  });
  const store = Layer.mock(Persistence.ConnectionRegistrationStore)({
    environmentKey: (environmentId) =>
      Effect.sync(() => Option.fromUndefinedOr(pins.get(environmentId))),
    pinEnvironmentKey: (environmentId, publicKey) =>
      Effect.sync(() => void pins.set(environmentId, publicKey)),
  });
  const services = yield* Layer.build(Layer.mergeAll(signer, store).pipe(Layer.provide(crypto)));
  const channel = yield* prepareSecureRpcChannel(
    {
      environmentId: ENVIRONMENT_ID,
      secureChannelRequested: true,
      descriptor: {
        capabilities: options.advertised ? { secureChannel: true } : {},
      } as ExecutionEnvironmentDescriptor,
    },
    {
      signer: Context.get(services, ManagedRelay.ManagedRelayDpopSigner),
      registrations: Context.get(services, Persistence.ConnectionRegistrationStore),
    },
  );
  const pair = yield* socketPair;
  const environmentSocket = yield* makeSecureEnvironmentSocket(pair.environment, {
    context: new TextEncoder().encode(ENVIRONMENT_ID),
    identity: environment,
    proofKeyThumbprint: options.rejectClient
      ? "another-key"
      : yield* DpopProof.thumbprint(key.publicJwk),
  });
  return { channel, pins, environment, pair, environmentSocket };
});

const closeCodeOf = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError" ? error.reason.code : undefined;

describe("prepareSecureRpcChannel", () => {
  it.effect.each([
    { advertised: false, pinned: false, secure: false },
    { advertised: true, pinned: false, secure: true },
    { advertised: false, pinned: true, secure: true },
    { advertised: true, pinned: true, secure: true },
  ] as const)(
    "advertised=$advertised pinned=$pinned runs the handshake: $secure",
    ({ advertised, pinned, secure }) =>
      Effect.gen(function* () {
        const { channel } = yield* setup({
          advertised,
          ...(pinned ? { pinned: "environment" } : {}),
        });
        assert.strictEqual(channel !== undefined, secure);
      }).pipe(Effect.scoped, Effect.provide(crypto)),
  );

  it.effect("pins the environment's key on its first sealed frame, not at the handshake", () =>
    Effect.gen(function* () {
      const { channel, pins, environment, pair, environmentSocket } = yield* setup({
        advertised: true,
      });
      const client = yield* channel!.wrap(pair.client);
      const environmentReader = yield* Effect.forkScoped(environmentSocket.reader);
      const clientReader = yield* client.reader;
      yield* Fiber.join(environmentReader);
      assert.isFalse(pins.has(ENVIRONMENT_ID));

      yield* (yield* environmentSocket.writer).write("snapshot");
      assert.deepStrictEqual(yield* clientReader.pull, ["snapshot"]);
      assert.deepStrictEqual(pins.get(ENVIRONMENT_ID), environment.publicKey);
      assert.isFalse(channel!.keyChanged());
    }).pipe(Effect.scoped, Effect.provide(crypto)),
  );

  it.effect("pins nothing when the environment rejects this device's handshake", () =>
    Effect.gen(function* () {
      const { channel, pins, pair, environmentSocket } = yield* setup({
        advertised: true,
        rejectClient: true,
      });
      const client = yield* channel!.wrap(pair.client);
      yield* Effect.forkScoped(environmentSocket.reader);
      const error = yield* client.reader.pipe(
        Effect.flatMap((reader) => reader.pull),
        Effect.flip,
      );
      assert.strictEqual(closeCodeOf(error), SECURE_CHANNEL_CLOSE_CODE);
      assert.isFalse(pins.has(ENVIRONMENT_ID));
    }).pipe(Effect.scoped, Effect.provide(crypto)),
  );

  it.effect("refuses an environment whose key is not the pinned one", () =>
    Effect.gen(function* () {
      const { channel, pins, pair, environmentSocket } = yield* setup({
        advertised: true,
        pinned: "other",
      });
      const pinned = pins.get(ENVIRONMENT_ID);
      const client = yield* channel!.wrap(pair.client);
      yield* Effect.forkScoped(environmentSocket.reader);
      const error = yield* Effect.flip(client.reader);
      assert.strictEqual(closeCodeOf(error), SECURE_CHANNEL_CLOSE_CODE);
      assert.isTrue(channel!.keyChanged());
      assert.strictEqual(pins.get(ENVIRONMENT_ID), pinned);
    }).pipe(Effect.scoped, Effect.provide(crypto)),
  );
});
