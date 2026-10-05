import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Needs a Featurestore, whose online serving takes ~6 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsFeaturestoresEntityTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsFeaturestoresEntityTypes on a missing entity type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsFeaturestoresEntityTypes({
          name: `projects/${project}/locations/us-central1/featurestores/alchemy_missing/entityTypes/alchemy_missing`,
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
  "create, update, and delete a featurestore entity type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.Featurestore("Features", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const entity = yield* GCP.AIPlatform.FeaturestoresEntityType("User", {
            featurestore: store.name,
            location: "us-central1",
            description: "end users",
            labels: { env: "test" },
          });
          return { store, entity };
        }),
      );

      expect(created.entity.name).toContain("/entityTypes/");
      expect(created.entity.featurestore).toEqual(created.store.name);
      expect(created.entity.description).toEqual("end users");
      expect(created.entity.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsFeaturestoresEntityTypes({
          name: created.entity.name,
        });
      expect(fetched.name).toEqual(created.entity.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.Featurestore("Features", {
            featurestoreId: created.store.featurestoreId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const entity = yield* GCP.AIPlatform.FeaturestoresEntityType("User", {
            featurestore: store.name,
            entityTypeId: created.entity.entityTypeId,
            location: "us-central1",
            description: "end users v2",
            labels: { env: "prod" },
          });
          return { store, entity };
        }),
      );

      expect(updated.entity.name).toEqual(created.entity.name);
      expect(updated.entity.description).toEqual("end users v2");
      expect(updated.entity.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.entity.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 600_000,
  },
);
