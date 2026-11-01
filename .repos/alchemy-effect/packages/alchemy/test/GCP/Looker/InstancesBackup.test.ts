import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as looker from "@distilled.cloud/gcp/looker_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const location = "us-central1";
const namesOf = (project: string) => {
  const instanceParent = `projects/${project}/locations/${location}`;
  const missingInstance = `${instanceParent}/instances/alchemy-missing-looker`;
  const missingName = `${missingInstance}/backups/alchemy-missing-backup`;
  return { instanceParent, missingInstance, missingName };
};

// Backups need an ACTIVE Looker instance, which bills hourly. Set
// GCP_TEST_LOOKER_INSTANCE to its full resource name to run the lifecycle.
const lookerInstance = process.env.GCP_TEST_LOOKER_INSTANCE?.trim();

const waitUntilGone = (name: string) =>
  looker.getProjectsLocationsInstancesBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsInstancesBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const { missingInstance, missingName } = namesOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        looker.getProjectsLocationsInstancesBackups({ name: missingName }),
      );
      expect(error._tag).toEqual("NotFound");

      const listError = yield* Effect.flip(
        looker.listProjectsLocationsInstancesBackups({
          parent: missingInstance,
          pageSize: 10,
        }),
      );
      expect(listError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:looker", "live"], timeout: 90_000 },
);

test.provider(
  "create against a missing Looker instance is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const { missingInstance } = namesOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Looker.InstancesBackup("Nightly", {
              instance: missingInstance,
            });
          }),
        ),
      );
      // "parent resource not found for .../instances/alchemy-missing-looker"
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:looker", "live"], timeout: 90_000 },
);

test.provider.skipIf(lookerInstance === undefined || !!process.env.FAST)(
  "create, refresh, and delete a Looker instance backup",
  (stack) =>
    Effect.gen(function* () {
      const parent = lookerInstance!;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Looker.InstancesBackup("Nightly", {
            instance: parent,
          });
        }),
      );

      expect(created.name).toContain("/backups/");
      expect(created.instance).toEqual(parent);
      expect(created.location).toEqual(location);
      expect(created.backupId).toEqual(expect.any(String));
      expect(created.state).toEqual("ACTIVE");

      const fetched = yield* looker.getProjectsLocationsInstancesBackups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.state).toEqual("ACTIVE");

      const refreshed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Looker.InstancesBackup("Nightly", {
            instance: parent,
            backupId: created.backupId,
          });
        }),
      );

      expect(refreshed.name).toEqual(created.name);
      expect(refreshed.backupId).toEqual(created.backupId);
      expect(refreshed.state).toEqual("ACTIVE");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:looker", "live"], timeout: 120_000 },
);
