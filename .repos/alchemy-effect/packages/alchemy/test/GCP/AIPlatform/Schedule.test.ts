import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as ScheduleLib from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsSchedules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: ScheduleLib.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSchedules on a missing schedule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsSchedules({
          name: `projects/${project}/locations/us-central1/schedules/1234567890123456789`,
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
  "create, pause, and delete a vertex schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("PipelineRoot", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.AIPlatform.Schedule("Nightly", {
            location: "us-central1",
            displayName: "nightly",
            cron: "0 8 * * *",
            paused: true,
            maxRunCount: "1",
            createPipelineJobRequest: {
              pipelineJob: {
                displayName: "nightly-hello",
                templateUri:
                  "https://us-kfp.pkg.dev/ml-pipeline/google-cloud-registry/hello-world/latest",
                runtimeConfig: {
                  gcsOutputDirectory: Output.interpolate`gs://${bucket.bucketName}/runs`,
                },
              },
            },
          });
        }),
      );

      expect(created.name).toContain("/schedules/");
      expect(created.paused).toEqual(true);
      expect(created.cron).toContain("0 8 * * *");

      const fetched = yield* aiplatform.getProjectsLocationsSchedules({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("PipelineRoot", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.AIPlatform.Schedule("Nightly", {
            location: "us-central1",
            displayName: "nightly-v2",
            cron: "0 9 * * *",
            paused: true,
            maxRunCount: "1",
            createPipelineJobRequest: {
              pipelineJob: {
                displayName: "nightly-hello",
                templateUri:
                  "https://us-kfp.pkg.dev/ml-pipeline/google-cloud-registry/hello-world/latest",
                runtimeConfig: {
                  gcsOutputDirectory: Output.interpolate`gs://${bucket.bucketName}/runs`,
                },
              },
            },
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.cron).toContain("0 9 * * *");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
