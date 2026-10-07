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

// Pool create + update + delete takes ~1.5 minutes.
const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsDeploymentResourcePools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDeploymentResourcePools on a missing pool fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsDeploymentResourcePools({
          name: `${parent}/deploymentResourcePools/alchemy-aiplatform-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page =
        yield* aiplatform.listProjectsLocationsDeploymentResourcePools({
          parent,
          pageSize: 10,
        });
      expect(
        (page.deploymentResourcePools ?? []).map((item) => item.name),
      ).not.toContain(
        `${parent}/deploymentResourcePools/alchemy-aiplatform-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a deployment resource pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.DeploymentResourcePool("Shared", {
            location: "us-central1",
            dedicatedResources: {
              minReplicaCount: 1,
              maxReplicaCount: 1,
              machineSpec: { machineType: "n1-standard-2" },
            },
          });
        }),
      );

      expect(created.name).toContain("/deploymentResourcePools/");
      expect(created.deploymentResourcePoolId.startsWith("alch-")).toEqual(
        true,
      );
      expect(created.dedicatedResources?.minReplicaCount).toEqual(1);

      const fetched =
        yield* aiplatform.getProjectsLocationsDeploymentResourcePools({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.DeploymentResourcePool("Shared", {
            deploymentResourcePoolId: created.deploymentResourcePoolId,
            location: "us-central1",
            dedicatedResources: {
              minReplicaCount: 1,
              maxReplicaCount: 2,
              machineSpec: { machineType: "n1-standard-2" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.dedicatedResources?.maxReplicaCount).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
