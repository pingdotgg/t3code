import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import { increment, metricAttributes, updateGauge } from "./Metrics.ts";

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

describe("relay metrics helpers", () => {
  it("normalizes metric attributes for OTEL labels", () => {
    expect(
      metricAttributes({
        operation: "enqueue",
        success: true,
        count: 3,
        skipped: undefined,
        empty: null,
      }),
    ).toEqual([
      ["operation", "enqueue"],
      ["success", "true"],
      ["count", "3"],
    ]);
  });

  it.effect("records counters and gauges with normalized labels", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("relay_metrics_helper_counter_total");
      const gauge = Metric.gauge("relay_metrics_helper_gauge");

      yield* increment(counter, { operation: "link", managed: true });
      yield* updateGauge(gauge, { kind: "active" }, 7);

      const snapshots = yield* Metric.snapshot;

      expect(
        hasMetricSnapshot(snapshots, "relay_metrics_helper_counter_total", {
          operation: "link",
          managed: "true",
        }),
      ).toBe(true);
      expect(
        hasMetricSnapshot(snapshots, "relay_metrics_helper_gauge", {
          kind: "active",
        }),
      ).toBe(true);
    }),
  );
});
