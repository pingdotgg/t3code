import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  clusterIdOf,
  clusterNameOf,
  instanceIdOf,
  listAlchemyInstances,
  MAX_BACKUP_ID_LENGTH,
  parentOwned,
  parseResourceName,
  tableNameOf,
  toPhysicalId,
  waitForOperation,
  collectPages,
} from "./operations.ts";

const DEFAULT_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

export type InstancesClustersBackupProps = {
  /**
   * Parent instance. Full name `projects/{project}/instances/{instance}`
   * or the instance id. Immutable — changing it replaces the backup.
   */
  instance: string;
  /**
   * Cluster that stores the backup. Full name
   * `projects/{project}/instances/{instance}/clusters/{cluster}` or the
   * cluster id. Immutable — changing it replaces the backup.
   */
  cluster: string;
  /**
   * Source table. Full name
   * `projects/{project}/instances/{instance}/tables/{table}` or the table
   * id. Immutable — changing it replaces the backup.
   */
  sourceTable: string;
  /**
   * Backup id (the `{backup}` segment of
   * `.../clusters/{cluster}/backups/{backup}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Must be 1-50
   * characters. Immutable — changing it replaces the backup.
   */
  backupId?: string;
  /**
   * RFC3339 expiration. Must be at least 6 hours and at most 90 days
   * after creation. Defaults to 7 days from reconcile time when omitted
   * on create.
   */
  expireTime?: string;
  /**
   * Backup type (`STANDARD` or `HOT`). Immutable — changing it replaces
   * the backup.
   */
  backupType?: bigtable.BackupBackupTypeEnum | (string & {});
  /**
   * Time at which a hot backup converts to standard. Only valid for
   * `HOT` backups; must be at least 24 hours after creation.
   */
  hotToStandardTime?: string;
};

