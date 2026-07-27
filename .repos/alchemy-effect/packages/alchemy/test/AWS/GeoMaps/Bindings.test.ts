import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import GeoMapsTestFunctionLive, { GeoMapsTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "GeoMapsBindings");

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

describe.sequential("GeoMaps Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "GeoMaps test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("GeoMaps test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GeoMapsTestFunction;
        }).pipe(Effect.provide(GeoMapsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `GeoMaps test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `GeoMaps test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 5 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(5);
      }),
    );
  });

  describe("GetStaticMap", () => {
    test.provider(
      "renders a static map image (nonzero PNG payload)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/static-map")) as any;
          expect(response.bytes).toBeGreaterThan(0);
          expect(response.contentType).toContain("image/");
          expect(typeof response.pricingBucket).toBe("string");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetTile", () => {
    test.provider(
      "fetches the 0/0/0 vector basemap tile",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/tile")) as any;
          expect(response.bytes).toBeGreaterThan(0);
          expect(typeof response.pricingBucket).toBe("string");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetStyleDescriptor", () => {
    test.provider(
      "fetches the Standard MapLibre style descriptor (valid JSON)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/style-descriptor")) as any;
          expect(response.bytes).toBeGreaterThan(0);
          // MapLibre style spec version is always 8.
          expect(response.version).toBe(8);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetSprites", () => {
    test.provider(
      "fetches the Standard style's sprite sheet",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/sprites")) as any;
          expect(response.bytes).toBeGreaterThan(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetGlyphs", () => {
    test.provider(
      "fetches a glyph PBF range for Amazon Ember Regular",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/glyphs")) as any;
          expect(response.bytes).toBeGreaterThan(0);
        }),
      { timeout: 60_000 },
    );
  });
});
