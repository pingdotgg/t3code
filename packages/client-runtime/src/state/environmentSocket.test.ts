import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { DpopPublicJwk } from "@t3tools/shared/dpop";
import { SecureChannelError } from "@t3tools/shared/secureChannel";
import {
  makeSecureEnvironmentSocket,
  mediaSocketContext,
  SECURE_CHANNEL_CLOSE_CODE,
} from "@t3tools/shared/secureChannelSocket";
import * as Cause from "effect/Cause";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as DpopProof from "../relay/dpopProof.ts";
import { makeEnvironmentSocketOpener, type EnvironmentSocket } from "./environmentSocket.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const SOCKET_URL = "wss://env.test/api/device-hub/vendor/serve-sim/helper/ws?wsTicket=ticket";

const crypto = Layer.mergeAll(
  Aead.layerWebCrypto,
  Digest.layerWebCrypto,
  Kdf.layerWebCrypto,
  KeyAgreement.layerWebCrypto,
  Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const prepared = (authorization: "Dpop" | "Bearer"): PreparedConnection => ({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  httpBaseUrl: "https://env.test",
  socketUrl: "wss://env.test/ws",
  httpAuthorization:
    authorization === "Dpop"
      ? { _tag: "Dpop", accessToken: "access", expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
      : { _tag: "Bearer", token: "bearer" },
  target: new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Remote",
    connectionId: "connection-1",
  }),
  descriptor: { capabilities: { secureChannel: true } } as ExecutionEnvironmentDescriptor,
  ...(authorization === "Dpop" ? { secureChannelRequested: true as const } : {}),
});

