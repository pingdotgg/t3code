import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { relayResourceNameForStage } from "./deploymentConfig.ts";

const relayRecentSpansQuery = (dataset: string) =>
  [
    `['${dataset}']`,
    `| where isnotnull(span_id) or isnotnull(trace_id)`,
    `| extend requestMethod = column_ifexists('attributes.http.request.method', ''), path = column_ifexists('attributes.url.path', ''), endpoint = column_ifexists('attributes.http.route', ''), statusCode = column_ifexists('attributes.http.response.status_code', 0), customAttributes = column_ifexists('attributes.custom', dynamic({}))`,
    `| extend userId = customAttributes['user']['id']`,
    `| project _time, name, trace_id, span_id, duration, requestMethod, path, statusCode, endpoint, userId`,
    `| order by _time desc`,
    `| limit 200`,
  ].join("\n");

export const RelayObservability = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const traces = yield* Axiom.Dataset("RelayTracesDataset", {
    name: relayResourceNameForStage("t3-code-relay-traces", stage),
    kind: "otel:traces:v1",
    description: "more Code relay Worker HTTP request spans.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });

  const workerIngestToken = yield* Axiom.ApiToken("RelayWorkerAxiomIngestToken", {
    name: relayResourceNameForStage("t3-code-relay-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for relay HTTP spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  const mobileIngestToken = yield* Axiom.ApiToken("RelayMobileAxiomIngestToken", {
    name: relayResourceNameForStage("t3-code-mobile-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for T3 Code mobile spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  yield* Axiom.View("RelayRecentSpansView", {
    name: relayResourceNameForStage("t3-code-relay-recent-spans", stage),
    description: "Recent relay HTTP request spans.",
    datasets: [traces.name],
    aplQuery: Output.map(traces.name, relayRecentSpansQuery),
  });

  return { traces, workerIngestToken, mobileIngestToken } as const;
});

export const withSpanAttributes =
  (attributes: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateCurrentSpan(attributes).pipe(
      Effect.andThen(effect.pipe(Effect.annotateSpans(attributes))),
    );

const appendEncodedAttributes = (
  attributes: Record<string, unknown>,
  prefix: string,
  value: unknown,
): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    Array.isArray(value)
  ) {
    attributes[prefix] = value;
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    appendEncodedAttributes(attributes, `${prefix}.${key}`, child);
  }
};

const schemaErrorAttributes = (error: unknown): Record<string, unknown> | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const constructor = error.constructor;
  if (!Schema.isSchema(constructor)) {
    return undefined;
  }
  const encoded = Schema.encodeUnknownOption(constructor as unknown as Schema.Encoder<unknown>)(
    error,
  );
  if (Option.isNone(encoded) || typeof encoded.value !== "object" || encoded.value === null) {
    return undefined;
  }
  const tag = Reflect.get(encoded.value, "_tag");
  if (typeof tag !== "string") {
    return undefined;
  }

  const attributes: Record<string, unknown> = {
    "error.type": tag,
  };
  for (const [key, value] of Object.entries(encoded.value)) {
    if (key !== "_tag") {
      appendEncodedAttributes(attributes, `error.${key}`, value);
    }
  }
  return attributes;
};

const annotateSchemaError = (span: Tracer.Span, exit: Exit.Exit<unknown, unknown>): void => {
  if (Exit.isSuccess(exit)) {
    return;
  }
  for (const reason of exit.cause.reasons) {
    const error = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    const attributes = schemaErrorAttributes(error);
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        span.attribute(key, value);
      }
      return;
    }
  }
};

class RelayTraceSpan implements Tracer.Span {
  readonly _tag = "Span";
  private readonly delegate: Tracer.Span;

  constructor(delegate: Tracer.Span) {
    this.delegate = delegate;
  }

  get name() {
    return this.delegate.name;
  }
  get spanId() {
    return this.delegate.spanId;
  }
  get traceId() {
    return this.delegate.traceId;
  }
  get parent() {
    return this.delegate.parent;
  }
  get annotations() {
    return this.delegate.annotations;
  }
  get status() {
    return this.delegate.status;
  }
  get attributes() {
    return this.delegate.attributes;
  }
  get links() {
    return this.delegate.links;
  }
  get sampled() {
    return this.delegate.sampled;
  }
  get kind() {
    return this.delegate.kind;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    annotateSchemaError(this.delegate, exit);
    this.delegate.end(endTime, exit);
  }

  attribute(key: string, value: unknown): void {
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.delegate.event(name, startTime, attributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.delegate.addLinks(links);
  }
}

const withSchemaErrorAttributes = (delegate: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) => new RelayTraceSpan(delegate.span(options)),
    ...(delegate.context ? { context: delegate.context } : {}),
  });

export const makeRelayTraceLayer = (input: {
  readonly tracesEndpoint: string;
  readonly tracesDatasetName: string;
  readonly ingestToken: Redacted.Redacted<string>;
}) =>
  Layer.effect(
    Tracer.Tracer,
    OtlpTracer.make({
      url: input.tracesEndpoint,
      resource: {
        serviceName: "t3-code-relay-worker",
        attributes: {
          "service.runtime": "cloudflare-worker",
          "service.component": "relay",
        },
      },
      headers: {
        Authorization: `Bearer ${Redacted.value(input.ingestToken)}`,
        "X-Axiom-Dataset": input.tracesDatasetName,
      },
      exportInterval: "1 second",
    }).pipe(Effect.map(withSchemaErrorAttributes)),
  ).pipe(Layer.provide(OtlpSerialization.layerJson));
