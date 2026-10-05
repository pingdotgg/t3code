import * as backupdr from "@distilled.cloud/gcp/backupdr_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  backupVaultOf,
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type BackupWindow = {
  /**
   * Hour of day (`0`–`23`) when the window starts.
   */
  startHourOfDay?: number;
  /**
   * Hour of day (`1`–`24`) when the window ends. Must be greater than
   * `startHourOfDay`. The end hour is exclusive.
   */
  endHourOfDay?: number;
};

export type WeekDayOfMonth = {
  /**
   * Day of week.
   */
  dayOfWeek?: backupdr.WeekDayOfMonthDayOfWeekEnum | (string & {});
  /**
   * Week of month (`FIRST`, `SECOND`, `THIRD`, `FOURTH`, `LAST`).
   */
  weekOfMonth?: backupdr.WeekDayOfMonthWeekOfMonthEnum | (string & {});
};

export type StandardSchedule = {
  /**
   * Recurrence (`HOURLY`, `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`).
   */
  recurrenceType?: backupdr.StandardScheduleRecurrenceTypeEnum | (string & {});
  /**
   * Days of month (`1`–`31`). `MONTHLY` and `YEARLY` only.
   */
  daysOfMonth?: number[];
  /**
   * Hourly frequency. Required for `HOURLY`. Workload-specific min/max
   * apply (Compute Instance: 4–23).
   */
  hourlyFrequency?: number;
  /**
   * Days of week. Required for `WEEKLY`.
   */
  daysOfWeek?: Array<
    backupdr.StandardScheduleDaysOfWeekItemEnum | (string & {})
  >;
  /**
   * IANA time zone used to interpret the schedule (`UTC`, `America/New_York`).
   */
  timeZone?: string;
  /**
   * Week day of the month. `MONTHLY` and `YEARLY` only.
   */
  weekDayOfMonth?: WeekDayOfMonth;
  /**
   * Months of year. `YEARLY` only.
   */
  months?: Array<backupdr.StandardScheduleMonthsItemEnum | (string & {})>;
  /**
   * Window of day during which backup jobs may start.
   */
  backupWindow?: BackupWindow;
};

export type BackupRule = {
  /**
   * Unique id of this rule within the plan. RFC1035: lowercase letter
   * followed by up to 62 letters, digits, or hyphens. Immutable.
   */
  ruleId?: string;
  /**
   * Retention in days. Must be at least the vault's minimum enforced
   * retention. Minimum 1.
   */
  backupRetentionDays?: number;
  /**
   * Schedule that runs inside a backup window.
   */
  standardSchedule?: StandardSchedule;
};

export type DiskBackupPlanProperties = {
  /**
   * Whether to guest-flush before a disk backup. `false` produces a
   * crash-consistent backup.
   * @default false
   */
  guestFlush?: boolean;
};

export type ComputeInstanceBackupPlanProperties = {
  /**
   * Whether to guest-flush before a compute backup. `false` produces a
   * crash-consistent backup.
   * @default false
   */
  guestFlush?: boolean;
};

