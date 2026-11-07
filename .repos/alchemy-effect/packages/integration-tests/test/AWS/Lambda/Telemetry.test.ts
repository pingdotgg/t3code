import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import type { OtelSink } from "./fixtures/otel-collector-worker.ts";
import { OtelTestFunction, OtelTestFunctionLive } from "./fixtures/otel-handler.ts";

const { test } = Test.make({ providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()) });

const collectorMain = pathe.resolve(import.meta.dirname, "fixtures/otel-collector-worker.ts");

// The OTLP sink the Lambda exports to. A workers.dev URL is fine here —
// the 1042 worker-to-worker restriction doesn't apply to requests coming
// from Lambda. Declared identically in both deploy steps so the second
// deploy keeps it.
const collectorWorker = () =>
  Cloudflare.Worker("OtelCollector", {
    main: collectorMain,
    env: { SINK: Cloudflare.DurableObject<OtelSink>("OtelSink") },
    compatibility: { date: "2024-09-23" },
  });

interface CollectedSpan {
  name: string;
  kind?: number;
  status?: { code?: number; message?: string };
  attributes?: { key: string; value: Record<string, unknown> }[];
}

// Every span across all the OTLP traces pushes the collector recorded.
const collectedSpans = (collected: unknown): CollectedSpan[] =>
  (collected as { items: { signal: string; payload: any }[] }).items
    .filter((item) => item.signal === "traces")
    .flatMap((item) => item.payload.resourceSpans ?? [])
    .flatMap((resource: any) => resource.scopeSpans ?? [])
    .flatMap((scope: any) => (scope.spans ?? []) as CollectedSpan[]);

// Name, path and status of each span, printed when an assertion fails.
const rootSpanSummary = (collected: unknown) =>
  collectedSpans(collected).map((span) => ({
    name: span.name,
    path: span.attributes?.find((attribute) => attribute.key === "url.path")?.value,
    status: span.status?.code,
  }));

// OTLP SPAN_KIND_SERVER: the HttpMiddleware tracer's root span per request.
const SERVER_SPAN_KIND = 2;

// The HTTP server root spans for one path.
const rootSpansFor = (collected: unknown, path: string): CollectedSpan[] =>
  collectedSpans(collected).filter(
    (span) =>
      span.kind === SERVER_SPAN_KIND &&
      span.attributes?.some(
        (attribute) => attribute.key === "url.path" && attribute.value.stringValue === path,
      ),
  );

