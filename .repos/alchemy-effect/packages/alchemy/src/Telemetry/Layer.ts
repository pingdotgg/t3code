import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as OtlpMetrics from "effect/observability/OtlpMetrics";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";
import packageJson from "../../package.json" with { type: "json" };
import { collectAttributes, isTelemetryDisabled } from "./Attributes.ts";

const TRACES_URL = "https://otel.alchemy.run/v1/traces";
const METRICS_URL = "https://otel.alchemy.run/v1/metrics";

const SERVICE_NAME = "alchemy-cli";

const buildOtlpLayer = (attrs: Record<string, unknown>): Layer.Layer<never, never, never> => {
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
  return Layer.mergeAll(tracer, metrics).pipe(
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
 * Logs are never exported: they stay in the run log on disk, which users
 * can attach to a support request.
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
