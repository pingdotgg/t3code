import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { expectUrlContains } from "../Cloudflare/Utils/Http.ts";
import AxiomTracedWorker, {
  Ingest,
  Logs,
  METRICS_DATASET,
  Metrics,
  TRACES_DATASET,
  Traces,
} from "./fixtures/axiom-traced-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Axiom.providers()),
});

const hasAxiomCreds = !!(process.env.AXIOM_TOKEN || process.env.AXIOM_API_KEY);

// Query a dataset's recent data out-of-band with the deployer's org token. The
// worker ingests with its own least-privilege token; this read proves the
// data actually landed in Axiom.
const queryDataset = (dataset: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post("https://api.axiom.co/v1/datasets/_apl?format=legacy").pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${process.env.AXIOM_TOKEN ?? process.env.AXIOM_API_KEY}`,
          "Content-Type": "application/json",
        }),
        HttpClientRequest.bodyJsonUnsafe({
          apl: `['${dataset}'] | where _time > ago(10m) | limit 1000`,
        }),
      ),
    );
    return yield* response.text;
  });

interface MetricsResult {
  series?: { metric: string; summary?: number | null }[];
}

// Metrics datasets are queried with MPL on the dataset's own edge. Returns
// the counter's total over the window, 0 until a data point has landed.
const queryWorkCount = (edgeUrl: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${edgeUrl.replace(/\/$/, "")}/v1/query/_mpl`).pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${process.env.AXIOM_TOKEN ?? process.env.AXIOM_API_KEY}`,
          "Content-Type": "application/json",
        }),
        HttpClientRequest.bodyJsonUnsafe({
          startTime: "now-10m",
          endTime: "now",
          mpl: `\`${METRICS_DATASET}\`:\`axiom_e2e_work_total\` | align to 1m using sum`,
        }),
      ),
    );
    if (response.status !== 200) return 0;
    const result = (yield* response.json) as MetricsResult;
    return (result.series ?? [])
      .filter((series) => series.metric === "axiom_e2e_work_total")
      .reduce((total, series) => total + (series.summary ?? 0), 0);
  });

test.provider.skipIf(!hasAxiomCreds)(
  "Worker exports telemetry to Axiom via the Axiom.Telemetry binding layer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker, metrics } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Traces;
          yield* Logs;
          const metrics = yield* Metrics;
          yield* Ingest;
          const worker = yield* AxiomTracedWorker;
          return { worker, metrics };
        }),
      );

      // Drive one traced request (fresh workers.dev URLs take a few
      // seconds to start serving).
      const url = worker.url as string;
      yield* expectUrlContains(`${url}/work`, "axiom-did-work", {
        timeout: "240 seconds",
      });

      // The request scope's flush ships the trace via ctx.waitUntil; poll
      // Axiom until it is queryable.
      const body = yield* queryDataset(TRACES_DATASET).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (text) => text.includes("otel-axiom-e2e"),
          times: 36,
        }),
      );
      expect(body).toContain("otel-axiom-e2e");
      expect(body).toContain("axiom.child-span");
      // The HttpMiddleware tracer's server span for the request: Effect's
      // default name, the request method.
      const spans = yield* Effect.try(
        () => (JSON.parse(body) as { matches: { data: { name: string; kind: string } }[] }).matches,
      );
      expect(spans.map((match) => match.data)).toContainEqual(
        expect.objectContaining({ name: "GET", kind: "server" }),
      );

      // Metrics export as OTLP protobuf (Axiom rejects JSON on /v1/metrics
      // with 415) and route with X-Axiom-Metrics-Dataset. Metrics datasets
      // are queried with MPL on the dataset's edge, not APL.
      const workCount = yield* queryWorkCount(metrics.edgeDeploymentUrl).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (count) => count > 0,
          times: 36,
        }),
      );
      expect(workCount).toBeGreaterThan(0);

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:axiom",
      "provider:axiom:apitoken",
      "provider:axiom:dataset",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 600_000,
  },
);
