import * as Config from "effect/Config";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as OtlpLogger from "effect/unstable/observability/OtlpLogger";
import * as OtlpMetrics from "effect/unstable/observability/OtlpMetrics";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";
import { unpackEnvValue } from "./RuntimeContext.ts";
import type { layer, layerOtlp } from "./Telemetry.ts";

/**
 * The shape of the {@link Telemetry} reference: a Layer of telemetry
 * exporters (tracer, loggers, metrics) built once per event into the
 * event's request scope. Requirements are satisfied from the runtime's
 * isolate context (`HttpClient`, `ConfigProvider`, …).
 */
export type TelemetryLayer = Layer.Layer<never, any, any>;

/**
 * Read one bound value back at runtime. `rc.set` packs values for the env
 * var wire (plain values JSON-stringified, `Redacted` as a marker routed
 * through the secret channel), so the raw env string must be unpacked with
 * {@link unpackEnvValue} — it handles all three shapes (packed JSON,
 * Redacted marker, and a raw string set directly in the environment).
 */
const readBoundValue = (key: string): Effect.Effect<unknown> =>
  Config.String(key).pipe(
    Config.withDefault(undefined),
    Effect.orElseSucceed(() => undefined),
    Effect.map((raw) => {
      if (raw === undefined || raw === "") {
        return undefined;
      }
      const value = unpackEnvValue<unknown>(raw);
      return Redacted.isRedacted(value) ? Redacted.value(value) : value;
    }),
  );

const readBound = (key: string): Effect.Effect<string | undefined> =>
  readBoundValue(key).pipe(
    Effect.map((inner) =>
      inner === undefined
        ? undefined
        : typeof inner === "string"
          ? inner
          : String(inner),
    ),
  );

/**
 * `service.name` fallback chain for the default exporter: the standard
 * OTEL variable, then the physical Function/Worker name, then the stack
 * name. `OtlpResource.fromConfig` dies without a service name, so the
 * chain must always produce one.
 */
const defaultServiceName = Effect.gen(function* () {
  return (
    (yield* readBound("OTEL_SERVICE_NAME")) ??
    (yield* readBound("ALCHEMY_WORKER_NAME")) ??
    (yield* readBound("AWS_LAMBDA_FUNCTION_NAME")) ??
    (yield* readBound("ALCHEMY_STACK_NAME")) ??
    "alchemy"
  );
});

const defaultResource = Effect.gen(function* () {
  const serviceName = yield* defaultServiceName;
  const stack = yield* readBound("ALCHEMY_STACK_NAME");
  const stage = yield* readBound("ALCHEMY_STAGE");
  return {
    serviceName,
    attributes: {
      ...(stack !== undefined ? { "alchemy.stack": stack } : undefined),
      ...(stage !== undefined ? { "alchemy.stage": stage } : undefined),
    },
  };
});

/**
 * Parse the OpenTelemetry `OTEL_EXPORTER_OTLP_HEADERS` format:
 * `key1=value1,key2=value2` with URL-encoded values.
 */
const parseOtlpHeaders = (
  raw: string | undefined,
): Record<string, string> | undefined => {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = entry.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    const value = entry.slice(eq + 1).trim();
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
};

/**
 * One export target for one signal, as stored in the bound destination
 * list: a concrete OTLP/HTTP URL and the headers to send with it.
 */
export interface ResolvedSignal {
  url: string;
  headers?: Record<string, string> | undefined;
}

/**
 * One export destination in the bound list — the resolved form of one
 * {@link layerOtlp} layer.
 */
export interface ResolvedDestination {
  traces?: ResolvedSignal | undefined;
  logs?: ResolvedSignal | undefined;
  metrics?: ResolvedSignal | undefined;
}

/**
 * The single env binding carrying every configured destination as a JSON
 * array of {@link ResolvedDestination}. One key (instead of per-signal
 * keys) is what lets multiple `layerOtlp` layers compose — each layer
 * build appends its destination and rebinds the full list.
 */
export const EXPORTERS_KEY = "ALCHEMY_OTEL_EXPORTERS";

/**
 * Resolve one signal's endpoint + headers from the standard OpenTelemetry
 * env vars (`OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT` as-is, or the base
 * endpoint with `/v1/{signal}` appended; headers per-signal → base). This
 * forms an *implicit extra destination*, so platform-injected OTLP config
 * exports without any layer.
 */
const signalConfig = (signal: "TRACES" | "LOGS" | "METRICS") =>
  Effect.gen(function* () {
    const specific = yield* readBound(`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`);
    const base = yield* readBound("OTEL_EXPORTER_OTLP_ENDPOINT");
    const url =
      specific !== undefined && specific !== ""
        ? specific
        : base !== undefined && base !== ""
          ? `${base.replace(/\/$/, "")}/v1/${signal.toLowerCase()}`
          : undefined;
    if (url === undefined) {
      return undefined;
    }
    const rawHeaders =
      (yield* readBound(`OTEL_EXPORTER_OTLP_${signal}_HEADERS`)) ??
      (yield* readBound("OTEL_EXPORTER_OTLP_HEADERS"));
    return { url, headers: parseOtlpHeaders(rawHeaders) } as ResolvedSignal;
  });

