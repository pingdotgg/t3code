import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as redis from "@distilled.cloud/gcp/redis_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Memorystore instance create + update + delete runs well past 5 minutes.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  redis.getProjectsLocationsInstances({ name }).pipe(
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
        redis.getProjectsLocationsInstances({
          name: `projects/${project}/locations/us-central1/instances/alchemy-redis-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* redis.listProjectsLocationsInstances({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(
        (page.instances ?? []).map((instance) =>
          instance.name?.split("/").pop(),
        ),
      ).not.toContain("alchemy-redis-missing");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:redis", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a redis instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Redis.Instance("Cache", {
            location: "us-central1",
            tier: "BASIC",
            memorySizeGb: 1,
            displayName: "alchemy-test-cache",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/instances/");
      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.tier).toEqual("BASIC");
      expect(created.memorySizeGb).toEqual(1);
      expect(created.displayName).toEqual("alchemy-test-cache");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("READY");

      const fetched = yield* redis.getProjectsLocationsInstances({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.tier).toEqual("BASIC");
      expect(fetched.memorySizeGb).toEqual(1);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.displayName).toEqual("alchemy-test-cache");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Redis.Instance("Cache", {
            instanceId: created.instanceId,
            location: "us-central1",
            tier: "BASIC",
            memorySizeGb: 1,
            displayName: "alchemy-prod-cache",
            labels: { env: "prod", role: "cache" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod-cache");
      expect(updated.labels).toMatchObject({ env: "prod", role: "cache" });

      const refetched = yield* redis.getProjectsLocationsInstances({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("alchemy-prod-cache");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("cache");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:redis", "live"], timeout: 1_800_000 },
);
