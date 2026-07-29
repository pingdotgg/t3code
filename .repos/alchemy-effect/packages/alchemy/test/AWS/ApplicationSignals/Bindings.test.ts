import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ApplicationSignalsTestFunctionLive, {
  ApplicationSignalsTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "ApplicationSignalsBindings",
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
      // Fresh-role IAM propagation can take ~60s right after deploy; the
      // handler's Effect.orDie surfaces a still-propagating grant as a 500.
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("ApplicationSignals Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ApplicationSignals test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ApplicationSignals test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ApplicationSignalsTestFunction;
        }).pipe(Effect.provide(ApplicationSignalsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `ApplicationSignals test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ApplicationSignals test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // Warm up the most permission-hungry route: budget reports exercise
      // both the application-signals grant on the SLO ARN and the dependent
      // cloudwatch:GetMetricData grant, so a 200 here means the fresh
      // role's policies have fully propagated.
      yield* HttpClient.get(`${baseUrl}/budget-report`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`IAM not propagated yet: ${response.status}`),
              ),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("4 seconds"),
            Schedule.recurs(30),
          ]),
        }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 14 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(14);
      }),
    );
  });

  describe("ListServices", () => {
    test.provider("lists discovered services", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/services");
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("GetService", () => {
    test.provider(
      "returns an empty service for unknown key attributes",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/service");
          expect((response as any).discovered).toBe(false);
        }),
    );
  });

  describe("ListServiceDependencies / ListServiceDependents / ListServiceOperations", () => {
    test.provider("return well-formed empty pages", (_stack) =>
      Effect.gen(function* () {
        const dependencies = yield* getJson("/dependencies");
        const dependents = yield* getJson("/dependents");
        const operations = yield* getJson("/operations");
        expect((dependencies as any).count).toBe(0);
        expect((dependents as any).count).toBe(0);
        expect((operations as any).count).toBe(0);
      }),
    );
  });

  describe("ListServiceStates", () => {
    test.provider("lists recent service states", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/states");
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("ListEntityEvents", () => {
    test.provider("lists change events for an entity", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/entity-events");
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("ListAuditFindings", () => {
    test.provider("lists audit findings for a service target", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/audit-findings");
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("ListServiceLevelObjectives", () => {
    test.provider(
      "lists the account's SLOs including the fixture SLO",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/slos");
          expect((response as any).count).toBeGreaterThanOrEqual(1);
          expect(
            (response as any).names.some((name: string) =>
              name.toLowerCase().includes("bindingsslo"),
            ),
          ).toBe(true);
        }),
    );
  });

  describe("GetServiceLevelObjective", () => {
    test.provider("reads the bound SLO's configuration", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/slo");
        expect((response as any).arn).toContain(":slo/");
        expect((response as any).attainmentGoal).toBe(99);
      }),
    );
  });

  describe("BatchGetServiceLevelObjectiveBudgetReport", () => {
    test.provider("returns the bound SLO's budget report", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/budget-report");
        expect((response as any).errors).toBe(0);
        expect((response as any).reports).toBe(1);
        expect((response as any).budgetStatus).toBeTruthy();
      }),
    );
  });

  describe("BatchUpdateExclusionWindows / ListServiceLevelObjectiveExclusionWindows", () => {
    test.provider(
      "adds, observes, and removes a maintenance window",
      (_stack) =>
        Effect.gen(function* () {
          const before = yield* getJson("/exclusion-windows");
          expect((before as any).count).toBe(0);

          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/exclusion-windows`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).addErrors).toBe(0);
          expect((response as any).afterAdd).toBe(1);
          expect((response as any).removeErrors).toBe(0);
          expect((response as any).afterRemove).toBe(0);
        }),
    );
  });

  describe("GetInstrumentationConfigurationStatus", () => {
    test.provider(
      "returns the bound configuration's (empty) status history",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/ic-status");
          expect((response as any).events).toBe(0);
        }),
    );
  });
});