/**
 * Sentinel URLs the single exporter set posts to; the fanout client
 * rewrites each POST to every configured destination for that signal.
 * Serializing once through one exporter per signal is what keeps span ids
 * consistent across destinations — Effect has a single `Tracer` service,
 * so per-destination tracers would generate divergent trace ids.
 */
const SENTINEL = {
  traces: "http://telemetry.alchemy.internal/v1/traces",
  logs: "http://telemetry.alchemy.internal/v1/logs",
  metrics: "http://telemetry.alchemy.internal/v1/metrics",
} as const;

/**
 * Wrap the ambient `HttpClient` so a POST to a sentinel URL is re-sent to
 * every destination configured for that signal (with the destination's own
 * headers). A single healthy destination keeps the exporter alive: the
 * first 2xx response is returned; per-destination failures are logged at
 * debug and only surface when every destination fails.
 */
const fanoutClient = (
  routes: ReadonlyMap<string, ResolvedSignal[]>,
): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const base = yield* HttpClient.HttpClient;
      return HttpClient.transform(base, (effect, request) => {
        const targets = routes.get(request.url);
        if (targets === undefined) {
          return effect;
        }
        return Effect.gen(function* () {
          const results = yield* Effect.all(
            targets.map((target) =>
              Effect.result(
                base.execute(
                  request.pipe(
                    HttpClientRequest.setUrl(target.url),
                    HttpClientRequest.setHeaders(target.headers ?? {}),
                  ),
                ),
              ),
            ),
            { concurrency: "unbounded" },
          );
          const healthy = results.find(
            (result) =>
              Result.isSuccess(result) &&
              result.success.status >= 200 &&
              result.success.status < 300,
          );
          const anySuccess =
            healthy ?? results.find((result) => Result.isSuccess(result));
          if (anySuccess !== undefined && Result.isSuccess(anySuccess)) {
            for (const result of results) {
              if (result !== anySuccess && Result.isFailure(result)) {
                yield* Effect.logDebug(
                  "telemetry destination failed",
                  result.failure,
                );
              }
            }
            return anySuccess.success;
          }
          const failure = results.find((result) => Result.isFailure(result));
          return yield* failure !== undefined && Result.isFailure(failure)
            ? Effect.fail(failure.failure)
            : effect;
        });
      });
    }),
  );

const makeExporterLayer = (options?: {
  exportInterval?: Duration.Input;
}): TelemetryLayer =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Depending on the secret/plain packing path, the bound list arrives
      // as a JSON string or already parsed into an array.
      const rawList = yield* readBoundValue(EXPORTERS_KEY);
      const bound: ResolvedDestination[] = Array.isArray(rawList)
        ? (rawList as ResolvedDestination[])
        : typeof rawList === "string" && rawList !== ""
          ? yield* Effect.try(
              () => JSON.parse(rawList) as ResolvedDestination[],
            )
          : [];
      // The standard OTEL_* env vars form an implicit extra destination.
      const [stdTraces, stdLogs, stdMetrics] = yield* Effect.all([
        signalConfig("TRACES"),
        signalConfig("LOGS"),
        signalConfig("METRICS"),
      ]);
      const destinations: ResolvedDestination[] = [
        ...bound,
        ...(stdTraces || stdLogs || stdMetrics
          ? [{ traces: stdTraces, logs: stdLogs, metrics: stdMetrics }]
          : []),
      ];
      const targets = (signal: keyof ResolvedDestination) =>
        destinations.flatMap((destination) => {
          const resolved = destination[signal];
          return resolved !== undefined ? [resolved] : [];
        });
      const traces = targets("traces");
      const logs = targets("logs");
      const metrics = targets("metrics");
      if (traces.length === 0 && logs.length === 0 && metrics.length === 0) {
        return Layer.empty;
      }
      const resource = yield* defaultResource;
      const routes = new Map<string, ResolvedSignal[]>();
      const layers: Layer.Layer<never, never, any>[] = [];
      if (traces.length > 0) {
        routes.set(SENTINEL.traces, traces);
        layers.push(
          OtlpTracer.layer({
            url: SENTINEL.traces,
            resource,
            exportInterval: options?.exportInterval,
          }),
        );
      }
      if (logs.length > 0) {
        routes.set(SENTINEL.logs, logs);
        layers.push(
          OtlpLogger.layer({
            url: SENTINEL.logs,
            resource,
            exportInterval: options?.exportInterval,
          }),
        );
      }
      if (metrics.length > 0) {
        routes.set(SENTINEL.metrics, metrics);
        layers.push(
          OtlpMetrics.layer({
            url: SENTINEL.metrics,
            resource,
            exportInterval: options?.exportInterval,
          }),
        );
      }
      return Layer.mergeAll(...(layers as [Layer.Layer<never>])).pipe(
        Layer.provide(OtlpSerialization.layerJson),
        Layer.provide(fanoutClient(routes)),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Invalid telemetry configuration; telemetry disabled",
          cause,
        ).pipe(Effect.as(Layer.empty)),
      ),
    ),
  );

