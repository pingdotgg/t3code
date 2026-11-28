import * as HttpObservability from "@t3tools/shared/httpObservability";
import { makeLocalFileTracer, makeTraceSink } from "@t3tools/shared/observability";
import * as SharedObservability from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as Statement from "effect/sql/Statement";

import * as ServerConfig from "../config.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ServerLogger from "../serverLogger.ts";
import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";
import * as HeapAttribution from "./HeapAttribution.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;

    const traces = config.otlpTracesExport;
    // Keep serialization in context for the browser trace forwarder's exporter.
    const layerSerialization = SharedObservability.layerOtlpSerialization(traces.protocol);
    const attribution = yield* ResourceAttribution.ResourceAttribution;

    const layerTraceReferences = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
      // Preserve SQL spans while awaiting connections so lock waits can be recorded on them.
      Layer.succeed(Statement.SpanPropagationEnabled, true),
      HttpObservability.layer,
    );

    const layerTracer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          onFlush: (stats) =>
            attribution.record({
              component: "server-trace",
              operation: "append",
              logicalWriteBytes: stats.logicalWriteBytes,
              count: stats.count,
              durationMs: stats.durationMs,
            }),
        });
        // Traces stay in the local trace file; this fork never exports them over the network.
        const delegate = undefined;

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sink,
          sampleRoutineSpans:
            config.traceTimingEnabled &&
            LogLevel.isGreaterThanOrEqualTo(config.traceMinLevel, "Info"),
          ...(delegate ? { delegate } : {}),
        });

        const heapAttribution = yield* HeapAttribution.make(tracer);
        yield* heapAttribution.run;

        return Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, heapAttribution.tracer),
          BrowserTraceCollector.layer(sink),
        );
      }),
    ).pipe(Layer.provide(OtlpExporter.layerFlusher), Layer.provideMerge(layerSerialization));

    const metricsLayer = Layer.empty;

    const layerOtelWarnings = Layer.effectDiscard(
      Effect.forEach(config.otelEnvironment.warnings, (warning) => Effect.logWarning(warning)),
    );

    return layerOtelWarnings.pipe(
      Layer.provideMerge(
        Layer.mergeAll(ServerLogger.layer, layerTraceReferences, layerTracer, metricsLayer),
      ),
      Layer.provide(
        OtelEnvironment.layerResourceAttributes(config.otelEnvironment.resourceAttributes),
      ),
    );
  }),
);
