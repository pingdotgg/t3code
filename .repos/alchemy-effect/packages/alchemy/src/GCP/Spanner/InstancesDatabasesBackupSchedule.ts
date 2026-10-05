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
  backupScheduleName,
  databaseIdOf,
  databaseName,
  instanceIdOf,
  instanceName,
  listAlchemyDatabases,
  MAX_BACKUP_SCHEDULE_ID_LENGTH,
  parentOwned,
  parseResourceName,
  retryConcurrentChanges,
  toPhysicalId,
} from "./operations.ts";

const DEFAULT_CRON = "0 2 * * *";
const DEFAULT_RETENTION = "604800s";

export type BackupScheduleEncryptionConfig = {
  /**
   * Encryption type (`USE_DATABASE_ENCRYPTION`,
   * `GOOGLE_DEFAULT_ENCRYPTION`, `CUSTOMER_MANAGED_ENCRYPTION`).
   */
  encryptionType?:
    | spanner.CreateBackupEncryptionConfigEncryptionTypeEnum
    | (string & {});
  /** Cloud KMS key. Prefer `kmsKeyNames` for new schedules. */
  kmsKeyName?: string;
  /** Cloud KMS keys covering every region of the instance config. */
  kmsKeyNames?: string[];
};

export type BackupScheduleSpec = {
  /**
   * Cron schedule in UTC. Full backups must be at least 12 hours
   * apart; incremental backups at least 4 hours apart.
   * @default "0 2 * * *"
   */
  cron?: string;
};

export type InstancesDatabasesBackupScheduleProps = {
  /**
   * Parent instance id or full name. Immutable — changing it replaces
   * the schedule.
   */
  instance: string;
  /**
   * Parent database id or full name. Immutable — changing it replaces
   * the schedule.
   */
  database: string;
  /**
   * Backup schedule id (the `{schedule}` segment of
   * `.../databases/{database}/backupSchedules/{schedule}`). If omitted,
   * a unique name is generated. Must match `^[a-z][-a-z0-9]*[a-z0-9]$`
   * (2–60 characters). Immutable — changing it replaces the schedule.
   */
  backupScheduleId?: string;
  /**
   * Cron-style schedule specification.
   */
  spec?: BackupScheduleSpec;
  /**
   * Retention duration of created backups (`604800s` is 7 days). Must
   * be at least 6 hours and at most 366 days.
   * @default "604800s"
   */
  retentionDuration?: string;
  /**
   * Encryption applied to backups created by this schedule.
   */
  encryptionConfig?: BackupScheduleEncryptionConfig;
  /**
   * When true, create incremental backup chains (Enterprise Plus).
   * Default creates full backups. Immutable — changing it replaces
   * the schedule.
   * @default false
   */
  incremental?: boolean;
};

