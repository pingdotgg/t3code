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

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsMetadataStoresContexts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsMetadataStoresContexts on a missing context fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsMetadataStoresContexts({
          name: `projects/${project}/locations/us-central1/metadataStores/alchemy-missing/contexts/alchemy-missing`,
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
  "create, update, and delete a metadata store context",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.MetadataStore("Mlmd", {
            location: "us-central1",
            description: "pipeline metadata",
          });
          const context = yield* GCP.AIPlatform.MetadataStoresContext(
            "Experiment",
            {
              metadataStore: store.name,
              displayName: "training-run",
              description: "first",
              labels: { env: "test" },
            },
          );
          return { store, context };
        }),
      );

      expect(created.context.name).toContain("/contexts/");
      expect(created.context.metadataStore).toEqual(created.store.name);
      expect(created.context.displayName).toEqual("training-run");
      expect(created.context.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsMetadataStoresContexts({
          name: created.context.name,
        });
      expect(fetched.name).toEqual(created.context.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.MetadataStore("Mlmd", {
            metadataStoreId: created.store.metadataStoreId,
            location: "us-central1",
            description: "pipeline metadata",
          });
          const context = yield* GCP.AIPlatform.MetadataStoresContext(
            "Experiment",
            {
              metadataStore: store.name,
              contextId: created.context.contextId,
              displayName: "training-run-v2",
              description: "second",
              labels: { env: "prod" },
            },
          );
          return { store, context };
        }),
      );

      expect(updated.context.name).toEqual(created.context.name);
      expect(updated.context.displayName).toEqual("training-run-v2");
      expect(updated.context.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.context.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
