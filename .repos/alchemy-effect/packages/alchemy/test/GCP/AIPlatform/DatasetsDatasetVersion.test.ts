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
  aiplatform.getDatasetsDatasetVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getDatasetsDatasetVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getDatasetsDatasetVersions({
          name: `${parent}/datasets/1234567890123456789/datasetVersions/0`,
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

const imageDataset = {
  location: "us-central1",
  displayName: "version-parent",
  metadataSchemaUri:
    "gs://google-cloud-aiplatform/schema/dataset/metadata/image_1.0.0.yaml",
  metadata: {},
  labels: { env: "test" },
  savedQueries: [
    {
      displayName: "default",
      problemType: "IMAGE_CLASSIFICATION_SINGLE_LABEL",
    },
  ],
};

test.provider(
  "creating a version of a dataset without data items fails with GCP.OperationFailed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const dataset = yield* GCP.AIPlatform.Dataset(
              "Samples",
              imageDataset,
            );
            const version = yield* GCP.AIPlatform.DatasetsDatasetVersion("V1", {
              dataset: dataset.name,
              displayName: "v1",
            });
            return { dataset, version };
          }),
        ),
      );
      expect(error._tag).toEqual("GCP.OperationFailed");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 600_000,
  },
);

// Set GCP_TEST_AIPLATFORM_DATASET_VERSION on a project where this succeeds to run the full lifecycle.
test.provider.skipIf(!process.env.GCP_TEST_AIPLATFORM_DATASET_VERSION)(
  "create, update, and delete a dataset version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.AIPlatform.Dataset(
            "Samples",
            imageDataset,
          );
          const version = yield* GCP.AIPlatform.DatasetsDatasetVersion("V1", {
            dataset: dataset.name,
            displayName: "v1",
          });
          return { dataset, version };
        }),
      );

      expect(created.version.name).toContain("/datasetVersions/");
      expect(created.version.dataset).toEqual(created.dataset.name);
      expect(created.version.displayName).toEqual("v1");

      const fetched = yield* aiplatform.getDatasetsDatasetVersions({
        name: created.version.name,
      });
      expect(fetched.name).toEqual(created.version.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.AIPlatform.Dataset("Samples", {
            ...imageDataset,
            datasetId: created.dataset.datasetId,
          });
          const version = yield* GCP.AIPlatform.DatasetsDatasetVersion("V1", {
            dataset: dataset.name,
            displayName: "v1-final",
          });
          return { dataset, version };
        }),
      );

      expect(updated.version.name).toEqual(created.version.name);
      expect(updated.version.displayName).toEqual("v1-final");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