/**
 * The runtime half of the {@link layerOtlp} binding, and the default
 * per-event Layer: reads the bound `OTEL_EXPORTER_OTLP_*` values back and
 * constructs the OTLP JSON exporters. Each signal resolves independently;
 * only configured signals export; resolves to `Layer.empty` when nothing is
 * bound, so telemetry is free until a layer is provided.
 *
 * The periodic export intervals are effectively disabled: the exporter is
 * built per event and the request-scope flush delivers everything. An
 * interval export firing mid-event would race the scope close — the close
 * interrupts the exporter's in-flight batch (already spliced out of the
 * buffer), silently dropping it. Lambda invocations regularly outlive the
 * 1-second logger interval, which is exactly how this was discovered.
 *
 * A malformed configuration degrades to `Layer.empty` with a warning
 * instead of failing the event.
 */
export const fromBoundConfig: TelemetryLayer = makeExporterLayer({
  exportInterval: "1 hour",
});

/**
 * The process-runtime half of the binding: same bound-value resolution with
 * the standard periodic export intervals, since a server's root scope only
 * flushes at shutdown.
 */
const fromBoundConfigProcess: TelemetryLayer = makeExporterLayer();

/**
 * The per-event telemetry exporters, as a `Context.Reference` holding the
 * Layer the runtime bridges build into every event's request scope.
 * Provide it via {@link layerOtlp} / {@link layer} rather than directly —
 * see the module documentation.
 */
export const Telemetry = Context.Reference<TelemetryLayer>(
  "alchemy/Telemetry",
  {
    defaultValue: () => fromBoundConfig,
  },
);

const reference = Telemetry;

/**
 * Build the configured {@link Telemetry} Layer into an event's request
 * scope, returning the Context of telemetry services to provide to the
 * event's handler effect.
 *
 * Called by the runtime bridges (Worker, Durable Object, Workflow, Lambda)
 * once per event. Building into the *request* scope — not the
 * never-finalized isolate scope — is what makes export work on workerd:
 * the batching fiber lives inside the event's I/O context and the final
 * flush runs from the scope's finalizer, which the bridges register with
 * `ctx.waitUntil`.
 *
 * A failed build (bad user Layer, config error) degrades to an empty
 * Context with a warning instead of failing the event.
 *
 * `override` is the (possibly merged) custom Layer registered on the
 * runtime context by {@link layer} during init. It composes with
 * — rather than replaces — the bound OTLP destinations: loggers and metric
 * exporters merge, and a custom `Tracer` (a single Effect service) wins
 * over the built-in one.
 *
 * Declared `R = never`: the Layer's actual requirements (`HttpClient`,
 * `ConfigProvider`, …) are satisfied at runtime by the bridge's surrounding
 * `Effect.provide` of the built runtime context.
 */
export const buildEventTelemetry = (
  context: Context.Context<never>,
  scope: Scope.Scope,
  override?: TelemetryLayer | undefined,
  base?: TelemetryLayer | undefined,
): Effect.Effect<Context.Context<never>> =>
  Effect.suspend(() => {
    const bound = base ?? Context.get(context, reference);
    return Layer.buildWithScope(
      override === undefined ? bound : Layer.mergeAll(bound, override),
      scope,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to build telemetry layer", cause).pipe(
        Effect.as(Context.empty()),
      ),
    ),
  ) as Effect.Effect<Context.Context<never>>;

/**
 * Provide telemetry to a long-running server process (Cloudflare Container,
 * ECS Task, EC2 host, Lambda microVM).
 *
 * Unlike the per-event runtime bridges, server processes have no I/O-context
 * pinning and a real shutdown: the configured {@link Telemetry} Layer is
 * built ONCE into the ambient root scope, exporters batch on their intervals
 * for the life of the process, and the final flush runs when the root scope
 * closes on graceful exit.
 *
 * `runtimeContext` is the entrypoint's runtime context; its `telemetry`
 * field carries the custom Layer(s) registered by {@link layer}
 * during init, composed with the bound OTLP destinations (read with the
 * standard periodic export intervals).
 */
export const provideProcessTelemetry =
  (runtimeContext?: { telemetry?: TelemetryLayer | undefined }) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | Scope.Scope> =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const scope = yield* Effect.scope;
      const telemetry = yield* buildEventTelemetry(
        context,
        scope,
        runtimeContext?.telemetry,
        fromBoundConfigProcess,
      );
      return yield* Effect.provideContext(effect, telemetry);
    });
