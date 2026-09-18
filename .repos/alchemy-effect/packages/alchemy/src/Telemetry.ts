/**
 * OpenTelemetry export for deployed Functions/Workers, built on Effect's
 * OTLP exporters (`effect/unstable/observability`) and configured through
 * alchemy's binding infrastructure — exporters are Layers, and their
 * configuration (endpoints, tokens) is wired from resource Outputs like any
 * other binding.
 *
 * Provide a telemetry Layer on the Function/Worker init Effect, composed
 * into the single `Effect.provide` alongside the other binding layers:
 *
 * ```ts
 * import * as Alchemy from "alchemy";
 * import * as Axiom from "alchemy/Axiom";
 *
 * Effect.gen(function* () {
 *   // ...
 * }).pipe(
 *   Effect.provide(
 *     Layer.mergeAll(
 *       Cloudflare.R2.ReadWriteBucketBinding,
 *       // vendor sugar — binds dataset endpoints + ingest token:
 *       Axiom.Telemetry({ token: Ingest, traces: Traces, logs: Logs }),
 *       // or the generic OTLP form, wired from any Inputs/Outputs:
 *       // Alchemy.Telemetry.layerOtlp({ url: collector.url, headers: { ... } }),
 *       // or any custom exporter Layer:
 *       // Alchemy.Telemetry.layer(myExporterLayer),
 *     ),
 *   ),
 * );
 * ```
 *
 * {@link layerOtlp} is a *binding* layer: at deploy time it binds the
 * configured endpoints/headers onto the host (Redacted values as secrets),
 * and at runtime the exporter reads those bound values back. Telemetry is
 * off until a layer is provided — Effect's default tracer is a no-op, so
 * all instrumentation stays free.
 *
 * `Telemetry` itself is a `Context.Reference` holding the Layer of
 * exporters to install for every event (fetch, queue, cron, RPC, Durable
 * Object call, Workflow run, Lambda invoke). The runtime bridges build that
 * Layer into the event's request scope, so:
 *
 * - the exporter's batching fiber runs inside the event's I/O context
 *   (required on workerd, where timers/fetches are pinned to the request),
 * - buffered spans/logs/metrics are flushed when the request scope
 *   finalizes — registered with `ctx.waitUntil`, so flushing never delays
 *   the response.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Input } from "./Input.ts";
import * as Output from "./Output.ts";
import { CurrentRuntimeContext } from "./RuntimeContext.ts";
import {
  EXPORTERS_KEY,
  fromBoundConfig,
  type ResolvedDestination,
  type ResolvedSignal,
  Telemetry,
  type TelemetryLayer,
} from "./TelemetryRuntime.ts";

export {
  buildEventTelemetry,
  provideProcessTelemetry,
  Telemetry,
  type TelemetryLayer,
} from "./TelemetryRuntime.ts";

const reference = Telemetry;

/**
 * Install a custom telemetry Layer (any Layer providing a `Tracer`,
 * loggers, and/or metric exporters). It is built once per event into the
 * event's request scope, so scoped exporters flush when the request scope
 * finalizes.
 *
 * Custom layers COMPOSE with the built-in OTLP destinations and with each
 * other: loggers and metric exporters merge; a custom `Tracer` (a single
 * Effect service) replaces the built-in one.
 *
 * The isolate {@link Telemetry} reference stays the bound OTLP reader.
 * The custom Layer is stored on `ctx.telemetry` and merged per event as
 * the override, so `Layer.mergeAll` order with {@link layerOtlp} does not
 * drop logs/metrics.
 *
 * Provide it on the Function/Worker's init Effect (merged into the single
 * `Effect.provide`): building the returned Layer registers the exporter
 * Layer on the current runtime context, where the runtime bridges pick it
 * up per event. Handlers' request-time context is assembled by the bridge,
 * so a plain `Layer.succeed` of the reference on the init Effect would
 * never reach them — the registration is what makes it visible at request
 * time.
 */
export const layer = (exporter: TelemetryLayer): Layer.Layer<never> =>
  Layer.effect(
    reference,
    Effect.gen(function* () {
      const ctx = yield* CurrentRuntimeContext;
      if (ctx !== undefined) {
        ctx.telemetry =
          ctx.telemetry === undefined
            ? exporter
            : Layer.mergeAll(ctx.telemetry, exporter);
      }
      return fromBoundConfig;
    }),
  );

/**
 * A header value: a plain string, a `Redacted` secret, or an Output of
 * either (e.g. an ApiToken's `token` attribute).
 */
export type OtlpHeaderValue = Input<string | Redacted.Redacted<string>>;

/**
 * OTLP configuration for one signal. `url` and header values accept plain
 * values or resource Outputs — they are *bound* onto the host at deploy
 * time like any other binding.
 */
export interface OtlpSignalOptions {
  /** The OTLP/HTTP URL exports for this signal are POSTed to. */
  url: Input<string>;
  /**
   * Headers sent with each export request (e.g. auth tokens). `Redacted`
   * values bind as secrets.
   */
  headers?: Record<string, OtlpHeaderValue> | undefined;
}

/**
 * Options for {@link layerOtlp}. Configure a base `url` (with
 * `/v1/{signal}` appended per signal), per-signal urls, or a mix — a
 * per-signal entry takes precedence over the base.
 */
export interface OtlpOptions {
  /** Base OTLP/HTTP URL; `/v1/{traces,logs,metrics}` is appended per signal. */
  url?: Input<string> | undefined;
  /** Headers for every signal; per-signal `headers` take precedence. */
  headers?: Record<string, OtlpHeaderValue> | undefined;
  traces?: OtlpSignalOptions | undefined;
  logs?: OtlpSignalOptions | undefined;
  metrics?: OtlpSignalOptions | undefined;
  /**
   * The exported `service.name`.
   * @default the deployed Function/Worker's physical name
   */
  serviceName?: Input<string> | undefined;
}

