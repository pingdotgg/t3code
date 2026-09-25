import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as OtlpLogger from "effect/unstable/observability/OtlpLogger";
import * as OtlpMetrics from "effect/unstable/observability/OtlpMetrics";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

import packageJson from "../../package.json" with { type: "json" };

import { collectAttributes, isTelemetryDisabled } from "./Attributes.ts";

const TRACES_URL = "https://otel.alchemy.run/v1/traces";
const METRICS_URL = "https://otel.alchemy.run/v1/metrics";
const LOGS_URL = "https://otel.alchemy.run/v1/logs";

const SERVICE_NAME = "alchemy-cli";

const buildOtlpLayer = (
  attrs: Record<string, unknown>,
): Layer.Layer<never, never, never> => {
  const resource = {
    serviceName: SERVICE_NAME,
    serviceVersion: packageJson.version,
    attributes: attrs,
  };

  // Short export intervals so even sub-second CLI invocations flush at
  // least one batch before the process exits.
  const tracer = OtlpTracer.layer({
    url: TRACES_URL,
    resource,
    exportInterval: "1 second",
  });
  const metrics = OtlpMetrics.layer({
    url: METRICS_URL,
    resource,
    exportInterval: "1 second",
  });
  // Stack on top of whatever loggers are already installed. Entrypoints
  // provide this layer *over* their terminal/file logger layer
  // (`Layer.provideMerge(TelemetryLive, ConsoleLogLive)`), so the terminal
  // logger has already replaced Effect's default stdout logger by the time
  // this runs and the OTLP logger is simply added alongside it.
  //
  // `mergeWithExisting: false` here would make telemetry *replace* the
  // terminal logger whenever this layer happened to be merged after it —
  // exactly what silenced `alchemy dev`'s console output in the exec child.
  const logger = OtlpLogger.layer({
    url: LOGS_URL,
    resource,
    exportInterval: "1 second",
    mergeWithExisting: true,
  });

  return Layer.mergeAll(tracer, metrics, logger).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );
};

/**
 * The CLI's telemetry layer. Builds an OTLP HTTP exporter that ships spans
 * to {@link TRACES_URL} and metrics to {@link METRICS_URL}, attaching
 * {@link collectAttributes} as resource-level attributes so every signal
 * carries user/project/runtime context.
 *
 * The OTLP logger merges with the loggers already installed, so provide this
 * layer on top of the entrypoint's terminal/file logger layer — e.g.
 * `Layer.provideMerge(TelemetryLive, ConsoleLogLive)` — never as a sibling in
 * a `Layer.mergeAll` (the last `CurrentLoggers` in a merge wins, silently
 * dropping either the terminal output or the telemetry).
 *
 * If the user has opted out (via `DO_NOT_TRACK`, `NO_TRACK`,
 * `ALCHEMY_TELEMETRY_DISABLED`, or `~/.alchemy/telemetry-disabled`), this
 * resolves to {@link Layer.empty}. Effect's default `Tracer` is a no-op,
 * so all `withSpan`/`Effect.fn` instrumentation in core stays free.
 */
export const TelemetryLive: Layer.Layer<never, never, never> = Layer.unwrap(
  Effect.gen(function* () {
    if (yield* isTelemetryDisabled) {
      return Layer.empty;
    }
    const attrs = yield* collectAttributes;
    return buildOtlpLayer(attrs as unknown as Record<string, unknown>);
  }),
);
