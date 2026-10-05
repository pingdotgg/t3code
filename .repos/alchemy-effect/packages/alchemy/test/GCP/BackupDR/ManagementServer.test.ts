import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as backupdr from "@distilled.cloud/gcp/backupdr_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Management servers take well over 5 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  backupdr.getProjectsLocationsManagementServers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsManagementServers on a missing server fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        backupdr.getProjectsLocationsManagementServers({
          name: `projects/${project}/locations/us-central1/managementServers/alchemy-backupdr-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* backupdr.listProjectsLocationsManagementServers({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(
        (page.managementServers ?? []).map((item) => item.name),
      ).not.toContain(
        `projects/${project}/locations/us-central1/managementServers/alchemy-backupdr-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:backupdr", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a management server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BackupDR.ManagementServer("Console", {
            description: "alchemy-test-console",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/managementServers/");
      expect(created.managementServerId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* backupdr.getProjectsLocationsManagementServers({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BackupDR.ManagementServer("Console", {
            managementServerId: created.managementServerId,
            description: "alchemy-test-console",
            labels: { env: "test" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // Provisioning a management server takes up to ~30 minutes, deletion more.
  {
    tags: ["provider:gcp", "provider:gcp:backupdr", "live"],
    timeout: 3_600_000,
    retry: 0,
  },
);
