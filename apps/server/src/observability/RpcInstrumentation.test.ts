import { assert, describe, it } from "@effect/vitest";
import { WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./RpcInstrumentation.ts";

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

const findHistogramSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Histogram" }> =>
      snapshot.type === "Histogram" &&
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

const collectSpanNames = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<ReadonlyArray<string>, E, R> =>
  Effect.gen(function* () {
    const spanNames: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);

        span.end = (endTime, exit) => {
          end(endTime, exit);
          if (span.sampled) {
            spanNames.push(span.name);
          }
        };

        return span;
      },
    });

    yield* effect.pipe(Effect.withTracer(tracer));

    return spanNames;
  });

describe("RpcInstrumentation", () => {
  it.effect("records success metrics for unary RPC handlers", () =>
    Effect.gen(function* () {
      yield* observeRpcEffect("rpc.instrumentation.success", Effect.succeed("ok"), {
        "rpc.aggregate": "test",
      }).pipe(Effect.withSpan("rpc.instrumentation.success.span"));

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.success",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.success",
        }),
        true,
      );
    }),
  );

  it.effect("records failure outcomes for unary RPC handlers", () =>
    Effect.gen(function* () {
      yield* Effect.exit(
        observeRpcEffect("rpc.instrumentation.failure", Effect.fail("boom"), {
          "rpc.aggregate": "test",
        }).pipe(Effect.withSpan("rpc.instrumentation.failure.span")),
      );

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.failure",
          outcome: "failure",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.failure",
        }),
        true,
      );
    }),
  );

  it.effect("records subscription activation metrics for stream RPC handlers", () =>
    Effect.gen(function* () {
      const events = yield* Stream.runCollect(
        observeRpcStreamEffect(
          "rpc.instrumentation.stream",
          Effect.succeed(Stream.make("a", "b")),
          { "rpc.aggregate": "test" },
        ).pipe(Stream.withSpan("rpc.instrumentation.stream.span")),
      );

      assert.deepStrictEqual(Array.from(events), ["a", "b"]);

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.stream",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.stream",
        }),
        true,
      );
    }),
  );

  it.effect("records failure outcomes for direct stream RPC handlers during consumption", () =>
    Effect.gen(function* () {
      const exit = yield* Stream.runCollect(
        observeRpcStream(
          "rpc.instrumentation.stream.failure",
          Stream.make("a").pipe(Stream.concat(Stream.fail("boom"))),
          { "rpc.aggregate": "test" },
        ).pipe(Stream.withSpan("rpc.instrumentation.stream.failure.span")),
      ).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.stream.failure",
          outcome: "failure",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.stream.failure",
        }),
        true,
      );
    }),
  );

  it.effect("records direct stream durations from nanosecond clock readings", () =>
    Effect.gen(function* () {
      const duration = Duration.nanos(1_500_000n);
      const events = yield* Effect.gen(function* () {
        const fiber = yield* Stream.runCollect(
          observeRpcStream(
            WS_METHODS.serverGetProcessDiagnostics,
            Stream.fromEffect(Effect.sleep(duration).pipe(Effect.as("ok"))),
            {
              "rpc.aggregate": "test",
            },
          ),
        ).pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        yield* TestClock.adjust(duration);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer()));

      assert.deepStrictEqual(Array.from(events), ["ok"]);

      const snapshots = yield* Metric.snapshot;
      const snapshot = findHistogramSnapshot(snapshots, "t3_rpc_request_duration", {
        method: WS_METHODS.serverGetProcessDiagnostics,
      });

      assert.equal(snapshot?.state.count, 1);
      assert.equal(snapshot?.state.sum, 1.5);
    }),
  );

  it.effect("records failure outcomes when a stream RPC effect produces a failing stream", () =>
    Effect.gen(function* () {
      const exit = yield* Stream.runCollect(
        observeRpcStreamEffect(
          "rpc.instrumentation.stream.effect.failure",
          Effect.succeed(Stream.fail("boom")),
          { "rpc.aggregate": "test" },
        ).pipe(Stream.withSpan("rpc.instrumentation.stream.effect.failure.span")),
      ).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.stream.effect.failure",
          outcome: "failure",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.stream.effect.failure",
        }),
        true,
      );
    }),
  );

  it.effect("records spans for traced stream RPC handlers", () =>
    Effect.gen(function* () {
      const spanNames = yield* collectSpanNames(
        Stream.runCollect(
          observeRpcStream(
            "rpc.instrumentation.traced.stream",
            Stream.fromEffect(
              Effect.succeed("ok").pipe(Effect.withSpan("rpc.instrumentation.traced.stream.child")),
            ),
            { "rpc.aggregate": "test" },
          ),
        ),
      );

      assert.equal(spanNames.includes("ws.rpc.rpc.instrumentation.traced.stream"), true);
      assert.equal(spanNames.includes("rpc.instrumentation.traced.stream.child"), true);
    }),
  );

  it.effect("does not create spans for disabled unary RPC handlers", () =>
    Effect.gen(function* () {
      const spanNames = yield* collectSpanNames(
        observeRpcEffect(
          WS_METHODS.serverGetTraceDiagnostics,
          Effect.succeed("ok").pipe(Effect.withSpan("rpc.instrumentation.disabled.unary.child")),
          { "rpc.aggregate": "test" },
        ),
      );

      assert.deepStrictEqual(spanNames, []);
    }),
  );

  it.effect("does not create spans for disabled direct stream RPC handlers", () =>
    Effect.gen(function* () {
      const spanNames = yield* collectSpanNames(
        Stream.runCollect(
          observeRpcStream(
            WS_METHODS.serverGetTraceDiagnostics,
            Stream.fromEffect(
              Effect.succeed("ok").pipe(
                Effect.withSpan("rpc.instrumentation.disabled.stream.child"),
              ),
            ),
            { "rpc.aggregate": "test" },
          ),
        ),
      );

      assert.deepStrictEqual(spanNames, []);
    }),
  );

  it.effect("does not create spans for disabled stream effect RPC handlers", () =>
    Effect.gen(function* () {
      const spanNames = yield* collectSpanNames(
        Stream.runCollect(
          observeRpcStreamEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            Effect.succeed(
              Stream.fromEffect(
                Effect.succeed("ok").pipe(
                  Effect.withSpan("rpc.instrumentation.disabled.stream.effect.consume"),
                ),
              ),
            ).pipe(Effect.withSpan("rpc.instrumentation.disabled.stream.effect.create")),
            { "rpc.aggregate": "test" },
          ),
        ),
      );

      assert.deepStrictEqual(spanNames, []);
    }),
  );
});
