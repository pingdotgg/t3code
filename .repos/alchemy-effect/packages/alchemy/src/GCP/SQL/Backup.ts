import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForSqlOperation } from "./operations.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  instanceIdOf,
  lastSegment,
  matchesOwnership,
  parseDescription,
} from "./ownership.ts";

export type BackupProps = {
  /**
   * Cloud SQL instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). Full resource names are
   * accepted and reduced to the last path segment. Immutable — changing
   * it replaces the backup.
   */
  instance: string;
  /**
   * Storage location of the backup (`us`, `us-central1`, …). If omitted,
   * Cloud SQL picks the closest multi-region. Immutable — changing it
   * replaces the backup.
   */
  location?: string;
  /**
   * Human-readable description. Cloud SQL backups have no labels field,
   * so Alchemy stamps ownership into the description at create. On-demand
   * backups cannot update description in place (`updateBackupBackups`
   * applies to FINAL backups only).
   */
  description?: string;
  /**
   * Time-to-live in days (1–365). Input-only on create. Ignored on
   * subsequent reconciles of on-demand backups.
   */
  ttlDays?: number | string;
  /**
   * RFC3339 expiration. Writable only on FINAL backups; ignored for
   * on-demand backups after create.
   */
  expiryTime?: string;
  /**
   * Existing backup id (the `{backup}` segment of
   * `projects/{project}/backups/{backup}`) used to observe a backup when
   * state is missing. The create API assigns ids — this is not sent on
   * insert.
   */
  backupId?: string;
};

export type Backup = Resource<
  "GCP.SQL.Backup",
  BackupProps,
  {
    /** Full resource name `projects/{project}/backups/{backup}`. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Project id. */
    project: string;
    /** Source Cloud SQL instance id. */
    instance: string;
    /** Storage location. */
    location: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Backup type (`ON_DEMAND`, `AUTOMATED`, `FINAL`). */
    type: string | undefined;
    /** Server-reported state (`ENQUEUED`, `RUNNING`, `SUCCESSFUL`, …). */
    state: string | undefined;
    /** Kind of backup (`SNAPSHOT`, `PHYSICAL`). */
    backupKind: string | undefined;
    /** Input-only TTL in days, if the API echoes it. */
    ttlDays: string | undefined;
    /** RFC3339 expiration. */
    expiryTime: string | undefined;
    /** Database version at backup time. */
    databaseVersion: string | undefined;
    /** Mapped backup-run resource name, if any. */
    backupRun: string | undefined;
    /** SQL Admin self-link. */
    selfLink: string | undefined;
    /** Backup time zone (SQL Server). */
    timeZone: string | undefined;
    /** KMS key used to encrypt the backup. */
    kmsKey: string | undefined;
    /** Maximum chargeable bytes. */
    maxChargeableBytes: string | undefined;
    /** Inclusive/exclusive backup interval. */
    backupInterval: sqladmin.Interval | undefined;
  },
  never,
  Providers
>;

/**
 * An on-demand Cloud SQL backup (`projects/{project}/backups/{backup}`).
 *
 * The create API assigns the backup id. Alchemy stamps ownership into
 * `description` so `list` / `pnpm nuke:gcp` can find leaked rows.
 * Changing `instance` or `location` replaces the backup. Description,
 * `ttlDays`, and `expiryTime` are create-time for on-demand backups;
 * FINAL backups can update description and expiration in place.
 *
 * ### Creating a Backup
 * **Example:** On-demand backup of a Cloud SQL instance
 * ```typescript
 * const instance = yield* GCP.SQL.Instance("AppDb", {
 *   tier: "db-f1-micro",
 *   backupEnabled: true,
 * });
 * const backup = yield* GCP.SQL.Backup("Nightly", {
 *   instance: instance.instanceName,
 * });
 * ```
 *
 * **Example:** Description, location, and TTL
 * ```typescript
 * const backup = yield* GCP.SQL.Backup("Nightly", {
 *   instance: instance.instanceName,
 *   location: "us",
 *   description: "pre-release",
 *   ttlDays: 7,
 * });
 * ```
 *
 * @resource
 * @category SQL
 */
export const Backup = Resource<Backup>("GCP.SQL.Backup");

