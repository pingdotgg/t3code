import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LocationTestFunctionLive, { LocationTestFunction } from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LocationBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

/**
 * GET a fixture route, retrying transient 5xx (cold starts, Location
 * eventual-consistency windows surfaced as handler failures).
 */
const send = (route: string) =>
  HttpClient.execute(HttpClientRequest.get(`${baseUrl}${route}`)).pipe(
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
    Effect.flatMap((response) => response.json),
  );

/**
 * GET a fixture route repeatedly until `until` holds — bounded. Location's
 * list APIs (geofences, device positions, history) are eventually consistent
 * with respect to writes made moments earlier.
 */
const sendUntil = <T>(route: string, until: (response: T) => boolean) =>
  send(route).pipe(
    Effect.map((response) => response as T),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until,
      times: 10,
    }),
  );

// Sequential: the tracker tests are write-then-read (BatchUpdateDevicePosition
// must land before GetDevicePosition/List/BatchGet observe it), and the global
// vitest config runs tests concurrently by default.
describe.skipIf(!!process.env.FAST).sequential("AWS.Location Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Location test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Location test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* LocationTestFunction;
        }).pipe(Effect.provide(LocationTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `Location test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Location test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // AWS canary: the fresh role's inline policy can take minutes to
      // propagate — every geo:* call 500s until it does. Poll a cheap
      // Location-backed route until it succeeds so tests start only once
      // IAM is live.
      yield* Effect.logInfo("Location test setup: waiting for IAM propagation");
      yield* HttpClient.get(`${baseUrl}/geofence/list`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`IAM not propagated: ${response.status}`)),
        ),
        Effect.flatMap((body) =>
          (body as { ok?: boolean }).ok === true
            ? Effect.void
            : Effect.fail(
                new Error(`geo:* not ready: ${JSON.stringify(body)}`),
              ),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Location test setup: geo:* not authorized yet (${String(error)})`,
          ),
        ),
        // IAM propagation of the fresh execution-role policy to geo:* has
        // been observed to take >150s — give it up to ~5 minutes.
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(150),
          ]),
        }),
      );
    }),
    { timeout: 600_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("Location.BatchUpdateDevicePosition", () => {
    test.provider(
      "uploads a device position to the tracker",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/tracker/update")) as {
            errors: number;
          };
          expect(response.errors).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetDevicePosition", () => {
    test.provider(
      "reads the device's latest position",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/tracker/latest")) as {
            deviceId?: string;
            position?: number[];
          };
          expect(response.deviceId).toBe("device-1");
          expect(response.position).toHaveLength(2);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.BatchGetDevicePosition", () => {
    test.provider(
      "reads several devices in one call",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* sendUntil<{
            found: number;
            errors: number;
          }>("/tracker/batch-get", (r) => r.found > 0);
          expect(response.found).toBe(1);
          expect(response.errors).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetDevicePositionHistory", () => {
    test.provider(
      "reads the device's position history",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* sendUntil<{ count: number }>(
            "/tracker/history",
            (r) => r.count > 0,
          );
          expect(response.count).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.ListDevicePositions", () => {
    test.provider(
      "lists the tracker's device positions",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* sendUntil<{
            count: number;
            deviceIds: string[];
          }>("/tracker/list", (r) => r.count > 0);
          expect(response.count).toBeGreaterThan(0);
          expect(response.deviceIds).toContain("device-1");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.VerifyDevicePosition", () => {
    test.provider(
      "verifies a position (or returns the typed validation error)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/tracker/verify")) as {
            inferredState?: boolean;
            deviceId?: string;
            validationError?: string;
          };
          // Fabricated Wi-Fi signals either verify (InferredState) or are
          // rejected with the typed ValidationException — both prove the
          // binding, IAM grant, and typed error union.
          expect(
            response.inferredState === true ||
              typeof response.validationError === "string",
          ).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.PutGeofence", () => {
    test.provider(
      "stores a circular geofence",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/geofence/put")) as {
            geofenceId: string;
          };
          expect(response.geofenceId).toBe("fence-1");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetGeofence", () => {
    test.provider(
      "reads the geofence back",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/geofence/get")) as {
            geofenceId: string;
            status: string;
          };
          expect(response.geofenceId).toBe("fence-1");
          expect(typeof response.status).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.ListGeofences", () => {
    test.provider(
      "lists the collection's geofences",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* sendUntil<{ ok: boolean; count?: number }>(
            "/geofence/list",
            (r) => r.ok && (r.count ?? 0) > 0,
          );
          expect(response).toMatchObject({ ok: true });
          expect(response.count).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.BatchPutGeofence", () => {
    test.provider(
      "stores several geofences in one call",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/geofence/batch-put")) as {
            successes: number;
            errors: number;
          };
          expect(response.successes).toBe(1);
          expect(response.errors).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.BatchEvaluateGeofences", () => {
    test.provider(
      "evaluates a device position against the collection",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/geofence/evaluate")) as {
            ok: boolean;
            errors?: number;
          };
          expect(response).toMatchObject({ ok: true, errors: 0 });
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.ForecastGeofenceEvents", () => {
    test.provider(
      "forecasts upcoming geofence events",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/geofence/forecast")) as {
            forecasted: number;
            distanceUnit: string;
          };
          expect(response.forecasted).toBeGreaterThanOrEqual(0);
          expect(typeof response.distanceUnit).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.BatchDeleteGeofence", () => {
    test.provider(
      "deletes geofences in one call",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/geofence/batch-delete")) as {
            errors: number;
          };
          expect(response.errors).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.BatchDeleteDevicePositionHistory", () => {
    test.provider(
      "purges the device's position history",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/tracker/delete-history")) as {
            errors: number;
          };
          expect(response.errors).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.SearchPlaceIndexForText", () => {
    test.provider(
      "geocodes a text query",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/places/search-text")) as {
            count: number;
            firstLabel?: string;
          };
          expect(response.count).toBeGreaterThan(0);
          expect(typeof response.firstLabel).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.SearchPlaceIndexForPosition", () => {
    test.provider(
      "reverse-geocodes a coordinate",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/places/search-position")) as {
            count: number;
            firstLabel?: string;
          };
          expect(response.count).toBeGreaterThan(0);
          expect(typeof response.firstLabel).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.SearchPlaceIndexForSuggestions", () => {
    test.provider(
      "returns typeahead suggestions",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/places/suggestions")) as {
            count: number;
            firstText?: string;
          };
          expect(response.count).toBeGreaterThan(0);
          expect(typeof response.firstText).toBe("string");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetPlace", () => {
    test.provider(
      "fetches place details by PlaceId",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/places/get-place")) as {
            ok: boolean;
            label?: string;
            point?: number[];
          };
          expect(response).toMatchObject({ ok: true });
          expect(typeof response.label).toBe("string");
          expect(response.point).toHaveLength(2);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.CalculateRoute", () => {
    test.provider(
      "calculates a route between two positions",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/routes/calculate")) as {
            distance?: number;
            duration?: number;
          };
          expect(response.distance).toBeGreaterThan(0);
          expect(response.duration).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.CalculateRouteMatrix", () => {
    test.provider(
      "calculates a distance matrix",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/routes/matrix")) as {
            rows: number;
            distance?: number;
          };
          expect(response.rows).toBe(1);
          expect(response.distance).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetMapStyleDescriptor", () => {
    test.provider(
      "serves the style descriptor",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/map/style")) as {
            bytes: number;
            contentType?: string;
          };
          expect(response.bytes).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetMapGlyphs", () => {
    test.provider(
      "serves a glyph range",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/map/glyphs")) as { bytes: number };
          expect(response.bytes).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetMapSprites", () => {
    test.provider(
      "serves the sprite index",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/map/sprites")) as { bytes: number };
          expect(response.bytes).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetMapTile", () => {
    test.provider(
      "serves a map tile",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/map/tile")) as { bytes: number };
          expect(response.bytes).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.ListJobs", () => {
    test.provider(
      "lists batch metadata jobs",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/jobs/list")) as { count: number };
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.GetJob", () => {
    test.provider(
      "returns the typed ResourceNotFoundException for a missing job",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/jobs/get-missing")) as {
            tag: string;
            message?: string;
          };
          expect(response).toMatchObject({ tag: "ResourceNotFoundException" });
        }),
      { timeout: 120_000 },
    );
  });

  describe("Location.CancelJob", () => {
    test.provider(
      "returns the typed ResourceNotFoundException for a missing job",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send("/jobs/cancel-missing")) as {
            tag: string;
            message?: string;
          };
          expect(response).toMatchObject({ tag: "ResourceNotFoundException" });
        }),
      { timeout: 120_000 },
    );
  });
});
