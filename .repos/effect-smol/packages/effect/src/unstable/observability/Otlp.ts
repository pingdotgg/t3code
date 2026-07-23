/**
 * Combined OTLP/HTTP export for Effect logs, metrics, and traces.
 *
 * This module installs the signal-specific OTLP logger, metrics exporter, and
 * tracer exporter from one shared configuration. Use it when an application
 * sends all three observability signals to the same OpenTelemetry Collector,
 * vendor OTLP intake, or local development collector and should not configure
 * each exporter separately.
 *
 * **Mental model**
 *
 * `baseUrl` is the OTLP/HTTP root, such as `http://localhost:4318`. The
 * combined layer appends `/v1/logs`, `/v1/metrics`, and `/v1/traces`, then
 * delegates batching, resource handling, and payload construction to the
 * signal-specific modules. `layerJson` and `layerProtobuf` provide the
 * serialization layer; `layer` leaves `OtlpSerialization` in the requirements
 * so callers can provide a custom encoder.
 *
 * **Common tasks**
 *
 * - Use `layerJson` for JSON OTLP/HTTP endpoints and `layerProtobuf` for
 *   protobuf endpoints.
 * - Pass `headers` for collector authentication or routing.
 * - Set `resource` to define service name, service version, and additional
 *   resource attributes.
 * - Tune export intervals, `maxBatchSize`, `metricsTemporality`, and
 *   `shutdownTimeout` for the target backend.
 *
 * **Gotchas**
 *
 * Do not include a signal path in `baseUrl`; this module adds the paths itself.
 * Buffered telemetry flushes when the scoped exporters finalize, subject to
 * `shutdownTimeout`, so long-running services should keep the layer installed
 * for the lifetime of the runtime.
 *
 * @since 4.0.0
 */
import type * as Duration from "../../Duration.ts"
import { flow } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import type * as Tracer from "../../Tracer.ts"
import type * as Headers from "../http/Headers.ts"
import type * as HttpClient from "../http/HttpClient.ts"
import * as HttpClientRequest from "../http/HttpClientRequest.ts"
import * as OtlpLogger from "./OtlpLogger.ts"
import type { AggregationTemporality } from "./OtlpMetrics.ts"
import * as OtlpMetrics from "./OtlpMetrics.ts"
import * as OtlpSerialization from "./OtlpSerialization.ts"
import * as OtlpTracer from "./OtlpTracer.ts"

/**
 * Creates a combined OTLP layer for logs, metrics, and traces.
 *
 * **Details**
 *
 * The layer sends data to `/v1/logs`, `/v1/metrics`, and `/v1/traces` below
 * `baseUrl` and requires an `OtlpSerialization` implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: {
  readonly baseUrl: string
  readonly resource?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown>
  } | undefined
  readonly headers?: Headers.Input | undefined
  readonly maxBatchSize?: number | undefined
  readonly tracerContext?: (<X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X) | undefined
  readonly loggerExportInterval?: Duration.Input | undefined
  readonly loggerExcludeLogSpans?: boolean | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly metricsExportInterval?: Duration.Input | undefined
  readonly metricsTemporality?: AggregationTemporality | undefined
  readonly tracerExportInterval?: Duration.Input | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
}): Layer.Layer<never, never, HttpClient.HttpClient | OtlpSerialization.OtlpSerialization> => {
  const base = HttpClientRequest.get(options.baseUrl)
  const url = (path: string) => HttpClientRequest.appendUrl(base, path).url
  return Layer.mergeAll(
    OtlpLogger.layer({
      url: url("/v1/logs"),
      resource: options.resource,
      headers: options.headers,
      exportInterval: options.loggerExportInterval,
      maxBatchSize: options.maxBatchSize,
      shutdownTimeout: options.shutdownTimeout,
      excludeLogSpans: options.loggerExcludeLogSpans,
      mergeWithExisting: options.loggerMergeWithExisting
    }),
    OtlpMetrics.layer({
      url: url("/v1/metrics"),
      resource: options.resource,
      headers: options.headers,
      exportInterval: options.metricsExportInterval,
      shutdownTimeout: options.shutdownTimeout,
      temporality: options.metricsTemporality
    }),
    OtlpTracer.layer({
      url: url("/v1/traces"),
      resource: options.resource,
      headers: options.headers,
      exportInterval: options.tracerExportInterval,
      maxBatchSize: options.maxBatchSize,
      context: options.tracerContext,
      shutdownTimeout: options.shutdownTimeout
    })
  )
}

/**
 * Creates the combined OTLP logs, metrics, and traces layer using JSON
 * serialization.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerJson: (options: {
  readonly baseUrl: string
  readonly resource?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown>
  } | undefined
  readonly headers?: Headers.Input | undefined
  readonly maxBatchSize?: number | undefined
  readonly tracerContext?: (<X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X) | undefined
  readonly loggerExportInterval?: Duration.Input | undefined
  readonly loggerExcludeLogSpans?: boolean | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly metricsExportInterval?: Duration.Input | undefined
  readonly metricsTemporality?: AggregationTemporality | undefined
  readonly tracerExportInterval?: Duration.Input | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
}) => Layer.Layer<never, never, HttpClient.HttpClient> = flow(layer, Layer.provide(OtlpSerialization.layerJson))

/**
 * Creates the combined OTLP logs, metrics, and traces layer using protobuf
 * serialization.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerProtobuf: (options: {
  readonly baseUrl: string
  readonly resource?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown>
  } | undefined
  readonly headers?: Headers.Input | undefined
  readonly maxBatchSize?: number | undefined
  readonly tracerContext?: (<X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X) | undefined
  readonly loggerExportInterval?: Duration.Input | undefined
  readonly loggerExcludeLogSpans?: boolean | undefined
  readonly loggerMergeWithExisting?: boolean | undefined
  readonly metricsExportInterval?: Duration.Input | undefined
  readonly metricsTemporality?: AggregationTemporality | undefined
  readonly tracerExportInterval?: Duration.Input | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
}) => Layer.Layer<never, never, HttpClient.HttpClient> = flow(layer, Layer.provide(OtlpSerialization.layerProtobuf))