export class BackupNotResolved extends Data.TaggedError(
  "GCP.SQL.BackupNotResolved",
)<{
  name: string;
}> {}

export class BackupNotReady extends Data.TaggedError("GCP.SQL.BackupNotReady")<{
  name: string;
  state: string | undefined;
}> {}

export class BackupStillExists extends Data.TaggedError(
  "GCP.SQL.BackupStillExists",
)<{
  name: string;
}> {}

const backupNameOf = (project: string, backupId: string) =>
  backupId.includes("/") ? backupId : `projects/${project}/backups/${backupId}`;

const normalizeLocation = (value: string | undefined) =>
  value === undefined || value.length === 0
    ? undefined
    : lastSegment(value).toLowerCase();

const ttlDaysOf = (value: number | string | undefined) =>
  value === undefined ? undefined : String(value);

const toUserDescription = (
  id: string,
  description: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (description !== undefined) return description;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
  });

const toAttrs = (backup: sqladmin.Backup, project: string) => {
  const name = backup.name ?? "";
  return {
    name,
    backupId: lastSegment(name),
    project,
    instance: instanceIdOf(backup.instance ?? ""),
    location: backup.location,
    description: parseDescription(backup.description).description,
    type: backup.type,
    state: backup.state,
    backupKind: backup.backupKind,
    ttlDays: backup.ttlDays,
    expiryTime: backup.expiryTime,
    databaseVersion: backup.databaseVersion,
    backupRun: backup.backupRun,
    selfLink: backup.selfLink,
    timeZone: backup.timeZone,
    kmsKey: backup.kmsKey,
    maxChargeableBytes: backup.maxChargeableBytes,
    backupInterval: backup.backupInterval,
  };
};

/**
 * Cloud SQL answers `SqlBackupAccessDenied` (403) both for a backup uid that
 * does not exist and for callers without permission. Recover with
 * `onMissing` only once the project's backup list confirms it is gone.
 */
