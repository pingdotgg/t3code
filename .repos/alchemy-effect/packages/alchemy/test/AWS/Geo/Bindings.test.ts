import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import GeoTestFunctionLive, { GeoTestFunction } from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "GeoBindings");

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

describe("Geo Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Geo test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Geo test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GeoTestFunction;
        }).pipe(Effect.provide(GeoTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `Geo test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Geo test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("GeoPlaces.SearchText", () => {
    test.provider(
      "returns ranked results for a text query",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/search-text`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            firstPosition?: number[];
          };

          expect(response.count).toBeGreaterThan(0);
          expect(Array.isArray(response.firstPosition)).toBe(true);
          expect(response.firstPosition).toHaveLength(2);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GeoPlaces.Geocode", () => {
    test.provider(
      "geocodes an address into coordinates",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/geocode`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            position?: number[];
          };

          expect(response.count).toBeGreaterThan(0);
          expect(Array.isArray(response.position)).toBe(true);
          expect(response.position).toHaveLength(2);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GeoPlaces.ReverseGeocode", () => {
    test.provider(
      "reverse geocodes coordinates into an address",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/reverse-geocode`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            label?: string;
          };

          expect(response.count).toBeGreaterThan(0);
          expect(typeof response.label).toBe("string");
          expect(response.label!.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

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

  describe("GeoPlaces.Autocomplete", () => {
    test.provider(
      "completes a partial address query",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/autocomplete`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            firstTitle?: string;
          };

          expect(response.count).toBeGreaterThan(0);
          expect(typeof response.firstTitle).toBe("string");
          expect(response.firstTitle!.length).toBeGreaterThan(0);
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

  describe("GeoMaps.GetTile", () => {
    test.provider(
      "fetches a vector tile at z/x/y",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/get-tile`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            byteLength: number;
            contentType?: string;
            pricingBucket?: string;
          };

          expect(response.byteLength).toBeGreaterThan(0);
          expect(typeof response.pricingBucket).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GeoMaps.GetStaticMap", () => {
    test.provider(
      "renders a static map image",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/get-static-map`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            byteLength: number;
            contentType?: string;
            pricingBucket?: string;
          };

          expect(response.byteLength).toBeGreaterThan(0);
          expect(response.contentType).toContain("image");
          expect(typeof response.pricingBucket).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });
});
