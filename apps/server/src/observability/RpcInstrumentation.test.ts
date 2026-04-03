import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Metric, Stream } from "effect";

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
});