export type InstancesDatabasesBackupSchedule = Resource<
  "GCP.Spanner.InstancesDatabasesBackupSchedule",
  InstancesDatabasesBackupScheduleProps,
  {
    /** Full resource name `.../databases/{database}/backupSchedules/{schedule}`. */
    name: string;
    /** Backup schedule id (last path segment). */
    backupScheduleId: string;
    /** Parent database id. */
    databaseId: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Cron text, if set. */
    cron: string | undefined;
    /** Cron time zone (UTC). */
    timeZone: string | undefined;
    /** Creation window after the version time. */
    creationWindow: string | undefined;
    /** Retention duration. */
    retentionDuration: string | undefined;
    /** Encryption configuration. */
    encryptionConfig: BackupScheduleEncryptionConfig | undefined;
    /** Whether the schedule creates incremental chains. */
    incremental: boolean;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An automated backup schedule on a Cloud Spanner database.
 *
 * Schedules have no labels field. Alchemy treats a schedule as owned
 * when its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it. Changing `backupScheduleId`, `instance`,
 * `database`, or `incremental` replaces the schedule. Cron, retention,
 * and encryption update in place.
 *
 * ### Creating a Backup Schedule
 * **Example:** Daily full backup retained for 7 days
 * ```typescript
 * const schedule = yield* GCP.Spanner.InstancesDatabasesBackupSchedule(
 *   "Nightly",
 *   {
 *     instance: instance.instanceId,
 *     database: database.databaseId,
 *     spec: { cron: "0 2 * * *" },
 *     retentionDuration: "604800s",
 *   },
 * );
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const schedule = yield* GCP.Spanner.InstancesDatabasesBackupSchedule(
 *   "Nightly",
 *   {
 *     instance: instance.name,
 *     database: database.name,
 *     backupScheduleId: "nightly",
 *     spec: { cron: "0 2 * * 0" },
 *     retentionDuration: "1209600s",
 *   },
 * );
 * ```
 *
 * @resource
 * @category Spanner
 */
export const InstancesDatabasesBackupSchedule =
  Resource<InstancesDatabasesBackupSchedule>(
    "GCP.Spanner.InstancesDatabasesBackupSchedule",
  );

export class BackupScheduleNotResolved extends Data.TaggedError(
  "GCP.Spanner.BackupScheduleNotResolved",
)<{
  name: string;
}> {}

const toId = (
  id: string,
  backupScheduleId: string | undefined,
  existing?: string,
) =>
  toPhysicalId(id, backupScheduleId, existing, MAX_BACKUP_SCHEDULE_ID_LENGTH);

const encryptionOf = (
  config: spanner.CreateBackupEncryptionConfig | undefined,
): BackupScheduleEncryptionConfig | undefined => {
  if (config === undefined) return undefined;
  if (
    config.encryptionType === undefined &&
    (config.kmsKeyName === undefined || config.kmsKeyName.length === 0) &&
    (config.kmsKeyNames === undefined || config.kmsKeyNames.length === 0)
  ) {
    return undefined;
  }
  return {
    encryptionType: config.encryptionType,
    kmsKeyName: config.kmsKeyName,
    kmsKeyNames: config.kmsKeyNames,
  };
};

const encryptionKey = (config: BackupScheduleEncryptionConfig | undefined) =>
  JSON.stringify({
    encryptionType: (config?.encryptionType ?? "").toUpperCase(),
    kmsKeyName: config?.kmsKeyName ?? "",
    kmsKeyNames: [...(config?.kmsKeyNames ?? [])].sort(),
  });

const toAttrs = (
  schedule: spanner.BackupSchedule,
  project: string,
): InstancesDatabasesBackupSchedule["Attributes"] => {
  const name = schedule.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    backupScheduleId: parsed.backupScheduleId,
    databaseId: parsed.databaseId,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    cron: schedule.spec?.cronSpec?.text,
    timeZone: schedule.spec?.cronSpec?.timeZone,
    creationWindow: schedule.spec?.cronSpec?.creationWindow,
    retentionDuration: schedule.retentionDuration,
    encryptionConfig: encryptionOf(schedule.encryptionConfig),
    incremental: schedule.incrementalBackupSpec !== undefined,
    updateTime: schedule.updateTime,
  };
};

