import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import type { HttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

export interface RelayClientTracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface RelayClientTracingResource {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly runtime: string;
  readonly client: string;
  readonly component?: string;
}

export class RelayClientTracer extends Context.Reference(
  "@t3tools/shared/relayTracing/RelayClientTracer",
  {
    defaultValue: () => Option.none<Tracer.Tracer>(),
  },
) {}

export const withRelayClientTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RelayClientTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) => effect.pipe(Effect.provideService(Tracer.Tracer, tracer)),
      }),
    ),
  );

function cleanTraceStack(error: Error): string {
  const stack = error.stack ?? `${error.name}: ${error.message}`;
  const lines = stack.split("\n");
  const effectFrameIndex = lines.findIndex(
    (line, index) => index > 0 && /(?:Generator\.next|~effect\/Effect)/.test(line),
  );
  return effectFrameIndex < 0 ? stack : lines.slice(0, effectFrameIndex).join("\n");
}

function traceSafeError(value: unknown, seen = new WeakSet<object>()): Error {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "object" &&
          value !== null &&
          "message" in value &&
          typeof value.message === "string"
        ? value.message
        : String(value);

  let cause: Error | undefined;
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    if ("cause" in value && value.cause !== undefined) {
      cause = traceSafeError(value.cause, seen);
    }
  }

  const error = new Error(message, cause ? { cause } : undefined);
  if (value instanceof Error) {
    error.name = value.name;
    error.stack = cleanTraceStack(value);
  } else if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    error.name = value.name;
  }
  if (cause) {
    error.stack = `${error.stack ?? `${error.name}: ${error.message}`}\nCaused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`;
  }
  return error;
}

function traceSafeExit(exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> {
  if (Exit.isSuccess(exit)) {
    return exit;
  }
  return Exit.failCause(
    Cause.fromReasons(
      exit.cause.reasons.map((reason) => {
        if (Cause.isFailReason(reason)) {
          return Cause.makeFailReason(traceSafeError(reason.error));
        }
        if (Cause.isDieReason(reason)) {
          return Cause.makeDieReason(traceSafeError(reason.defect));
        }
        return reason;
      }),
    ),
  );
}

function nonInterferingTracer(delegate: Tracer.Tracer): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = delegate.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        try {
          end(endTime, traceSafeExit(exit));
        } catch {
          // Telemetry is best-effort and must never change application behavior.
        }
      };
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
}

export function makeRelayClientTracingLayer(
  config: RelayClientTracingConfig | null,
  resource: RelayClientTracingResource,
): Layer.Layer<never, never, HttpClient.HttpClient> {
  if (config === null) {
    return Layer.succeed(RelayClientTracer, Option.none());
  }

  const tracerLayer = OtlpTracer.layer({
    url: config.tracesUrl,
    headers: {
      Authorization: `Bearer ${config.tracesToken}`,
      "X-Axiom-Dataset": config.tracesDataset,
    },
    resource: {
      serviceName: resource.serviceName,
      serviceVersion: resource.serviceVersion,
      attributes: {
        "service.runtime": resource.runtime,
        "service.component": resource.component ?? "relay-client",
        "t3.client.surface": resource.client,
      },
    },
  }).pipe(Layer.provide(OtlpSerialization.layerJson));

  return Layer.effect(
    RelayClientTracer,
    Tracer.Tracer.pipe(Effect.map(nonInterferingTracer), Effect.map(Option.some)),
  ).pipe(Layer.provide(tracerLayer));
}
