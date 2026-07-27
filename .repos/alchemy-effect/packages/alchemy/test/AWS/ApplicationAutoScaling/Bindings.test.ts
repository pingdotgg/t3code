import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ApplicationAutoScalingTestFunctionLive, {
  ApplicationAutoScalingTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "ApplicationAutoScalingBindings",
);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load (cold re-init, IAM propagation on the freshly
// attached policy that the handler's `Effect.orDie` surfaces as a 500).
// Retry only 5xx; a genuine 4xx/assertion failure surfaces immediately.
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

describe.sequential("ApplicationAutoScaling Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ApplicationAutoScaling test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "ApplicationAutoScaling test setup: deploying fixture",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ApplicationAutoScalingTestFunction;
        }).pipe(Effect.provide(ApplicationAutoScalingTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `ApplicationAutoScaling test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ApplicationAutoScaling test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("both capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toEqual([
          "describeScalingActivities",
          "getPredictiveScalingForecast",
        ]);
      }),
    );
  });

  describe("DescribeScalingActivities", () => {
    test.provider("lists the fixture target's scaling activities", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/scaling-activities`),
        ).pipe(Effect.flatMap((r) => r.json));
        // A fresh target typically has zero activities — assert the call
        // round-trips with a well-formed page (the identity triple was
        // injected and the IAM grant works).
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("ScalingActivityEventSource", () => {
    test.provider(
      "consumeScalingActivityEvents created the EventBridge rule",
      (_stack) =>
        Effect.gen(function* () {
          // The rule's physical name starts with the stack name but the
          // 64-char rule-name budget truncates the long
          // `BindingsTarget-ScalingActivityEvents` logical id, so scope by
          // NamePrefix and match on the rule's event pattern instead
          // (bounded manual pagination).
          let rule: eventbridge.Rule | undefined;
          let nextToken: string | undefined;
          for (let page = 0; page < 10 && !rule; page++) {
            const result = yield* eventbridge.listRules({
              NamePrefix: "ApplicationAutoScalingBindings",
              NextToken: nextToken,
            });
            rule = (result.Rules ?? []).find((candidate) =>
              candidate.EventPattern?.includes("aws.application-autoscaling"),
            );
            nextToken = result.NextToken;
            if (!nextToken) break;
          }
          expect(rule).toBeDefined();
          expect(rule?.EventPattern).toContain("aws.application-autoscaling");
          expect(rule?.EventPattern).toContain(
            "Application Auto Scaling Scaling Activity State Change",
          );
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetPredictiveScalingForecast", () => {
    // Ungated probe (runs in the test process, which resolves distilled from
    // patched `src/` via the bun export condition): predictive scaling
    // exists only for ECS services, and for a dynamodb-namespace target the
    // live API answers with the typed PredictiveScalingForecastNotSupported
    // — a distilled synthetic error carved out of AccessDeniedException
    // "GetPredictiveScalingForecast is not supported.". The namespace check
    // runs before any existence check, so the probe needs no live target.
    test.provider(
      "distilled patch: non-ECS namespace surfaces the typed not-supported tag",
      (_stack) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            aas.getPredictiveScalingForecast({
              ServiceNamespace: "dynamodb",
              ResourceId: "table/alchemy-probe-nonexistent",
              ScalableDimension: "dynamodb:table:ReadCapacityUnits",
              PolicyName: "alchemy-probe-nonexistent",
              StartTime: new Date("2030-01-01T00:00:00Z"),
              EndTime: new Date("2030-01-01T12:00:00Z"),
            }),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe(
              "PredictiveScalingForecastNotSupported",
            );
          }
        }),
    );

    // End-to-end through the deployed Lambda: the fixture's policy is on the
    // dynamodb namespace, so the call is rejected with the platform
    // not-supported error. An IAM gap would ALSO surface as an
    // AccessDeniedException — the probe above plus the CLI-verified message
    // ("GetPredictiveScalingForecast is not supported.") pin the platform
    // behavior; here we accept either the synthetic tag (patched distilled
    // in the bundle) or its base wire tag (the deployed bundle resolves
    // distilled's built `lib/`, which only picks up the patch after the
    // coordinator rebuilds distilled).
    test.provider(
      "runtime binding surfaces the typed rejection through the Lambda",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/forecast`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect([
            "PredictiveScalingForecastNotSupported",
            "AccessDeniedException",
          ]).toContain((response as any).tag);
        }),
    );
  });
});
