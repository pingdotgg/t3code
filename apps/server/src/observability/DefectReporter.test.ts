import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc";

import { WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import * as DefectReporter from "./DefectReporter.ts";

class TestRpcs extends RpcGroup.make(
  Rpc.make("subscribe", { success: Schema.Number, stream: true }),
  Rpc.make("boom", { success: Schema.Void }),
) {}
type TestRpc = RpcGroup.Rpcs<typeof TestRpcs>;

/** Runs `body` with every error log captured. */
const withErrorLogs = <A, E, R>(
  body: (logs: Queue.Queue<Cause.Cause<unknown>>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logs = yield* Queue.unbounded<Cause.Cause<unknown>>();
    const logger = Logger.make(({ cause, logLevel }) => {
      if (logLevel === "Error") Queue.offerUnsafe(logs, cause);
    });
    return yield* body(logs).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });

const errorMessage = (cause: Cause.Cause<unknown>) => (Cause.squash(cause) as Error).message;

describe("DefectReporter", () => {
  it.effect("a dying RPC handler fails alone, and its defect is logged", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        const subscription = yield* Queue.unbounded<number>();
        // The same client/server pairing as RpcTest.makeClient, with ws.ts's options.
        let client!: Effect.Success<
          ReturnType<typeof RpcClient.makeNoSerialization<TestRpc, never>>
        >;
        const server = yield* RpcServer.makeNoSerialization(TestRpcs, {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) => client.write(response),
        }).pipe(
          // Provided to the handlers, as ws.ts does.
          Effect.provide(
            TestRpcs.toLayer({
              subscribe: () => Stream.fromQueue(subscription),
              boom: () => Effect.die(new Error("handler bug")),
            }).pipe(Layer.provide(DefectReporter.layer)),
          ),
        );
        client = yield* RpcClient.makeNoSerialization(TestRpcs, {
          supportsAck: true,
          onFromClient: ({ message }) => server.write(0, message),
        });

        const received = yield* Queue.unbounded<number>();
        const sibling = yield* client.client.subscribe().pipe(
          Stream.runForEach((value) => Queue.offer(received, value)),
          Effect.forkScoped,
        );
        yield* Queue.offer(subscription, 1);
        assert.equal(yield* Queue.take(received), 1);

        const boom = yield* Effect.exit(client.client.boom());
        assert.isTrue(Exit.hasDies(boom));
        // The server reports before it answers, so the log is already written.
        const logged = yield* Queue.clear(logs);
        assert.deepEqual(logged.map(errorMessage), ["handler bug"]);

        // The sibling subscription on the same client keeps delivering.
        yield* Queue.offer(subscription, 2);
        const next = yield* Queue.take(received).pipe(
          Effect.raceFirst(Fiber.await(sibling).pipe(Effect.as("subscription ended"))),
        );
        assert.equal(next, 2);
        assert.equal(yield* Queue.size(logs), 0);
      }),
    ).pipe(Effect.scoped),
  );

  it.effect("logs defects, not typed failures or interrupts", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        yield* ErrorReporter.report(Cause.fail(new Error("expected")));
        yield* ErrorReporter.report(Cause.interrupt());
        yield* ErrorReporter.report(Cause.die(new Error("bug")));

        // Reporters log synchronously, so the logs are already written.
        assert.deepEqual((yield* Queue.clear(logs)).map(errorMessage), ["bug"]);
      }).pipe(Effect.provide(DefectReporter.layer)),
    ),
  );
});
