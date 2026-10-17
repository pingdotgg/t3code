import { type TerminalAttachStreamEvent, type TerminalEvent, WS_METHODS } from "@t3tools/contracts";
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

export function withTerminalOutputWindow(
  protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] {
  const windows = new Map<string, number[]>();
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0];
  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) =>
        Effect.suspend(() => {
          if (
            message._tag === "Request" &&
            (message.tag === WS_METHODS.terminalAttach ||
              message.tag === WS_METHODS.terminalObserve ||
              message.tag === WS_METHODS.subscribeTerminalEvents)
          ) {
            const key = `${clientId}:${message.id}`;
            if (!windows.has(key)) windows.set(key, []);
          } else if (message._tag === "Ack") {
            const window = windows.get(`${clientId}:${message.requestId}`);
            if (window) {
              const wasFull = isFull(window);
              window.shift();
              if (!wasFull || isFull(window)) return Effect.void;
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
          windows.delete(`${clientId}:${response.requestId}`);
        } else if (response._tag === "Chunk") {
          const window = windows.get(`${clientId}:${response.requestId}`);
          if (window) {
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            const size = Buffer.byteLength(JSON.stringify(response));
            window.push(size);
            if (!isFull(window)) {
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

// One subscription may fall this far behind its client. It matches the default
// terminal history limit, so a resync snapshot is never larger than the
// backlog it replaces and a client that can keep up never loops on resyncs.
const MAX_QUEUED_OUTPUT = 8 * 1024 * 1024;
// Counts the envelope too, so a flood of tiny events is bounded as well.
const EVENT_OVERHEAD = 128;

type Listener<A> = (event: A) => Effect.Effect<void>;
type Subscribe<A, E> = (listener: Listener<A>) => Effect.Effect<() => void, E>;

// Output and snapshot history count their UTF-8 bytes, like the history limit.
const queuedSize = (event: TerminalEvent | TerminalAttachStreamEvent) =>
  EVENT_OVERHEAD +
  (event.type === "output"
    ? Buffer.byteLength(event.data)
    : "snapshot" in event
      ? Buffer.byteLength(event.snapshot.history)
      : 0);

/**
 * Streams a terminal subscription to one RPC client, in batches that stop at
 * the output window. A subscription that queues more than `maxQueued` beyond
 * its oldest event is released and its backlog dropped; the next pull
 * subscribes again through `resync`, whose fresh snapshot replaces the dropped
 * output. Without `resync` the stream ends.
 */
export function terminalOutputStream<A extends TerminalEvent | TerminalAttachStreamEvent, E>(
  subscribe: Subscribe<A, E>,
  resync?: Subscribe<A, E>,
  maxQueued = MAX_QUEUED_OUTPUT,
): Stream.Stream<A, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const ready = yield* Latch.make();
      // Taken slots are cleared at once and compacted once half the array is spent.
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
      };
      yield* Effect.addFinalizer(() => Effect.sync(release));

      // Uninterruptible like acquireRelease, so an unsubscribe is never lost.
      const listen = (from: Subscribe<A, E>) =>
        Effect.suspend(() => {
          const id = ++subscription;
          return from((event) =>
            Effect.sync(() => {
              if (id !== subscription) return;
              const size = queuedSize(event);
              pending.push(event);
              sizes.push(size);
              queued += size;
              // The oldest event never counts, so one recovery snapshot as
              // large as the history limit cannot overflow on its own.
              if (queued - sizes[head]! > maxQueued) {
                release();
                pending = [];
                sizes = [];
                head = 0;
                queued = 0;
                overflowed = true;
              }
              ready.openUnsafe();
            }),
          ).pipe(
            Effect.map((stop) => {
              // The subscription overflowed before it returned.
              if (id === subscription) unsubscribe = stop;
              else stop();
            }),
          );
        }).pipe(Effect.uninterruptible);

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
