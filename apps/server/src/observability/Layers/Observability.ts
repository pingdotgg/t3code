import { makeLocalFileTracer, makeTraceSink } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { ServerConfig } from "../../config.ts";
import { ServerLoggerLive } from "../../serverLogger.ts";
import { BrowserTraceCollector } from "../Services/BrowserTraceCollector.ts";

const otlpSerializationLayer = OtlpSerialization.layerJson;

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    const traceReferencesLayer = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
    );

    const tracerLayer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
        });
        const delegate =
          config.otlpTracesUrl === undefined
            ? undefined
            : yield* OtlpTracer.make({
                url: config.otlpTracesUrl,
                exportInterval: `${config.otlpExportIntervalMs} millis`,
                resource: {
                  serviceName: config.otlpServiceName,
                  attributes: {
                    "service.runtime": "t3-server",
                    "service.mode": config.mode,
                  },
                },
              });

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sink,
          ...(delegate ? { delegate } : {}),
        });

        return Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, tracer),
          Layer.succeed(BrowserTraceCollector, {
            record: (records) =>
              Effect.sync(() => {
                for (const record of records) {
                  sink.push(record);
                }
              }),
          }),
        );
      }),
    ).pipe(Layer.provideMerge(otlpSerializationLayer));

    const metricsLayer =
      config.otlpMetricsUrl === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: config.otlpMetricsUrl,
            exportInterval: `${config.otlpExportIntervalMs} millis`,
            resource: {
              serviceName: config.otlpServiceName,
              attributes: {
                "service.runtime": "t3-server",
                "service.mode": config.mode,
              },
            },
          }).pipe(Layer.provideMerge(otlpSerializationLayer));

    return Layer.mergeAll(ServerLoggerLive, traceReferencesLayer, tracerLayer, metricsLayer);
  }),
);
