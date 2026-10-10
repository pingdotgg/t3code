import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwayApi } from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Volume backups are Pro-plan gated. Railway rejects Hobby/unentitled
// workspaces with GraphQL `Not Authorized`, already typed as
// RailwayForbidden. The probe always runs and pins that tag. The
// create+list+delete lifecycle is opt-in via RAILWAY_TEST_VOLUME_BACKUP=1.
const backupEntitled = !!process.env.RAILWAY_TEST_VOLUME_BACKUP;

const VolumeStack = Effect.gen(function* () {
  const { project, environment } = yield* suitePartition;
  const api = yield* Railway.Service("Api", {
    project,
    environment,
    image: "hashicorp/http-echo",
  });
  const volume = yield* Railway.Volume("Data", {
    project,
    environment,
    mountPath: "/data",
    service: api,
  });
  return { project, environment, api, volume };
});

const listVolumeInstanceBackups = Query.fn((volumeInstanceId: string) =>
  RailwayApi.volumeInstanceBackupList({ volumeInstanceId }).pipe(
    Query.map((backup) => ({
      id: backup.id,
      name: backup.name,
      createdAt: backup.createdAt,
    })),
  ),
);

const readVolumeInstanceState = Query.fn((id: string) => {
  const instance = RailwayApi.volumeInstance({ id });
  return { deletedAt: instance.deletedAt, state: instance.state };
});

const createVolumeInstanceBackup = Query.fn((volumeInstanceId: string) => {
  const created = RailwayApi.volumeInstanceBackupCreate({ volumeInstanceId });
  return { workflowId: created.workflowId };
});

const readWorkflowStatus = Query.fn((workflowId: string) => {
  const workflow = RailwayApi.workflowStatus({ workflowId });
  return { status: workflow.status };
});

const deleteVolumeInstanceBackup = Query.fn(
  (volumeInstanceBackupId: string, volumeInstanceId: string) => {
    const deleted = RailwayApi.volumeInstanceBackupDelete({
      volumeInstanceBackupId,
      volumeInstanceId,
    });
    return { workflowId: deleted.workflowId };
  },
);

const listLive = (volumeInstanceId: string) =>
  listVolumeInstanceBackups(volumeInstanceId).pipe(
    Effect.catchTag(["RailwayNotFound", "RailwayForbidden"], () =>
      Effect.succeed([]),
    ),
  );

const waitUntilReady = (volumeInstanceId: string) =>
  readVolumeInstanceState(volumeInstanceId).pipe(
    Effect.map((instance) =>
      instance.deletedAt == null &&
      instance.state !== "DELETED" &&
      instance.state !== "DELETING" &&
      instance.state !== "UPDATING" &&
      instance.state !== "MIGRATING" &&
      instance.state !== "MIGRATION_PENDING" &&
      instance.state !== "RESTORING" &&
      instance.state !== "ERROR"
        ? ("ready" as const)
        : ("pending" as const),
    ),
    Effect.catchTag("RailwayNotFound", () =>
      Effect.succeed("pending" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "ready",
      times: 10,
    }),
  );

const waitUntilBackupGone = (
  volumeInstanceId: string,
  volumeInstanceBackupId: string,
) =>
  listLive(volumeInstanceId).pipe(
    Effect.map((items) =>
      items.some((backup) => backup.id === volumeInstanceBackupId)
        ? ("found" as const)
        : ("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "volume backup create surfaces a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(VolumeStack);
      yield* waitUntilReady(created.volume.volumeInstanceId);

      const result = yield* Effect.result(
        createVolumeInstanceBackup(created.volume.volumeInstanceId),
      );
      if (Result.isSuccess(result)) {
        yield* Effect.logInfo(
          "volume backups are entitled on this token; probe is a no-op",
        );
        if (
          result.success.workflowId != null &&
          result.success.workflowId.length > 0
        ) {
          yield* readWorkflowStatus(result.success.workflowId).pipe(
            Effect.catchTag("RailwayForbidden", () => Effect.void),
          );
        }
        const extras = yield* listLive(created.volume.volumeInstanceId);
        for (const extra of extras) {
          yield* deleteVolumeInstanceBackup(
            extra.id,
            created.volume.volumeInstanceId,
          ).pipe(
            Effect.catchTag(
              ["RailwayNotFound", "RailwayForbidden"],
              () => Effect.void,
            ),
          );
        }
        yield* stack.destroy();
        return;
      }

      expect(result.failure._tag === "RailwayForbidden").toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "provider:railway:service",
      "provider:railway:volume",
      "provider:railway:volumebackup",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider.skipIf(!backupEntitled)(
  "create, list, and delete a volume backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(VolumeStack);
      yield* waitUntilReady(base.volume.volumeInstanceId);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
          });
          const volume = yield* Railway.Volume("Data", {
            project,
            environment,
            mountPath: "/data",
            service: api,
          });
          const backup = yield* Railway.VolumeBackup("Snapshot", {
            volume,
            environment,
          });
          return { project, environment, api, volume, backup };
        }),
      );

      expect(created.backup.volumeInstanceBackupId).toEqual(expect.any(String));
      expect(created.backup.volumeInstanceBackupId.length).toBeGreaterThan(0);
      expect(created.backup.volumeInstanceId).toEqual(
        created.volume.volumeInstanceId,
      );
      expect(created.backup.volumeId).toEqual(created.volume.volumeId);
      expect(created.backup.projectId).toEqual(created.project.projectId);
      expect(created.backup.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.backup.name).toEqual(expect.any(String));
      expect(created.backup.name.length).toBeGreaterThan(0);
      expect(created.backup.createdAt).toEqual(expect.any(String));

      const listed = yield* listLive(created.volume.volumeInstanceId);
      const fetched = listed.find(
        (backup) => backup.id === created.backup.volumeInstanceBackupId,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.name).toEqual(created.backup.name);
      expect(fetched?.createdAt).toEqual(created.backup.createdAt);

      const provider = yield* Provider.findProvider(Railway.VolumeBackup);
      const fromProvider = yield* provider.list();
      const found = fromProvider.find(
        (backup) =>
          backup.volumeInstanceBackupId ===
          created.backup.volumeInstanceBackupId,
      );
      expect(found).toBeDefined();
      expect(found?.volumeInstanceId).toEqual(created.volume.volumeInstanceId);
      expect(found?.name).toEqual(created.backup.name);

      yield* stack.destroy();

      const backupGone = yield* waitUntilBackupGone(
        created.volume.volumeInstanceId,
        created.backup.volumeInstanceBackupId,
      );
      expect(backupGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "provider:railway:service",
      "provider:railway:volume",
      "provider:railway:volumebackup",
      "live",
    ],
    timeout: 120_000,
  },
);
