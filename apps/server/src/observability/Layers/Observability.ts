import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import { otlpSerializationLayer } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

import * as ServerConfig from "../../config.ts";
import * as AgentTelemetry from "./AgentTelemetry.ts";

// This demo records provider activity only. Never install the agent exporter as
// the runtime tracer: doing so also records HTTP, SQL, Git polling, and UI work.
export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const traces = config.otlpTracesExport;
    const agentExporter = Layer.effect(
      AgentTelemetry.AgentTraceExporter,
      config.otlpTracesUrl === undefined
        ? Effect.succeed(undefined)
        : OtlpTracer.make({
            url: config.otlpTracesUrl,
            exportInterval: `${traces.exportIntervalMs} millis`,
            headers: traces.headers,
            resource: ServerConfig.otlpResource(config),
          }),
    ).pipe(
      Layer.provide(OtlpExporter.layerFlusher),
      Layer.provide(otlpSerializationLayer(traces.protocol)),
      Layer.provide(
        OtelEnvironment.layerResourceAttributes(config.otelEnvironment.resourceAttributes),
      ),
    );

    return Layer.effectDiscard(
      Effect.forEach(config.otelEnvironment.warnings, (warning) => Effect.logWarning(warning)),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          agentExporter,
          Layer.succeed(References.TracerEnabled, false),
          Layer.succeed(References.MinimumLogLevel, config.logLevel),
          Logger.layer([Logger.consolePretty()], { mergeWithExisting: false }),
          httpHeaderRedactionLayer,
        ),
      ),
    );
  }),
);