/** A browser socket whose far end is an Effect socket the test drives as the environment. */
class FakeWebSocket extends EventTarget {
  static dialed = Promise.withResolvers<FakeWebSocket>();
  /** What the next socket's client end sends; a test sets it before the adapter dials. */
  static inbox: Queue.Queue<string | Uint8Array, Socket.SocketError> | undefined;
  readyState = 0;
  binaryType = "blob";
  readonly fromClient = FakeWebSocket.inbox!;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.dialed.resolve(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  send(data: string | Uint8Array) {
    Queue.offerUnsafe(this.fromClient, typeof data === "string" ? data : data.slice());
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    Queue.failCauseUnsafe(
      this.fromClient,
      Cause.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) })),
    );
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
  /** The environment's end of this connection. */
  readonly environment = Socket.make({
    reader: Effect.succeed({
      pull: Queue.takeAll(this.fromClient),
      upgrade: Socket.SocketUpgradeError.unsupported,
    }),
    writer: Effect.succeed({
      write: (chunk) => Effect.sync(() => this.deliver(chunk)),
      writeAll: (chunks) => Effect.sync(() => chunks.forEach((chunk) => this.deliver(chunk))),
    }),
  });
  private deliver(chunk: string | Uint8Array | Socket.CloseEvent) {
    if (Socket.isCloseEvent(chunk)) return this.close(chunk.code, chunk.reason);
    const data = typeof chunk === "string" ? chunk : chunk.slice().buffer;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const decodeJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

const setup = Effect.fnUntraced(function* (options: {
  readonly authorization?: "Dpop" | "Bearer";
  readonly canRunChannel?: boolean;
}) {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.promise(
    () =>
      globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
  );
  const key: DpopProof.DpopProofKey = {
    publicJwk: yield* Effect.promise(() =>
      globalThis.crypto.subtle.exportKey("jwk", pair.publicKey),
    ).pipe(Effect.flatMap(decodeJwk), Effect.orDie),
    sign: (data) =>
      Signature.privateKeyFromCryptoKey(Signature.ecdsaP256, pair.privateKey).pipe(
        Effect.flatMap((privateKey) => signature.sign(privateKey, data)),
        Effect.orDie,
      ),
  };
  const environmentPair = yield* Effect.orDie(signature.generateKeyPair(Signature.ed25519));
  const environment = {
    publicKey: yield* Effect.orDie(Signature.toBytes(environmentPair.publicKey)),
    sign: (message: Uint8Array) =>
      signature
        .sign(environmentPair.privateKey, message)
        .pipe(
          Effect.mapError((cause) => new SecureChannelError({ reason: "crypto_failure", cause })),
        ),
  };
  FakeWebSocket.inbox = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>();
  const services = Layer.mergeAll(
    DpopProof.layerSigner({
      keyStore: "indexed-db",
      loadOrCreateKey: Effect.succeed(key),
      ...(options.canRunChannel === false ? {} : { secureChannelCrypto: crypto }),
    }),
    Layer.mock(Persistence.ConnectionRegistrationStore)({
      environmentKey: () => Effect.succeedNone,
      pinEnvironmentKey: () => Effect.void,
    }),
  ).pipe(Layer.provide(crypto));
  const open = yield* makeEnvironmentSocketOpener(
    prepared(options.authorization ?? "Dpop"),
    "ticket",
  ).pipe(Effect.provide(services));
  return { open, environment, thumbprint: yield* DpopProof.thumbprint(key.publicJwk) };
});

/** The next socket the adapter dials, and the claims of the proof on its URL. */
const dialed = Effect.promise(async () => {
  const socket = await FakeWebSocket.dialed.promise;
  FakeWebSocket.dialed = Promise.withResolvers();
  const proof = new URL(socket.url).searchParams.get("dpop")!;
  const claims = JSON.parse(atob(proof.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
  return { socket, claims: claims as { readonly htu: string; readonly t3sc?: boolean } };
});

/** Listens now, so an event dispatched before the effect runs is not missed. */
const nextEvent = (socket: EnvironmentSocket, type: "open" | "message" | "close") => {
  const next = new Promise<Event>((resolve) =>
    socket.addEventListener(type, resolve, { once: true }),
  );
  return Effect.promise(() => next);
};

describe("makeEnvironmentSocketOpener", () => {
  afterEach(() => {
    FakeWebSocket.dialed = Promise.withResolvers();
    vi.unstubAllGlobals();
  });

  it.live("seals frames in send order and delivers them in arrival order", () =>
    Effect.gen(function* () {
      vi.stubGlobal("WebSocket", FakeWebSocket);
      const { open, environment, thumbprint } = yield* setup({});
      const socket = open!(SOCKET_URL);
      const { socket: raw, claims } = yield* dialed;
      assert.strictEqual(claims.htu, "https://env.test/api/device-hub/vendor/serve-sim/helper/ws");
      assert.isTrue(claims.t3sc);
      const opened = nextEvent(socket, "open");
      raw.open();
      const secured = yield* makeSecureEnvironmentSocket(raw.environment, {
        context: mediaSocketContext(ENVIRONMENT_ID, new URL(raw.url).searchParams),
        identity: environment,
        proofKeyThumbprint: thumbprint,
      });
      const reader = yield* secured.reader;
      const writer = yield* secured.writer;
      yield* opened;

      const sent = Array.from({ length: 50 }, (_, index) =>
        index % 2 === 0 ? `text-${index}` : Uint8Array.of(index),
      );
      for (const frame of sent) socket.send(frame);
      const received: Array<string | Uint8Array> = [];
      while (received.length < sent.length) received.push(...(yield* reader.pull));
      assert.deepStrictEqual(received, sent);

      const messages: Array<unknown> = [];
      const delivered = Promise.withResolvers<void>();
      socket.onmessage = (event) => {
        if (messages.push(event.data) === sent.length) delivered.resolve();
      };
      yield* writer.writeAll(sent as [string | Uint8Array, ...Array<string | Uint8Array>]);
      yield* Effect.promise(() => delivered.promise);
      assert.deepStrictEqual(messages, sent);
    }).pipe(Effect.scoped, Effect.provide(crypto)),
  );

  it.live("closes the socket on a frame that does not open", () =>
    Effect.gen(function* () {
      vi.stubGlobal("WebSocket", FakeWebSocket);
      const { open, environment, thumbprint } = yield* setup({});
      const socket = open!(SOCKET_URL);
      const { socket: raw } = yield* dialed;
      const opened = nextEvent(socket, "open");
      raw.open();
      const secured = yield* makeSecureEnvironmentSocket(raw.environment, {
        context: mediaSocketContext(ENVIRONMENT_ID, new URL(raw.url).searchParams),
        identity: environment,
        proofKeyThumbprint: thumbprint,
      });
      yield* secured.reader;
      yield* opened;
      const closed = nextEvent(socket, "close");
      const messages: Array<unknown> = [];
      socket.onmessage = (event) => messages.push(event.data);
      yield* (yield* raw.environment.writer).write(Uint8Array.of(1, 2, 3));
      const event = (yield* closed) as CloseEvent;
      assert.strictEqual(event.code, SECURE_CHANNEL_CLOSE_CODE);
      assert.deepStrictEqual(messages, []);
      assert.strictEqual(socket.readyState, 3);
    }).pipe(Effect.scoped, Effect.provide(crypto)),
  );

  it.live("sends a proof without the claim on a platform that cannot run the channel", () =>
    Effect.gen(function* () {
      vi.stubGlobal("WebSocket", FakeWebSocket);
      const { open } = yield* setup({ canRunChannel: false });
      const socket = open!(SOCKET_URL);
      const { socket: raw, claims } = yield* dialed;
      assert.isUndefined(claims.t3sc);
      const opened = nextEvent(socket, "open");
      raw.open();
      yield* opened;
      socket.send("plain");
      assert.deepStrictEqual(yield* Queue.takeAll(raw.fromClient), ["plain"]);
      const message = nextEvent(socket, "message");
      yield* (yield* raw.environment.writer).write(Uint8Array.of(7));
      assert.deepStrictEqual(((yield* message) as MessageEvent).data, Uint8Array.of(7));
    }).pipe(Effect.scoped, Effect.provide(crypto)),
  );
});
