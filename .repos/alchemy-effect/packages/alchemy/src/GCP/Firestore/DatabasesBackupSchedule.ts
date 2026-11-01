import * as firestore from "@distilled.cloud/gcp/firestore_v1";
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
  databaseIdOf,
  databaseNameOf,
  lastSegment,
  parseDatabaseName,
  retryConcurrentChanges,
} from "./internal.ts";

const DEFAULT_RETENTION = "604800s";
export type WeeklyRecurrenceDay =
  | firestore.GoogleFirestoreAdminV1WeeklyRecurrenceDayEnum
  | (string & {});

export type DatabasesBackupScheduleProps = {
  /**
   * Parent database. Full name `projects/{project}/databases/{database}`
   * or the database id. Immutable — changing it replaces the schedule.
   */
  database: string;
  /**
   * How long each backup is retained (e.g. `"604800s"` is 7 days). The
   * maximum supported retention is 14 weeks.
   * @default "604800s"
   */
  retention?: string;
  /**
   * Daily UTC recurrence. Mutually exclusive with `weeklyRecurrence`.
   * Default when neither recurrence is set. Changing daily vs weekly
   * replaces the schedule.
   */
  dailyRecurrence?: boolean;
  /**
   * Weekly UTC recurrence. Mutually exclusive with `dailyRecurrence`.
   * Changing the day or switching from daily replaces the schedule.
   */
  weeklyRecurrence?: {
    /** Day of week (`MONDAY` … `SUNDAY`). */
    day: WeeklyRecurrenceDay;
  };
};

