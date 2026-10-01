import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  ExtensionApiSubscribeInput,
  WS_METHODS,
  WsSubscribeExtensionApiRpc,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcGroup, RpcTest } from "effect/unstable/rpc";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";

const group = RpcGroup.make(WsSubscribeExtensionApiRpc);
const input = Schema.decodeUnknownSync(ExtensionApiSubscribeInput)({
  installationId: "consumer.example",
  expectedContentHash: "a".repeat(64),
  request: {
    id: "producer.example/events",
    versionRange: "^1.0.0",
    name: "changes",
    input: {},
    context: {
      client: "test",
      resource: {
        namespace: "consumer.example",
        id: "view",
        environmentId: "env",
        projectId: "project",
      },
    },
  },
});

it("stream RPC requires authenticated read scope", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.subscribeExtensionApi)).toBe(
    AuthOrchestrationReadScope,
  );
});

it.effect("RPC ACKs bound a stalled consumer and interruption releases the producer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const stalled = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const thirdProduced = yield* Deferred.make<void>();
      let produced = 0;
      let consumed = 0;
      const frames = Stream.fromEffectRepeat(
        Effect.sync(() => ({
          streamId: "host-generated-stream",
          sequence: ++produced,
          type: "data" as const,
          value: produced,
        })),
      ).pipe(
        Stream.tap((frame) =>
          frame.sequence === 3 ? Deferred.succeed(thirdProduced, undefined) : Effect.void,
        ),
        Stream.ensuring(Deferred.succeed(closed, undefined)),
      );
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(group.toLayer({ subscribeExtensionApi: () => frames })),
      );
      const consumer = yield* client.subscribeExtensionApi(input, { streamBufferSize: 1 }).pipe(
        Stream.tap(() =>
          Effect.gen(function* () {
            consumed++;
            yield* Deferred.succeed(stalled, undefined);
            yield* Deferred.await(released);
          }),
        ),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Deferred.await(stalled);
      yield* Deferred.await(thirdProduced);
      expect(consumed).toBe(1);
      // One delivered frame, one queued frame and one awaiting its ACK.
      expect(produced).toBe(3);
      yield* Fiber.interrupt(consumer);
      yield* Deferred.await(closed);
      expect(produced).toBe(3);
    }),
  ),
);
