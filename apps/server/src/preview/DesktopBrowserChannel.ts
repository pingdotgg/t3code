// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to the desktop's channel.
/**
 * Playwright requires a WebSocket CDP endpoint for each desktop tab.
 * The loopback endpoint relays frames over inherited pipes or a WSL socket.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  DESKTOP_BROWSER_SOCKET_PATH,
  DESKTOP_BROWSER_SOCKET_SECRET_HEADER,
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const decodeEventLine = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopBrowserEvent));
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));

const textDecoder = new TextDecoder();

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

const frameText = (frame: string | Uint8Array) =>
  typeof frame === "string" ? frame : textDecoder.decode(frame);

const secretMatches = (expected: string, presented: string | undefined) => {
  if (presented === undefined) return false;
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  return (
    presentedBytes.length === expectedBytes.length &&
    NodeCrypto.timingSafeEqual(presentedBytes, expectedBytes)
  );
};

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    readonly available: boolean;
    /** Subscribe before checking so concurrent attaches cannot be missed. */
    readonly awaitAttached: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly attached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
    /** Never fails. A failed write means a broken channel; the next backend starts with no turns. */
    readonly turn: (threadId: string, active: boolean) => Effect.Effect<void>;
    readonly acceptsSocket: boolean;
    readonly authorizesSocket: (secret: string | undefined) => boolean;
    readonly serveSocket: (socket: Socket.Socket) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/preview/DesktopBrowserChannel") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  const socketSecret = config.desktopBrowserSocketSecret;
  const changes = yield* PubSub.unbounded<{ key: DesktopTabKey; attached: boolean }>();
  const attachedTabs = new Map<string, DesktopTabKey>();
  const activeThreads = new Set<string>();
  const inbound = new Map<string, Queue.Queue<string>>();
  const writeLock = yield* Semaphore.make(1);

  if (!ServerConfig.hasDesktopBrowserChannel(config)) {
    return DesktopBrowserChannel.of({
      available: false,
      awaitAttached: Effect.fn("DesktopBrowserChannel.awaitAttached")(function () {
        return Effect.succeed(false);
      }),
      detached: Stream.empty,
      attached: Stream.empty,
      isAttached: Effect.fn("DesktopBrowserChannel.isAttached")(function () {
        return Effect.succeed(false);
      }),
      endpoint: Effect.fn("DesktopBrowserChannel.endpoint")(function () {
        return Effect.die("No desktop app is attached to this server.");
      }),
      turn: Effect.fn("DesktopBrowserChannel.turn")(function () {
        return Effect.void;
      }),
      pointer: Effect.fn("DesktopBrowserChannel.pointer")(function () {
        return Effect.void;
      }),
      acceptsSocket: false,
      authorizesSocket: () => false,
      serveSocket: Effect.fn("DesktopBrowserChannel.serveSocket")(function () {
        return Effect.void;
      }),
    });
  }

  // Commands sent while no desktop socket is connected are dropped: the desktop
  // announces its tabs again when it reconnects, and the server then reattaches.
  let writeLine: ((line: string) => Effect.Effect<void, Error>) | null =
    inputFd !== undefined && controlFd !== undefined
      ? (line) => writeAllToFileDescriptor(controlFd, Buffer.from(`${line}\n`))
      : null;

  const command = (message: DesktopBrowserCommandType, writer = writeLine) =>
    writeLock.withPermits(1)(
      encodeCommand(message).pipe(
        Effect.flatMap((line) =>
          writer === null || writer !== writeLine ? Effect.void : writer(line),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop browser command failed", { cause }),
        ),
      ),
    );

  const receive = (event: DesktopBrowserEventType) => {
    const key = { threadId: event.threadId, tabId: event.tabId };
    const id = keyOf(key);
    switch (event.type) {
      case "cdp": {
        const queue = inbound.get(id);
        return queue ? Queue.offer(queue, event.message).pipe(Effect.asVoid) : Effect.void;
      }
      case "attached":
        attachedTabs.set(id, key);
        return PubSub.publish(changes, { key, attached: true }).pipe(
          Effect.andThen(() =>
            activeThreads.has(key.threadId)
              ? command({ type: "turn", threadId: key.threadId, active: true })
              : Effect.void,
          ),
        );
      case "detached":
        return detach(id, key);
    }
  };

  const detach = (id: string, key: DesktopTabKey) => {
    attachedTabs.delete(id);
    const queue = inbound.get(id);
    return (queue ? Queue.shutdown(queue) : Effect.void).pipe(
      Effect.andThen(PubSub.publish(changes, { key, attached: false })),
      Effect.asVoid,
    );
  };

  const detachAll = Effect.suspend(() =>
    Effect.forEach([...attachedTabs], ([id, key]) => detach(id, key), { discard: true }),
  );

  if (inputFd !== undefined && controlFd !== undefined) {
    // Socket reads can be cancelled while the desktop keeps its write end open.
    // Filesystem reads on this pipe keep Node alive after scope shutdown.
    const readable = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeNet.Socket({ fd: inputFd, readable: true, writable: false })),
      (stream) => Effect.sync(() => stream.destroy()),
    );
    yield* NodeStream.fromReadable<Uint8Array, Error>({
      evaluate: () => readable,
      closeOnDone: true,
      onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
      Stream.runForEach((decoded) =>
        Option.isSome(decoded) ? receive(decoded.value) : Effect.void,
      ),
      Effect.catchCause((cause) => Effect.logWarning("desktop browser channel stopped", { cause })),
      Effect.forkScoped,
    );
  }

  let currentSocket: { readonly close: Effect.Effect<void> } | null = null;
  const serveSocket = Effect.fn("DesktopBrowserChannel.serveSocket")(
    function* (socket: Socket.Socket) {
      if (socketSecret === undefined) return;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      // A desktop only reconnects after losing the old socket, which may not have
      // noticed yet. It reports no detaches, and its frames must not reach the new one.
      const replaced = currentSocket;
      const connection = {
        close: writer.write(new Socket.CloseEvent(1000, "replaced")).pipe(Effect.ignore),
      };
      currentSocket = connection;
      writeLine = (line) => writer.write(line);
      if (replaced !== null) yield* replaced.close;
      yield* detachAll;
      yield* Effect.addFinalizer(() =>
        currentSocket === connection
          ? Effect.suspend(() => {
              currentSocket = null;
              writeLine = null;
              return detachAll;
            })
          : Effect.void,
      );
      const receiveFrames = (frames: ReadonlyArray<string | Uint8Array>) =>
        Effect.forEach(
          frames.flatMap((frame) => frameText(frame).split("\n")),
          (line) =>
            line.trim().length === 0 || currentSocket !== connection
              ? Effect.void
              : decodeEventLine(line).pipe(Effect.flatMap(receive), Effect.ignore),
          { discard: true },
        );
      return yield* reader.pull.pipe(Effect.flatMap(receiveFrames), Effect.forever);
    },
    Effect.catchCause((cause) => Effect.logDebug("desktop browser socket closed", { cause })),
  );

  const endpoint = Effect.fn("DesktopBrowserChannel.endpoint")(function* (key: DesktopTabKey) {
    const channelWriter = writeLine;
    const id = keyOf(key);
    const secret = NodeCrypto.randomBytes(24).toString("base64url");
    const server = yield* NodeSocketServer.makeWebSocket({
      host: "127.0.0.1",
      port: 0,
      path: `/${secret}`,
    }).pipe(Effect.orDie);
    const queue = yield* Queue.unbounded<string>();
    inbound.set(id, queue);
    // A detach before this registration shut down no queue, so check again.
    if (!attachedTabs.has(id)) {
      inbound.delete(id);
      return yield* Effect.die("The desktop tab detached before the server connected.");
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (inbound.get(id) === queue) inbound.delete(id);
        yield* Queue.shutdown(queue);
        yield* command({ type: "release", ...key }, channelWriter);
      }),
    );
    // The relay serves one Playwright connection; a second would see the first's sessions.
    let connected = false;
    yield* server
      .run((socket) =>
        Effect.gen(function* () {
          if (connected) return;
          connected = true;
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          yield* Stream.fromQueue(queue).pipe(
            Stream.runForEach((message) => writer.write(message)),
            Effect.forkScoped,
          );
          return yield* reader.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (frame) =>
                  command({ type: "cdp", ...key, message: frameText(frame) }, channelWriter),
                { discard: true },
              ),
            ),
            Effect.forever,
          );
        }).pipe(Effect.scoped, Effect.ignore),
      )
      .pipe(Effect.forkScoped);
    const address = server.address;
    if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected relay address.");
    return `ws://127.0.0.1:${address.port}/${secret}`;
  });

  return DesktopBrowserChannel.of({
    available: true,
    awaitAttached: Effect.fn("DesktopBrowserChannel.awaitAttached")(function (key, timeout) {
      return Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          if (attachedTabs.has(keyOf(key))) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.attached && keyOf(change.key) === keyOf(key)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      );
    }),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => !change.attached),
      Stream.map((change) => change.key),
    ),
    attached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => change.attached),
      Stream.map((change) => change.key),
    ),
    isAttached: Effect.fn("DesktopBrowserChannel.isAttached")(function (key) {
      return Effect.sync(() => attachedTabs.has(keyOf(key)));
    }),
    endpoint,
    turn: Effect.fn("DesktopBrowserChannel.turn")(function* (threadId, active) {
      if (active) activeThreads.add(threadId);
      else activeThreads.delete(threadId);
      yield* command({ type: "turn", threadId, active });
    }),
    pointer: Effect.fn("DesktopBrowserChannel.pointer")(function (key, pointer) {
      return command({ type: "pointer", ...key, ...pointer });
    }),
    acceptsSocket: socketSecret !== undefined,
    authorizesSocket: (secret) => socketSecret !== undefined && secretMatches(socketSecret, secret),
    serveSocket,
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);

// The upgrade presents the bootstrap secret, so this route skips session auth.
export const socketRouteLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const channel = yield* DesktopBrowserChannel;
    yield* router.add(
      "GET",
      DESKTOP_BROWSER_SOCKET_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!channel.acceptsSocket || request.headers.upgrade?.toLowerCase() !== "websocket") {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        if (!channel.authorizesSocket(request.headers[DESKTOP_BROWSER_SOCKET_SECRET_HEADER])) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        // The desktop sits on this machine, so deflate would only cost CPU.
        delete NodeHttpServerRequest.toIncomingMessage(request).headers["sec-websocket-extensions"];
        const socket = yield* request.upgrade;
        yield* Effect.scoped(channel.serveSocket(socket));
        return HttpServerResponse.empty();
      }),
    );
  }),
);
