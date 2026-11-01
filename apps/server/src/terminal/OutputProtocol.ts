import { type TerminalAttachStreamEvent, type TerminalEvent, WS_METHODS } from "@t3tools/contracts";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";
import type { RpcServer } from "effect/rpc";

const MAX_PENDING_CHUNKS = 8;
const MAX_PENDING_BYTES = 64 * 1024;
// Charge an envelope so tiny events cannot bypass the byte budget.
const EVENT_OVERHEAD = 128;
const isFull = (sizes: number[]) =>
  sizes.length >= MAX_PENDING_CHUNKS ||
  sizes.reduce((total, size) => total + size, 0) >= MAX_PENDING_BYTES;

const byteLengthOf = (value: unknown) => (typeof value === "string" ? Buffer.byteLength(value) : 0);

// Charges every variable-size field a terminal event can carry, so the byte
// budgets below cannot be bypassed by a large payload in an uncharged field.
const queuedSize = (event: TerminalEvent | TerminalAttachStreamEvent) =>
  EVENT_OVERHEAD +
  ("threadId" in event ? byteLengthOf(event.threadId) + byteLengthOf(event.terminalId) : 0) +
  (event.type === "output"
    ? byteLengthOf(event.data)
    : event.type === "error"
      ? byteLengthOf(event.message)
      : event.type === "activity"
        ? byteLengthOf(event.label)
        : "snapshot" in event
          ? byteLengthOf(event.snapshot.threadId) +
            byteLengthOf(event.snapshot.terminalId) +
            byteLengthOf(event.snapshot.history) +
            byteLengthOf(event.snapshot.cwd) +
            byteLengthOf(event.snapshot.worktreePath) +
            byteLengthOf(event.snapshot.label)
          : 0);

const TERMINAL_EVENT_TYPES = new Set([
  "started",
  "output",
  "exited",
  "closed",
  "error",
  "cleared",
  "restarted",
  "activity",
  "snapshot",
]);

// Windowed chunks carry terminal events, so charge them the way the output
// queue below does instead of serializing the frame a second time just to
// measure it. Only the event shapes queuedSize measures take the fast path;
// anything else keeps the exact JSON measurement.
const chunkSize = (values: ReadonlyArray<unknown>) =>
  values.reduce<number>((total, value) => {
    if (typeof value === "string") return total + EVENT_OVERHEAD + Buffer.byteLength(value);
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      typeof value.type === "string" &&
      TERMINAL_EVENT_TYPES.has(value.type)
    ) {
      return total + queuedSize(value as TerminalEvent | TerminalAttachStreamEvent);
    }
    return total + Buffer.byteLength(JSON.stringify(value) ?? "");
  }, EVENT_OVERHEAD);

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
              message.tag === WS_METHODS.terminalObserve)
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
            window.push(chunkSize(response.values));
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

const MAX_QUEUED_OUTPUT = 8 * 1024 * 1024;

type Listener<A> = (event: A) => Effect.Effect<void>;
// Acquisition must register cleanup synchronously with installing the listener.
type Subscribe<A, E> = (
  listener: Listener<A>,
  registerCleanup: (stop: () => void) => void,
) => Effect.Effect<() => void, E>;

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
