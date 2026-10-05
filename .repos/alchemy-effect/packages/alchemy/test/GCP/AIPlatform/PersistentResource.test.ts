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

// Persistent training clusters take 5-15 minutes to provision and tear down.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsPersistentResources({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsPersistentResources on a missing resource fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsPersistentResources({
          name: `${parent}/persistentResources/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsPersistentResources({
        parent,
        pageSize: 10,
      });
      expect(
        (page.persistentResources ?? []).map((item) => item.name),
      ).not.toContain(`${parent}/persistentResources/alchemy-missing`);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a persistent resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.PersistentResource("Train", {
            location: "us-central1",
            displayName: "alchemy-persistent",
            resourcePools: [
              {
                id: "worker",
                replicaCount: "1",
                machineSpec: { machineType: "n1-standard-4" },
              },
            ],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/persistentResources/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsPersistentResources(
        {
          name: created.name,
        },
      );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.PersistentResource("Train", {
            persistentResourceId: created.persistentResourceId,
            location: "us-central1",
            displayName: "alchemy-persistent",
            resourcePools: [
              {
                id: "worker",
                // Non-Ray persistent resources cannot be updated in place,
                // so a replica change replaces the resource.
                replicaCount: "2",
                machineSpec: { machineType: "n1-standard-4" },
              },
            ],
            labels: { env: "test" },
          });
        }),
      );

      // Replaced under the same id.
      expect(updated.name).toEqual(created.name);
      const scaled = yield* aiplatform.getProjectsLocationsPersistentResources({
        name: created.name,
      });
      expect(scaled.resourcePools?.[0]?.replicaCount).toEqual("2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // Provisioning the worker pool takes several minutes; so does teardown.
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 2_400_000,
    retry: 0,
  },
);
