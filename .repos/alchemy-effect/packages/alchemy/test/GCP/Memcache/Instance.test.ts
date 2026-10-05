import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as memcache from "@distilled.cloud/gcp/memcache_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Memcached instances need Private Service Access on the project's default
// network — without it create fails with BadRequest "Google private service
// access is not enabled." — and take ~10 minutes to provision. Set
// GCP_TEST_PRIVATE_SERVICE_ACCESS=1 on a project with PSA configured.
const privateServiceAccess = !!process.env.GCP_TEST_PRIVATE_SERVICE_ACCESS;
const runLifecycle =
  privateServiceAccess && !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  memcache.getProjectsLocationsInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsInstances on a missing instance fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        memcache.getProjectsLocationsInstances({
          name: `projects/${project}/locations/us-central1/instances/alchemy-memcache-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* memcache.listProjectsLocationsInstances({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(
        (page.instances ?? []).map((instance) => instance.name),
      ).not.toContain(
        `projects/${project}/locations/us-central1/instances/alchemy-memcache-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:memcache", "live"], timeout: 90_000 },
);

test.provider.skipIf(privateServiceAccess)(
  "createProjectsLocationsInstances without private service access fails with PrivateServiceAccessNotEnabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const error = yield* Effect.flip(
        memcache.createProjectsLocationsInstances({
          parent: `projects/${project}/locations/us-central1`,
          instanceId: "alchemy-memcache-psa-probe",
          body: {
            nodeCount: 1,
            nodeConfig: { cpuCount: 1, memorySizeMb: 1024 },
          },
        }),
      );
      expect(error._tag).toEqual("PrivateServiceAccessNotEnabled");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:memcache", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a memcache instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Memcache.Instance("Cache", {
            location: "us-central1",
            nodeCount: 1,
            nodeConfig: { cpuCount: 1, memorySizeMb: 1024 },
            displayName: "alchemy-test-memcache",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/instances/");
      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.nodeCount).toEqual(1);
      expect(created.nodeConfig.cpuCount).toEqual(1);
      expect(created.nodeConfig.memorySizeMb).toEqual(1024);
      expect(created.displayName).toEqual("alchemy-test-memcache");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("READY");

      const fetched = yield* memcache.getProjectsLocationsInstances({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.nodeCount).toEqual(1);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.displayName).toEqual("alchemy-test-memcache");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Memcache.Instance("Cache", {
            instanceId: created.instanceId,
            location: "us-central1",
            nodeCount: 1,
            nodeConfig: { cpuCount: 1, memorySizeMb: 1024 },
            displayName: "alchemy-prod-memcache",
            labels: { env: "prod", role: "cache" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod-memcache");
      expect(updated.labels).toMatchObject({ env: "prod", role: "cache" });

      const refetched = yield* memcache.getProjectsLocationsInstances({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("alchemy-prod-memcache");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("cache");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:memcache", "live"],
    timeout: 1_800_000,
  },
);
