import { assert, describe, it } from "@effect/vitest";
import {
  type TerminalAttachStreamEvent,
  TerminalAttachStreamEvent as TerminalAttachStreamEventSchema,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
    subscribe: (listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    publish: (event: TerminalAttachStreamEvent) =>
      Effect.forEach(listeners, (listener) => listener(event), { discard: true }),
  };
};

// Like TerminalManager.attachStream: a snapshot, then live events.
const attach =
  (publisher: ReturnType<typeof makePublisher>, history: string) =>
  (listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>) =>
    publisher.subscribe(listener).pipe(Effect.tap(() => listener(snapshot(history))));

const chunkBytes = (message: RpcMessage.FromServerEncoded) =>
  Buffer.byteLength(JSON.stringify(message));

describe("terminal output stream", () => {
  it.effect("drops a backlog the client stopped acknowledging and resumes from a snapshot", () =>
    Effect.gen(function* () {
      const tag = WS_METHODS.terminalAttach;
      const group = RpcGroup.make(
        Rpc.make(tag, { success: TerminalAttachStreamEventSchema, stream: true }),
      );
      const publisher = makePublisher();
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
      const maxQueued = 256 * 1024;
      yield* RpcServer.make(group).pipe(
        Effect.provide(
          group.toLayerHandler(tag, () =>
            terminalOutputStream(
              attach(publisher, ""),
              attach(publisher, "fresh history"),
              maxQueued,
            ),
          ),
        ),
        Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
        Effect.forkScoped,
      );
      const write = yield* Deferred.await(receive);
      const takeChunk = Effect.gen(function* () {
        const response = yield* Queue.take(responses);
        assert.equal(response._tag, "Chunk");
        return response as RpcMessage.ResponseChunkEncoded;
      });

      yield* write(0, { _tag: "Request", id: "1", tag, payload: null, headers: [] });
      assert.deepEqual((yield* takeChunk).values, [snapshot("")]);
      // A second client keeps acknowledging while the first one stalls.
      yield* write(1, { _tag: "Request", id: "2", tag, payload: null, headers: [] });
      assert.deepEqual((yield* takeChunk).values, [snapshot("")]);
      assert.equal(publisher.listeners.size, 2);

      // Fill client 0's window: 64 KiB in flight and no ACK.
      const data = "x".repeat(4 * 1024);
      let sentToStalledClient = 0;
      let published = 0;
      while (publisher.listeners.size === 2) {
        yield* publisher.publish(output(`${published++}:${data}`));
        yield* TestClock.adjust(0);
        for (const response of yield* Queue.clear(responses)) {
          assert.equal(response._tag, "Chunk");
          assert.isAtMost(chunkBytes(response), 70 * 1024);
          if (response._tag !== "Chunk") continue;
          if (response.requestId === "1") sentToStalledClient += 1;
          // Client 1 acknowledges everything and receives every event.
          else yield* write(1, { _tag: "Ack", requestId: "2" });
        }
      }
      // Client 0 overflowed: its listener and backlog were released while
      // client 1 still receives output.
      assert.isAbove(published, maxQueued / data.length);
      assert.isBelow(sentToStalledClient, published);
      assert.equal(publisher.listeners.size, 1);
      yield* publisher.publish(output("live"));
      yield* TestClock.adjust(0);
      const live = yield* takeChunk;
      assert.equal(live.requestId, "2");
      assert.deepEqual(live.values, [output("live")]);

      // Once client 0 acknowledges, it resumes from a fresh snapshot instead of
      // the dropped backlog, then follows live output.
      yield* write(0, { _tag: "Ack", requestId: "1" });
      const resumed = yield* takeChunk;
      assert.equal(resumed.requestId, "1");
      assert.deepEqual(resumed.values, [snapshot("fresh history")]);
      assert.equal(publisher.listeners.size, 2);
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
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
      const history = "h".repeat(48 * 1024);
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

  it.effect("ends a stream without a snapshot to resume from", () =>
    Effect.gen(function* () {
      const publisher = makePublisher();
      const events = terminalOutputStream(attach(publisher, ""), undefined, 8 * 1024);
      const pull = yield* Stream.toPull(events);
      assert.deepEqual(yield* pull, [snapshot("")]);
      for (let index = 0; index < 4; index++) {
        yield* publisher.publish(output("z".repeat(4 * 1024)));
      }
      assert.equal(publisher.listeners.size, 0);
      const exit = yield* Effect.exit(pull);
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.scoped),
  );
});