/**
 * A placeholder in the destinations template pointing at one captured
 * Input value.
 */
interface Placeholder {
  readonly $input: number;
}

/**
 * Per-runtime-context accumulator: every `layerOtlp` layer built for
 * the same host appends its destination here and rebinds the full list, so
 * merged layers compose instead of clobbering each other.
 */
const rcDestinations = new WeakMap<object, OtlpOptions[]>();

/**
 * Compose the full destination list into a single Output: capture every
 * Input (urls, header values) into an `Output.all`, then materialize the
 * JSON array of {@link ResolvedDestination}. If any captured value is
 * `Redacted`, the whole JSON binds as a secret.
 */
const destinationsOutput = (
  list: OtlpOptions[],
): Output.Output<string | Redacted.Redacted<string>> => {
  const inputs: unknown[] = [];
  const capture = (value: unknown): Placeholder => {
    inputs.push(value);
    return { $input: inputs.length - 1 };
  };
  const captureHeaders = (
    headers: Record<string, OtlpHeaderValue> | undefined,
  ): Record<string, Placeholder> | undefined =>
    headers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [key, capture(value)]),
        );
  const template = list.map((options) => ({
    url: options.url !== undefined ? capture(options.url) : undefined,
    headers: captureHeaders(options.headers),
    traces: options.traces && {
      url: capture(options.traces.url),
      headers: captureHeaders(options.traces.headers),
    },
    logs: options.logs && {
      url: capture(options.logs.url),
      headers: captureHeaders(options.logs.headers),
    },
    metrics: options.metrics && {
      url: capture(options.metrics.url),
      headers: captureHeaders(options.metrics.headers),
    },
  }));
  return (
    Output.all(
      ...inputs.map((input) => Output.asOutput(input as never)),
    ) as Output.Output<unknown[]>
  ).pipe(
    Output.map((values) => {
      let secret = false;
      const resolve = (placeholder: Placeholder): string => {
        let value = values[placeholder.$input];
        if (Redacted.isRedacted(value)) {
          secret = true;
          value = Redacted.value(value);
        }
        return typeof value === "string" ? value : String(value);
      };
      const resolveHeaders = (
        headers: Record<string, Placeholder> | undefined,
      ): Record<string, string> | undefined =>
        headers === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(headers).map(([key, value]) => [
                key,
                resolve(value),
              ]),
            );
      const resolveSignal = (
        entry: { url: Placeholder; headers?: Record<string, Placeholder> },
        base: { url?: Placeholder; headers?: Record<string, Placeholder> },
        path: string,
      ): ResolvedSignal | undefined => {
        if (entry !== undefined) {
          return {
            url: resolve(entry.url),
            headers: resolveHeaders(entry.headers),
          };
        }
        if (base.url !== undefined) {
          return {
            url: `${resolve(base.url).replace(/\/$/, "")}/v1/${path}`,
            headers: resolveHeaders(base.headers),
          };
        }
        return undefined;
      };
      const destinations = template.flatMap((entry): ResolvedDestination[] => {
        const destination: ResolvedDestination = {
          traces: resolveSignal(entry.traces as never, entry, "traces"),
          logs: resolveSignal(entry.logs as never, entry, "logs"),
          metrics: resolveSignal(entry.metrics as never, entry, "metrics"),
        };
        return destination.traces || destination.logs || destination.metrics
          ? [destination]
          : [];
      });
      const json = JSON.stringify(destinations);
      return secret ? Redacted.make(json) : json;
    }),
  );
};

/**
 * The built-in OTLP exporter as a *binding* layer.
 *
 * At deploy time, building this layer binds the configured urls and
 * headers onto the host Function/Worker (Redacted values as secret
 * bindings) — url and header values accept resource Outputs, so exporter
 * config is wired from resources like any other binding. At runtime the
 * exporter reads the bound values back and ships traces, logs, and metrics
 * over OTLP/HTTP JSON, flushed as each event's scope closes.
 *
 * Exporters COMPOSE: merge several `otlp` layers (or vendor sugar like
 * `Axiom.Telemetry`) and every destination receives the telemetry — spans
 * are serialized once, so trace/span ids agree across destinations:
 *
 * ```ts
 * Effect.provide(
 *   Layer.mergeAll(
 *     Cloudflare.R2.ReadWriteBucketBinding,
 *     Axiom.Telemetry({ token: Ingest, traces: Traces, logs: Logs }),
 *     Alchemy.Telemetry.layerOtlp({
 *       url: "https://api.honeycomb.io",
 *       headers: { "x-honeycomb-team": apiKey },
 *     }),
 *   ),
 * )
 * ```
 */
export const layerOtlp = (options: OtlpOptions): Layer.Layer<never> =>
  Layer.effect(
    reference,
    Effect.gen(function* () {
      const rc = yield* CurrentRuntimeContext;
      if (rc !== undefined && !globalThis.__ALCHEMY_RUNTIME__) {
        // Accumulate this destination with any bound by sibling layers on
        // the same host, and rebind the full list (rebinding the same key
        // just overwrites, so build order doesn't matter).
        const list = rcDestinations.get(rc) ?? [];
        list.push(options);
        rcDestinations.set(rc, list);
        yield* rc.set(EXPORTERS_KEY, destinationsOutput(list));
        if (options.serviceName !== undefined) {
          yield* rc.set(
            "OTEL_SERVICE_NAME",
            Output.asOutput(options.serviceName as never),
          );
        }
      }
      // The runtime half reads the bound destinations back per event (or
      // once per process via `provideProcessTelemetry`).
      return fromBoundConfig;
    }),
  );