export type InstancesClustersBackup = Resource<
  "GCP.Bigtable.InstancesClustersBackup",
  InstancesClustersBackupProps,
  {
    /** Full resource name `.../clusters/{cluster}/backups/{backup}`. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Parent cluster resource name. */
    cluster: string;
    /** Parent cluster id. */
    clusterId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Source table resource name. */
    sourceTable: string | undefined;
    /** Copied-from backup name, if this backup is a copy. */
    sourceBackup: string | undefined;
    /** RFC3339 expiration. */
    expireTime: string | undefined;
    /** Backup type (`STANDARD`, `HOT`). */
    backupType: string | undefined;
    /** Hot-to-standard conversion time. */
    hotToStandardTime: string | undefined;
    /** Server-reported state (`CREATING`, `READY`). */
    state: string | undefined;
    /** RFC3339 start time. */
    startTime: string | undefined;
    /** RFC3339 end time. */
    endTime: string | undefined;
    /** Size in bytes (decimal string). */
    sizeBytes: string | undefined;
    /** Encryption info reported by the API. */
    encryptionInfo: bigtable.EncryptionInfo | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable backup of a table, stored on one cluster.
 *
 * The parent instance, cluster, and source table must already exist.
 * Changing `backupId`, `instance`, `cluster`, `sourceTable`, or
 * `backupType` replaces the backup. `expireTime` and
 * `hotToStandardTime` update in place.
 *
 * Backups have no labels field. Alchemy treats a backup as owned when
 * its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it.
 *
 * ### Creating a Backup
 * **Example:** 7-day backup of an existing table
 * ```typescript
 * const backup = yield* GCP.Bigtable.InstancesClustersBackup("Nightly", {
 *   instance: instance.name,
 *   cluster: "cluster",
 *   sourceTable: table.name,
 * });
 * ```
 *
 * **Example:** Explicit id and expiration
 * ```typescript
 * const backup = yield* GCP.Bigtable.InstancesClustersBackup("Nightly", {
 *   instance: instance.name,
 *   cluster: replica.clusterId,
 *   sourceTable: table.name,
 *   backupId: "nightly",
 *   expireTime: "2026-12-31T00:00:00Z",
 *   backupType: "STANDARD",
 * });
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const InstancesClustersBackup = Resource<InstancesClustersBackup>(
  "GCP.Bigtable.InstancesClustersBackup",
);

export class BackupNotResolved extends Data.TaggedError(
  "GCP.Bigtable.BackupNotResolved",
)<{
  name: string;
}> {}

export class BackupNotReady extends Data.TaggedError(
  "GCP.Bigtable.BackupNotReady",
)<{
  name: string;
  state: string;
}> {}

export class BackupStillExists extends Data.TaggedError(
  "GCP.Bigtable.BackupStillExists",
)<{
  name: string;
}> {}

const toId = (id: string, backupId: string | undefined, existing?: string) =>
  toPhysicalId(id, backupId, existing, MAX_BACKUP_ID_LENGTH);

const normalizeType = (value: string | undefined) => {
  const next = (value ?? "").toUpperCase();
  return next === "BACKUP_TYPE_UNSPECIFIED" ? "" : next;
};

const defaultExpireTime = () =>
  Effect.sync(() => new Date(Date.now() + DEFAULT_EXPIRE_MS).toISOString());

const toAttrs = (backup: bigtable.Backup, project: string) => {
  const name = backup.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    backupId: parsed.backupId,
    cluster: parsed.cluster,
    clusterId: parsed.clusterId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    sourceTable: backup.sourceTable,
    sourceBackup: backup.sourceBackup,
    expireTime: backup.expireTime,
    backupType: backup.backupType,
    hotToStandardTime: backup.hotToStandardTime,
    state: backup.state,
    startTime: backup.startTime,
    endTime: backup.endTime,
    sizeBytes: backup.sizeBytes,
    encryptionInfo: backup.encryptionInfo,
  };
};

const getByName = (name: string) =>
  bigtable
    .getProjectsInstancesClustersBackups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isBusy = (state: string | undefined) =>
  state === "CREATING" || state === "STATE_UNSPECIFIED" || state === undefined;

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup
        ? Effect.succeed(backup)
        : Effect.fail(new BackupNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.BackupNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (backup): backup is bigtable.Backup => backup !== undefined,
      () => new BackupNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (backup) => !isBusy(backup.state),
      (backup) =>
        new BackupNotReady({
          name,
          state: backup.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Bigtable.BackupNotReady" ||
        error._tag === "GCP.Bigtable.BackupNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup === undefined
        ? Effect.void
        : Effect.fail(new BackupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.BackupStillExists",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

export const InstancesClustersBackupProvider = () =>
  Provider.succeed(InstancesClustersBackup, {
    stables: [
      "name",
      "backupId",
      "cluster",
      "clusterId",
      "instance",
      "instanceId",
      "project",
      "sourceTable",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.backupId ?? output?.backupId;
      const nextId = news.backupId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      const previousCluster = clusterIdOf(
        olds?.cluster ?? output?.cluster ?? output?.clusterId ?? "",
      );
      const nextCluster = clusterIdOf(news.cluster);
      const previousTable = parseResourceName(
        olds?.sourceTable ?? output?.sourceTable ?? "",
      ).tableId;
      const nextTable = parseResourceName(
        news.sourceTable.includes("/tables/")
          ? news.sourceTable
          : `projects/_/instances/_/tables/${news.sourceTable}`,
      ).tableId;
      const previousType = normalizeType(
        olds?.backupType ?? output?.backupType,
      );
      const nextType = normalizeType(news.backupType ?? output?.backupType);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstance.length > 0 && previousInstance !== nextInstance) ||
        (previousCluster.length > 0 && previousCluster !== nextCluster) ||
        (previousTable.length > 0 && previousTable !== nextTable) ||
        (news.backupType !== undefined &&
          previousType.length > 0 &&
          nextType.length > 0 &&
          previousType !== nextType)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupId = yield* toId(id, olds?.backupId, output?.backupId);
      const instanceRef = olds?.instance ?? output?.instance;
      const clusterRef = olds?.cluster ?? output?.cluster;
      const name =
        output?.name ??
        (instanceRef && clusterRef
          ? `${clusterNameOf(env.project, instanceRef, clusterRef)}/backups/${backupId}`
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* parentOwned(attrs.instance)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = (yield* listAlchemyInstances(env.project)).filter(
          (instance): instance is bigtable.Instance & { name: string } =>
            typeof instance.name === "string" && instance.name.length > 0,
        );
        const pages = yield* Effect.forEach(
          instances,
          (instance) =>
            collectPages(
              bigtable.listProjectsInstancesClustersBackups.pages({
                parent: `${instance.name}/clusters/-`,
                pageSize: 1000,
              }),
              (page) => page.backups,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as bigtable.Backup[]),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat().map((backup) => toAttrs(backup, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const backupId = yield* toId(id, news.backupId, output?.backupId);
      const parent = clusterNameOf(env.project, news.instance, news.cluster);
      const name = `${parent}/backups/${backupId}`;
      const sourceTable = tableNameOf(
        env.project,
        news.instance,
        news.sourceTable,
      );
      const expireTime = news.expireTime ?? (yield* defaultExpireTime());

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigtable
          .createProjectsInstancesClustersBackups({
            parent,
            backupId,
            body: {
              sourceTable,
              expireTime,
              backupType: news.backupType,
              hotToStandardTime: news.hotToStandardTime,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if (isBusy(current.state)) {
        current = yield* waitUntilReady(name);
      }

      const mask: string[] = [];
      const patchBody: bigtable.Backup = {};
      if (
        news.expireTime !== undefined &&
        (current.expireTime ?? "") !== news.expireTime
      ) {
        patchBody.expireTime = news.expireTime;
        mask.push("expire_time");
      }
      if (
        news.hotToStandardTime !== undefined &&
        (current.hotToStandardTime ?? "") !== news.hotToStandardTime
      ) {
        patchBody.hotToStandardTime = news.hotToStandardTime;
        mask.push("hot_to_standard_time");
      }

      if (mask.length > 0) {
        current = yield* bigtable.patchProjectsInstancesClustersBackups({
          name,
          updateMask: mask.join(","),
          body: patchBody,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigtable
        .deleteProjectsInstancesClustersBackups({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(output.name);
    }),
  });
