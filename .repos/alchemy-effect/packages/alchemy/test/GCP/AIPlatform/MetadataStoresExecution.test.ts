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
  aiplatform.getProjectsLocationsMetadataStoresExecutions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsMetadataStoresExecutions on a missing execution fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsMetadataStoresExecutions({
          name: `projects/${project}/locations/us-central1/metadataStores/alchemy-missing/executions/alchemy-missing`,
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
  "create, update, and delete a metadata store execution",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.MetadataStore("Mlmd", {
            location: "us-central1",
            description: "pipeline metadata",
          });
          const execution = yield* GCP.AIPlatform.MetadataStoresExecution(
            "Train",
            {
              metadataStore: store.name,
              displayName: "train-step",
              description: "first",
              state: "RUNNING",
              labels: { env: "test" },
            },
          );
          return { store, execution };
        }),
      );

      expect(created.execution.name).toContain("/executions/");
      expect(created.execution.metadataStore).toEqual(created.store.name);
      expect(created.execution.displayName).toEqual("train-step");
      expect(created.execution.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsMetadataStoresExecutions({
          name: created.execution.name,
        });
      expect(fetched.name).toEqual(created.execution.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.MetadataStore("Mlmd", {
            metadataStoreId: created.store.metadataStoreId,
            location: "us-central1",
            description: "pipeline metadata",
          });
          const execution = yield* GCP.AIPlatform.MetadataStoresExecution(
            "Train",
            {
              metadataStore: store.name,
              executionId: created.execution.executionId,
              displayName: "train-step-v2",
              description: "second",
              state: "COMPLETE",
              labels: { env: "prod" },
            },
          );
          return { store, execution };
        }),
      );

      expect(updated.execution.name).toEqual(created.execution.name);
      expect(updated.execution.displayName).toEqual("train-step-v2");
      expect(updated.execution.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.execution.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