describe(
  "AWS.Lambda Telemetry",
  {
    tags: [
      "provider:aws",
      "provider:aws:lambda",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
  },
  () => {
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
          yield* expectUrlContains(collected, "otel-collector-ok", { timeout: "180 seconds" });

          // The fixture's telemetry binding layer reads `COLLECTOR_URL` via
          // `Config` at Init. The test harness snapshots its ConfigProvider
          // before the test body runs, so layer the just-learned collector
          // URL on top of the current provider for this deploy only.
          const currentConfig = yield* ConfigProvider.ConfigProvider;
          const { fn } = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* collectorWorker();
                const fn = yield* OtelTestFunction.pipe(Effect.provide(OtelTestFunctionLive));
                return { fn };
              }),
            )
            .pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.orElse(
                  ConfigProvider.fromUnknown({ COLLECTOR_URL: collector.url }),
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
          yield* expectUrlContains(`${fnUrl}/work`, "lambda-did-work", { timeout: "120 seconds" });

          // The invocation scope's flush ships everything the invocation
          // produced before the response is returned.
          yield* expectUrlContains(collected, "otel-lambda-test", {
            timeout: "120 seconds",
            label: "lambda service.name",
          });
          // HTTP server root span from the HttpMiddleware tracer, named
          // after the request method.
          yield* expectUrlContains(collected, '"name":"GET"');
          // Child span from Effect.fn instrumentation.
          yield* expectUrlContains(collected, "lambda.child-span");
          // Log record shipped by the OTLP logger.
          yield* expectUrlContains(collected, "lambda-work-log");

          // An invocation that runs past its 3 s timeout is interrupted:
          // its finalizer runs, the span of the call that hung ends, and the
          // root span ends with the timeout — all exported. The invocation
          // is then held until Lambda's own 5 s timeout ends it, so the
          // caller sees Lambda's timeout error, not a response from the
          // handler.
          const client = yield* HttpClient.HttpClient;
          const slowStart = yield* Clock.currentTimeMillis;
          const slow = yield* client.get(`${fnUrl}/slow`);
          const slowElapsed = (yield* Clock.currentTimeMillis) - slowStart;
          expect(slow.status).not.toBe(200);
          expect(slowElapsed).toBeGreaterThanOrEqual(4500);

          // Lambda counts it as a real timeout and shuts the sandbox down
          // (our shutdown extension logs the SIGTERM inside the invocation),
          // so work that ignored the interruption cannot resume later.
          const logGroupName = `/aws/lambda/${fn.functionName}`;
          const slowRequestLines = yield* logs.filterLogEvents({ logGroupName }).pipe(
            Effect.map((result) => (result.events ?? []).map((event) => event.message ?? "")),
            Effect.map((lines) => {
              const requestId = lines
                .map((line) => /Lambda invocation (\S+) of .* timed out after/.exec(line)?.[1])
                .find((id) => id !== undefined);
              return requestId === undefined
                ? []
                : lines.filter((line) => line.includes(requestId));
            }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (lines) => lines.some((line) => line.startsWith("REPORT")),
              times: 30,
            }),
          );
          expect(slowRequestLines.find((line) => line.startsWith("REPORT"))).toContain(
            "Status: timeout",
          );
          expect(slowRequestLines.some((line) => line.includes("SIGTERM"))).toBe(true);
          yield* expectUrlContains(collected, "lambda-slow-finalizer", {
            timeout: "120 seconds",
            label: "interrupted invocation's finalizer log",
          });
          yield* expectUrlContains(collected, "lambda-slow-log");
          const slowBody = yield* client
            .get(collected)
            .pipe(Effect.flatMap((response) => response.json));
          const slowRoots = rootSpansFor(slowBody, "/slow");
          expect({ slowRoots: slowRoots.length, roots: rootSpanSummary(slowBody) }).toMatchObject({
            slowRoots: 1,
          });
          expect(slowRoots[0]?.status).toMatchObject({
            code: 2,
            message: expect.stringContaining("timed out"),
          });
          // The span of the call that hung, ended by the interruption.
          const hung = collectedSpans(slowBody).filter((span) => span.name === "lambda.slow-span");
          expect(hung).toHaveLength(1);
          expect(hung[0]?.attributes).toContainEqual({
            key: "effect.fiber.interrupted",
            value: { boolValue: true },
          });

          // An invocation that finishes just inside its timeout is never
          // interrupted, and its root span is a plain success.
          const late = yield* client.get(`${fnUrl}/late`);
          expect(late.status).toBe(200);
          expect(yield* late.text).toContain("lambda-late-done");
          const lateBody = yield* client
            .get(collected)
            .pipe(Effect.flatMap((response) => response.json));
          const lateSpans = rootSpansFor(lateBody, "/late");
          expect({ lateSpans: lateSpans.length, roots: rootSpanSummary(lateBody) }).toMatchObject({
            lateSpans: 1,
          });
          expect(lateSpans[0]?.status?.code).not.toBe(2);

          // An invocation whose finalizer hangs past Lambda's own timeout:
          // Lambda kills it, but 500 ms before that the backstop flush ended
          // the root span and drained the exporters.
          const stuck = yield* client.get(`${fnUrl}/stuck`);
          expect(stuck.status).not.toBe(200);
          const stuckSpans = yield* client.get(collected).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((body) => rootSpansFor(body, "/stuck")),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (spans) => spans.length > 0,
              times: 30,
            }),
          );
          expect(stuckSpans).toHaveLength(1);
          expect(stuckSpans[0]?.status?.code).toBe(2);
          expect(stuckSpans[0]?.attributes).toContainEqual({
            key: "aws.lambda.timeout.imminent",
            value: { boolValue: true },
          });
        }),
      { timeout: 600_000 },
    );
  },
);
