import * as Axiom from "@/Axiom";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { expectUrlContains } from "../Cloudflare/Utils/Http.ts";
import AxiomTracedWorker, {
  Ingest,
  Logs,
  TRACES_DATASET,
  Traces,
} from "./fixtures/axiom-traced-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Axiom.providers()),
});

const hasAxiomCreds = !!(process.env.AXIOM_TOKEN || process.env.AXIOM_API_KEY);

// Query recent trace data out-of-band with the deployer's org token. The
// worker ingests with its own least-privilege token; this read proves the
// data actually landed in Axiom.
const queryTraces = Effect.gen(function* () {
  const response = yield* HttpClient.execute(
    HttpClientRequest.post(
      "https://api.axiom.co/v1/datasets/_apl?format=legacy",
    ).pipe(
      HttpClientRequest.setHeaders({
        Authorization: `Bearer ${process.env.AXIOM_TOKEN ?? process.env.AXIOM_API_KEY}`,
        "Content-Type": "application/json",
      }),
      HttpClientRequest.bodyJsonUnsafe({
        apl: `['${TRACES_DATASET}'] | where _time > ago(10m) | limit 1000`,
      }),
    ),
  );
  return yield* response.text;
});

test.provider.skipIf(!hasAxiomCreds)(
  "Worker exports telemetry to Axiom via the Axiom.Telemetry binding layer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Traces;
          yield* Logs;
          yield* Ingest;
          const worker = yield* AxiomTracedWorker;
          return { worker };
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
      const body = yield* queryTraces.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (text) => text.includes("otel-axiom-e2e"),
          times: 36,
        }),
      );
      expect(body).toContain("otel-axiom-e2e");
      expect(body).toContain("axiom.child-span");
      expect(body).toContain("http.server GET");

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
