import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import { HttpClient, HttpClientResponse } from "effect/http";
import { OtlpMetrics, OtlpSerialization } from "effect/observability";
import { describe } from "vite-plus/test";

import * as Metrics from "./Metrics.ts";

const TOTAL_COUNTERS = Object.values(Metrics).filter(
  (value): value is Metric.Counter<number> => Metric.isMetric(value) && value.type === "Counter",
);

interface OtlpMetricsPayload {
  readonly resourceMetrics?: ReadonlyArray<{
    readonly scopeMetrics?: ReadonlyArray<{
      readonly metrics?: ReadonlyArray<{
        readonly name?: string;
        readonly sum?: { readonly isMonotonic?: boolean };
      }>;
    }>;
  }>;
}

describe("Metrics", () => {
  it.effect("exports every *_total counter as a monotonic OTLP sum", () => {
    const exported: Array<OtlpMetricsPayload> = [];
    const client = HttpClient.make((request) => {
      if (request.body._tag === "Uint8Array") {
        exported.push(
          JSON.parse(new TextDecoder().decode(request.body.body)) as OtlpMetricsPayload,
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
      );
    });
    const layer = OtlpMetrics.layer({
      url: "http://localhost:4318/v1/metrics",
      resource: { serviceName: "t3-test" },
      exportInterval: "1 hour",
      shutdownTimeout: "1 second",
    }).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );

    return Effect.gen(function* () {
      const registry = new Map();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer);
          for (const counter of TOTAL_COUNTERS) {
            yield* Metric.update(counter, 1);
          }
        }),
      ).pipe(Effect.provideService(Metric.MetricRegistry, registry));

      const sumsByName = new Map(
        exported
          .flatMap((payload) => payload.resourceMetrics ?? [])
          .flatMap((resourceMetric) => resourceMetric.scopeMetrics ?? [])
          .flatMap((scopeMetric) => scopeMetric.metrics ?? [])
          .flatMap((metric) =>
            typeof metric.name === "string" && metric.sum !== undefined
              ? [[metric.name, metric.sum.isMonotonic] as const]
              : [],
          ),
      );

      assert.isAbove(TOTAL_COUNTERS.length, 0);
      assert.strictEqual(sumsByName.size, TOTAL_COUNTERS.length);
      for (const [name, isMonotonic] of sumsByName) {
        assert.isTrue(isMonotonic, `${name} should export with sum.isMonotonic = true`);
      }
    });
  });
});
