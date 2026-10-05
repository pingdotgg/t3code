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
  aiplatform.getProjectsLocationsNasJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const nasJobSpec = {
  searchSpaceSpec: "{}",
  multiTrialAlgorithmSpec: {
    metric: { metricId: "accuracy", goal: "MAXIMIZE" as const },
    searchTrialSpec: {
      maxTrialCount: 1,
      maxParallelTrialCount: 1,
      searchTrialJobSpec: {
        workerPoolSpecs: [
          {
            machineSpec: { machineType: "n1-standard-4" },
            replicaCount: "1",
            containerSpec: {
              imageUri:
                "us-docker.pkg.dev/vertex-ai/training/tf-cpu.2-12.py310:latest",
              command: ["echo", "ok"],
            },
          },
        ],
      },
    },
  },
};

test.provider(
  "getProjectsLocationsNasJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsNasJobs({
          name: `${parent}/nasJobs/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsNasJobs({
        parent,
        pageSize: 10,
      });
      expect((page.nasJobs ?? []).map((item) => item.name)).not.toContain(
        `${parent}/nasJobs/1234567890123456789`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create and delete a nas job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.NasJob("Search", {
            location: "us-central1",
            displayName: "alchemy-nas",
            nasJobSpec,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/nasJobs/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsNasJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