export type DatabasesBackupSchedule = Resource<
  "GCP.Firestore.DatabasesBackupSchedule",
  DatabasesBackupScheduleProps,
  {
    /** Full resource name `.../databases/{database}/backupSchedules/{schedule}`. */
    name: string;
    /** Server-assigned backup schedule id. */
    backupScheduleId: string;
    /** Parent database resource name. */
    database: string;
    /** Parent database id. */
    databaseId: string;
    /** Project id. */
    project: string;
    /** Retention duration. */
    retention: string | undefined;
    /** Whether this schedule runs daily. */
    dailyRecurrence: boolean;
    /** Weekly recurrence day, if any. */
    weeklyRecurrenceDay: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A scheduled backup for a Cloud Firestore database.
 *
 * At most one daily and one weekly schedule can exist per database.
 * The schedule id is assigned by the API. Retention updates in place;
 * switching daily vs weekly or moving to another database replaces the
 * schedule. Backup schedules have no labels field: `read` reports a
 * schedule it finds without prior state as unowned (adopt it with
 * `--adopt`).
 *
 * ### Creating a Backup Schedule
 * **Example:** Daily backups retained for 7 days
 * ```typescript
 * const database = yield* GCP.Firestore.Database("App", {
 *   location: "us-central1",
 * });
 * const schedule = yield* GCP.Firestore.DatabasesBackupSchedule("Nightly", {
 *   database: database.name,
 *   retention: "604800s",
 *   dailyRecurrence: true,
 * });
 * ```
 *
 * **Example:** Weekly backups
 * ```typescript
 * const schedule = yield* GCP.Firestore.DatabasesBackupSchedule("Weekly", {
 *   database: database.name,
 *   retention: "1209600s",
 *   weeklyRecurrence: { day: "SUNDAY" },
 * });
 * ```
 *
 * @resource
 * @category Firestore
 */
export const DatabasesBackupSchedule = Resource<DatabasesBackupSchedule>(
  "GCP.Firestore.DatabasesBackupSchedule",
);

export class BackupScheduleNotResolved extends Data.TaggedError(
  "GCP.Firestore.BackupScheduleNotResolved",
)<{
  name: string;
}> {}

export class BackupScheduleStillExists extends Data.TaggedError(
  "GCP.Firestore.BackupScheduleStillExists",
)<{
  name: string;
}> {}

const desiredWeeklyDay = (
  news: DatabasesBackupScheduleProps,
): string | undefined =>
  news.weeklyRecurrence?.day !== undefined
    ? news.weeklyRecurrence.day.toUpperCase()
    : undefined;

const desiredDaily = (news: DatabasesBackupScheduleProps) =>
  news.weeklyRecurrence === undefined && news.dailyRecurrence !== false;

const toAttrs = (
  schedule: firestore.GoogleFirestoreAdminV1BackupSchedule,
  project: string,
): DatabasesBackupSchedule["Attributes"] => {
  const name = schedule.name ?? "";
  const parsed = parseDatabaseName(name);
  return {
    name,
    backupScheduleId: parsed.backupScheduleId || lastSegment(name),
    database: databaseNameOf(parsed.project || project, parsed.databaseId),
    databaseId: parsed.databaseId,
    project: parsed.project || project,
    retention: schedule.retention,
    dailyRecurrence: schedule.dailyRecurrence !== undefined,
    weeklyRecurrenceDay: schedule.weeklyRecurrence?.day,
    createTime: schedule.createTime,
    updateTime: schedule.updateTime,
  };
};

const getByName = (name: string) =>
  firestore
    .getProjectsDatabasesBackupSchedules({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOnDatabase = (parent: string) =>
  firestore.listProjectsDatabasesBackupSchedules({ parent }).pipe(
    Effect.map((page) => page.backupSchedules ?? []),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as firestore.GoogleFirestoreAdminV1BackupSchedule[]),
    ),
  );

const matchesDesired = (
  schedule: firestore.GoogleFirestoreAdminV1BackupSchedule,
  news: DatabasesBackupScheduleProps,
) => {
  const weeklyDay = desiredWeeklyDay(news);
  if (weeklyDay !== undefined) {
    return schedule.weeklyRecurrence?.day?.toUpperCase() === weeklyDay;
  }
  return schedule.dailyRecurrence !== undefined;
};

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (schedule) => schedule === undefined,
      () => new BackupScheduleStillExists({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Firestore.BackupScheduleStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const DatabasesBackupScheduleProvider = () =>
  Provider.succeed(DatabasesBackupSchedule, {
    stables: [
      "name",
      "backupScheduleId",
      "database",
      "databaseId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousDatabase = databaseIdOf(
        olds?.database ?? output?.database ?? output?.databaseId ?? "",
      );
      const nextDatabase = databaseIdOf(news.database);
      const previousWeekly = (
        olds?.weeklyRecurrence?.day ??
        output?.weeklyRecurrenceDay ??
        ""
      ).toUpperCase();
      const nextWeekly = (news.weeklyRecurrence?.day ?? "").toUpperCase();
      const previousDaily =
        olds?.weeklyRecurrence === undefined &&
        (olds?.dailyRecurrence !== false || output?.dailyRecurrence === true);
      const nextDaily = desiredDaily(news);
      if (
        (previousDatabase.length > 0 && previousDatabase !== nextDatabase) ||
        previousWeekly !== nextWeekly ||
        previousDaily !== nextDaily
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const name = output?.name;
      if (name === undefined || name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = databaseNameOf(env.project, news.database);
      const weeklyDay = desiredWeeklyDay(news);
      const daily = desiredDaily(news);
      const retention = news.retention ?? DEFAULT_RETENTION;
      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;

      if (current === undefined) {
        const existing = yield* listOnDatabase(parent);
        current = existing.find((schedule) => matchesDesired(schedule, news));
      }

      if (current === undefined) {
        const created = yield* firestore
          .createProjectsDatabasesBackupSchedules({
            parent,
            body: {
              retention,
              dailyRecurrence:
                daily && weeklyDay === undefined ? {} : undefined,
              weeklyRecurrence:
                weeklyDay !== undefined ? { day: weeklyDay } : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created?.name !== undefined) {
          current = created;
        } else {
          const listed = yield* listOnDatabase(parent);
          current = listed.find((schedule) => matchesDesired(schedule, news));
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new BackupScheduleNotResolved({
          name: `${parent}/backupSchedules`,
        });
      }

      const name = current.name;
      if ((current.retention ?? "") !== retention) {
        current = yield* retryConcurrentChanges(
          firestore.patchProjectsDatabasesBackupSchedules({
            name,
            updateMask: "retention",
            body: { retention },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* firestore
        .deleteProjectsDatabasesBackupSchedules({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(output.name);
    }),
  });
