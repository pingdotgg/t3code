import { assert, describe, it } from "@effect/vitest";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";

import { computeDpopJwkThumbprint } from "./dpop.ts";
import { SecureChannelError, type SecureChannelIdentity } from "./secureChannel.ts";
import {
  makeSecureClientSocket,
  makeSecureEnvironmentSocket,
  SECURE_CHANNEL_CLOSE_CODE,
} from "./secureChannelSocket.ts";

const layer = Layer.mergeAll(
  Aead.layerWebCrypto,
  Kdf.layerWebCrypto,
  KeyAgreement.layerWebCrypto,
  Digest.layerWebCrypto,
  Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

type Frame = string | Uint8Array;

/**
 * Two connected in-memory sockets. `tamper` sees each frame the client sends, numbered from 0
 * (hello, finish, then sealed frames). Closing either end fails both readers with the close code.
 */
const makeSocketPair = Effect.fnUntraced(function* (
  tamper?: (frame: Frame, index: number) => Frame,
) {
  const toEnvironment = yield* Queue.unbounded<Frame, Socket.SocketError>();
  const toClient = yield* Queue.unbounded<Frame, Socket.SocketError>();
  const wire: Array<Frame> = [];
  const closeCodes: Array<number> = [];
  let clientFrames = 0;
  const close = (event: Socket.CloseEvent) =>
    Effect.gen(function* () {
      closeCodes.push(event.code);
      const error = new Socket.SocketError({
        reason: new Socket.SocketCloseError({ code: event.code }),
      });
      yield* Queue.fail(toEnvironment, error);
      yield* Queue.fail(toClient, error);
    });
  const end = (inbound: typeof toClient, outbound: typeof toClient) => {
    const send = (chunk: Frame) =>
      Effect.suspend(() => {
        wire.push(chunk);
        const frame = outbound === toEnvironment && tamper ? tamper(chunk, clientFrames++) : chunk;
        return Queue.offer(outbound, frame);
      });
    return Socket.make({
      reader: Effect.succeed({
        pull: Queue.takeAll(inbound),
        upgrade: Socket.SocketUpgradeError.unsupported,
      }),
      writer: Effect.succeed({
        write: (chunk) => (Socket.isCloseEvent(chunk) ? close(chunk) : Effect.asVoid(send(chunk))),
        writeAll: (chunks) => Effect.forEach(chunks, send, { discard: true }),
      }),
    });
  };
  return {
    client: end(toClient, toEnvironment),
    environment: end(toEnvironment, toClient),
    wire,
    closeCodes,
  };
});

const makeIdentity = Effect.fnUntraced(function* (algorithm: Signature.Algorithm) {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.orDie(signature.generateKeyPair(algorithm));
  const identity: SecureChannelIdentity = {
    publicKey: yield* Effect.orDie(Signature.toBytes(pair.publicKey)),
    sign: (message) =>
      signature
        .sign(pair.privateKey, message)
        .pipe(
          Effect.mapError((cause) => new SecureChannelError({ reason: "crypto_failure", cause })),
        ),
  };
  return { identity, pair };
});

const thumbprintOf = (publicKey: Uint8Array) =>
  computeDpopJwkThumbprint({
    kty: "EC",
    crv: "P-256",
    x: Base64Url.encode(publicKey.subarray(1, 33)),
    y: Base64Url.encode(publicKey.subarray(33)),
  });

const context = new TextEncoder().encode("environment-1");

interface SetupOptions {
  readonly sessionKey?: Uint8Array;
  readonly tamper?: (frame: Frame, index: number) => Frame;
}

const setup = Effect.fnUntraced(function* (options: SetupOptions = {}) {
  const signature = yield* Signature.Signature;
  const pair = yield* makeSocketPair(options.tamper);
  const client = yield* makeIdentity(Signature.ecdsaP256);
  const environment = yield* makeIdentity(Signature.ed25519);
  const clientSocket = yield* makeSecureClientSocket(pair.client, {
    context,
    identity: client.identity,
    verifyPeer: (input) =>
      input.publicKey.every((byte, index) => byte === environment.identity.publicKey[index])
        ? signature
            .verify(environment.pair.publicKey, input.signature, input.message)
            .pipe(Effect.orElseSucceed(() => false))
        : Effect.succeed(false),
  });
  const environmentSocket = yield* makeSecureEnvironmentSocket(pair.environment, {
    context,
    identity: environment.identity,
    proofKeyThumbprint: thumbprintOf(options.sessionKey ?? client.identity.publicKey),
  });
  return { ...pair, clientSocket, environmentSocket };
});

const closeCodeOf = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError" ? error.reason.code : undefined;

describe("secure channel sockets", () => {
  it.effect("carries frames both ways and puts only ciphertext on the wire", () =>
    Effect.gen(function* () {
      const { clientSocket, environmentSocket, wire } = yield* setup();
      const binary = Uint8Array.of(0, 255, 7);
      // Writes made before the handshake wait for it, as the RPC server's and client's do.
      const environmentWriter = yield* environmentSocket.writer;
      yield* Effect.forkScoped(environmentWriter.writeAll(["from environment", binary]));
      const clientWriter = yield* clientSocket.writer;
      yield* Effect.forkScoped(clientWriter.write('{"_tag":"Request"}'));

      const environmentReader = yield* Effect.forkScoped(environmentSocket.reader);
      const clientReader = yield* clientSocket.reader;
      const environmentPull = (yield* Fiber.join(environmentReader)).pull;

      assert.deepStrictEqual(yield* environmentPull, ['{"_tag":"Request"}']);
      const received: Array<Frame> = [];
      while (received.length < 2) received.push(...(yield* clientReader.pull));
      assert.strictEqual(received[0], "from environment");
      assert.deepStrictEqual(received[1], binary);
      assert.isTrue(wire.every((frame) => frame instanceof Uint8Array));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.each<{
    readonly label: string;
    readonly options: Effect.Effect<SetupOptions, never, Signature.Signature>;
  }>([
    {
      label: "a sealed frame was altered",
      options: Effect.succeed({
        tamper: (frame, index) =>
          index === 2 && frame instanceof Uint8Array
            ? frame.map((byte, at) => (at === 0 ? byte ^ 1 : byte))
            : frame,
      }),
    },
    {
      label: "a plaintext frame follows the handshake",
      options: Effect.succeed({
        tamper: (frame, index) => (index === 2 ? '{"_tag":"Request"}' : frame),
      }),
    },
    {
      label: "a plaintext frame replaces the handshake",
      options: Effect.succeed({
        tamper: (frame, index) => (index === 0 ? '{"_tag":"Request"}' : frame),
      }),
    },
    {
      label: "the client key is not the session's proof key",
      options: Effect.map(makeIdentity(Signature.ecdsaP256), (other) => ({
        sessionKey: other.identity.publicKey,
      })),
    },
  ])("the environment closes the socket when $label", ({ options }) =>
    Effect.gen(function* () {
      const { clientSocket, environmentSocket, closeCodes } = yield* setup(yield* options);
      const clientWriter = yield* clientSocket.writer;
      yield* Effect.forkScoped(clientSocket.reader);
      yield* Effect.forkScoped(clientWriter.write('{"_tag":"Request"}'));
      const error = yield* environmentSocket.reader.pipe(
        Effect.flatMap((reader) => reader.pull),
        Effect.flip,
      );
      assert.strictEqual(closeCodeOf(error), SECURE_CHANNEL_CLOSE_CODE);
      assert.include(closeCodes, SECURE_CHANNEL_CLOSE_CODE);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("the environment closes the socket when no handshake arrives in time", () =>
    Effect.gen(function* () {
      const { environmentSocket, closeCodes } = yield* setup();
      const reader = yield* Effect.forkScoped(Effect.flip(environmentSocket.reader));
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(closeCodeOf(yield* Fiber.join(reader)), SECURE_CHANNEL_CLOSE_CODE);
      assert.deepStrictEqual(closeCodes, [SECURE_CHANNEL_CLOSE_CODE]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
