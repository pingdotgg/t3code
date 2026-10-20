import { assert, describe, it } from "@effect/vitest";
import {
  type TerminalAttachStreamEvent,
  TerminalAttachStreamEvent as TerminalAttachStreamEventSchema,
  TerminalEvent as TerminalEventSchema,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rpc, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";

import { terminalOutputStream, withTerminalOutputWindow } from "./OutputProtocol.ts";

describe("terminal output window", () => {
  it.effect.each([
    { tag: WS_METHODS.terminalAttach, size: 1, limit: 8 },
    { tag: WS_METHODS.terminalObserve, size: 1, limit: 8 },
    { tag: WS_METHODS.subscribeTerminalEvents, size: 1, limit: 8 },
    { tag: WS_METHODS.terminalAttach, size: 64 * 1024, limit: 1 },
    { tag: WS_METHODS.terminalObserve, size: 64 * 1024, limit: 1 },
    { tag: WS_METHODS.subscribeTerminalMetadata, size: 1, limit: 1 },
  ])("limits $tag with $size-byte values to $limit pending chunks", ({ tag, size, limit }) =>
    Effect.gen(function* () {
      const group = RpcGroup.make(Rpc.make(tag, { success: Schema.String, stream: true }));
      const output = yield* Queue.unbounded<string>();
      const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
      const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
      const protocol = yield* RpcServer.Protocol.make((write) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(receive, write);
          const serialization = yield* RpcSerialization.RpcSerialization;
          return {
            disconnects: yield* Queue.unbounded<number>(),
            send: (_clientId, response) => Queue.offer(responses, response),
            end: () => Effect.void,
            clientIds: Effect.succeed(new Set([0])),
            initialMessage: Effect.succeedNone,
            supportsAck: true,
            supportsTransferables: false,
            supportsSpanPropagation: false,
            supportsNotifications: true,
            codecFor: serialization.codecFor,
          };
        }),
      );
      yield* RpcServer.make(group).pipe(
        Effect.provide(group.toLayerHandler(tag, () => Stream.fromQueue(output))),
        Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
        Effect.forkScoped,
      );
      const write = yield* Deferred.await(receive);
      yield* write(0, { _tag: "Request", id: "1", tag, payload: null, headers: [] });

      for (let index = 0; index < limit; index++) {
        const value = String(index).repeat(size);
        yield* Queue.offer(output, value);
        yield* TestClock.adjust(0);
        assert.equal(yield* Queue.size(responses), 1);
        assert.deepEqual(yield* Queue.take(responses), {
          _tag: "Chunk",
          requestId: "1",
          values: [value],
        });
      }
      yield* Queue.offer(output, "i".repeat(size));
      yield* TestClock.adjust(0);
      assert.equal(yield* Queue.size(responses), 0);
      yield* write(0, { _tag: "Ack", requestId: "1" });
      const resumed = yield* Queue.take(responses);
      assert.equal(resumed._tag, "Chunk");
      if (resumed._tag === "Chunk") assert.deepEqual(resumed.values, ["i".repeat(size)]);

      yield* Queue.offer(output, "j");
      yield* TestClock.adjust(0);
      assert.equal(yield* Queue.size(responses), 0);
      yield* write(0, { _tag: "Interrupt", requestId: "1" });
      assert.equal((yield* Queue.take(responses))._tag, "Exit");
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );
});

const output = (data: string): TerminalAttachStreamEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "default",
  data,
});

