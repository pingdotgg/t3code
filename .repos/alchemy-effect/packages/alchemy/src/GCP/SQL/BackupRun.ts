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
import { recoverIfInstanceMissing, waitForSqlOperation } from "./operations.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  instanceIdOf,
  lastSegment,
  matchesOwnership,
  parseDescription,
} from "./ownership.ts";

export type BackupRunProps = {
  /**
   * Cloud SQL instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). Full resource names are
   * accepted and reduced to the last path segment. Immutable — changing
   * it replaces the backup run.
   */
  instance: string;
  /**
   * Storage location of the backup (`us`, `us-central1`, …). If omitted,
   * Cloud SQL picks the closest multi-region. Immutable — changing it
   * replaces the backup run.
   */
  location?: string;
  /**
   * Human-readable description. Cloud SQL backup runs have no labels
   * field and no update API, so Alchemy stamps ownership into the
   * description at create and cannot change it in place.
   */
  description?: string;
  /**
   * Existing backup-run id used to observe a run when state is missing.
   * The insert API assigns ids — this is not sent on insert.
   */
  backupRunId?: string;
};

export type BackupRun = Resource<
  "GCP.SQL.BackupRun",
  BackupRunProps,
  {
    /** Backup-run id unique to the instance. */
    backupRunId: string;
    /** Cloud SQL instance id. */
    instance: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Run type (`ON_DEMAND`, `AUTOMATED`). */
    type: string | undefined;
    /** Server-reported status (`ENQUEUED`, `RUNNING`, `SUCCESSFUL`, …). */
    status: string | undefined;
    /** Storage location. */
    location: string | undefined;
    /** SQL Admin self-link. */
    selfLink: string | undefined;
    /** RFC3339 enqueue time. */
    enqueuedTime: string | undefined;
    /** RFC3339 start time. */
    startTime: string | undefined;
    /** RFC3339 end time. */
    endTime: string | undefined;
    /** RFC3339 backup-window start. */
    windowStartTime: string | undefined;
    /** Database version at backup time. */
    databaseVersion: string | undefined;
    /** Kind of backup (`SNAPSHOT`, `PHYSICAL`). */
    backupKind: string | undefined;
    /** Backup time zone (SQL Server). */
    timeZone: string | undefined;
    /** Maximum chargeable bytes. */
    maxChargeableBytes: string | undefined;
  },
  never,
  Providers
>;

/**
 * An on-demand Cloud SQL backup run
 * (`projects/{project}/instances/{instance}/backupRuns/{id}`).
 *
 * Insert assigns the run id. Alchemy stamps ownership into `description`
 * so `list` / `pnpm nuke:gcp` can find leaked rows. Changing `instance`
 * or `location` replaces the run. Description is create-only — backup
 * runs have no update API.
 *
 * ### Creating a Backup Run
 * **Example:** On-demand backup of a Cloud SQL instance
 * ```typescript
 * const instance = yield* GCP.SQL.Instance("AppDb", {
 *   tier: "db-f1-micro",
 *   backupEnabled: true,
 * });
 * const backup = yield* GCP.SQL.BackupRun("Nightly", {
 *   instance: instance.instanceName,
 * });
 * ```
 *
 * **Example:** Description and location
 * ```typescript
 * const backup = yield* GCP.SQL.BackupRun("Nightly", {
 *   instance: instance.instanceName,
 *   location: "us",
 *   description: "pre-release",
 * });
 * ```
 *
 * @resource
 * @category SQL
 */
export const BackupRun = Resource<BackupRun>("GCP.SQL.BackupRun");

export class BackupRunNotResolved extends Data.TaggedError(
  "GCP.SQL.BackupRunNotResolved",
)<{
  instance: string;
  backupRunId: string;
}> {}

export class BackupRunNotReady extends Data.TaggedError(
  "GCP.SQL.BackupRunNotReady",
)<{
  instance: string;
  backupRunId: string;
  status: string | undefined;
}> {}

export class BackupRunStillExists extends Data.TaggedError(
  "GCP.SQL.BackupRunStillExists",
)<{
  instance: string;
  backupRunId: string;
}> {}

const normalizeLocation = (value: string | undefined) =>
  value === undefined || value.length === 0
    ? undefined
    : lastSegment(value).toLowerCase();

const idOf = (value: string | number | undefined) =>
  value === undefined ? "" : String(value);

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

const toAttrs = (
  run: sqladmin.BackupRun,
  project: string,
  instance: string,
) => ({
  backupRunId: idOf(run.id),
  instance: instanceIdOf(run.instance ?? instance),
  project,
  description: parseDescription(run.description).description,
  type: run.type,
  status: run.status,
  location: run.location,
  selfLink: run.selfLink,
  enqueuedTime: run.enqueuedTime,
  startTime: run.startTime,
  endTime: run.endTime,
  windowStartTime: run.windowStartTime,
  databaseVersion: run.databaseVersion,
  backupKind: run.backupKind,
  timeZone: run.timeZone,
  maxChargeableBytes: run.maxChargeableBytes,
});

const getById = (project: string, instance: string, backupRunId: string) =>
  backupRunId.length === 0
    ? Effect.succeed(undefined)
    : sqladmin
        .getBackupRuns({
          project,
          instance,
          id: backupRunId,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          recoverIfInstanceMissing(project, instance, () => undefined),
        );

const listRuns = (project: string, instance: string) =>
  sqladmin.listBackupRuns
    .items({
      project,
      instance,
      maxResults: 1000,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as sqladmin.BackupRun[]),
      ),
      recoverIfInstanceMissing(
        project,
        instance,
        () => [] as sqladmin.BackupRun[],
      ),
    );

