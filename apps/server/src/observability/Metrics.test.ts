import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";

import { withMetrics } from "./Metrics.ts";

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

describe("withMetrics", () => {
  it.effect("supports pipe-style usage", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_pipe_total");
      const timer = Metric.timer("with_metrics_pipe_duration");

      const result = yield* Effect.succeed("ok").pipe(
        withMetrics({
          counter,
          timer,
          attributes: {
            operation: "pipe",
          },
        }),
      );

      assert.equal(result, "ok");

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_pipe_total", {
          operation: "pipe",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_pipe_duration", {
          operation: "pipe",
        }),
        true,
      );
    }),
  );

  it.effect("supports direct invocation", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_direct_total");

      yield* withMetrics(Effect.fail("boom"), {
        counter,
        attributes: {
          operation: "direct",
        },
      }).pipe(Effect.exit);

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_direct_total", {
          operation: "direct",
          outcome: "failure",
        }),
        true,
      );
    }),
  );

  it.effect("evaluates attributes lazily after the wrapped effect runs", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_lazy_total");
      const timer = Metric.timer("with_metrics_lazy_duration");
      let provider = ProviderDriverKind.make("unknown");
      const lazyInittedProvider = ProviderDriverKind.make("codex");

      yield* Effect.sync(() => {
        provider = lazyInittedProvider;
      }).pipe(
        withMetrics({
          counter,
          timer,
          attributes: () => ({
            provider,
            operation: "lazy",
          }),
        }),
      );

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_lazy_total", {
          provider: lazyInittedProvider,
          operation: "lazy",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_lazy_duration", {
          provider: lazyInittedProvider,
          operation: "lazy",
        }),
        true,
      );
    }),
  );

  it.effect("records timer durations from nanosecond clock readings", () =>
    Effect.gen(function* () {
      const duration = Duration.nanos(1_500_000n);
      const timer = Metric.timer("with_metrics_nanos_duration");

      yield* Effect.gen(function* () {
        const fiber = yield* Effect.sleep(duration).pipe(
          withMetrics({
            timer,
            attributes: {
              operation: "nanos",
            },
          }),
          Effect.forkChild,
        );

        yield* Effect.yieldNow;
        yield* TestClock.adjust(duration);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer()));

      const snapshots = yield* Metric.snapshot;
      const snapshot = findHistogramSnapshot(snapshots, "with_metrics_nanos_duration", {
        operation: "nanos",
      });

      assert.equal(snapshot?.state.count, 1);
      assert.equal(snapshot?.state.sum, 1.5);
    }),
  );
});
