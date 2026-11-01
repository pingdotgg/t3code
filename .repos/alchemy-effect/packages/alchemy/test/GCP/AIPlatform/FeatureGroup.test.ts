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
  aiplatform.getProjectsLocationsFeatureGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsFeatureGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsFeatureGroups({
          name: `${parent}/featureGroups/alchemy_missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsFeatureGroups({
        parent,
        pageSize: 10,
      });
      expect((page.featureGroups ?? []).map((item) => item.name)).not.toContain(
        `${parent}/featureGroups/alchemy_missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a feature group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const inputUri = yield* UsersSource;
          return yield* GCP.AIPlatform.FeatureGroup("Users", {
            location: "us-central1",
            description: "user features",
            labels: { env: "test" },
            bigQuery: {
              inputUri,
              entityIdColumns: ["entity_id"],
            },
          });
        }),
      );

      expect(created.name).toContain("/featureGroups/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.description).toEqual("user features");

      const fetched = yield* aiplatform.getProjectsLocationsFeatureGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const inputUri = yield* UsersSource;
          return yield* GCP.AIPlatform.FeatureGroup("Users", {
            featureGroupId: created.featureGroupId,
            location: "us-central1",
            description: "user features v2",
            labels: { env: "prod", role: "features" },
            bigQuery: {
              inputUri,
              entityIdColumns: ["entity_id"],
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("user features v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "features" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 600_000,
  },
);