const getByName = (name: string) =>
  spanner
    .getProjectsInstancesDatabasesBackupSchedules({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toBody = (
  news: InstancesDatabasesBackupScheduleProps,
): spanner.BackupSchedule => {
  const incremental = news.incremental === true;
  const body: spanner.BackupSchedule = {
    spec: {
      cronSpec: {
        text: news.spec?.cron ?? DEFAULT_CRON,
      },
    },
    retentionDuration: news.retentionDuration ?? DEFAULT_RETENTION,
    encryptionConfig: news.encryptionConfig,
  };
  if (incremental) {
    body.incrementalBackupSpec = {};
  } else {
    body.fullBackupSpec = {};
  }
  return body;
};

export const InstancesDatabasesBackupScheduleProvider = () =>
  Provider.succeed(InstancesDatabasesBackupSchedule, {
    stables: [
      "name",
      "backupScheduleId",
      "databaseId",
      "instanceId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.backupScheduleId ?? output?.backupScheduleId;
      const nextId = news.backupScheduleId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      const previousDatabase = databaseIdOf(
        olds?.database ?? output?.databaseId ?? "",
      );
      const nextDatabase = databaseIdOf(news.database);
      const previousIncremental = olds?.incremental ?? output?.incremental;
      const nextIncremental = news.incremental ?? previousIncremental;

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstance.length > 0 && previousInstance !== nextInstance) ||
        (previousDatabase.length > 0 && previousDatabase !== nextDatabase) ||
        (previousIncremental !== undefined &&
          nextIncremental !== undefined &&
          previousIncremental !== nextIncremental);

      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupScheduleId = yield* toId(
        id,
        olds?.backupScheduleId,
        output?.backupScheduleId,
      );
      const instanceId = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      const databaseId = databaseIdOf(
        olds?.database ?? output?.databaseId ?? "",
      );
      if (instanceId.length === 0 || databaseId.length === 0) return undefined;
      const name =
        output?.name ??
        backupScheduleName(
          env.project,
          instanceId,
          databaseId,
          backupScheduleId,
        );
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
        const databases = yield* listAlchemyDatabases(env.project);
        const pages = yield* Effect.forEach(
          databases,
          (database) => {
            const parent = database.name;
            if (parent === undefined || parent.length === 0) {
              return Effect.succeed(
                [] as InstancesDatabasesBackupSchedule["Attributes"][],
              );
            }
            return spanner.listProjectsInstancesDatabasesBackupSchedules
              .pages({
                parent,
                pageSize: 1000,
              })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.backupSchedules ?? []),
                ),
                Stream.map((schedule) => toAttrs(schedule, env.project)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed(
                    [] as InstancesDatabasesBackupSchedule["Attributes"][],
                  ),
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
      const databaseId = databaseIdOf(news.database);
      const backupScheduleId = yield* toId(
        id,
        news.backupScheduleId,
        output?.backupScheduleId,
      );
      const parent = databaseName(env.project, instanceId, databaseId);
      const name = backupScheduleName(
        env.project,
        instanceId,
        databaseId,
        backupScheduleId,
      );
      const desiredCron = news.spec?.cron ?? DEFAULT_CRON;
      const desiredRetention = news.retentionDuration ?? DEFAULT_RETENTION;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        current = yield* spanner
          .createProjectsInstancesDatabasesBackupSchedules({
            parent,
            backupScheduleId,
            body: toBody(news),
          })
          .pipe(
            Effect.catchTag("Conflict", () => getByName(name)),
            Effect.flatMap((schedule) =>
              schedule
                ? Effect.succeed(schedule)
                : Effect.fail(new BackupScheduleNotResolved({ name })),
            ),
          );
      }

      const observedCron = current.spec?.cronSpec?.text ?? "";
      const observedRetention = current.retentionDuration ?? "";
      const encryptionChanged =
        news.encryptionConfig !== undefined &&
        encryptionKey(encryptionOf(current.encryptionConfig)) !==
          encryptionKey(news.encryptionConfig);
      const cronChanged = observedCron !== desiredCron;
      const retentionChanged = observedRetention !== desiredRetention;

      if (cronChanged || retentionChanged || encryptionChanged) {
        const fieldMask = [
          cronChanged ? "spec.cron_spec.text" : undefined,
          retentionChanged ? "retention_duration" : undefined,
          encryptionChanged ? "encryption_config" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patchBody: spanner.BackupSchedule = {
          name,
        };
        if (cronChanged) {
          patchBody.spec = { cronSpec: { text: desiredCron } };
        }
        if (retentionChanged) {
          patchBody.retentionDuration = desiredRetention;
        }
        if (encryptionChanged) {
          patchBody.encryptionConfig = news.encryptionConfig;
        }
        current = yield* retryConcurrentChanges(
          spanner.patchProjectsInstancesDatabasesBackupSchedules({
            name,
            updateMask: fieldMask.join(","),
            body: patchBody,
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* spanner
        .deleteProjectsInstancesDatabasesBackupSchedules({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
    }),
  });
