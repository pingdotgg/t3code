import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

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
  const traces = yield* Axiom.Dataset("RelayTracesDataset", {
    name: "t3-code-relay-traces",
    kind: "otel:traces:v1",
    description: "T3 Code relay Worker HTTP request spans.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });

  const ingestToken = yield* Axiom.ApiToken("RelayAxiomIngestToken", {
    name: "t3-code-relay-otel-ingest",
    description: "Owned by Alchemy. Scoped OTLP ingest token for relay HTTP spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  yield* Axiom.View("RelayRecentSpansView", {
    name: "t3-code-relay-recent-spans",
    description: "Recent relay HTTP request spans.",
    datasets: [traces.name],
    aplQuery: Output.map(traces.name, relayRecentSpansQuery),
  });

  return { traces, ingestToken } as const;
});

export const withSpanAttributes =
  (attributes: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateCurrentSpan(attributes).pipe(
      Effect.andThen(effect.pipe(Effect.annotateSpans(attributes))),
    );

export const makeRelayTraceLayer = (input: {
  readonly tracesEndpoint: string;
  readonly tracesDatasetName: string;
  readonly ingestToken: Redacted.Redacted<string>;
}) =>
  OtlpTracer.layer({
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
  }).pipe(Layer.provide(OtlpSerialization.layerJson));