const findByOwnership = (
  project: string,
  instance: string,
  labels: Record<string, string>,
) =>
  listRuns(project, instance).pipe(
    Effect.map((runs) =>
      runs.find((run) => matchesOwnership(run.description, labels)),
    ),
  );

const observe = (
  project: string,
  instance: string,
  backupRunId: string | undefined,
  labels: Record<string, string>,
) =>
  Effect.gen(function* () {
    if (backupRunId !== undefined && backupRunId.length > 0) {
      const existing = yield* getById(project, instance, backupRunId);
      if (existing !== undefined) return existing;
    }
    return yield* findByOwnership(project, instance, labels);
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

const waitUntilExists = (
  project: string,
  instance: string,
  backupRunId: string,
) =>
  getById(project, instance, backupRunId).pipe(
    Effect.flatMap((run) =>
      run
        ? Effect.succeed(run)
        : Effect.fail(new BackupRunNotResolved({ instance, backupRunId })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.BackupRunNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const isBusy = (status: string | undefined) =>
  status === "ENQUEUED" ||
  status === "OVERDUE" ||
  status === "RUNNING" ||
  status === "SQL_BACKUP_RUN_STATUS_UNSPECIFIED" ||
  status === undefined;

const waitUntilReady = (
  project: string,
  instance: string,
  backupRunId: string,
) =>
  getById(project, instance, backupRunId).pipe(
    Effect.filterOrFail(
      (run): run is sqladmin.BackupRun => run !== undefined,
      () => new BackupRunNotResolved({ instance, backupRunId }),
    ),
    Effect.filterOrFail(
      (run) => !isBusy(run.status),
      (run) =>
        new BackupRunNotReady({
          instance,
          backupRunId,
          status: run.status,
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.SQL.BackupRunNotReady" ||
        error._tag === "GCP.SQL.BackupRunNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const waitUntilGone = (
  project: string,
  instance: string,
  backupRunId: string,
) =>
  getById(project, instance, backupRunId).pipe(
    Effect.flatMap((run) =>
      run === undefined || run.status === "DELETED"
        ? Effect.void
        : Effect.fail(new BackupRunStillExists({ instance, backupRunId })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.BackupRunStillExists",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const idFromOperation = (operation: sqladmin.Operation) =>
  idOf(operation.backupContext?.backupId);

export const BackupRunProvider = () =>
  Provider.succeed(BackupRun, {
    stables: ["backupRunId", "instance", "project", "selfLink"],

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
      const instance = instanceIdOf(olds?.instance ?? output?.instance ?? "");
      if (instance.length === 0) return undefined;
      const ownership = yield* createInternalLabels(id);
      const existing = yield* observe(
        env.project,
        instance,
        olds?.backupRunId ?? output?.backupRunId,
        ownership,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, instance);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const runs = yield* listRuns(env.project, "-");
        return runs
          .filter((run) => hasOwnershipMarker(run.description))
          .map((run) =>
            toAttrs(run, env.project, instanceIdOf(run.instance ?? "")),
          );
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

      let current = yield* observe(
        env.project,
        instance,
        news.backupRunId ?? output?.backupRunId,
        ownership,
      );

      if (current === undefined) {
        const created = yield* sqladmin
          .insertBackupRuns({
            project: env.project,
            instance,
            body: {
              instance,
              description: desiredDescription,
              location: news.location,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              findByOwnership(env.project, instance, ownership).pipe(
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
          const backupRunId = idFromOperation(done) || idFromOperation(created);
          if (backupRunId.length > 0) {
            current = yield* waitUntilExists(
              env.project,
              instance,
              backupRunId,
            );
          }
        }
        if (current === undefined) {
          current = yield* findByOwnership(
            env.project,
            instance,
            ownership,
          ).pipe(
            Effect.flatMap((existing) =>
              existing
                ? Effect.succeed(existing)
                : Effect.fail(
                    new BackupRunNotResolved({
                      instance,
                      backupRunId:
                        output?.backupRunId ??
                        ownership[alchemyLabelKeys.id] ??
                        "",
                    }),
                  ),
            ),
            Effect.retry({
              while: (error) => error._tag === "GCP.SQL.BackupRunNotResolved",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        }
      }

      const backupRunId = idOf(current.id);
      if (backupRunId.length === 0) {
        return yield* new BackupRunNotResolved({
          instance,
          backupRunId,
        });
      }

      if (isBusy(current.status)) {
        current = yield* waitUntilReady(env.project, instance, backupRunId);
      }

      return toAttrs(current, env.project, instance);
    }),

    delete: Effect.fn(function* ({ output }) {
      const project = output.project;
      const instance = instanceIdOf(output.instance);
      const backupRunId = output.backupRunId;
      if (backupRunId.length === 0) return;
      yield* sqladmin
        .deleteBackupRuns({
          project,
          instance,
          id: backupRunId,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForOperation(project, operation, { notFoundOk: true }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          recoverIfInstanceMissing(project, instance, () => undefined),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      yield* waitUntilGone(project, instance, backupRunId);
    }),
  });
