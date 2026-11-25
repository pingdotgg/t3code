/**
 * Runs the secure channel over a WebSocket: three binary handshake frames right after the
 * upgrade, then every frame in both directions sealed as one binary frame. Frame splitting and
 * heartbeats wrap the returned socket, so each part is sealed on its own.
 */
import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import type * as Arr from "effect/Array";
import type * as Aead from "effect/crypto/Aead";
import type * as Digest from "effect/crypto/Digest";
import type * as Kdf from "effect/crypto/Kdf";
import type * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";

import { computeDpopJwkThumbprint } from "./dpop.ts";
import {
  initiateSecureChannel,
  respondSecureChannel,
  type SecureChannel,
  SecureChannelError,
  type SecureChannelIdentity,
  type SecureChannelVerifyPeer,
} from "./secureChannel.ts";

/** Close code either side sends when the handshake or a sealed frame fails. */
export const SECURE_CHANNEL_CLOSE_CODE = 4400;

const HANDSHAKE_TIMEOUT = Duration.seconds(10);

type SecureChannelServices = Aead.Aead | Digest.Digest | Kdf.Kdf | KeyAgreement.KeyAgreement;

/**
 * The handshake context of a media socket: the environment ID and the socket's query. The query
 * names what the socket reaches, such as a preview tab or a device, and the upgrade proof covers
 * only the path. Without the query here, the hop that ends TLS could point an accepted socket at
 * another target. The proof itself rides in `dpop` and is left out.
 */
export const mediaSocketContext = (environmentId: string, query: URLSearchParams) =>
  new TextEncoder().encode(
    JSON.stringify([
      environmentId,
      [...query]
        .filter(([name]) => name !== "dpop")
        .map((pair) => JSON.stringify(pair))
        .sort(),
    ]),
  );

export interface SecureClientSocketOptions {
  /** UTF-8 bytes of the environment ID, or `mediaSocketContext` on a media socket. */
  readonly context: Uint8Array;
  /** The DPoP proof key: 65-byte uncompressed P-256 point, ES256 `r‖s` signatures. */
  readonly identity: SecureChannelIdentity;
  /** Must pin the environment's raw Ed25519 public key and check its signature. */
  readonly verifyPeer: SecureChannelVerifyPeer;
}

export interface SecureEnvironmentSocketOptions {
  /** UTF-8 bytes of the environment ID, or `mediaSocketContext` on a media socket. */
  readonly context: Uint8Array;
  /** The environment key: raw 32-byte Ed25519 public key, plain Ed25519 signatures. */
  readonly identity: SecureChannelIdentity;
  /** The authenticated session's DPoP key; the client must prove it holds this key. */
  readonly proofKeyThumbprint: string;
}

type Handshake = (io: {
  readonly receive: Effect.Effect<Uint8Array, SecureChannelError | Socket.SocketError>;
  readonly send: (frame: Uint8Array) => Effect.Effect<void, Socket.SocketError>;
}) => Effect.Effect<SecureChannel, SecureChannelError | Socket.SocketError, SecureChannelServices>;

const closed = () =>
  new Socket.SocketError({
    reason: new Socket.SocketCloseError({
      code: SECURE_CHANNEL_CLOSE_CODE,
      closeReason: "Secure channel failed",
    }),
  });

const malformed = () => new SecureChannelError({ reason: "malformed_message" });