const snapshot = (history: string): TerminalAttachStreamEvent => ({
  type: "snapshot",
  snapshot: {
    threadId: "thread-1",
    terminalId: "default",
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 1,
    history,
    exitCode: null,
    exitSignal: null,
    label: "bash",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

// Stands in for TerminalManager's fanout: listeners run in publish order and
// may release themselves while it iterates.
const makePublisher = () => {
  const listeners = new Set<(event: TerminalAttachStreamEvent) => Effect.Effect<void>>();
  return {
    listeners,
    subscribe: (
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) =>
      Effect.sync(() => {
        listeners.add(listener);
        const stop = () => {
          listeners.delete(listener);
        };
        registerCleanup?.(stop);
        return stop;
      }),
    publish: (event: TerminalAttachStreamEvent) =>
      Effect.forEach(listeners, (listener) => listener(event), { discard: true }),
  };
};

// Like TerminalManager.attachStream: a snapshot, then live events.
const attach =
  (publisher: ReturnType<typeof makePublisher>, history: string) =>
  (
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    registerCleanup: (stop: () => void) => void,
  ) =>
    publisher
      .subscribe(listener, registerCleanup)
      .pipe(Effect.tap(() => listener(snapshot(history))));

const chunkBytes = (message: RpcMessage.FromServerEncoded) =>
  Buffer.byteLength(JSON.stringify(message));

describe("terminal output stream", () => {
  it.effect.each([
    WS_METHODS.terminalAttach,
    WS_METHODS.terminalObserve,
    WS_METHODS.subscribeTerminalEvents,
  ])("releases only the ACK-stalled subscriber on %s and resumes safely", (tag) =>
    Effect.gen(function* () {
      const legacy = tag === WS_METHODS.subscribeTerminalEvents;
      const group = RpcGroup.make(
        Rpc.make(tag, {
          success: legacy ? TerminalEventSchema : TerminalAttachStreamEventSchema,
          stream: true,
        }),
      );
      const publisher = makePublisher();
      const stalled = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
      const healthy = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
      const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
      const protocol = yield* RpcServer.Protocol.make((write) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(receive, write);
          const serialization = yield* RpcSerialization.RpcSerialization;
          return {
            disconnects: yield* Queue.unbounded<number>(),
            send: (clientId, response) => Queue.offer(clientId === 0 ? stalled : healthy, response),
            end: () => Effect.void,
            clientIds: Effect.succeed(new Set([0, 1])),
            initialMessage: Effect.succeedNone,
            supportsAck: true,
            supportsTransferables: false,
            supportsSpanPropagation: false,
            supportsNotifications: true,
            codecFor: serialization.codecFor,
          };
        }),
      );
      const initial = legacy ? output("ready") : snapshot("");
      yield* RpcServer.make(group).pipe(
        Effect.provide(
          group.toLayerHandler(tag, () =>
            terminalOutputStream(
              (listener, registerCleanup) =>
                publisher
                  .subscribe(listener, registerCleanup)
                  .pipe(Effect.tap(() => listener(initial))),
              legacy ? undefined : attach(publisher, "fresh history"),
              256 * 1024,
            ),
          ),
        ),
        Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
        Effect.forkScoped,
      );
      const write = yield* Deferred.await(receive);
      const takeChunk = Effect.fnUntraced(function* (queue: typeof stalled) {
        const response = yield* Queue.take(queue);
        assert.equal(response._tag, "Chunk");
        if (response._tag !== "Chunk") throw new Error("Expected an RPC chunk");
        assert.isAtMost(chunkBytes(response), 70 * 1024);
        return response.values;
      });
      yield* write(0, { _tag: "Request", id: "1", tag, payload: null, headers: [] });
      assert.deepEqual(yield* takeChunk(stalled), [initial]);
      yield* write(1, { _tag: "Request", id: "2", tag, payload: null, headers: [] });
      assert.deepEqual(yield* takeChunk(healthy), [initial]);
      yield* write(1, { _tag: "Ack", requestId: "2" });

      // Eight unacknowledged chunks fill only client 0's output window.
      for (let index = 0; index < 7; index++) {
        const event = output("before-stall-" + index);
        yield* publisher.publish(event);
        assert.deepEqual(yield* takeChunk(stalled), [event]);
        assert.deepEqual(yield* takeChunk(healthy), [event]);
        yield* write(1, { _tag: "Ack", requestId: "2" });
      }
      assert.equal(publisher.listeners.size, 2);
      for (let index = 0; index < 100; index++) {
        const event = output(index + ":" + "界".repeat(1365));
        yield* publisher.publish(event);
        assert.deepEqual(yield* takeChunk(healthy), [event]);
        yield* write(1, { _tag: "Ack", requestId: "2" });
        if (index === 31) assert.equal(publisher.listeners.size, 2);
      }
      assert.equal(yield* Queue.size(stalled), 0);
      assert.equal(publisher.listeners.size, 1);

      yield* write(0, { _tag: "Ack", requestId: "1" });
      if (legacy) {
        assert.deepEqual(yield* Queue.take(stalled), {
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Success", value: null },
        });
      } else {
        assert.deepEqual(yield* takeChunk(stalled), [snapshot("fresh history")]);
        assert.equal(publisher.listeners.size, 2);
        for (let index = 0; index < 7; index++) {
          yield* write(0, { _tag: "Ack", requestId: "1" });
        }
      }
      const after = output("unique output after recovery");
      yield* publisher.publish(after);
      assert.deepEqual(yield* takeChunk(healthy), [after]);
      if (!legacy) assert.deepEqual(yield* takeChunk(stalled), [after]);
      assert.equal(yield* Queue.size(stalled), 0);
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it.effect("interrupts recovery while its subscription is still waiting", () =>
    Effect.gen(function* () {
      const publisher = makePublisher();
      const recovering = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const pull = yield* Stream.toPull(
        terminalOutputStream(
          attach(publisher, ""),
          () =>
            Deferred.succeed(recovering, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
          1024,
        ),
      );
      yield* pull;
      yield* publisher.publish(output("x".repeat(1024)));
      yield* publisher.publish(output("x".repeat(1024)));
      assert.equal(publisher.listeners.size, 0);

      const recovery = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(recovering);
      yield* Fiber.interrupt(recovery);
      yield* Deferred.await(interrupted);
      assert.equal(publisher.listeners.size, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("cleans listeners when cancelled during a successful acquisition handoff", () =>
    Effect.gen(function* () {
      const publisher = makePublisher();
      for (const recovering of [false, true, false, true]) {
        const handoff = yield* Deferred.make<void>();
        const complete = yield* Deferred.make<void>();
        const acquire: ReturnType<typeof attach> = (listener, registerCleanup) =>
          attach(publisher, "")(listener, registerCleanup).pipe(
            // Hold the successful exit before its cleanup handle reaches the caller.
            Effect.onExit(() =>
              Deferred.succeed(handoff, undefined).pipe(Effect.andThen(Deferred.await(complete))),
            ),
          );
        const consumer = yield* Effect.gen(function* () {
          const pull = yield* Stream.toPull(
            terminalOutputStream(recovering ? attach(publisher, "") : acquire, acquire, 1024),
          );
          yield* pull;
          yield* publisher.publish(output("x".repeat(1024)));
          yield* publisher.publish(output("x".repeat(1024)));
          yield* pull;
        }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(handoff);
        assert.equal(publisher.listeners.size, 1);
        const cancellation = yield* Fiber.interrupt(consumer).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(complete, undefined);
        yield* Fiber.join(cancellation);
        assert.equal(publisher.listeners.size, 0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("caps each delivered batch at the output window in UTF-8 bytes", () =>
    Effect.gen(function* () {
      const publisher = makePublisher();
      const pull = yield* Stream.toPull(terminalOutputStream(attach(publisher, "")));
      assert.deepEqual(yield* pull, [snapshot("")]);
      // 1,024 code units but 3 KiB of UTF-8.
      const data = "界".repeat(1024);
      for (let index = 0; index < 1024; index++) yield* publisher.publish(output(data));

      let delivered = 0;
      while (delivered < 1024) {
        const batch = yield* pull;
        assert.isAtMost(
          batch.reduce(
            (bytes, event) => bytes + (event.type === "output" ? Buffer.byteLength(event.data) : 0),
            0,
          ),
          64 * 1024,
        );
        delivered += batch.length;
      }
      assert.equal(delivered, 1024);
    }).pipe(Effect.scoped),
  );

  it.effect("charges snapshot history but never overflows on one snapshot", () =>
    Effect.gen(function* () {
      const publisher = makePublisher();
      const history = "界".repeat(16 * 1024);
      const events = terminalOutputStream(attach(publisher, history), undefined, 32 * 1024);
      const pull = yield* Stream.toPull(events);
      // A snapshot larger than the budget is still delivered.
      assert.deepEqual(yield* pull, [snapshot(history)]);
      assert.equal(publisher.listeners.size, 1);

      // Queued snapshots count their history: a second one overflows.
      yield* publisher.publish(snapshot(history));
      assert.equal(publisher.listeners.size, 1);
      yield* publisher.publish(snapshot(history));
      assert.equal(publisher.listeners.size, 0);
    }).pipe(Effect.scoped),
  );
});
