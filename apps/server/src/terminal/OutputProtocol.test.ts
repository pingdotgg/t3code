import { assert, describe, it } from "@effect/vitest";
import { WS_METHODS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rpc, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { withTerminalOutputWindow } from "./OutputProtocol.ts";

describe("terminal output window", () => {
  for (const { tag, size, limit } of [
    { tag: WS_METHODS.terminalAttach, size: 1, limit: 8 },
    { tag: WS_METHODS.subscribeTerminalEvents, size: 1, limit: 8 },
    { tag: WS_METHODS.terminalAttach, size: 64 * 1024, limit: 1 },
    { tag: WS_METHODS.subscribeTerminalMetadata, size: 1, limit: 1 },
  ]) {
    it.effect(`limits ${tag} with ${size}-byte values to ${limit} pending chunks`, () =>
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
  }
});
