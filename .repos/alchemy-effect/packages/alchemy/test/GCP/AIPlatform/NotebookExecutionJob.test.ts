import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import { defaultComputeServiceAccount } from "@/GCP/Host";
import * as Output from "@/Output";
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

// The job provisions a Colab runtime and runs the notebook (2-4 minutes).
const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsNotebookExecutionJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const emptyNotebook =
  "eyJuYmZvcm1hdCI6NCwibmJmb3JtYXRfbWlub3IiOjUsIm1ldGFkYXRhIjp7fSwiY2VsbHMiOltdfQ==";

test.provider(
  "getProjectsLocationsNotebookExecutionJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsNotebookExecutionJobs({
          name: `${parent}/notebookExecutionJobs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsNotebookExecutionJobs(
        {
          parent,
          pageSize: 10,
        },
      );
      expect(
        (page.notebookExecutionJobs ?? []).map((item) => item.name),
      ).not.toContain(`${parent}/notebookExecutionJobs/alchemy-missing`);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a notebook execution job",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const serviceAccount = yield* defaultComputeServiceAccount(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.AIPlatform.NotebookRuntimeTemplate(
            "Runtime",
            {
              location: "us-central1",
              displayName: "alchemy-notebook-runtime",
              machineSpec: { machineType: "e2-standard-4" },
              networkSpec: { enableInternetAccess: true },
              // Standard disk keeps the run clear of the regional SSD quota.
              dataPersistentDiskSpec: {
                diskType: "pd-standard",
                diskSizeGb: "100",
              },
              labels: { env: "test" },
            },
          );
          const bucket = yield* GCP.Storage.Bucket("NotebookOut", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.AIPlatform.NotebookExecutionJob("Nightly", {
            location: "us-central1",
            displayName: "alchemy-notebook-job",
            notebookRuntimeTemplateResourceName: template.name,
            directNotebookSource: { content: emptyNotebook },
            gcsOutputUri: Output.interpolate`gs://${bucket.bucketName}/notebook-out`,
            serviceAccount,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/notebookExecutionJobs/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsNotebookExecutionJobs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 600_000,
  },
);
