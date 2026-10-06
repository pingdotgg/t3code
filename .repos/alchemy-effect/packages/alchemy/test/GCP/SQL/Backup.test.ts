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

const waitUntilGone = (name: string) =>
  sqladmin.getBackupBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    // Cloud SQL answers a deleted backup uid with this 403.
    Effect.catchTag("SqlBackupAccessDenied", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getBackupBackups on a missing backup fails with SqlBackupAccessDenied",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getBackupBackups({
          name: `projects/${project}/backups/00000000-0000-0000-0000-000000000000`,
        }),
      );
      // Cloud SQL hides unknown backups behind 403 rather than 404.
      expect(error._tag).toBe("SqlBackupAccessDenied");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider(
  "lists sql backups",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const page = yield* sqladmin.listBackupsBackups({
        parent: `projects/${project}`,
        pageSize: 10,
      });
      expect((page.backups ?? []).map((backup) => backup.name)).not.toContain(
        `projects/${project}/backups/00000000-0000-0000-0000-000000000000`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql backup",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const instance = sqlInstance!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Backup("Nightly", {
            instance,
            description: "alchemy-on-demand",
          });
        }),
      );

      expect(created.backupId).toEqual(expect.any(String));
      expect(created.backupId.length).toBeGreaterThan(0);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(
        `projects/${project}/backups/${created.backupId}`,
      );
      expect(created.description).toEqual("alchemy-on-demand");

      const fetched = yield* sqladmin.getBackupBackups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.instance).toEqual(instance);
      expect(fetched.description).toContain("alchemy-on-demand");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Backup("Nightly", {
            instance,
            description: "alchemy-on-demand",
          });
        }),
      );

      expect(updated.backupId).toEqual(created.backupId);
      expect(updated.name).toEqual(created.name);

      const refetched = yield* sqladmin.getBackupBackups({
        name: updated.name,
      });
      expect(refetched.name).toEqual(updated.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 120_000 },
);
