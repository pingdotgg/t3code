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

// Vertex AI data labeling is shut down for new projects: create fails with
// BadRequest "Vertex DataLabelingJob is deprecated, so new project ... will
// not be able to use the service unless they opt-in to use Labelbox human
// labelers." Set GCP_TEST_AIPLATFORM_DATA_LABELING=1 on an opted-in project.
const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_AIPLATFORM_DATA_LABELING;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsDataLabelingJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDataLabelingJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsDataLabelingJobs({
          name: `${parent}/dataLabelingJobs/1234567890123456789`,
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
  "create and delete a data labeling job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.AIPlatform.Dataset("ToLabel", {
            location: "us-central1",
            displayName: "label-source",
            metadataSchemaUri:
              "gs://google-cloud-aiplatform/schema/dataset/metadata/image_1.0.0.yaml",
            metadata: {},
            labels: { env: "test" },
          });
          return yield* GCP.AIPlatform.DataLabelingJob("Label", {
            location: "us-central1",
            displayName: "alchemy-label",
            datasets: [dataset.name],
            labelerCount: 1,
            instructionUri: "gs://cloud-samples-data/ai-platform/label.pdf",
            inputsSchemaUri:
              "gs://google-cloud-aiplatform/schema/datalabelingjob/inputs/image_classification_1.0.0.yaml",
            inputs: { annotationSpecs: ["cat", "dog"] },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/dataLabelingJobs/");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsDataLabelingJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
