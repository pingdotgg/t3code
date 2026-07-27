import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import IoTSiteWiseTestFunctionLive, {
  IoTSiteWiseTestFunction,
} from "./fixtures/handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "IoTSiteWiseBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(60),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// POST a fixture route; retry 5xx (cold-start IAM propagation surfaces as a
// defect -> 500 until the fresh role policy is visible to IoT SiteWise).
const post = (path: string) =>
  HttpClient.execute(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
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

const postJson = (path: string) =>
  post(path).pipe(Effect.flatMap((response) => response.json));

describe("IoTSiteWise Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "IoTSiteWise test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("IoTSiteWise test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IoTSiteWiseTestFunction;
        }).pipe(Effect.provide(IoTSiteWiseTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `IoTSiteWise test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `IoTSiteWise test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("DescribeAsset", () => {
    test.provider(
      "describes the bound asset with its properties",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/describe")) as {
            assetId: string;
            assetName: string;
            propertyNames: string[];
          };
          expect(response.assetId).toBeTruthy();
          expect(response.propertyNames).toContain("Temperature");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListAssetProperties", () => {
    test.provider(
      "lists the bound asset's property summaries",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/properties")) as {
            count: number;
          };
          expect(response.count).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("BatchPutAssetPropertyValue + GetAssetPropertyValue + GetAssetPropertyValueHistory", () => {
    test.provider(
      "ingests a TQV and reads it back (current value + history)",
      (_stack) =>
        Effect.gen(function* () {
          const put = (yield* postJson("/put")) as {
            errorCount: number;
            errorCodes: string[];
          };
          expect(put.errorCodes).toEqual([]);
          expect(put.errorCount).toBe(0);

          // Ingested values become readable within seconds — poll bounded.
          const value = yield* postJson("/value").pipe(
            Effect.map(
              (body) =>
                body as {
                  doubleValue: number | null;
                  timeInSeconds: number | null;
                },
            ),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (body): boolean => body.doubleValue !== null,
              times: 20,
            }),
          );
          expect(value.doubleValue).toBe(23.5);
          expect(value.timeInSeconds).toBeGreaterThan(0);

          const history = (yield* postJson("/history")) as { count: number };
          expect(history.count).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 180_000 },
    );
  });

  describe("GetAssetPropertyAggregates", () => {
    test.provider(
      "reads aggregates over the last hour",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/aggregates")) as {
            ok: boolean;
            count: number;
          };
          expect(response.ok).toBe(true);
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetInterpolatedAssetPropertyValues", () => {
    test.provider(
      "computes interpolated values over the last hour",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/interpolated")) as {
            ok: boolean;
            count: number;
          };
          expect(response.ok).toBe(true);
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ExecuteQuery", () => {
    test.provider(
      "runs a SiteWise SQL query against the asset index",
      (_stack) =>
        Effect.gen(function* () {
          // The query index is eventually consistent for fresh assets — the
          // call succeeding with a well-formed (possibly empty) row set is
          // the contract under test.
          const response = (yield* postJson("/query")) as {
            ok: boolean;
            rowCount: number;
          };
          expect(response.ok).toBe(true);
          expect(response.rowCount).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );
  });
});
