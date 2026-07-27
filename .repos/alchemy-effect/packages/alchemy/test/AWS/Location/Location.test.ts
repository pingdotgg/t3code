import * as AWS from "@/AWS";
import * as Location from "@/AWS/Location";
import * as Test from "@/Test/Alchemy";
import * as location from "@distilled.cloud/aws/location";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Bounded wait-until-gone: a Describe on a deleted Location resource returns a
// typed ResourceNotFoundException. Poll a few times so the assertion tolerates
// the brief eventual-consistency window after Delete.
const assertGone = <R>(probe: Effect.Effect<unknown, { _tag: string }, R>) =>
  probe.pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "StillExists" as const })),
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

describe.skipIf(!!process.env.FAST)("AWS.Location", () => {
  test.provider(
    "Map: create, update description, delete",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const map = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.Map("TestMap", {
              configuration: { style: "VectorEsriNavigation" },
              tags: { Environment: "test" },
            });
          }),
        );

        expect(map.mapName).toBeDefined();
        expect(map.mapArn).toContain(":map/");
        expect(map.style).toEqual("VectorEsriNavigation");

        const described = yield* location.describeMap({
          MapName: map.mapName,
        });
        expect(described.Configuration.Style).toEqual("VectorEsriNavigation");
        expect(described.Tags?.Environment).toEqual("test");
        expect(described.Tags?.["alchemy::id"]).toEqual("TestMap");

        // Update the description in place (no replacement).
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.Map("TestMap", {
              configuration: { style: "VectorEsriNavigation" },
              description: "updated map",
              tags: { Environment: "prod" },
            });
          }),
        );
        expect(updated.mapName).toEqual(map.mapName);
        expect(updated.description).toEqual("updated map");
        expect(updated.tags.Environment).toEqual("prod");

        yield* stack.destroy();
        yield* assertGone(location.describeMap({ MapName: map.mapName }));
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "PlaceIndex: create, update, delete",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const index = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.PlaceIndex("TestIndex", {
              dataSource: "Esri",
            });
          }),
        );

        expect(index.indexArn).toContain(":place-index/");
        expect(index.dataSource).toEqual("Esri");

        const described = yield* location.describePlaceIndex({
          IndexName: index.indexName,
        });
        expect(described.DataSource).toEqual("Esri");
        expect(described.Tags?.["alchemy::id"]).toEqual("TestIndex");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.PlaceIndex("TestIndex", {
              dataSource: "Esri",
              description: "updated index",
            });
          }),
        );
        expect(updated.indexName).toEqual(index.indexName);
        expect(updated.description).toEqual("updated index");

        yield* stack.destroy();
        yield* assertGone(
          location.describePlaceIndex({ IndexName: index.indexName }),
        );
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "RouteCalculator: create and delete",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const calc = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.RouteCalculator("TestCalc", {
              dataSource: "Esri",
            });
          }),
        );

        expect(calc.calculatorArn).toContain(":route-calculator/");
        expect(calc.dataSource).toEqual("Esri");

        const described = yield* location.describeRouteCalculator({
          CalculatorName: calc.calculatorName,
        });
        expect(described.DataSource).toEqual("Esri");
        expect(described.Tags?.["alchemy::id"]).toEqual("TestCalc");

        yield* stack.destroy();
        yield* assertGone(
          location.describeRouteCalculator({
            CalculatorName: calc.calculatorName,
          }),
        );
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "GeofenceCollection: create, update, delete",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const collection = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.GeofenceCollection("TestFences", {});
          }),
        );

        expect(collection.collectionArn).toContain(":geofence-collection/");

        const described = yield* location.describeGeofenceCollection({
          CollectionName: collection.collectionName,
        });
        expect(described.Tags?.["alchemy::id"]).toEqual("TestFences");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.GeofenceCollection("TestFences", {
              description: "updated fences",
            });
          }),
        );
        expect(updated.collectionName).toEqual(collection.collectionName);
        expect(updated.description).toEqual("updated fences");

        yield* stack.destroy();
        yield* assertGone(
          location.describeGeofenceCollection({
            CollectionName: collection.collectionName,
          }),
        );
      }),
    { timeout: 180_000 },
  );

  // Ungated probe: this account cannot create Location V1 API keys — even
  // AdministratorAccess gets an AccessDeniedException with an EMPTY action
  // name ("is not authorized to perform:  because no resource-based policy
  // allows the  action") from `geo:CreateKey` in every region. That is a
  // service-side gate (Location classic is closed to newer accounts), not an
  // IAM misconfiguration. The probe pins the typed tag forever at near-zero
  // cost; an entitled account instead exercises cleanup of the probe key.
  test.provider(
    "ApiKey: CreateKey is service-gated (typed AccessDeniedException) or succeeds",
    (_stack) =>
      Effect.gen(function* () {
        const created = yield* Effect.result(
          location.createKey({
            KeyName: "alchemy-apikey-probe",
            NoExpiry: true,
            Restrictions: {
              AllowActions: ["geo:GetMap*"],
              AllowResources: ["arn:aws:geo:*:*:map/*"],
            },
          }),
        );
        if (Result.isSuccess(created)) {
          // Entitled account: clean up the probe key immediately.
          yield* location.deleteKey({
            KeyName: "alchemy-apikey-probe",
            ForceDelete: true,
          });
        } else {
          expect(created.failure._tag).toBe("AccessDeniedException");
        }
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_LOCATION_API_KEYS)(
    "ApiKey: create, update description, delete",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const key = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.ApiKey("TestKey", {
              restrictions: {
                allowActions: ["geo:GetMap*"],
                allowResources: ["arn:aws:geo:*:*:map/*"],
              },
            });
          }),
        );

        expect(key.keyArn).toContain(":api-key/");
        expect(Redacted.value(key.key)).toMatch(/^v1\.public\./);
        expect(key.restrictions.allowActions).toEqual(["geo:GetMap*"]);

        const described = yield* location.describeKey({
          KeyName: key.keyName,
        });
        expect(described.Tags?.["alchemy::id"]).toEqual("TestKey");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.ApiKey("TestKey", {
              restrictions: {
                allowActions: ["geo:GetMap*"],
                allowResources: ["arn:aws:geo:*:*:map/*"],
                allowReferers: ["https://example.com/*"],
              },
              description: "updated key",
            });
          }),
        );
        expect(updated.keyName).toEqual(key.keyName);
        expect(updated.description).toEqual("updated key");
        expect(updated.restrictions.allowReferers).toEqual([
          "https://example.com/*",
        ]);
        expect(Redacted.value(updated.key)).toEqual(Redacted.value(key.key));

        yield* stack.destroy();
        yield* assertGone(location.describeKey({ KeyName: key.keyName }));
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "TrackerConsumer: link tracker to geofence collection, delete",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const out = yield* stack.deploy(
          Effect.gen(function* () {
            const tracker = yield* Location.Tracker("ConsumerTracker", {});
            const collection = yield* Location.GeofenceCollection(
              "ConsumerFences",
              {},
            );
            const link = yield* Location.TrackerConsumer("Link", {
              trackerName: tracker.trackerName,
              consumerArn: collection.collectionArn,
            });
            return {
              trackerName: tracker.trackerName,
              collectionArn: collection.collectionArn,
              linkTracker: link.trackerName,
              linkConsumer: link.consumerArn,
            };
          }),
        );

        expect(out.linkTracker).toEqual(out.trackerName);
        expect(out.linkConsumer).toEqual(out.collectionArn);

        const consumers = yield* location.listTrackerConsumers({
          TrackerName: out.trackerName,
        });
        expect(consumers.ConsumerArns).toContain(out.collectionArn);

        yield* stack.destroy();
        yield* assertGone(
          location.describeTracker({ TrackerName: out.trackerName }),
        );
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "Tracker: create, update filtering, delete",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const tracker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.Tracker("TestTracker", {});
          }),
        );

        expect(tracker.trackerArn).toContain(":tracker/");
        expect(tracker.positionFiltering).toEqual("TimeBased");

        const described = yield* location.describeTracker({
          TrackerName: tracker.trackerName,
        });
        expect(described.Tags?.["alchemy::id"]).toEqual("TestTracker");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.Tracker("TestTracker", {
              positionFiltering: "DistanceBased",
              description: "fleet tracker",
            });
          }),
        );
        expect(updated.trackerName).toEqual(tracker.trackerName);
        expect(updated.positionFiltering).toEqual("DistanceBased");
        expect(updated.description).toEqual("fleet tracker");

        yield* stack.destroy();
        yield* assertGone(
          location.describeTracker({ TrackerName: tracker.trackerName }),
        );
      }),
    { timeout: 180_000 },
  );
});
