import * as FSx from "@/AWS/FSx";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// Syntactically valid but nonexistent ids: each probe must round-trip to FSx
// and come back as the typed *NotFound — an IAM gap would surface
// AccessDeniedException (a 500 via Effect.orDie) instead.
const MISSING_BACKUP_ID = "backup-00000000000000000";
const MISSING_SNAPSHOT_ID = "fsvolsnap-00000000000000000";
const MISSING_VOLUME_ID = "fsvol-00000000000000000";
const MISSING_TASK_ID = "task-00000000000000000";
// Well-formed FSx snapshot ARN pointing at a nonexistent snapshot. FSx
// reports the missing source snapshot as "SourceSnapshotARN provided is not
// a valid ARN" — the distilled patch carves the typed SourceSnapshotNotFound
// out of that BadRequest by message predicate.
const MISSING_SNAPSHOT_ARN =
  "arn:aws:fsx:us-west-2:000000000000:snapshot/fsvolsnap-00000000000000000";

export class FSxBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "FSxBindingsFunction",
) {}

export default FSxBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Account-level bindings only — the file-system-scoped bindings
    // (DescribeFileSystem, CreateBackup, CreateDataRepositoryTask,
    // ReleaseFileSystemNfsV3Locks) require a live FSx file system, which
    // takes ~8 minutes to provision and bills hourly; their runtime path is
    // identical scaffolding and is exercised by the account-level routes.
    const describeBackups = yield* FSx.DescribeBackups();
    const deleteBackup = yield* FSx.DeleteBackup();
    const copyBackup = yield* FSx.CopyBackup();
    const updateSnapshot = yield* FSx.UpdateSnapshot();
    const describeSnapshots = yield* FSx.DescribeSnapshots();
    const createSnapshot = yield* FSx.CreateSnapshot();
    const deleteSnapshot = yield* FSx.DeleteSnapshot();
    const restoreVolumeFromSnapshot = yield* FSx.RestoreVolumeFromSnapshot();
    const copySnapshotAndUpdateVolume =
      yield* FSx.CopySnapshotAndUpdateVolume();
    const describeVolumes = yield* FSx.DescribeVolumes();
    const describeStorageVirtualMachines =
      yield* FSx.DescribeStorageVirtualMachines();
    const describeDataRepositoryTasks =
      yield* FSx.DescribeDataRepositoryTasks();
    const describeDataRepositoryAssociations =
      yield* FSx.DescribeDataRepositoryAssociations();
    const cancelDataRepositoryTask = yield* FSx.CancelDataRepositoryTask();

    const bound = {
      describeBackups,
      deleteBackup,
      copyBackup,
      updateSnapshot,
      describeSnapshots,
      createSnapshot,
      deleteSnapshot,
      restoreVolumeFromSnapshot,
      copySnapshotAndUpdateVolume,
      describeVolumes,
      describeStorageVirtualMachines,
      describeDataRepositoryTasks,
      describeDataRepositoryAssociations,
      cancelDataRepositoryTask,
    };

    // Run a probe expected to fail with a typed tag; return the tag so the
    // test can assert the exact typed error (proving both the IAM grant and
    // the typed error union end-to-end).
    const probeTag = <A, E extends { _tag: string }, R>(
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(
        Effect.result,
        Effect.map((result) =>
          result._tag === "Failure" ? result.failure._tag : "Success",
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/backups") {
          const response = yield* describeBackups();
          return yield* HttpServerResponse.json({
            count: (response.Backups ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/snapshots") {
          const response = yield* describeSnapshots();
          return yield* HttpServerResponse.json({
            count: (response.Snapshots ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/volumes") {
          const response = yield* describeVolumes();
          return yield* HttpServerResponse.json({
            count: (response.Volumes ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/svms") {
          const response = yield* describeStorageVirtualMachines();
          return yield* HttpServerResponse.json({
            count: (response.StorageVirtualMachines ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/dr-tasks") {
          const response = yield* describeDataRepositoryTasks();
          return yield* HttpServerResponse.json({
            count: (response.DataRepositoryTasks ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/dr-associations") {
          const response = yield* describeDataRepositoryAssociations();
          return yield* HttpServerResponse.json({
            count: (response.Associations ?? []).length,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/backup/delete-missing"
        ) {
          const tag = yield* probeTag(
            deleteBackup({ BackupId: MISSING_BACKUP_ID }),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "POST" && pathname === "/backup/copy-missing") {
          const tag = yield* probeTag(
            copyBackup({ SourceBackupId: MISSING_BACKUP_ID }),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "POST" &&
          pathname === "/snapshot/update-missing"
        ) {
          const tag = yield* probeTag(
            updateSnapshot({
              SnapshotId: MISSING_SNAPSHOT_ID,
              Name: "alchemy-fsx-bindings-probe",
            }),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "POST" &&
          pathname === "/snapshot/delete-missing"
        ) {
          const tag = yield* probeTag(
            deleteSnapshot({ SnapshotId: MISSING_SNAPSHOT_ID }),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "POST" &&
          pathname === "/snapshot/create-missing-volume"
        ) {
          const tag = yield* probeTag(
            createSnapshot({
              Name: "alchemy-fsx-bindings-probe",
              VolumeId: MISSING_VOLUME_ID,
            }),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "POST" &&
          pathname === "/volume/restore-missing"
        ) {
          const tag = yield* probeTag(
            restoreVolumeFromSnapshot({
              VolumeId: MISSING_VOLUME_ID,
              SnapshotId: MISSING_SNAPSHOT_ID,
            }),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "POST" &&
          pathname === "/volume/copy-snapshot-missing"
        ) {
          const tag = yield* probeTag(
            copySnapshotAndUpdateVolume({
              VolumeId: MISSING_VOLUME_ID,
              SourceSnapshotARN: MISSING_SNAPSHOT_ARN,
            }),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "POST" &&
          pathname === "/dr-task/cancel-missing"
        ) {
          const tag = yield* probeTag(
            cancelDataRepositoryTask({ TaskId: MISSING_TASK_ID }),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FSx.DescribeBackupsHttp,
        FSx.DeleteBackupHttp,
        FSx.CopyBackupHttp,
        FSx.UpdateSnapshotHttp,
        FSx.DescribeSnapshotsHttp,
        FSx.CreateSnapshotHttp,
        FSx.DeleteSnapshotHttp,
        FSx.RestoreVolumeFromSnapshotHttp,
        FSx.CopySnapshotAndUpdateVolumeHttp,
        FSx.DescribeVolumesHttp,
        FSx.DescribeStorageVirtualMachinesHttp,
        FSx.DescribeDataRepositoryTasksHttp,
        FSx.DescribeDataRepositoryAssociationsHttp,
        FSx.CancelDataRepositoryTaskHttp,
      ),
    ),
  ),
);
