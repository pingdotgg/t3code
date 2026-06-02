/**
 * Provides an Effect layer for configuring OpenTelemetry in browser
 * applications. The module builds a shared resource from explicit service
 * metadata and wires Effect tracing, metrics, and logging into OpenTelemetry
 * SDK providers when span processors, metric readers, or log record processors
 * are supplied.
 *
 * Use this module in client-side applications that need Effect spans, metrics,
 * and logs exported from browser runtimes, such as single-page apps,
 * multi-page apps with hydrated Effect code, frontend workers, or UI flows
 * that should be correlated with backend traces. Telemetry is enabled only for
 * the configured signal types, so tracing, metrics, and logging can be
 * installed independently from the same layer.
 *
 * Browser SDKs cannot rely on process environment resource configuration, so
 * provide stable service metadata explicitly and use resource attributes for
 * application, release, deployment, or page-shell identity rather than
 * per-event data. This module does not create exporters; supply
 * browser-compatible processors, readers, and exporters yourself, and make sure
 * their endpoints are reachable from the browser with the required CORS and
 * authentication behavior. The layer is scoped: tracer providers are
 * force-flushed and shut down when the scope is released, while metric readers
 * and logger providers follow their respective layer lifecycles. Keep the
 * scope alive for the lifetime of the browser application and release it during
 * application teardown when possible so batched exporters and periodic metric
 * readers can deliver buffered telemetry before the page is unloaded.
 *
 * @since 4.0.0
 */
import type * as Otel from "@opentelemetry/api"
import type { LoggerProviderConfig, LogRecordProcessor } from "@opentelemetry/sdk-logs"
import type { MetricReader } from "@opentelemetry/sdk-metrics"
import type { SpanProcessor, TracerConfig } from "@opentelemetry/sdk-trace-base"
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Effect from "effect/Effect"
import { constant, type LazyArg } from "effect/Function"
import * as Layer from "effect/Layer"
import { isNonEmpty } from "./internal/utilities.ts"
import * as Logger from "./Logger.ts"
import * as Metrics from "./Metrics.ts"
import * as Resource from "./Resource.ts"
import * as Tracer from "./Tracer.ts"

/**
 * Configuration for the Web OpenTelemetry layer, including resource metadata and optional tracing, metrics, and logging settings.
 *
 * @category models
 * @since 4.0.0
 */
export interface Configuration {
  readonly spanProcessor?: SpanProcessor | ReadonlyArray<SpanProcessor> | undefined
  readonly tracerConfig?: Omit<TracerConfig, "resource">
  readonly metricReader?: MetricReader | ReadonlyArray<MetricReader> | undefined
  readonly metricTemporality?: Metrics.TemporalityPreference | undefined
  readonly logRecordProcessor?: LogRecordProcessor | ReadonlyArray<LogRecordProcessor> | undefined
  readonly loggerProviderConfig?: Omit<LoggerProviderConfig, "resource"> | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly resource: {
    readonly serviceName: string
    readonly serviceVersion?: string
    readonly attributes?: Otel.Attributes
  }
}

/**
 * Creates a scoped Web OpenTelemetry tracer provider from one or more span processors and shuts it down when the layer is released.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTracerProvider = (
  processor: SpanProcessor | NonEmptyReadonlyArray<SpanProcessor>,
  config?: Omit<TracerConfig, "resource">
): Layer.Layer<Tracer.OtelTracerProvider, never, Resource.Resource> =>
  Layer.effect(
    Tracer.OtelTracerProvider,
    Effect.gen(function*() {
      const resource = yield* Resource.Resource
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          const provider = new WebTracerProvider({
            ...(config ?? undefined),
            resource,
            spanProcessors: Array.isArray(processor) ? (processor as any) : [processor]
          })
          return provider
        }),
        (provider) =>
          Effect.ignore(
            Effect.promise(() => provider.forceFlush().then(() => provider.shutdown()))
          )
      )
    })
  )

/**
 * Creates a Web OpenTelemetry layer from configuration, providing the resource and enabling tracing, metrics, and logging when configured.
 *
 * **When to use**
 *
 * Use to install browser OpenTelemetry support for an Effect application when
 * service metadata is provided in code and tracing, metrics, or logging should
 * be enabled from supplied span processors, metric readers, or log record
 * processors.
 *
 * **Details**
 *
 * The configuration can be provided lazily or effectfully. The layer always
 * provides `Resource.Resource`; tracing, metrics, and logging are installed only
 * when the corresponding processors or readers are non-empty.
 *
 * **Gotchas**
 *
 * Browser resource metadata is explicit; this layer does not read
 * OpenTelemetry environment variables. Empty processor or reader arrays are
 * treated as not configured.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: {
  (evaluate: LazyArg<Configuration>): Layer.Layer<Resource.Resource>
  <E, R>(evaluate: Effect.Effect<Configuration, E, R>): Layer.Layer<Resource.Resource, E, R>
} = (
  evaluate: LazyArg<Configuration> | Effect.Effect<Configuration, any, any>
): Layer.Layer<Resource.Resource> =>
  Layer.unwrap(
    Effect.gen(function*() {
      const config = yield* Effect.isEffect(evaluate)
        ? evaluate as Effect.Effect<Configuration>
        : Effect.sync(evaluate)

      const ResourceLive = Resource.layer(config.resource)

      const TracerLive = isNonEmpty(config.spanProcessor)
        ? Layer.provide(
          Tracer.layer,
          layerTracerProvider(config.spanProcessor, config.tracerConfig)
        )
        : Layer.empty

      const LoggerLive = isNonEmpty(config.logRecordProcessor)
        ? Layer.provide(
          Logger.layer({ mergeWithExisting: config.loggerMergeWithExisting }),
          Logger.layerLoggerProvider(config.logRecordProcessor, config.loggerProviderConfig)
        )
        : Layer.empty

      const MetricsLive = isNonEmpty(config.metricReader)
        ? Metrics.layer(constant(config.metricReader), {
          temporality: config.metricTemporality
        })
        : Layer.empty

      return Layer.mergeAll(TracerLive, MetricsLive, LoggerLive).pipe(
        Layer.provideMerge(ResourceLive)
      )
    })
  )
