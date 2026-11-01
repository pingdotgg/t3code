import * as GCP from "@/GCP";
import type { StackServices } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<
    GCP.ProviderRequirements,
    never,
    StackServices
  >,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Runs against an existing Cloud SQL instance (creating one takes well over
// 5 minutes); set GCP_SQL_INSTANCE to its name.
const sqlInstance =
  process.env.GCP_SQL_INSTANCE || process.env.GCP_TEST_SQL_INSTANCE;
const runLifecycle = !!sqlInstance && !process.env.FAST;

const waitUntilGone = (instance: string, backupRunId: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      sqladmin
        .getBackupRuns({
          project,
          instance,
          id: backupRunId,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

test.provider(
  "getBackupRuns on a missing instance fails with SqlInstanceNotAuthorized",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getBackupRuns({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
          id: "1",
        }),
      );
      // Cloud SQL hides unknown instances behind 403 rather than 404.
      expect(error._tag).toBe("SqlInstanceNotAuthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider(
  "listBackupRuns on a missing instance fails with SqlInstanceNotAuthorized",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.listBackupRuns({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
          maxResults: 10,
        }),
      );
      expect(error._tag).toBe("SqlInstanceNotAuthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql backup run",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const instance = sqlInstance!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.BackupRun("Nightly", {
            instance,
            description: "alchemy-on-demand",
          });
        }),
      );

      expect(created.backupRunId).toEqual(expect.any(String));
      expect(created.backupRunId.length).toBeGreaterThan(0);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);
      expect(created.description).toEqual("alchemy-on-demand");

      const fetched = yield* sqladmin.getBackupRuns({
        project: created.project,
        instance: created.instance,
        id: created.backupRunId,
      });
      expect(String(fetched.id)).toEqual(created.backupRunId);
      expect(fetched.instance).toEqual(instance);
      expect(fetched.description).toContain("alchemy-on-demand");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.BackupRun("Nightly", {
            instance,
            description: "alchemy-on-demand",
          });
        }),
      );

      expect(updated.backupRunId).toEqual(created.backupRunId);
      expect(updated.instance).toEqual(created.instance);

      const refetched = yield* sqladmin.getBackupRuns({
        project: updated.project,
        instance: updated.instance,
        id: updated.backupRunId,
      });
      expect(String(refetched.id)).toEqual(updated.backupRunId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.instance, created.backupRunId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 120_000 },
);
