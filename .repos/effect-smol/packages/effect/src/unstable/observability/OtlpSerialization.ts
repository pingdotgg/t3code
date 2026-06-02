/**
 * OTLP/HTTP serialization service shared by logs, metrics, and traces.
 *
 * This module decides how in-memory OTLP payloads become HTTP request bodies.
 * The signal exporters build trace, metric, and log data structures, then call
 * `OtlpSerialization` immediately before posting them to a collector.
 *
 * **Mental model**
 *
 * `OtlpSerialization` has one encoder per OTLP signal. `layerJson` writes the
 * structures directly with `HttpBody.jsonUnsafe`, which is useful for debugging
 * or endpoints that explicitly accept OTLP/HTTP JSON. `layerProtobuf` encodes
 * the same structures with the internal OTLP protobuf encoder and sets the
 * `application/x-protobuf` content type expected by many production collectors.
 *
 * **Common tasks**
 *
 * - Provide `layerProtobuf` for collectors that expect binary OTLP payloads.
 * - Provide `layerJson` when inspecting payloads or using an OTLP/HTTP JSON
 *   endpoint.
 * - Provide a custom `OtlpSerialization` service only when an exporter needs a
 *   non-standard body format.
 *
 * **Gotchas**
 *
 * This module only controls the wire format for traces, metrics, and logs.
 * Endpoint paths, authentication headers, batching, retries, and shutdown
 * flushing are handled by the OTLP exporter layers that consume the service.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Layer from "../../Layer.ts"
import * as HttpBody from "../http/HttpBody.ts"
import * as otlpProtobuf from "./internal/otlpProtobuf.ts"
import type { LogsData } from "./OtlpLogger.ts"
import type { MetricsData } from "./OtlpMetrics.ts"
import type { TraceData } from "./OtlpTracer.ts"

/**
 * Service for serializing OTLP traces, metrics, and logs into HTTP request
 * bodies.
 *
 * @category services
 * @since 4.0.0
 */
export class OtlpSerialization extends Context.Service<OtlpSerialization, {
  readonly traces: (data: TraceData) => HttpBody.HttpBody
  readonly metrics: (data: MetricsData) => HttpBody.HttpBody
  readonly logs: (data: LogsData) => HttpBody.HttpBody
}>()("effect/observability/OtlpSerialization") {}

/**
 * Provides `OtlpSerialization` using OTLP/HTTP JSON bodies.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerJson = Layer.succeed(OtlpSerialization, {
  traces: (spans) => HttpBody.jsonUnsafe(spans),
  metrics: (metrics) => HttpBody.jsonUnsafe(metrics),
  logs: (logs) => HttpBody.jsonUnsafe(logs)
})

/**
 * Provides `OtlpSerialization` using protobuf-encoded OTLP bodies with the
 * `application/x-protobuf` content type.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerProtobuf = Layer.succeed(OtlpSerialization, {
  traces: (spans) =>
    HttpBody.uint8Array(
      otlpProtobuf.encodeTracesData(spans as any),
      "application/x-protobuf"
    ),
  metrics: (metrics) =>
    HttpBody.uint8Array(
      otlpProtobuf.encodeMetricsData(metrics as any),
      "application/x-protobuf"
    ),
  logs: (logs) =>
    HttpBody.uint8Array(
      otlpProtobuf.encodeLogsData(logs as any),
      "application/x-protobuf"
    )
})
