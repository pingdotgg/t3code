import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  backupName,
  databaseIdOf,
  databaseNameOf,
  instanceIdOf,
  instanceName,
  listAlchemyInstances,
  MAX_BACKUP_ID_LENGTH,
  parentOwned,
  parseResourceName,
  retryConcurrentChanges,
  toPhysicalId,
  waitForOperation,
} from "./operations.ts";

const DEFAULT_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

export type BackupEncryptionConfig = {
  /**
   * Encryption type (`USE_DATABASE_ENCRYPTION`,
   * `GOOGLE_DEFAULT_ENCRYPTION`, `CUSTOMER_MANAGED_ENCRYPTION`).
   */
  encryptionType?:
    | spanner.CreateProjectsInstancesBackupsEncryptionConfig_encryptionTypeEnum
    | (string & {});
  /**
   * Cloud KMS key. Use only when the key location matches the instance
   * config exactly. Prefer `kmsKeyNames` for new backups.
   */
  kmsKeyName?: string;
  /**
   * Cloud KMS keys covering every region of the instance config.
   */
  kmsKeyNames?: string[];
};

export type InstancesBackupProps = {
  /**
   * Parent instance id or full name
   * (`projects/{project}/instances/{instance}`). Must be the instance
   * that owns `database`. Immutable — changing it replaces the backup.
   */
  instance: string;
  /**
   * Source database id or full name
   * (`projects/{project}/instances/{instance}/databases/{database}`).
   * Immutable — changing it replaces the backup.
   */
  database: string;
  /**
   * Backup id (the `{backup}` segment of
   * `projects/{project}/instances/{instance}/backups/{backup}`). If
   * omitted, a unique name is generated. Must match
   * `^[a-z][-a-z0-9]*[a-z0-9]$` (2–60 characters). Immutable —
   * changing it replaces the backup.
   */
  backupId?: string;
  /**
   * RFC3339 expiration. Must be at least 6 hours and at most 366 days
   * from create time. Defaults to 7 days from reconcile time on create.
   */
  expireTime?: string;
  /**
   * Externally consistent version timestamp. Defaults to create time.
   * Immutable — changing it replaces the backup.
   */
  versionTime?: string;
  /**
   * Backup encryption. Immutable — changing it replaces the backup.
   */
  encryptionConfig?: BackupEncryptionConfig;
};

export type InstancesBackup = Resource<
  "GCP.Spanner.InstancesBackup",
  InstancesBackupProps,
  {
    /** Full resource name `projects/{project}/instances/{instance}/backups/{backup}`. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Source database resource name. */
    database: string | undefined;
    /** RFC3339 expiration. */
    expireTime: string | undefined;
    /** Version timestamp captured in the backup. */
    versionTime: string | undefined;
    /** RFC3339 create time. */
    createTime: string | undefined;
    /** Size in bytes (decimal string). */
    sizeBytes: string | undefined;
    /** Bytes freed by deleting this backup. */
    freeableSizeBytes: string | undefined;
    /** Incremental exclusive size in bytes. */
    exclusiveSizeBytes: string | undefined;
    /** Server-reported state (`CREATING`, `READY`). */
    state: string | undefined;
    /** Databases restored from this backup. */
    referencingDatabases: string[];
    /** Encryption info. */
    encryptionInfo: spanner.EncryptionInfo | undefined;
    /** SQL dialect of the source database. */
    databaseDialect: string | undefined;
    /** Destination backups copying this backup. */
    referencingBackups: string[];
    /** Max allowed expiration. */
    maxExpireTime: string | undefined;
    /** Backup schedule names that produced this backup. */
    backupSchedules: string[];
    /** Incremental backup chain id, if any. */
    incrementalBackupChainId: string | undefined;
    /** Oldest retained version timestamp. */
    oldestVersionTime: string | undefined;
    /** Instance partitions stored in the backup. */
    instancePartitions: string[];
    /** Minimum edition required to restore. */
    minimumRestorableEdition: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Spanner backup of a database, stored on the parent instance.
 *
 * Backups have no labels field. Alchemy treats a backup as owned when
 * its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it. Changing `backupId`, `instance`,
 * `database`, `versionTime`, or encryption replaces the backup.
 * `expireTime` updates in place.
 *
 * ### Creating a Backup
 * **Example:** 7-day backup of an existing database
 * ```typescript
 * const backup = yield* GCP.Spanner.InstancesBackup("Nightly", {
 *   instance: instance.instanceId,
 *   database: database.databaseId,
 * });
 * ```
 *
 * **Example:** Explicit id and expiration
 * ```typescript
 * const backup = yield* GCP.Spanner.InstancesBackup("Nightly", {
 *   instance: instance.name,
 *   database: database.name,
 *   backupId: "nightly",
 *   expireTime: "2026-12-31T00:00:00Z",
 * });
 * ```
 *
 * @resource
 * @category Spanner
 */
export const InstancesBackup = Resource<InstancesBackup>(
  "GCP.Spanner.InstancesBackup",
);

export class BackupNotResolved extends Data.TaggedError(
  "GCP.Spanner.BackupNotResolved",
)<{
  name: string;
}> {}

export class BackupNotReady extends Data.TaggedError(
  "GCP.Spanner.BackupNotReady",
)<{
  name: string;
  state: string;
}> {}

export class BackupStillExists extends Data.TaggedError(
  "GCP.Spanner.BackupStillExists",
)<{
  name: string;
}> {}

const toId = (id: string, backupId: string | undefined, existing?: string) =>
  toPhysicalId(id, backupId, existing, MAX_BACKUP_ID_LENGTH);

const defaultExpireTime = () =>
  Effect.sync(() => new Date(Date.now() + DEFAULT_EXPIRE_MS).toISOString());

const encryptionKey = (config: BackupEncryptionConfig | undefined) =>
  JSON.stringify({
    encryptionType: (config?.encryptionType ?? "").toUpperCase(),
    kmsKeyName: config?.kmsKeyName ?? "",
    kmsKeyNames: [...(config?.kmsKeyNames ?? [])].sort(),
  });

const toAttrs = (
  backup: spanner.Backup,
  project: string,
): InstancesBackup["Attributes"] => {
  const name = backup.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    backupId: parsed.backupId,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    database: backup.database,
    expireTime: backup.expireTime,
    versionTime: backup.versionTime,
    createTime: backup.createTime,
    sizeBytes: backup.sizeBytes,
    freeableSizeBytes: backup.freeableSizeBytes,
    exclusiveSizeBytes: backup.exclusiveSizeBytes,
    state: backup.state,
    referencingDatabases: backup.referencingDatabases ?? [],
    encryptionInfo: backup.encryptionInfo,
    databaseDialect: backup.databaseDialect,
    referencingBackups: backup.referencingBackups ?? [],
    maxExpireTime: backup.maxExpireTime,
    backupSchedules: backup.backupSchedules ?? [],
    incrementalBackupChainId: backup.incrementalBackupChainId,
    oldestVersionTime: backup.oldestVersionTime,
    instancePartitions: (backup.instancePartitions ?? [])
      .map((item) => item.instancePartition)
      .filter((item): item is string => typeof item === "string"),
    minimumRestorableEdition: backup.minimumRestorableEdition,
  };
};

