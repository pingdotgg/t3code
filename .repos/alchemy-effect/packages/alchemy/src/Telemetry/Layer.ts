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
  // Replace (don't merge with) the default stdout logger here; downstream
  // commands re-add their own `fileLogger`/`consolePretty` via
  // `Logger.layer([...], { mergeWithExisting: true })`, which stacks on top
  // of this OtlpLogger without resurrecting Effect's default stdout logger.
  const logger = OtlpLogger.layer({
    url: LOGS_URL,
    resource,
    exportInterval: "1 second",
    mergeWithExisting: false,
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
