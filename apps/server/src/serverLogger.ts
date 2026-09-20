import { otlpSerializationLayer } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import * as OtlpLogger from "effect/unstable/observability/OtlpLogger";

import { otlpResource, ServerConfig } from "./config.ts";

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  const logs = config.otlpLogsExport;
  const otlpLogger =
    config.otlpLogsUrl === undefined
      ? undefined
      : OtlpLogger.make({
          url: config.otlpLogsUrl,
          exportInterval: `${logs.exportIntervalMs} millis`,
          headers: logs.headers,
          resource: otlpResource(config),
        });

  // `Logger.layer` writes the whole logger set rather than adding to it, so
  // every logger the server wants has to be named in this one call.
  //
  // `Logger.tracerLogger` reaches a collector by attaching each message to the
  // active span as a span event, which covers only messages logged inside a
  // recorded span and files them under traces. The OTLP logger carries the same
  // messages as log records stamped with their trace and span ids, so it is a
  // superset: keeping both would export every in-span message twice.
  //
  // Recording events on spans is also the shape OpenTelemetry is deprecating,
  // in favor of the log-based events this logger emits:
  // https://opentelemetry.io/blog/2026/deprecating-span-events/
  const loggerLayer = Logger.layer(
    otlpLogger === undefined
      ? [Logger.consolePretty(), Logger.tracerLogger]
      : [Logger.consolePretty(), otlpLogger],
    { mergeWithExisting: false },
  ).pipe(
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(otlpSerializationLayer(logs.protocol)),
  );

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
