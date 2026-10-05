import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const WORKER_IMAGE = "us-docker.pkg.dev/cloudrun/container/worker-pool";

const waitUntilGone = (name: string) =>
  cloudrun.getProjectsLocationsWorkerPools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a Cloud Run worker pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.WorkerPool("Workers", {
            location: "us-central1",
            description: "test run worker pool",
            labels: { env: "test" },
            scaling: { manualInstanceCount: 0 },
            template: {
              containers: [{ image: WORKER_IMAGE }],
            },
          });
        }),
      );

      expect(created.name).toContain("/workerPools/");
      expect(created.workerPoolId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("test run worker pool");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.image).toEqual(WORKER_IMAGE);
      expect(created.terminalConditionState).toEqual("CONDITION_SUCCEEDED");

      const fetched = yield* cloudrun.getProjectsLocationsWorkerPools({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("test run worker pool");
      expect(fetched.template?.containers?.[0]?.image).toEqual(WORKER_IMAGE);
      expect(fetched.scaling?.manualInstanceCount).toEqual(0);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.WorkerPool("Workers", {
            workerPoolId: created.workerPoolId,
            location: "us-central1",
            description: "prod run worker pool",
            labels: { env: "prod", role: "worker" },
            scaling: { manualInstanceCount: 0 },
            template: {
              containers: [
                {
                  image: WORKER_IMAGE,
                  env: [{ name: "ENV", value: "prod" }],
                },
              ],
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("prod run worker pool");
      expect(updated.labels).toMatchObject({ env: "prod", role: "worker" });
      expect(updated.image).toEqual(WORKER_IMAGE);

      const refetched = yield* cloudrun.getProjectsLocationsWorkerPools({
        name: created.name,
      });
      expect(refetched.description).toEqual("prod run worker pool");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("worker");
      expect(
        refetched.template?.containers?.[0]?.env?.some(
          (env) => env.name === "ENV" && env.value === "prod",
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 120_000 },
);
