import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as file from "@distilled.cloud/gcp/file_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CAPACITY_ZONE } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Filestore instances take 5–20 minutes to provision and several to delete.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  file.getProjectsLocationsInstances({ name }).pipe(
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
        file.getProjectsLocationsInstances({
          name: `projects/${project}/locations/us-central1-a/instances/alchemy-filestore-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:filestore", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a filestore instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Filestore.Instance("Nfs", {
            location: CAPACITY_ZONE,
            tier: "BASIC_HDD",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            description: "alchemy-test-nfs",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/instances/");
      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.location).toEqual(CAPACITY_ZONE);
      expect(created.tier).toEqual("BASIC_HDD");
      expect(created.description).toEqual("alchemy-test-nfs");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("READY");
      expect(created.fileShares[0]?.name).toEqual("share1");
      expect(created.fileShares[0]?.capacityGb).toEqual(1024);

      const fetched = yield* file.getProjectsLocationsInstances({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.tier).toEqual("BASIC_HDD");
      expect(fetched.description).toEqual("alchemy-test-nfs");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.fileShares?.[0]?.name).toEqual("share1");
      expect(fetched.fileShares?.[0]?.capacityGb).toEqual("1024");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Filestore.Instance("Nfs", {
            instanceId: created.instanceId,
            location: CAPACITY_ZONE,
            tier: "BASIC_HDD",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            description: "alchemy-prod-nfs",
            labels: { env: "prod", role: "nfs" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-nfs");
      expect(updated.labels).toMatchObject({ env: "prod", role: "nfs" });

      const refetched = yield* file.getProjectsLocationsInstances({
        name: created.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-nfs");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("nfs");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:filestore", "live"],
    timeout: 2_700_000,
    retry: 0,
  },
);
