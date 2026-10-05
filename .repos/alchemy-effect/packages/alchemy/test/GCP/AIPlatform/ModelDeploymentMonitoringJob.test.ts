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

// Monitoring needs an endpoint with a deployed model: against an empty
// endpoint create fails with BadRequest "Deployed Model ID: `0` does not
// match existing Deployed Models". Set GCP_TEST_AIPLATFORM_DEPLOYED_ENDPOINT
// to `{endpoint name}#{deployed model id}` to run the lifecycle.
const deployedEndpoint = process.env.GCP_TEST_AIPLATFORM_DEPLOYED_ENDPOINT;
const runLifecycle = !process.env.FAST && !!deployedEndpoint;
const [endpointName = "", deployedModelId = ""] = (
  deployedEndpoint ?? ""
).split("#");

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsModelDeploymentMonitoringJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsModelDeploymentMonitoringJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsModelDeploymentMonitoringJobs({
          name: `${parent}/modelDeploymentMonitoringJobs/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page =
        yield* aiplatform.listProjectsLocationsModelDeploymentMonitoringJobs({
          parent,
          pageSize: 10,
        });
      expect(
        (page.modelDeploymentMonitoringJobs ?? []).map((item) => item.name),
      ).not.toContain(
        `${parent}/modelDeploymentMonitoringJobs/1234567890123456789`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a model deployment monitoring job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const job = yield* GCP.AIPlatform.ModelDeploymentMonitoringJob(
            "Watch",
            {
              location: "us-central1",
              displayName: "alchemy-mdm",
              endpoint: endpointName,
              loggingSamplingStrategy: {
                randomSampleConfig: { sampleRate: 0.1 },
              },
              modelDeploymentMonitoringScheduleConfig: {
                monitorInterval: "3600s",
              },
              modelDeploymentMonitoringObjectiveConfigs: [
                {
                  deployedModelId,
                  objectiveConfig: {
                    predictionDriftDetectionConfig: {},
                  },
                },
              ],
              labels: { env: "test" },
            },
          );
          return { job };
        }),
      );

      expect(created.job.name).toContain("/modelDeploymentMonitoringJobs/");
      expect(created.job.endpoint).toEqual(endpointName);
      expect(created.job.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsModelDeploymentMonitoringJobs({
          name: created.job.name,
        });
      expect(fetched.name).toEqual(created.job.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const job = yield* GCP.AIPlatform.ModelDeploymentMonitoringJob(
            "Watch",
            {
              location: "us-central1",
              displayName: "alchemy-mdm-v2",
              endpoint: endpointName,
              loggingSamplingStrategy: {
                randomSampleConfig: { sampleRate: 0.2 },
              },
              modelDeploymentMonitoringScheduleConfig: {
                monitorInterval: "3600s",
              },
              modelDeploymentMonitoringObjectiveConfigs: [
                {
                  deployedModelId,
                  objectiveConfig: {
                    predictionDriftDetectionConfig: {},
                  },
                },
              ],
              labels: { env: "prod" },
            },
          );
          return { job };
        }),
      );

      expect(updated.job.name).toEqual(created.job.name);
      expect(updated.job.displayName).toEqual("alchemy-mdm-v2");
      expect(updated.job.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.job.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
