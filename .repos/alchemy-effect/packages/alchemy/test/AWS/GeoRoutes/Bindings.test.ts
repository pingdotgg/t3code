import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import GeoRoutesTestFunctionLive, { GeoRoutesTestFunction } from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "GeoRoutesBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

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
        Schedule.recurs(5),
      ]),
    }),
  );

describe("GeoRoutes Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "GeoRoutes test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("GeoRoutes test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GeoRoutesTestFunction;
        }).pipe(Effect.provide(GeoRoutesTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `GeoRoutes test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `GeoRoutes test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("GeoRoutes.CalculateRoutes", () => {
    test.provider(
      "computes a route between two points",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/calculate-routes`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            distance?: number;
            duration?: number;
          };

          expect(response.count).toBeGreaterThan(0);
          expect(response.distance).toBeGreaterThan(0);
          expect(response.duration).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GeoRoutes.CalculateIsolines", () => {
    test.provider(
      "computes a drive-time isoline around a point",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/calculate-isolines`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            geometryCount: number;
            pricingBucket?: string;
          };

          expect(response.count).toBeGreaterThan(0);
          expect(response.geometryCount).toBeGreaterThan(0);
          expect(typeof response.pricingBucket).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GeoRoutes.CalculateRouteMatrix", () => {
    test.provider(
      "computes a 2x2 origin-destination matrix",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/calculate-route-matrix`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            rows: number;
            columns: number;
            firstDuration?: number;
            errorCount: number;
            pricingBucket?: string;
          };

          expect(response.rows).toBe(2);
          expect(response.columns).toBe(2);
          expect(response.errorCount).toBe(0);
          expect(response.firstDuration).toBeGreaterThan(0);
          expect(typeof response.pricingBucket).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GeoRoutes.OptimizeWaypoints", () => {
    test.provider(
      "orders waypoints to minimize travel time",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/optimize-waypoints`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            optimizedCount: number;
            order: string[];
            distance?: number;
            duration?: number;
            pricingBucket?: string;
          };

          // Origin + 2 waypoints + destination.
          expect(response.optimizedCount).toBe(4);
          expect(response.order).toContain("stop-1");
          expect(response.order).toContain("stop-2");
          expect(response.distance).toBeGreaterThan(0);
          expect(response.duration).toBeGreaterThan(0);
          expect(typeof response.pricingBucket).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GeoRoutes.SnapToRoads", () => {
    test.provider(
      "snaps a GPS trace onto the road network",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/snap-to-roads`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            snappedCount: number;
            firstConfidence?: number;
            pricingBucket?: string;
          };

          expect(response.snappedCount).toBeGreaterThan(0);
          expect(response.firstConfidence).toBeGreaterThan(0);
          expect(typeof response.pricingBucket).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });
});