// shortcut: one handshake per wrapped socket, so it must connect once (as the RPC server and the
// client session's sockets do). A reconnecting socket needs a fresh wrapper per connection.
const makeSecureSocket = Effect.fnUntraced(function* (socket: Socket.Socket, handshake: Handshake) {
  const services = yield* Effect.context<SecureChannelServices>();
  const ready = Deferred.makeUnsafe<SecureChannel, Socket.SocketError>();
  // Holds sealing and sending together, so frames go on the wire in the order they were sealed.
  const sending = Semaphore.makeUnsafe(1);

  const reader: Socket.Socket["reader"] = Effect.gen(function* () {
    const raw = yield* socket.reader;
    const rawWriter = yield* socket.writer;
    // A pull can return the client's finish frame together with the first sealed frames.
    let batch: ReadonlyArray<string | Uint8Array> = [];
    let next = 0;
    let failure: Socket.SocketError | undefined;
    const reject = (error: SecureChannelError | Socket.SocketError) => {
      failure = Socket.isSocketError(error) ? error : closed();
      return rawWriter
        .write(new Socket.CloseEvent(SECURE_CHANNEL_CLOSE_CODE, "Secure channel failed"))
        .pipe(Effect.ignore, Effect.andThen(Effect.fail(failure)));
    };
    const receive = Effect.suspend(() =>
      next < batch.length
        ? Effect.succeed(batch[next++]!)
        : Effect.map(raw.pull, (frames) => {
            batch = frames;
            next = 1;
            return frames[0];
          }),
    ).pipe(
      Effect.filterOrFail((frame): frame is Uint8Array => typeof frame !== "string", malformed),
    );

    const channel = yield* handshake({ receive, send: rawWriter.write }).pipe(
      Effect.provide(services),
      Effect.timeoutOrElse({ duration: HANDSHAKE_TIMEOUT, orElse: () => Effect.fail(malformed()) }),
      Effect.catch(reject),
      Effect.onExit((exit) =>
        Deferred.done(ready, Exit.isSuccess(exit) ? exit : Exit.fail(failure ?? closed())),
      ),
    );

    const open = (frames: ReadonlyArray<string | Uint8Array>) =>
      Effect.forEach(frames, (frame) =>
        typeof frame === "string" ? Effect.fail(malformed()) : channel.open(frame),
      ) as unknown as Effect.Effect<
        Arr.NonEmptyReadonlyArray<string | Uint8Array>,
        SecureChannelError
      >;

    return {
      pull: Effect.suspend(() => {
        if (failure !== undefined) return Effect.fail(failure);
        if (next < batch.length) {
          const rest = batch.slice(next);
          next = batch.length;
          return open(rest).pipe(Effect.catch(reject));
        }
        return raw.pull.pipe(
          Effect.flatMap((frames) => open(frames).pipe(Effect.catch(reject))),
          Effect.tapError((error) => Effect.sync(() => (failure ??= error))),
        );
      }),
      upgrade: Socket.SocketUpgradeError.unsupported,
    };
  });

  const writer: Socket.Socket["writer"] = Effect.map(socket.writer, (raw) => {
    const send = (frames: Arr.NonEmptyReadonlyArray<string | Uint8Array>) =>
      Effect.flatMap(Deferred.await(ready), (channel) =>
        sending.withPermit(
          Effect.forEach(frames, channel.seal).pipe(
            Effect.mapError(
              (cause) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
            ),
            Effect.flatMap((sealed) =>
              raw.writeAll(sealed as unknown as Arr.NonEmptyReadonlyArray<Uint8Array>),
            ),
          ),
        ),
      );
    return {
      write: (chunk) =>
        Socket.isCloseEvent(chunk) ? sending.withPermit(raw.write(chunk)) : send([chunk]),
      writeAll: send,
    };
  });

  return Socket.make({ reader, writer });
});

/** Client side: runs the handshake when the socket connects, then seals and opens every frame. */
export const makeSecureClientSocket = (
  socket: Socket.Socket,
  options: SecureClientSocketOptions,
): Effect.Effect<Socket.Socket, never, SecureChannelServices> =>
  makeSecureSocket(socket, ({ receive, send }) =>
    Effect.gen(function* () {
      const initiated = yield* initiateSecureChannel(options);
      yield* send(initiated.hello);
      const finished = yield* initiated.finish(yield* receive);
      yield* send(finished.finish);
      return finished.channel;
    }),
  );

/** Environment side: answers the client's handshake, then seals and opens every frame. */
export const makeSecureEnvironmentSocket = (
  socket: Socket.Socket,
  options: SecureEnvironmentSocketOptions,
): Effect.Effect<Socket.Socket, never, SecureChannelServices> =>
  makeSecureSocket(socket, ({ receive, send }) =>
    Effect.gen(function* () {
      const responded = yield* respondSecureChannel({
        context: options.context,
        identity: options.identity,
        verifyPeer: verifyDpopKeyPeer(options.proofKeyThumbprint),
        clientHello: yield* receive,
      });
      yield* send(responded.hello);
      return yield* responded.accept(yield* receive);
    }),
  );

/** Accepts only the P-256 key with this RFC 7638 thumbprint, then checks its ES256 signature. */
const verifyDpopKeyPeer =
  (proofKeyThumbprint: string): SecureChannelVerifyPeer =>
  ({ publicKey, message, signature }) =>
    Effect.sync(() => {
      if (publicKey.length !== 65 || publicKey[0] !== 0x04) return false;
      const thumbprint = computeDpopJwkThumbprint({
        kty: "EC",
        crv: "P-256",
        x: Base64Url.encode(publicKey.subarray(1, 33)),
        y: Base64Url.encode(publicKey.subarray(33)),
      });
      if (thumbprint !== proofKeyThumbprint) return false;
      try {
        return p256.verify(signature, sha256(message), publicKey, {
          prehash: false,
          format: "compact",
        });
      } catch {
        return false;
      }
    });
