import {
  ORCHESTRATION_V2_WS_METHODS,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";
import type { RpcServer } from "effect/rpc";

const MAX_PENDING_CHUNKS = 8;
const MAX_PENDING_BYTES = 64 * 1024;
const isFull = (sizes: number[]) =>
  sizes.length >= MAX_PENDING_CHUNKS ||
  sizes.reduce((total, size) => total + size, 0) >= MAX_PENDING_BYTES;
// Terminal output is small chunks, so its window also caps bytes. The other streams
// window by count only: sizing a multi-MB thread snapshot would serialize it twice.
const BYTE_WINDOWED_STREAMS: ReadonlySet<string> = new Set([
  WS_METHODS.terminalAttach,
  WS_METHODS.terminalObserve,
]);
// One ACK round trip per chunk stalls sync on high-latency links.
const COUNT_WINDOWED_STREAMS: ReadonlySet<string> = new Set([
  WS_METHODS.subscribeServerConfig,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
]);

interface Window {
  readonly bytes: boolean;
  readonly sizes: number[];
}

export function withOutputWindow(
  protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] {
  // RpcServer drops a disconnected client before its streams exit, so their Exit never
  // reaches send; departed clients are pruned when a window opens instead.
  const clients = new Map<number, Map<string, Window>>();
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0];
  const windowFor = (clientId: number, requestId: string) => clients.get(clientId)?.get(requestId);
  const openWindow = Effect.fnUntraced(function* (
    clientId: number,
    requestId: string,
    bytes: boolean,
  ) {
    const connected = yield* protocol.clientIds;
    for (const id of clients.keys()) if (!connected.has(id)) clients.delete(id);
    let windows = clients.get(clientId);
    if (!windows) clients.set(clientId, (windows = new Map()));
    if (!windows.has(requestId)) windows.set(requestId, { bytes, sizes: [] });
  });
  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) =>
        Effect.suspend(() => {
          if (message._tag === "Request") {
            const bytes = BYTE_WINDOWED_STREAMS.has(message.tag);
            if (bytes || COUNT_WINDOWED_STREAMS.has(message.tag)) {
              return openWindow(clientId, String(message.id), bytes).pipe(
                Effect.andThen(write(clientId, message)),
              );
            }
          } else if (message._tag === "Ack") {
            const window = windowFor(clientId, String(message.requestId));
            if (window) {
              const wasFull = isFull(window.sizes);
              window.sizes.shift();
              if (!wasFull || isFull(window.sizes)) return Effect.void;
            }
          }
          return write(clientId, message);
        }),
      );
    },
    send: (clientId, response, transferables) =>
      Effect.suspend(() => {
        const send = protocol.send(clientId, response, transferables);
        if (response._tag === "Exit") {
          clients.get(clientId)?.delete(String(response.requestId));
        } else if (response._tag === "Chunk") {
          const window = windowFor(clientId, String(response.requestId));
          if (window) {
            window.sizes.push(
              // @effect-diagnostics-next-line globalJsonInEffect:off
              window.bytes ? Buffer.byteLength(JSON.stringify(response)) : 0,
            );
            if (!isFull(window.sizes)) {
              return send.pipe(
                Effect.andThen(() =>
                  receive(clientId, {
                    _tag: "Ack",
                    requestId: response.requestId,
                  }),
                ),
              );
            }
          }
        }
        return send;
      }),
  };
}

const MAX_QUEUED_OUTPUT = 8 * 1024 * 1024;
// Charge an envelope so tiny events cannot bypass the byte budget.
const EVENT_OVERHEAD = 128;

type Listener<A> = (event: A) => Effect.Effect<void>;
// Acquisition must register cleanup synchronously with installing the listener.
type Subscribe<A, E> = (
  listener: Listener<A>,
  registerCleanup: (stop: () => void) => void,
) => Effect.Effect<() => void, E>;

const queuedSize = (event: TerminalEvent | TerminalAttachStreamEvent) =>
  EVENT_OVERHEAD +
  (event.type === "output"
    ? Buffer.byteLength(event.data)
    : "snapshot" in event
      ? Buffer.byteLength(event.snapshot.history)
      : 0);

export function terminalOutputStream<A extends TerminalEvent | TerminalAttachStreamEvent, E>(
  subscribe: Subscribe<A, E>,
  resync?: Subscribe<A, E>,
  maxQueued = MAX_QUEUED_OUTPUT,
): Stream.Stream<A, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const ready = yield* Latch.make();
      let pending: Array<A | undefined> = [];
      let sizes: number[] = [];
      let head = 0;
      let queued = 0;
      let overflowed = false;
      let subscription = 0;
      let unsubscribe: (() => void) | null = null;
      const release = () => {
        subscription += 1;
        unsubscribe?.();
        unsubscribe = null;
        pending = [];
        sizes = [];
        head = 0;
        queued = 0;
      };
      yield* Effect.addFinalizer(() => Effect.sync(release));

      const listen = (from: Subscribe<A, E>) =>
        Effect.suspend(() => {
          const id = ++subscription;
          return from(
            (event) =>
              Effect.sync(() => {
                if (id !== subscription) return;
                const size = queuedSize(event);
                pending.push(event);
                sizes.push(size);
                queued += size;
                // A single snapshot must fit even when history fills the budget.
                if (queued - sizes[head]! > maxQueued) {
                  release();
                  overflowed = true;
                }
                ready.openUnsafe();
              }),
            (stop) => {
              // Overflow or cancellation may invalidate acquisition before registration.
              if (id === subscription) unsubscribe = stop;
              else stop();
            },
          ).pipe(
            Effect.asVoid,
            Effect.onError(() => Effect.sync(release)),
          );
        });

      const take = () => {
        const event = pending[head]!;
        pending[head] = undefined;
        head += 1;
        return event;
      };
      const takeBatch = (): Arr.NonEmptyReadonlyArray<A> => {
        let bytes = sizes[head]!;
        const batch: [A, ...A[]] = [take()];
        while (head < pending.length && bytes + sizes[head]! <= MAX_PENDING_BYTES) {
          bytes += sizes[head]!;
          batch.push(take());
        }
        queued -= bytes;
        if (head * 2 >= pending.length) {
          pending = pending.slice(head);
          sizes = sizes.slice(head);
          head = 0;
        }
        return batch;
      };

      const pull: Effect.Effect<Arr.NonEmptyReadonlyArray<A>, E | Cause.Done> = Effect.suspend(
        () => {
          if (overflowed) {
            overflowed = false;
            return resync ? listen(resync).pipe(Effect.andThen(pull)) : Cause.done();
          }
          if (head < pending.length) return Effect.succeed(takeBatch());
          ready.closeUnsafe();
          return ready.await.pipe(Effect.andThen(pull));
        },
      );

      yield* listen(subscribe);
      return Stream.fromPull(Effect.succeed(pull));
    }),
  );
}
