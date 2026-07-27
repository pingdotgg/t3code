import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as amp from "@distilled.cloud/aws/amp";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AmpTestFunctionLive, { AmpTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AMPBindings");

// Deterministic metric name — same on every run of this test file.
const METRIC = "alchemy_amp_bindings_test_total";

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx (cold re-init, IAM propagation on a fresh deploy —
// aps permissions can take a few seconds to become effective).
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe("AMP Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("AMP test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("AMP test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AmpTestFunction;
        }).pipe(Effect.provide(AmpTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/health`;

      yield* Effect.logInfo(
        `AMP test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `AMP test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      yield* Effect.logInfo("AMP test setup: fixture responded successfully");
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Assert gone: no workspace with the fixture's alias survives the
      // destroy (AMP deletes asynchronously — DELETING counts as gone; a
      // fresh run's leading destroy would reconcile any remnant anyway).
      // The out-of-band distilled call needs the AWS providers layer
      // (credentials), which afterAll does not provide by default.
      const { workspaces } = yield* Core.withProviders(
        amp.listWorkspaces({ alias: "alchemy-test-amp-bindings" }),
        testOptions,
        "AMPBindings",
      );
      const alive = workspaces.filter(
        (w) =>
          w.status.statusCode !== "DELETING" &&
          w.status.statusCode !== "DELETED",
      );
      expect(alive).toHaveLength(0);
    }),
    { timeout: 120_000 },
  );

  describe("RemoteWrite", () => {
    test.provider("pushes a sample into the workspace", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/remote-write`),
            { name: METRIC, labels: { source: "bindings-test" }, value: 1 },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as { success: boolean };
        expect(body.success).toBe(true);
      }),
    );
  });

  describe("QueryMetrics", () => {
    test.provider(
      "instant query reads back the remote-written sample",
      (_stack) =>
        Effect.gen(function* () {
          // Write, then poll the query API until ingestion catches up.
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/remote-write`),
              { name: METRIC, labels: { source: "bindings-test" }, value: 2 },
            ),
          );

          const body = (yield* getJson(`/query?query=${METRIC}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (b): boolean => {
                const result = (
                  b as {
                    result: { resultType: string; result: unknown[] };
                  }
                ).result;
                return (
                  result.resultType === "vector" && result.result.length > 0
                );
              },
              times: 20,
            }),
          )) as {
            result: {
              resultType: string;
              result: Array<{
                metric: Record<string, string>;
                value: [number, string];
              }>;
            };
          };

          expect(body.result.resultType).toBe("vector");
          const sample = body.result.result.find(
            (s) => s.metric.__name__ === METRIC,
          );
          expect(sample).toBeDefined();
          expect(sample!.metric.source).toBe("bindings-test");
          expect(Number(sample!.value[1])).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );

    test.provider("range query returns a matrix", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(`/query-range?query=${METRIC}`)) as {
          result: { resultType: string };
        };
        expect(body.result.resultType).toBe("matrix");
      }),
    );
  });

  describe("GetLabels", () => {
    test.provider("lists label names", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson("/labels")) as { names: string[] };
        expect(body.names).toContain("__name__");
      }),
    );

    test.provider("lists metric names via label values", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson("/label-values?label=__name__")) as {
          values: string[];
        };
        expect(body.values).toContain(METRIC);
      }),
    );
  });

  describe("GetSeries", () => {
    test.provider("matches the remote-written series", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(
          `/series?match=${encodeURIComponent(`{__name__="${METRIC}"}`)}`,
        )) as { series: Array<Record<string, string>> };
        const series = body.series.find((s) => s.__name__ === METRIC);
        expect(series).toBeDefined();
        expect(series!.source).toBe("bindings-test");
      }),
    );
  });

  describe("DescribeWorkspace", () => {
    test.provider("describes the bound workspace", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson("/describe-workspace")) as {
          workspaceId: string;
          status: string;
        };
        expect(body.workspaceId).toMatch(/^ws-/);
        expect(body.status).toBe("ACTIVE");
      }),
    );
  });

  describe("ListWorkspaces", () => {
    test.provider("lists workspaces including the bound one", (_stack) =>
      Effect.gen(function* () {
        const described = (yield* getJson("/describe-workspace")) as {
          workspaceId: string;
        };
        const body = (yield* getJson("/list-workspaces")) as {
          workspaceIds: string[];
        };
        expect(body.workspaceIds).toContain(described.workspaceId);
      }),
    );
  });

  describe("GetDefaultScraperConfiguration", () => {
    test.provider("reads the default scraper configuration YAML", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson("/default-scraper-config")) as {
          configuration: string;
        };
        // The default configuration is Prometheus scrape-config YAML.
        expect(body.configuration).toContain("scrape_configs");
      }),
    );
  });

  describe("GetMetricMetadata", () => {
    test.provider("reads metric metadata", (_stack) =>
      Effect.gen(function* () {
        // Remote-write carries no metadata, so the map may be empty — the
        // assertion is that the signed call succeeds and returns an object.
        const body = (yield* getJson("/metadata")) as {
          metadata: Record<string, unknown>;
        };
        expect(typeof body.metadata).toBe("object");
      }),
    );
  });
});
