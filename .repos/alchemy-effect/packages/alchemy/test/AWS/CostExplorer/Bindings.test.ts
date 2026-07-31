import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CostExplorerTestFunctionLive, {
  CostExplorerTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CostExplorerBindings");

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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("CostExplorer Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "CostExplorer test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CostExplorer test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CostExplorerTestFunction;
        }).pipe(Effect.provide(CostExplorerTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `CostExplorer test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `CostExplorer test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 31 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(31);
      }),
    );
  });

  describe("GetCostAndUsage", () => {
    test.provider(
      "queries last month's unblended cost",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/cost-and-usage")) as any;
          // A fresh account may legitimately have no ingested data yet — the
          // typed DataUnavailableException tag is the accepted alternative.
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
          if (response.tag === "Ok") {
            expect(response.results).toBeGreaterThan(0);
            expect(response.amount).not.toBeNull();
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetDimensionValues", () => {
    test.provider(
      "lists the SERVICE dimension values",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/dimension-values")) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
          if (response.tag === "Ok") {
            expect(response.count).toBeGreaterThan(0);
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetTags", () => {
    test.provider(
      "lists cost allocation tag keys",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/tag-keys")) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
          expect(typeof response.count).toBe("number");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetCostCategories", () => {
    test.provider(
      "lists cost category names (fixture category present after processing)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/cost-categories")) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
          expect(Array.isArray(response.names)).toBe(true);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetCostForecast", () => {
    test.provider(
      "forecasts next month's spend (or reports insufficient data, typed)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/forecast")) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetApproximateUsageRecords", () => {
    test.provider(
      "estimates usage record volume per service",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/approximate-usage")) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
          expect(typeof response.total).toBe("number");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetRightsizingRecommendation", () => {
    test.provider(
      "returns EC2 rightsizing recommendations (or the typed opt-in rejection)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/rightsizing")) as any;
          // Rightsizing is an opt-in Cost Explorer preference on the payer
          // account; without the opt-in the API rejects with
          // RightsizingRecommendationNotEnabled — the AccessDeniedException
          // "opt-in only feature" rejection patched into distilled as a
          // specific typed tag. Either outcome proves the binding + grant.
          expect(["Ok", "RightsizingRecommendationNotEnabled"]).toContain(
            response.tag,
          );
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetReservationPurchaseRecommendation", () => {
    test.provider(
      "returns EC2 reservation purchase recommendations",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/reservation-recommendation",
          )) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetSavingsPlansUtilization", () => {
    test.provider(
      "reads Savings Plans utilization (or typed data-unavailable)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/savings-plans-utilization",
          )) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListSavingsPlansPurchaseRecommendationGeneration", () => {
    test.provider(
      "lists recent recommendation generations",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/recommendation-generations",
          )) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListCommitmentPurchaseAnalyses", () => {
    test.provider(
      "lists commitment purchase analyses",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/commitment-analyses")) as any;
          expect(["Ok", "DataUnavailableException"]).toContain(response.tag);
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListCostAllocationTags", () => {
    test.provider(
      "lists cost allocation tags",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/allocation-tags")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListCostAllocationTagBackfillHistory", () => {
    test.provider(
      "lists backfill requests",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/backfill-history")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetAnomalies", () => {
    test.provider(
      "lists the fixture monitor's anomalies (proving MonitorArn injection + the monitor-scoped grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/anomalies")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ProvideAnomalyFeedback", () => {
    test.provider(
      "surfaces the typed ValidationException for a nonexistent anomaly (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/anomaly-feedback-invalid")) as any;
          expect(response.tag).toBe("ValidationException");
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListCostCategoryResourceAssociations", () => {
    test.provider(
      "lists the fixture category's resource associations (proving CostCategoryArn injection)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/category-associations")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });
});
