// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to the desktop's fds.
/**
 * Playwright connects over CDP only through a WebSocket URL, so each attached
 * desktop tab gets a loopback endpoint with an unguessable path. Its frames
 * cross the bootstrap file descriptors to the desktop's relay, which owns the
 * tab's `webContents.debugger`.
 */
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
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
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    readonly available: boolean;
    /**
     * Subscribes before it checks, so an attach landing in between is never
     * missed.
     */
    readonly awaitAttached: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly attached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    readonly isVisible: (key: DesktopTabKey) => boolean;
    readonly visibilityChanged: Stream.Stream<DesktopTabKey>;
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
  }
>()("t3/preview/DesktopBrowserChannel") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  const changes = yield* PubSub.unbounded<{ key: DesktopTabKey; attached: boolean }>();
  const attachedTabs = new Set<string>();
  const visibleTabs = new Set<string>();
  const visibility = yield* PubSub.unbounded<DesktopTabKey>();
  const inbound = new Map<string, Queue.Queue<string>>();
  const writeLock = yield* Semaphore.make(1);

  if (inputFd === undefined || controlFd === undefined) {
    return DesktopBrowserChannel.of({
      available: false,
      awaitAttached: () => Effect.succeed(false),
      detached: Stream.empty,
      attached: Stream.empty,
      isAttached: () => Effect.succeed(false),
      isVisible: () => false,
      visibilityChanged: Stream.empty,
      endpoint: () => Effect.die("No desktop app is attached to this server."),
      pointer: () => Effect.void,
    });
  }

  const command = (message: DesktopBrowserCommandType) =>
    writeLock.withPermits(1)(
      encodeCommand(message).pipe(
        Effect.flatMap((line) => writeAllToFileDescriptor(controlFd, Buffer.from(`${line}\n`))),
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop browser command failed", { cause }),
        ),
      ),
    );

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
    Stream.runForEach((decoded) => {
      if (Option.isNone(decoded)) return Effect.void;
      const event = decoded.value;
      const key = { threadId: event.threadId, tabId: event.tabId };
      const id = keyOf(key);
      switch (event.type) {
        case "cdp": {
          const queue = inbound.get(id);
          return queue ? Queue.offer(queue, event.message).pipe(Effect.asVoid) : Effect.void;
        }
        case "attached":
          attachedTabs.add(id);
          return PubSub.publish(changes, { key, attached: true });
        case "visibility":
          if (visibleTabs.has(id) === event.visible) return Effect.void;
          if (event.visible) visibleTabs.add(id);
          else visibleTabs.delete(id);
          return PubSub.publish(visibility, key).pipe(Effect.asVoid);
        case "detached": {
          attachedTabs.delete(id);
          visibleTabs.delete(id);
          const queue = inbound.get(id);
          return (queue ? Queue.shutdown(queue) : Effect.void).pipe(
            Effect.andThen(PubSub.publish(changes, { key, attached: false })),
          );
        }
      }
    }),
    Effect.catchCause((cause) => Effect.logWarning("desktop browser channel stopped", { cause })),
    Effect.forkScoped,
  );

  const endpoint = Effect.fn("DesktopBrowserChannel.endpoint")(function* (key: DesktopTabKey) {
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
        yield* command({ type: "release", ...key });
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
          const decoder = new TextDecoder();
          return yield* reader.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (frame) =>
                  command({
                    type: "cdp",
                    ...key,
                    message: typeof frame === "string" ? frame : decoder.decode(frame),
                  }),
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
    awaitAttached: (key, timeout) =>
      Effect.scoped(
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
      ),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => !change.attached),
      Stream.map((change) => change.key),
    ),
    attached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => change.attached),
      Stream.map((change) => change.key),
    ),
    isAttached: (key) => Effect.sync(() => attachedTabs.has(keyOf(key))),
    isVisible: (key) => visibleTabs.has(keyOf(key)),
    visibilityChanged: Stream.fromPubSub(visibility),
    endpoint,
    pointer: (key, pointer) => command({ type: "pointer", ...key, ...pointer }),
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);
