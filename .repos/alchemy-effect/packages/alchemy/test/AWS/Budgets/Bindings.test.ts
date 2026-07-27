import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BudgetsTestFunctionLive, {
  BudgetsTestFunction,
  fixtureBudgetName,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BudgetsBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

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

describe.sequential("Budgets Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Budgets test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Budgets test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BudgetsTestFunction;
        }).pipe(Effect.provide(BudgetsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Budgets test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Budgets test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("binding registration", () => {
    test.provider("all 7 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(7);
      }),
    );
  });

  describe("DescribeBudget", () => {
    test.provider("reads the fixture budget's definition", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/budget`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).name).toBe(fixtureBudgetName);
        expect(Number((response as any).limitAmount)).toBe(1_000_000);
        expect((response as any).limitUnit).toBe("USD");
        expect((response as any).timeUnit).toBe("MONTHLY");
      }),
    );
  });

  describe("DescribeBudgetPerformanceHistory", () => {
    test.provider(
      "reads the budget's history (fresh budget: >= 0 periods)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/history`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect(typeof (response as any).periods).toBe("number");
          expect((response as any).periods).toBeGreaterThanOrEqual(0);
        }),
    );
  });

  describe("DescribeNotificationsForBudget", () => {
    test.provider("lists the fixture notification threshold", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/notifications`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).thresholds).toContain(80);
      }),
    );
  });

  describe("DescribeSubscribersForNotification", () => {
    test.provider("lists the fixture notification's subscriber", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/subscribers`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).count).toBe(1);
        expect((response as any).subscriptionTypes).toContain("EMAIL");
      }),
    );
  });

  describe("DescribeBudgetActionsForBudget", () => {
    test.provider("lists the fixture action in STANDBY", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/actions`),
        ).pipe(Effect.flatMap((r) => r.json));
        const actions = (response as any).actions as {
          actionId: string;
          status: string;
          actionType: string;
        }[];
        expect(actions.length).toBeGreaterThanOrEqual(1);
        expect(actions[0]!.actionType).toBe("APPLY_IAM_POLICY");
        expect(actions[0]!.status).toBe("STANDBY");
      }),
    );
  });

  describe("DescribeBudgetActionHistories", () => {
    test.provider(
      "reads the action's event history (>= CREATE_ACTION)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/action-histories`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).count).toBeGreaterThanOrEqual(1);
          expect((response as any).eventTypes).toContain("CREATE_ACTION");
        }),
    );
  });

  describe("ExecuteBudgetAction", () => {
    test.provider(
      "the grant works — execute returns a typed budgets outcome",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/execute-reset`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect([
            "ok",
            "ResourceLockedException",
            "InvalidParameterException",
          ]).toContain((response as any).outcome);
        }),
    );
  });
});
