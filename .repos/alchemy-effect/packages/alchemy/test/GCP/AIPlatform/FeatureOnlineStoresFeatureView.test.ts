import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { UsersSource } from "./fixtures/features.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Bigtable-backed store provisioning takes 1-3 minutes.
const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsFeatureOnlineStoresFeatureViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsFeatureOnlineStoresFeatureViews on a missing view fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsFeatureOnlineStoresFeatureViews({
          name: `projects/${project}/locations/us-central1/featureOnlineStores/alchemy_missing/featureViews/alchemy_missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a feature online store feature view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.FeatureOnlineStore("Serving", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const inputUri = yield* UsersSource;
          const group = yield* GCP.AIPlatform.FeatureGroup("UserFeatures", {
            location: "us-central1",
            bigQuery: { inputUri, entityIdColumns: ["entity_id"] },
          });
          const feature = yield* GCP.AIPlatform.FeatureGroupsFeature("Age", {
            featureGroup: group.name,
            location: "us-central1",
            versionColumnName: "age",
          });
          const view = yield* GCP.AIPlatform.FeatureOnlineStoresFeatureView(
            "Users",
            {
              featureOnlineStore: store.name,
              location: "us-central1",
              labels: { env: "test" },
              featureRegistrySource: {
                featureGroups: [
                  {
                    featureGroupId: group.featureGroupId,
                    featureIds: [feature.featureId],
                  },
                ],
              },
              syncConfig: { cron: "0 * * * *" },
            },
          );
          return { store, view };
        }),
      );

      expect(created.view.name).toContain("/featureViews/");
      expect(created.view.featureOnlineStore).toEqual(created.store.name);
      expect(created.view.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsFeatureOnlineStoresFeatureViews({
          name: created.view.name,
        });
      expect(fetched.name).toEqual(created.view.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.FeatureOnlineStore("Serving", {
            featureOnlineStoreId: created.store.featureOnlineStoreId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const inputUri = yield* UsersSource;
          const group = yield* GCP.AIPlatform.FeatureGroup("UserFeatures", {
            location: "us-central1",
            bigQuery: { inputUri, entityIdColumns: ["entity_id"] },
          });
          const feature = yield* GCP.AIPlatform.FeatureGroupsFeature("Age", {
            featureGroup: group.name,
            location: "us-central1",
            versionColumnName: "age",
          });
          const view = yield* GCP.AIPlatform.FeatureOnlineStoresFeatureView(
            "Users",
            {
              featureOnlineStore: store.name,
              featureViewId: created.view.featureViewId,
              location: "us-central1",
              labels: { env: "prod" },
              featureRegistrySource: {
                featureGroups: [
                  {
                    featureGroupId: group.featureGroupId,
                    featureIds: [feature.featureId],
                  },
                ],
              },
              syncConfig: { cron: "0 * * * *" },
            },
          );
          return { store, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 600_000,
  },
);
