import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Metric from "effect/Metric";

/**
 * End-to-end fixture for Axiom telemetry: datasets and an ingest token
 * declared next to the Worker, wired through the `Axiom.Telemetry` binding
 * layer. Deterministic dataset names so re-runs reconcile the same
 * datasets.
 */
export const TRACES_DATASET = "alchemy-test-otel-traces";
export const LOGS_DATASET = "alchemy-test-otel-logs";
export const METRICS_DATASET = "alchemy-test-otel-metrics";

export const Traces = Axiom.Dataset("Traces", {
  name: TRACES_DATASET,
  kind: "otel:traces:v1",
});

export const Logs = Axiom.Dataset("Logs", {
  name: LOGS_DATASET,
  kind: "otel:logs:v1",
});

export const Metrics = Axiom.Dataset("Metrics", {
  name: METRICS_DATASET,
  kind: "otel:metrics:v1",
});

/** Counted once per `/work` request; the test queries it out of Axiom. */
const workCounter = Metric.counter("axiom_e2e_work_total");

export const Ingest = Axiom.ApiToken("Ingest", {
  name: "alchemy-test-otel-ingest",
  datasetCapabilities: {
    [TRACES_DATASET]: { ingest: ["create"] },
    [LOGS_DATASET]: { ingest: ["create"] },
    [METRICS_DATASET]: { ingest: ["create"] },
  },
});

export default class AxiomTracedWorker extends Cloudflare.Worker<AxiomTracedWorker>()(
  "AxiomTracedWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/work") {
          yield* Effect.log("axiom-work-log").pipe(Effect.withSpan("axiom.child-span"));
          yield* Metric.update(workCounter, 1);
          return yield* HttpServerResponse.json({ marker: "axiom-did-work" });
        }
        return HttpServerResponse.text("axiom-ok");
      }),
    };
  }).pipe(
    // The whole observability integration: dataset endpoints + the ingest
    // token bind onto the Worker; the built-in exporter ships each signal
    // to its dataset, flushed per request.
    Effect.provide(
      Axiom.Telemetry({
        token: Ingest,
        traces: Traces,
        logs: Logs,
        metrics: Metrics,
        serviceName: "otel-axiom-e2e",
      }),
    ),
  ),
) {}
