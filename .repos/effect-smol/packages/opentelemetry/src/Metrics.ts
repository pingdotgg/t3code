/**
 * OpenTelemetry metric export bridge for Effect metrics.
 *
 * Effect applications record metrics through Effect's metric APIs. This module
 * exposes the current Effect metric snapshot as an OpenTelemetry
 * `MetricProducer` and registers it with SDK `MetricReader`s so existing
 * OpenTelemetry exporters can deliver those metrics to OTLP, Prometheus, or
 * vendor backends.
 *
 * **Mental model**
 *
 * {@link makeProducer} captures the current Effect context and `Resource` and
 * builds a producer that OpenTelemetry readers can pull from.
 * {@link registerProducer} attaches that producer to one or more readers for
 * the lifetime of a scope. {@link layer} composes both steps and is the path
 * used by the Node and Web SDK layers when metric readers are configured.
 *
 * **Common tasks**
 *
 * - Install Effect metrics into OpenTelemetry with {@link layer}
 * - Build a producer manually with {@link makeProducer}
 * - Attach an existing producer to readers with {@link registerProducer}
 * - Choose cumulative or delta export with {@link TemporalityPreference}
 *
 * **Gotchas**
 *
 * Readers are shut down when the layer scope closes, so periodic exporters need
 * the application runtime to stay alive long enough for collection and export.
 * This module defaults to cumulative temporality; configure
 * `temporality: "delta"` only when the backend expects interval values. Export
 * protocol, batching, and delivery behavior come from the OpenTelemetry
 * reader/exporter, not from this bridge.
 *
 * @since 4.0.0
 */
import type { MetricProducer, MetricReader } from "@opentelemetry/sdk-metrics"
import type * as Arr from "effect/Array"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { LazyArg } from "effect/Function"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { MetricProducerImpl } from "./internal/metrics.ts"
import { Resource } from "./Resource.ts"

/**
 * Determines how metric values relate to the time interval over which they
 * are aggregated.
 *
 * **Details**
 *
 * `cumulative` reports total since a fixed start time. Each data point depends
 * on all previous measurements. This is the default behavior. `delta` reports
 * changes since the last export. Each interval is independent with no
 * dependency on previous measurements.
 *
 * @category models
 * @since 4.0.0
 */
export type TemporalityPreference = "cumulative" | "delta"

/**
 * Creates an OpenTelemetry metric producer from Effect metrics.
 *
 * **When to use**
 *
 * Use to create a `MetricProducer` when you need to wire Effect metrics into
 * OpenTelemetry manually instead of using the scoped `layer` helper.
 *
 * **Details**
 *
 * Requires the current OpenTelemetry `Resource`, captures the current Effect
 * context, and uses cumulative temporality by default. Pass `"delta"` for
 * interval-based values.
 *
 * @see {@link registerProducer} for attaching a producer to metric readers
 * @see {@link layer} for creating and registering a producer in a scoped layer
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeProducer = (temporality?: TemporalityPreference): Effect.Effect<MetricProducer, never, Resource> =>
  Effect.gen(function*() {
    const resource = yield* Resource
    const services = yield* Effect.context<never>()
    return new MetricProducerImpl(resource, services, temporality)
  })

/**
 * Registers a metric producer with one or more metric readers.
 *
 * @category constructors
 * @since 4.0.0
 */
export const registerProducer = (
  self: MetricProducer,
  metricReader: LazyArg<MetricReader | Arr.NonEmptyReadonlyArray<MetricReader>>,
  options?: {
    readonly shutdownTimeout?: Duration.Input | undefined
  }
): Effect.Effect<Array<any>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const reader = metricReader()
      const readers: Array<MetricReader> = Array.isArray(reader) ? reader : [reader] as any
      readers.forEach((reader) => reader.setMetricProducer(self))
      return readers
    }),
    (readers) =>
      Effect.promise(() =>
        Promise.all(
          readers.map((reader) => reader.shutdown())
        )
      ).pipe(
        Effect.ignore,
        Effect.interruptible,
        Effect.timeoutOption(options?.shutdownTimeout ?? 3000)
      )
  )

/**
 * Creates a Layer that registers a metric producer with metric readers.
 *
 * **Example** (Creating a metrics layer with temporality)
 *
 * ```ts
 * import { Metrics } from "@effect/opentelemetry"
 * import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
 * import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
 *
 * const metricExporter = new OTLPMetricExporter({ url: "<your-otel-url>" })
 *
 * // Use delta temporality for backends like Datadog or Dynatrace
 * const metricsLayer = Metrics.layer(
 *   () => new PeriodicExportingMetricReader({
 *     exporter: metricExporter,
 *     exportIntervalMillis: 10000
 *   }),
 *   { temporality: "delta" }
 * )
 *
 * // Use cumulative temporality for backends like Prometheus (default)
 * const cumulativeLayer = Metrics.layer(
 *   () => new PeriodicExportingMetricReader({ exporter: metricExporter }),
 *   { temporality: "cumulative" }
 * )
 * ```
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  evaluate: LazyArg<MetricReader | Arr.NonEmptyReadonlyArray<MetricReader>>,
  options?: {
    readonly shutdownTimeout?: Duration.Input | undefined
    readonly temporality?: TemporalityPreference | undefined
  }
): Layer.Layer<never, never, Resource> =>
  Layer.effectDiscard(Effect.flatMap(
    makeProducer(options?.temporality),
    (producer) => registerProducer(producer, evaluate, options)
  ))
