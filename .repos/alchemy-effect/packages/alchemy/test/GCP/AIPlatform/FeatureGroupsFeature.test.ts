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

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsFeatureGroupsFeatures({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const groupProps = {
  location: "us-central1" as const,
  description: "user features",
  labels: { env: "test" },
};

test.provider(
  "getProjectsLocationsFeatureGroupsFeatures on a missing feature fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsFeatureGroupsFeatures({
          name: `projects/${project}/locations/us-central1/featureGroups/alchemy_missing/features/alchemy_missing`,
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

test.provider(
  "create, update, and delete a feature group feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const inputUri = yield* UsersSource;
          const group = yield* GCP.AIPlatform.FeatureGroup("Users", {
            ...groupProps,
            bigQuery: { inputUri, entityIdColumns: ["entity_id"] },
          });
          const feature = yield* GCP.AIPlatform.FeatureGroupsFeature("Age", {
            featureGroup: group.name,
            location: "us-central1",
            description: "customer age",
            versionColumnName: "age",
            labels: { env: "test" },
          });
          return { group, feature };
        }),
      );

      expect(created.feature.name).toContain("/features/");
      expect(created.feature.featureGroup).toEqual(created.group.name);
      expect(created.feature.labels).toMatchObject({ env: "test" });
      expect(created.feature.description).toEqual("customer age");

      const fetched =
        yield* aiplatform.getProjectsLocationsFeatureGroupsFeatures({
          name: created.feature.name,
        });
      expect(fetched.name).toEqual(created.feature.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const inputUri = yield* UsersSource;
          const group = yield* GCP.AIPlatform.FeatureGroup("Users", {
            ...groupProps,
            featureGroupId: created.group.featureGroupId,
            bigQuery: { inputUri, entityIdColumns: ["entity_id"] },
          });
          const feature = yield* GCP.AIPlatform.FeatureGroupsFeature("Age", {
            featureGroup: group.name,
            featureId: created.feature.featureId,
            location: "us-central1",
            description: "customer age v2",
            versionColumnName: "age",
            labels: { env: "prod" },
          });
          return { group, feature };
        }),
      );

      expect(updated.feature.name).toEqual(created.feature.name);
      expect(updated.feature.description).toEqual("customer age v2");
      expect(updated.feature.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.feature.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 600_000,
  },
);
