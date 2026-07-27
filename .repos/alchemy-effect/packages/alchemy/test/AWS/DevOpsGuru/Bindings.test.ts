import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import DevOpsGuruTestFunctionLive, { DevOpsGuruTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DevOpsGuruBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class FunctionStillExists extends Data.TaggedError("FunctionStillExists") {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("DevOpsGuru Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "DevOpsGuru test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DevOpsGuru test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DevOpsGuruTestFunction;
        }).pipe(Effect.provide(DevOpsGuruTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `DevOpsGuru test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `DevOpsGuru test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Assert gone (skipped when beforeAll never got far enough to deploy):
      // the fixture Lambda answers with the typed not-found tag, and the
      // event-source's EventBridge rule no longer targets it. afterAll runs
      // outside `test.provider`'s layer, so raw distilled calls need the
      // provider layer (credentials, region) supplied explicitly.
      if (functionArn) {
        yield* Core.withProviders(
          Effect.gen(function* () {
            yield* lambda.getFunction({ FunctionName: functionArn }).pipe(
              Effect.flatMap(() => Effect.fail(new FunctionStillExists())),
              Effect.retry({
                while: (error) => error._tag === "FunctionStillExists",
                schedule: Schedule.exponential("500 millis"),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
            const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
              TargetArn: functionArn,
            });
            expect(RuleNames ?? []).toHaveLength(0);
          }),
          testOptions,
          sharedStack.name,
        );
      }
    }),
    { timeout: 120_000 },
  );

  describe("binding registration", () => {
    test.provider("all 22 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(22);
        expect(response.bound).toContain("describeAccountHealth");
        expect(response.bound).toContain("searchInsights");
        expect(response.bound).toContain("putFeedback");
      }),
    );
  });

  describe("DescribeAccountHealth", () => {
    test.provider("reads the account's insight counters", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/health")) as {
          openReactiveInsights: number;
          openProactiveInsights: number;
          metricsAnalyzed: number;
        };
        expect(response.openReactiveInsights).toBeGreaterThanOrEqual(0);
        expect(response.openProactiveInsights).toBeGreaterThanOrEqual(0);
        expect(response.metricsAnalyzed).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeAccountOverview", () => {
    test.provider("summarizes the trailing 24 hours", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/overview")) as {
          reactiveInsights: number;
          proactiveInsights: number;
        };
        expect(response.reactiveInsights).toBeGreaterThanOrEqual(0);
        expect(response.proactiveInsights).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListInsights", () => {
    test.provider("lists ongoing reactive insights", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/insights")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("SearchInsights", () => {
    test.provider("searches reactive insights by time range", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/search")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeResourceCollectionHealth", () => {
    test.provider("reads per-stack coverage health", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/collection-health")) as {
          stacks: number;
        };
        expect(response.stacks).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListMonitoredResources", () => {
    test.provider(
      "lists analyzed resources (typed not-found -> zero coverage)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/monitored")) as {
            count: number;
          };
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
    );
  });

  describe("consumeInsightEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeInsightEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
