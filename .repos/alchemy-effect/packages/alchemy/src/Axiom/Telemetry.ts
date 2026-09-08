import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import { layerOtlp, type OtlpSignalOptions } from "../Telemetry.ts";
import type { ApiToken } from "./ApiToken.ts";
import type { Dataset } from "./Dataset.ts";

/**
 * A resource passed to the layer: either the module-scope declaration (an
 * Effect that resolves to the instance, same as what capability bindings
 * accept) or an already-yielded instance.
 */
export type ResourceInput<T> = T | Effect.Effect<T, never, any>;

/**
 * Options for {@link Telemetry}: an ingest {@link ApiToken} plus one
 * {@link Dataset} per OTel signal to export.
 */
export interface AxiomTelemetryProps {
  /**
   * The ingest credential. Must have `ingest: ["create"]` capability on
   * every dataset passed below.
   */
  token: ResourceInput<ApiToken>;
  /** Dataset (kind `otel:traces:v1`) to export traces into. */
  traces?: ResourceInput<Dataset> | undefined;
  /** Dataset (kind `otel:logs:v1`) to export logs into. */
  logs?: ResourceInput<Dataset> | undefined;
  /** Dataset (kind `otel:metrics:v1`) to export metrics into. */
  metrics?: ResourceInput<Dataset> | undefined;
  /**
   * The exported `service.name`.
   * @default the deployed Function/Worker's physical name
   */
  serviceName?: Input<string> | undefined;
}

/**
 * Resource declarations are Effects — yield them to get the instance with
 * attribute Output accessors, same as `Binding.Service`'s callable does for
 * capability bindings.
 */
const instance = <T>(resource: ResourceInput<T>): Effect.Effect<T> =>
  Effect.isEffect(resource)
    ? (resource as Effect.Effect<T>)
    : Effect.succeed(resource);

const signal = (
  token: ApiToken,
  dataset: Dataset | undefined,
  urlAttr: "otelTracesEndpoint" | "otelLogsEndpoint" | "otelMetricsEndpoint",
): OtlpSignalOptions | undefined =>
  dataset === undefined
    ? undefined
    : {
        url: dataset[urlAttr],
        headers: {
          Authorization: Output.map(
            token.token,
            (bearer) =>
              Redacted.make(
                `Bearer ${Redacted.value(bearer)}`,
              ) as Redacted.Redacted<string>,
          ),
          "X-Axiom-Dataset": dataset.name,
        },
      };

/**
 * Export a Function/Worker's telemetry to Axiom.
 *
 * A binding layer over {@link layerOtlp | Alchemy.Telemetry.layerOtlp}:
 * building it binds each dataset's OTLP endpoint and the ingest token's
 * `Authorization` header (as a secret) onto the host, and at runtime the
 * built-in exporter ships each signal to its dataset, flushed per event.
 *
 * Compose it into the Function/Worker's single `Effect.provide`:
 *
 * ```ts
 * import * as Axiom from "alchemy/Axiom";
 * import { Bucket } from "./bucket.ts";
 * import { Ingest, Logs, Traces } from "./observability.ts";
 *
 * export default Cloudflare.Worker(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // ...
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         Cloudflare.R2.ReadWriteBucketBinding,
 *         Axiom.Telemetry({ token: Ingest, traces: Traces, logs: Logs }),
 *       ),
 *     ),
 *   ),
 * );
 * ```
 */
export const Telemetry = (props: AxiomTelemetryProps): Layer.Layer<never> =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Declarations are yielded to instances (registering them on the
      // Stack if the enclosing host is the first to reference them), so
      // attribute accessors below produce real Outputs.
      const token = yield* instance(props.token);
      const traces = props.traces && (yield* instance(props.traces));
      const logs = props.logs && (yield* instance(props.logs));
      const metrics = props.metrics && (yield* instance(props.metrics));
      return layerOtlp({
        serviceName: props.serviceName,
        traces: signal(token, traces, "otelTracesEndpoint"),
        logs: signal(token, logs, "otelLogsEndpoint"),
        metrics: signal(token, metrics, "otelMetricsEndpoint"),
      });
    }),
  ) as Layer.Layer<never>;