export type BackupPlanProps = {
  /**
   * Backup plan id (the `{backupPlan}` segment of
   * `projects/{project}/locations/{location}/backupPlans/{backupPlan}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the plan.
   */
  backupPlanId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the plan. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Backup vault that stores backups created by this plan. Full name
   * `projects/{project}/locations/{location}/backupVaults/{backupvault}`
   * or a vault id combined with `location`. Immutable — changing it
   * replaces the plan.
   */
  backupVault: string;
  /**
   * Resource type the plan applies to, e.g. `compute.googleapis.com/Instance`,
   * `compute.googleapis.com/Disk`, `sqladmin.googleapis.com/Instance`,
   * `alloydb.googleapis.com/Cluster`, `file.googleapis.com/Instance`.
   * Immutable — changing it replaces the plan.
   */
  resourceType: string;
  /**
   * Backup rules (schedule + retention). At least one rule is required
   * in practice.
   */
  backupRules?: BackupRule[];
  /**
   * Cloud SQL only. Log retention in days. Must be at least the vault's
   * minimum log retention.
   */
  logRetentionDays?: string;
  /**
   * Maximum days an on-demand backup with custom retention may be kept.
   */
  maxCustomOnDemandRetentionDays?: number;
  /**
   * Disk-specific options (`compute.googleapis.com/Disk`).
   */
  diskBackupPlanProperties?: DiskBackupPlanProperties;
  /**
   * Compute instance-specific options (`compute.googleapis.com/Instance`).
   */
  computeInstanceBackupPlanProperties?: ComputeInstanceBackupPlanProperties;
  /**
   * Human-readable description (2048 characters or less).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackupPlan = Resource<
  "GCP.BackupDR.BackupPlan",
  BackupPlanProps,
  {
    /** Full resource name. */
    name: string;
    /** Backup plan id (last path segment). */
    backupPlanId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Backup vault name. */
    backupVault: string | undefined;
    /** Backup vault service account. */
    backupVaultServiceAccount: string | undefined;
    /** Resource type this plan applies to. */
    resourceType: string | undefined;
    /** Resource types this plan can be applied to. */
    supportedResourceTypes: string[];
    /** Backup rules. */
    backupRules: BackupRule[];
    /** Cloud SQL log retention days. */
    logRetentionDays: string | undefined;
    /** Max custom on-demand retention days. */
    maxCustomOnDemandRetentionDays: number | undefined;
    /** Disk-specific options. */
    diskBackupPlanProperties: DiskBackupPlanProperties | undefined;
    /** Compute instance-specific options. */
    computeInstanceBackupPlanProperties:
      | ComputeInstanceBackupPlanProperties
      | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** Revision resource name. */
    revisionName: string | undefined;
    /** User-friendly revision id (`v0`, `v1`, …). */
    revisionId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Backup and DR backup plan — schedule and retention for a workload
 * type, stored in a Backup Vault.
 *
 * Changing `backupPlanId`, `location`, `backupVault`, `resourceType`, or
 * `labels` replaces the plan. Description, rules, log retention, and
 * workload properties update in place.
 *
 * ### Creating a Backup Plan
 * **Example:** Daily compute backups
 * ```typescript
 * const backupRules = [
 *   {
 *     ruleId: "daily",
 *     backupRetentionDays: 7,
 *     standardSchedule: {
 *       recurrenceType: "DAILY",
 *       timeZone: "UTC",
 *       backupWindow: { startHourOfDay: 1, endHourOfDay: 5 },
 *     },
 *   },
 * ];
 * const plan = yield* GCP.BackupDR.BackupPlan("Nightly", {
 *   backupVault: vault.name,
 *   resourceType: "compute.googleapis.com/Instance",
 *   backupRules,
 * });
 * ```
 *
 * ### Updating a Backup Plan
 * **Example:** Description and labels
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const plan = yield* GCP.BackupDR.BackupPlan("Nightly", {
 *   backupVault: vault.name,
 *   resourceType: "compute.googleapis.com/Instance",
 *   description: "nightly backups v2",
 *   labels: { env: "prod" },
 *   backupRules,
 * });
 * ```
 *
 * @resource
 * @category BackupDR
 */
export const BackupPlan = Resource<BackupPlan>("GCP.BackupDR.BackupPlan");

const resourceName = (
  project: string,
  location: string,
  backupPlanId: string,
) => `projects/${project}/locations/${location}/backupPlans/${backupPlanId}`;

const toRule = (rule: backupdr.BackupRule | BackupRule): BackupRule => ({
  ruleId: rule.ruleId,
  backupRetentionDays: rule.backupRetentionDays,
  standardSchedule: rule.standardSchedule,
});

const toRules = (
  rules: readonly (backupdr.BackupRule | BackupRule)[] | undefined,
): BackupRule[] => (rules ?? []).map(toRule);

const toAttrs = (
  item: backupdr.BackupPlan,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backupPlans", region);
  return {
    name,
    backupPlanId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    backupVault: item.backupVault,
    backupVaultServiceAccount: item.backupVaultServiceAccount,
    resourceType: item.resourceType,
    supportedResourceTypes: item.supportedResourceTypes ?? [],
    backupRules: toRules(item.backupRules),
    logRetentionDays: item.logRetentionDays,
    maxCustomOnDemandRetentionDays: item.maxCustomOnDemandRetentionDays,
    diskBackupPlanProperties: item.diskBackupPlanProperties,
    computeInstanceBackupPlanProperties:
      item.computeInstanceBackupPlanProperties,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    revisionName: item.revisionName,
    revisionId: item.revisionId,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  backupdr
    .getProjectsLocationsBackupPlans({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      backupdr.listProjectsLocationsBackupPlans.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backupPlans,
      (item) => item.labels,
    ),
  );

export const BackupPlanProvider = () =>
  Provider.succeed(BackupPlan, {
    stables: ["name", "backupPlanId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousVault = olds?.backupVault ?? output?.backupVault;
      const previousType = olds?.resourceType ?? output?.resourceType;
      return replaceOnIdentity({
        previousId: olds?.backupPlanId ?? output?.backupPlanId,
        nextId: news.backupPlanId ?? olds?.backupPlanId ?? output?.backupPlanId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousType !== undefined &&
            news.resourceType !== undefined &&
            previousType !== news.resourceType) ||
          (previousVault !== undefined &&
            news.backupVault !== undefined &&
            previousVault !== news.backupVault &&
            !previousVault.endsWith(`/${news.backupVault}`)) ||
          // Backup plan labels are immutable ("labels can not be updated").
          (olds !== undefined &&
            fingerprint(olds.labels ?? {}) !== fingerprint(news.labels ?? {})),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupPlanId = yield* toPhysicalId(
        id,
        olds?.backupPlanId,
        output?.backupPlanId,
        "backupplan",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, backupPlanId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const backupPlanId = yield* toPhysicalId(
        id,
        news.backupPlanId,
        output?.backupPlanId,
        "backupplan",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, backupPlanId);
      const backupVault = backupVaultOf(
        news.backupVault,
        env.project,
        location,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* backupdr
          .createProjectsLocationsBackupPlans({
            parent: parentOf(env.project, location),
            backupPlanId,
            body: {
              backupVault,
              resourceType: news.resourceType,
              backupRules: news.backupRules,
              logRetentionDays: news.logRetentionDays,
              maxCustomOnDemandRetentionDays:
                news.maxCustomOnDemandRetentionDays,
              diskBackupPlanProperties: news.diskBackupPlanProperties,
              computeInstanceBackupPlanProperties:
                news.computeInstanceBackupPlanProperties,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const mask = fieldMask([
        !sameText(current.description, news.description) && "description",
        fingerprint(toRules(current.backupRules)) !==
          fingerprint(toRules(news.backupRules)) && "backupRules",
        news.logRetentionDays !== undefined &&
          !sameText(current.logRetentionDays, news.logRetentionDays) &&
          "logRetentionDays",
        news.maxCustomOnDemandRetentionDays !== undefined &&
          current.maxCustomOnDemandRetentionDays !==
            news.maxCustomOnDemandRetentionDays &&
          "maxCustomOnDemandRetentionDays",
        news.diskBackupPlanProperties !== undefined &&
          fingerprint(current.diskBackupPlanProperties) !==
            fingerprint(news.diskBackupPlanProperties) &&
          "diskBackupPlanProperties",
        news.computeInstanceBackupPlanProperties !== undefined &&
          fingerprint(current.computeInstanceBackupPlanProperties) !==
            fingerprint(news.computeInstanceBackupPlanProperties) &&
          "computeInstanceBackupPlanProperties",
      ]);

      if (mask.length > 0) {
        const operation = yield* backupdr.patchProjectsLocationsBackupPlans({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            etag: current.etag,
            description: news.description,
            backupRules: news.backupRules,
            logRetentionDays: news.logRetentionDays,
            maxCustomOnDemandRetentionDays: news.maxCustomOnDemandRetentionDays,
            diskBackupPlanProperties: news.diskBackupPlanProperties,
            computeInstanceBackupPlanProperties:
              news.computeInstanceBackupPlanProperties,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* backupdr
        .deleteProjectsLocationsBackupPlans({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