const recoverIfBackupMissing =
  <B>(name: string, onMissing: () => B) =>
  <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(
        (
          error,
        ): error is Extract<E, { readonly _tag: "SqlBackupAccessDenied" }> =>
          error._tag === "SqlBackupAccessDenied",
        (error) =>
          listBackups(name.split("/")[1] ?? "").pipe(
            Effect.flatMap((backups) =>
              backups.some((backup) => backup.name === name)
                ? Effect.fail(error)
                : Effect.succeed(onMissing()),
            ),
          ),
      ),
    );

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : sqladmin.getBackupBackups({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        recoverIfBackupMissing(name, () => undefined),
      );

const listBackups = (project: string) =>
  sqladmin.listBackupsBackups
    .pages({
      parent: `projects/${project}`,
      pageSize: 500,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.backups ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

const findByOwnership = (project: string, labels: Record<string, string>) =>
  listBackups(project).pipe(
    Effect.map((backups) =>
      backups.find((backup) => matchesOwnership(backup.description, labels)),
    ),
  );

const observe = (
  project: string,
  name: string | undefined,
  labels: Record<string, string>,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    return yield* findByOwnership(project, labels);
  });

const waitForOperation = (
  project: string,
  operation: sqladmin.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForSqlOperation(project, operation, {
    budget: "20 minutes",
    notFoundOk: options?.notFoundOk,
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup
        ? Effect.succeed(backup)
        : Effect.fail(new BackupNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.BackupNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const isBusy = (state: string | undefined) =>
  state === "ENQUEUED" ||
  state === "RUNNING" ||
  state === "SQL_BACKUP_STATE_UNSPECIFIED" ||
  state === undefined;

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (backup): backup is sqladmin.Backup => backup !== undefined,
      () => new BackupNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (backup) => !isBusy(backup.state),
      (backup) =>
        new BackupNotReady({
          name,
          state: backup.state,
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.SQL.BackupNotReady" ||
        error._tag === "GCP.SQL.BackupNotResolved",
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
      while: (error) => error._tag === "GCP.SQL.BackupStillExists",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const nameFromOperation = (project: string, operation: sqladmin.Operation) => {
  const fromContext = operation.backupContext?.name;
  if (fromContext !== undefined && fromContext.length > 0) return fromContext;
  const backupId = operation.backupContext?.backupId;
  if (backupId !== undefined && backupId.length > 0) {
    return backupNameOf(project, backupId);
  }
  return undefined;
};

export const BackupProvider = () =>
  Provider.succeed(Backup, {
    stables: [
      "name",
      "backupId",
      "project",
      "instance",
      "selfLink",
      "backupRun",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousInstance = olds?.instance ?? output?.instance;
      const nextInstance = news.instance;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const instanceChanged =
        previousInstance !== undefined &&
        instanceIdOf(previousInstance) !== instanceIdOf(nextInstance);
      const locationChanged =
        news.location !== undefined &&
        previousLocation !== undefined &&
        nextLocation !== undefined &&
        previousLocation !== nextLocation;
      if (!instanceChanged && !locationChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: false,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* createInternalLabels(id);
      const name =
        output?.name ??
        (olds?.backupId || output?.backupId
          ? backupNameOf(env.project, olds?.backupId ?? output!.backupId)
          : undefined);
      const existing = yield* observe(env.project, name, ownership);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const backups = yield* listBackups(env.project);
        return backups
          .filter((backup) => hasOwnershipMarker(backup.description))
          .map((backup) => toAttrs(backup, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = instanceIdOf(news.instance);
      const ownership = yield* createInternalLabels(id);
      const userDescription = yield* toUserDescription(
        id,
        news.description,
        output?.description,
      );
      const desiredDescription = encodeDescription(ownership, userDescription);
      const name =
        output?.name ??
        (news.backupId ? backupNameOf(env.project, news.backupId) : undefined);

      let current = yield* observe(env.project, name, ownership);

      if (current === undefined) {
        const created = yield* sqladmin
          .createBackupBackups({
            parent: `projects/${env.project}`,
            body: {
              instance,
              description: desiredDescription,
              location: news.location,
              ttlDays: ttlDaysOf(news.ttlDays),
            },
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              findByOwnership(env.project, ownership).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.succeed(undefined) : Effect.fail(error),
                ),
              ),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );

        if (created !== undefined) {
          const done = yield* waitForOperation(env.project, created);
          const createdName =
            nameFromOperation(env.project, done) ??
            nameFromOperation(env.project, created);
          if (createdName !== undefined) {
            current = yield* waitUntilExists(createdName);
          }
        }
        if (current === undefined) {
          current = yield* findByOwnership(env.project, ownership).pipe(
            Effect.flatMap((existing) =>
              existing
                ? Effect.succeed(existing)
                : Effect.fail(
                    new BackupNotResolved({
                      name:
                        name ??
                        `projects/${env.project}/backups/${ownership[alchemyLabelKeys.id]}`,
                    }),
                  ),
            ),
            Effect.retry({
              while: (error) => error._tag === "GCP.SQL.BackupNotResolved",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        }
      }

      const currentName = current.name ?? "";
      if (currentName.length === 0) {
        return yield* new BackupNotResolved({ name: currentName });
      }

      if (isBusy(current.state)) {
        current = yield* waitUntilReady(currentName);
      }

      const isFinal = (current.type ?? "").toUpperCase() === "FINAL";
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const expiryChanged =
        news.expiryTime !== undefined &&
        (current.expiryTime ?? "") !== news.expiryTime;

      if (isFinal && (descriptionChanged || expiryChanged)) {
        const patched = yield* sqladmin.updateBackupBackups({
          name: currentName,
          updateMask: [
            descriptionChanged ? "description" : undefined,
            expiryChanged ? "expiryTime" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            description: desiredDescription,
            expiryTime: news.expiryTime,
          },
        });
        yield* waitForOperation(env.project, patched);
        current = yield* waitUntilExists(currentName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name.length === 0) return;
      yield* sqladmin.deleteBackupBackups({ name }).pipe(
        Effect.flatMap((operation) =>
          waitForOperation(output.project, operation, { notFoundOk: true }),
        ),
        Effect.catchTag("NotFound", () => Effect.void),
        recoverIfBackupMissing(name, () => undefined),
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("5 seconds"),
        }),
      );
      yield* waitUntilGone(name);
    }),
  });
