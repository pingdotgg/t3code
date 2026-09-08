import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as pathe from "pathe";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import type { OtelSink } from "./fixtures/otel-collector-worker.ts";
import {
  OtelTestFunction,
  OtelTestFunctionLive,
} from "./fixtures/otel-handler.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

const collectorMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/otel-collector-worker.ts",
);

// The OTLP sink the Lambda exports to. A workers.dev URL is fine here —
// the 1042 worker-to-worker restriction doesn't apply to requests coming
// from Lambda. Declared identically in both deploy steps so the second
// deploy keeps it.
const collectorWorker = () =>
  Cloudflare.Worker("OtelCollector", {
    main: collectorMain,
    env: {
      SINK: Cloudflare.DurableObject<OtelSink>("OtelSink"),
    },
    compatibility: { date: "2024-09-23" },
  });

describe("AWS.Lambda Telemetry", () => {
  test.provider(
    "Lambda exports OTLP telemetry per invocation",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Deploy the collector first: the Lambda's OTLP endpoint is
        // resolved from the deployer's environment at deploy time.
        const collector = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* collectorWorker();
          }),
        );
        const collected = `${collector.url}/collected`;
        yield* expectUrlContains(collected, "otel-collector-ok", {
          timeout: "180 seconds",
        });

        // The fixture's telemetry binding layer reads `COLLECTOR_URL` via
        // `Config` at Init. The test harness snapshots its ConfigProvider
        // before the test body runs, so layer the just-learned collector
        // URL on top of the current provider for this deploy only.
        const currentConfig = yield* ConfigProvider.ConfigProvider;
        const { fn } = yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* collectorWorker();
              const fn = yield* OtelTestFunction.pipe(
                Effect.provide(OtelTestFunctionLive),
              );
              return { fn };
            }),
          )
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({
                  COLLECTOR_URL: collector.url,
                }),
                currentConfig,
              ),
            ),
          );

        // Wait for the function URL to serve AND for the collector to be
        // reachable from the Lambda's region — workers.dev propagates
        // per-PoP, so the Lambda can see placeholder 404s long after the
        // test machine gets 200s.
        const fnUrl = (fn.functionUrl as string).replace(/\/$/, "");
        yield* expectUrlContains(`${fnUrl}/probe`, '"status":200', {
          timeout: "240 seconds",
          label: "collector reachable from Lambda",
        });

        // Drive one traced invocation.
        yield* expectUrlContains(`${fnUrl}/work`, "lambda-did-work", {
          timeout: "120 seconds",
        });

        // The invocation scope's flush ships everything the invocation
        // produced before the response is returned.
        yield* expectUrlContains(collected, "otel-lambda-test", {
          timeout: "120 seconds",
          label: "lambda service.name",
        });
        // http.server root span from the HttpMiddleware tracer.
        yield* expectUrlContains(collected, "http.server GET");
        // Child span from Effect.fn instrumentation.
        yield* expectUrlContains(collected, "lambda.child-span");
        // Log record shipped by the OTLP logger.
        yield* expectUrlContains(collected, "lambda-work-log");
      }),
    { timeout: 600_000 },
  );
});