const getByName = (name: string) =>
  spanner
    .getProjectsInstancesBackups({ name })
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
      while: (error) => error._tag === "GCP.Spanner.BackupNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (backup): backup is spanner.Backup => backup !== undefined,
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
        error._tag === "GCP.Spanner.BackupNotReady" ||
        error._tag === "GCP.Spanner.BackupNotResolved",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const refreshOrFail = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup
        ? Effect.succeed(backup)
        : Effect.fail(new BackupNotResolved({ name })),
    ),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup === undefined
        ? Effect.void
        : Effect.fail(new BackupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Spanner.BackupStillExists",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const expireEquals = (left: string | undefined, right: string | undefined) => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return left === right;
  return Math.abs(leftMs - rightMs) < 1000;
};

export const InstancesBackupProvider = () =>
  Provider.succeed(InstancesBackup, {
    stables: [
      "name",
      "backupId",
      "instanceId",
      "project",
      "database",
      "createTime",
      "versionTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.backupId ?? output?.backupId;
      const nextId = news.backupId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      const previousDatabase = databaseIdOf(
        olds?.database ?? output?.database ?? "",
      );
      const nextDatabase = databaseIdOf(news.database);
      const previousVersion = olds?.versionTime ?? output?.versionTime ?? "";
      const nextVersion = news.versionTime ?? previousVersion;
      const previousEncryption = encryptionKey(olds?.encryptionConfig);
      const nextEncryption = encryptionKey(
        news.encryptionConfig ?? olds?.encryptionConfig,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstance.length > 0 && previousInstance !== nextInstance) ||
        (previousDatabase.length > 0 && previousDatabase !== nextDatabase) ||
        (news.versionTime !== undefined &&
          previousVersion.length > 0 &&
          previousVersion !== nextVersion) ||
        (news.encryptionConfig !== undefined &&
          previousEncryption !== nextEncryption);

      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupId = yield* toId(id, olds?.backupId, output?.backupId);
      const instanceId = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      if (instanceId.length === 0) return undefined;
      const name =
        output?.name ?? backupName(env.project, instanceId, backupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* parentOwned(instanceName(attrs.project, attrs.instanceId)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* listAlchemyInstances(env.project);
        const pages = yield* Effect.forEach(
          instances,
          (instance) => {
            const parent = instance.name;
            if (parent === undefined || parent.length === 0) {
              return Effect.succeed([] as InstancesBackup["Attributes"][]);
            }
            return spanner.listProjectsInstancesBackups
              .pages({
                parent,
                pageSize: 1000,
              })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.backups ?? []),
                ),
                Stream.map((backup) => toAttrs(backup, env.project)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as InstancesBackup["Attributes"][]),
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = instanceIdOf(news.instance);
      const backupId = yield* toId(id, news.backupId, output?.backupId);
      const name = backupName(env.project, instanceId, backupId);
      const parent = instanceName(env.project, instanceId);
      const database = databaseNameOf(
        env.project,
        news.instance,
        news.database,
      );
      const expireTime = news.expireTime ?? (yield* defaultExpireTime());

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* spanner
          .createProjectsInstancesBackups({
            parent,
            backupId,
            "encryptionConfig.encryptionType":
              news.encryptionConfig?.encryptionType,
            "encryptionConfig.kmsKeyName": news.encryptionConfig?.kmsKeyName,
            "encryptionConfig.kmsKeyNames": news.encryptionConfig?.kmsKeyNames,
            body: {
              database,
              expireTime,
              versionTime: news.versionTime,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined && created.done === true) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if (isBusy(current.state)) {
        current = yield* waitUntilReady(name).pipe(
          Effect.catchTag(
            ["GCP.Spanner.BackupNotReady", "GCP.Spanner.BackupNotResolved"],
            () => refreshOrFail(name),
          ),
        );
      }

      if (
        news.expireTime !== undefined &&
        !expireEquals(current.expireTime, news.expireTime)
      ) {
        current = yield* retryConcurrentChanges(
          spanner.patchProjectsInstancesBackups({
            name,
            updateMask: "expire_time",
            body: {
              expireTime: news.expireTime,
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* spanner.deleteProjectsInstancesBackups({ name: output.name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("5 seconds"),
        }),
      );
      yield* waitUntilGone(output.name);
    }),
  });
