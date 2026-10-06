import * as gkebackup from "@distilled.cloud/gcp/gkebackup_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  clusterName,
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
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type RetentionPolicy = {
  /**
   * Default maximum age of a Backup created via this plan, in days
   * (`0`–`365`). `0` disables automatic deletion.
   */
  backupRetainDays?: number;
  /**
   * When true, the retention policy cannot be updated further.
   */
  locked?: boolean;
  /**
   * Minimum age before a Backup can be deleted, in days (`0`–`90`).
   */
  backupDeleteLockDays?: number;
};

export type TimeOfDay = {
  /** Hours of day in 24-hour format (`0`–`23`). */
  hours?: number;
  /** Minutes of hour (`0`–`59`). */
  minutes?: number;
  /** Seconds of minute (`0`–`59`). */
  seconds?: number;
  /** Fractional seconds, in nanoseconds. */
  nanos?: number;
};

export type CalendarDate = {
  /** Year (`1`–`9999`), or `0` to omit. */
  year?: number;
  /** Month (`1`–`12`), or `0` to omit. */
  month?: number;
  /** Day (`1`–`31`), or `0` to omit. */
  day?: number;
};

export type DayOfWeekList = {
  /** Days of week in UTC. */
  daysOfWeek?: Array<gkebackup.DayOfWeekListDaysOfWeekItemEnum | (string & {})>;
};

export type ExclusionWindow = {
  /** Weekly recurrence days in UTC. */
  daysOfWeek?: DayOfWeekList;
  /** Start time of the window in UTC. */
  startTime?: TimeOfDay;
  /** When true, the window recurs every day. */
  daily?: boolean;
  /** Window duration (at least 5 minutes). */
  duration?: string;
  /** Single-occurrence date in UTC (no recurrence). */
  singleOccurrenceDate?: CalendarDate;
};

export type RpoConfig = {
  /**
   * Target RPO in minutes (`60`–`86400`).
   */
  targetRpoMinutes?: number;
  /**
   * Windows during which backups must not run.
   */
  exclusionWindows?: ExclusionWindow[];
};

export type BackupSchedule = {
  /**
   * When true, automatic Backup creation is paused.
   */
  paused?: boolean;
  /**
   * Cron schedule for creating Backups. Mutually exclusive with
   * `rpoConfig`.
   */
  cronSchedule?: string;
  /**
   * RPO schedule. Mutually exclusive with `cronSchedule`.
   */
  rpoConfig?: RpoConfig;
};

export type NamespacedName = {
  /** Kubernetes namespace. */
  namespace?: string;
  /** Kubernetes resource name. */
  name?: string;
};

export type EncryptionKey = {
  /**
   * Cloud KMS key used to encrypt config backup artifacts.
   * Format: `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  gcpKmsEncryptionKey?: string;
};

export type ResourceLabels = {
  /** Kubernetes label-value pairs. */
  resourceLabels?: Array<{
    /** Label key. */
    key?: string;
    /** Label value. */
    value?: string;
  }>;
};

export type BackupConfig = {
  /** When true, include all namespaced resources. */
  allNamespaces?: boolean;
  /** Include namespaces matching these Kubernetes labels. */
  selectedNamespaceLabels?: ResourceLabels;
  /**
   * Whether Kubernetes Secret resources are included.
   * @default false
   */
  includeSecrets?: boolean;
  /**
   * Whether volume data is backed up when PVCs are in scope.
   * @default false
   */
  includeVolumeData?: boolean;
  /**
   * When false, backups fail on non-standard Kubernetes configuration.
   * @default false
   */
  permissiveMode?: boolean;
  /** Include only resources in these namespaces. */
  selectedNamespaces?: { namespaces?: string[] };
  /** Include only resources referenced by these ProtectedApplications. */
  selectedApplications?: { namespacedNames?: NamespacedName[] };
  /** Customer-managed key that encrypts config backup artifacts. */
  encryptionKey?: EncryptionKey;
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
   * `us-central1`. Must match the source cluster region.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Source GKE cluster. Full name
   * `projects/{project}/locations/{location}/clusters/{cluster}` (or the
   * zonal `zones/{zone}` form) or a cluster id combined with `location`.
   * Immutable — changing it replaces the plan.
   */
  cluster: string;
  /**
   * Retention policy for Backups created via this plan.
   */
  retentionPolicy?: RetentionPolicy;
  /**
   * Schedule for automatic Backup creation.
   */
  backupSchedule?: BackupSchedule;
  /**
   * Configuration of Backups created via this plan.
   */
  backupConfig?: BackupConfig;
  /**
   * When true, the plan is locked and no further Backups are created.
   * @default false
   */
  deactivated?: boolean;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackupPlan = Resource<
  "GCP.GKEBackup.BackupPlan",
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
    /** Source cluster name. */
    cluster: string | undefined;
    /** Cross-project backup channel, if any. */
    backupChannel: string | undefined;
    /** Retention policy. */
    retentionPolicy: RetentionPolicy | undefined;
    /** Automatic backup schedule. */
    backupSchedule: BackupSchedule | undefined;
    /** Backup configuration. */
    backupConfig: BackupConfig | undefined;
    /** Whether the plan is deactivated. */
    deactivated: boolean;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** Human-readable state reason. */
    stateReason: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Last successful Backup completion time. */
    lastSuccessfulBackupTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Backup for GKE backup plan — the configuration and schedule for a
 * line of cluster backups.
 *
 * Changing `backupPlanId`, `location`, or `cluster` replaces the plan.
 * Description, labels, retention, schedule, backup config, and
 * `deactivated` update in place.
 *
 * ### Creating a Backup Plan
 * **Example:** Generated name
 * ```typescript
 * const plan = yield* GCP.GKEBackup.BackupPlan("Nightly", {
 *   cluster: cluster.name,
 *   backupConfig: { allNamespaces: true },
 * });
 * ```
 *
 * **Example:** Cron schedule and retention
 * ```typescript
 * const plan = yield* GCP.GKEBackup.BackupPlan("Nightly", {
 *   cluster: cluster.name,
 *   backupSchedule: { cronSchedule: "0 2 * * *" },
 *   retentionPolicy: { backupRetainDays: 14, backupDeleteLockDays: 1 },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup Plan
 * **Example:** Description and labels
 * ```typescript
 * const plan = yield* GCP.GKEBackup.BackupPlan("Nightly", {
 *   cluster: cluster.name,
 *   description: "nightly backups v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category GKEBackup
 */
export const BackupPlan = Resource<BackupPlan>("GCP.GKEBackup.BackupPlan");

const resourceName = (
  project: string,
  location: string,
  backupPlanId: string,
) => `projects/${project}/locations/${location}/backupPlans/${backupPlanId}`;

const toRetention = (
  policy: gkebackup.RetentionPolicy | undefined,
): RetentionPolicy | undefined =>
  policy === undefined
    ? undefined
    : {
        backupRetainDays: policy.backupRetainDays,
        locked: policy.locked,
        backupDeleteLockDays: policy.backupDeleteLockDays,
      };

const toSchedule = (
  schedule: gkebackup.Schedule | undefined,
): BackupSchedule | undefined =>
  schedule === undefined
    ? undefined
    : {
        paused: schedule.paused,
        cronSchedule: schedule.cronSchedule,
        rpoConfig: schedule.rpoConfig,
      };

const toBackupConfig = (
  config: gkebackup.BackupConfig | undefined,
): BackupConfig | undefined =>
  config === undefined
    ? undefined
    : {
        allNamespaces: config.allNamespaces,
        selectedNamespaceLabels: config.selectedNamespaceLabels,
        includeSecrets: config.includeSecrets,
        includeVolumeData: config.includeVolumeData,
        permissiveMode: config.permissiveMode,
        selectedNamespaces: config.selectedNamespaces,
        selectedApplications: config.selectedApplications,
        encryptionKey: config.encryptionKey,
      };

const desiredSchedule = (schedule: BackupSchedule | undefined) =>
  schedule === undefined
    ? undefined
    : {
        paused: schedule.paused,
        cronSchedule: schedule.cronSchedule,
        rpoConfig: schedule.rpoConfig,
      };

const toAttrs = (
  item: gkebackup.BackupPlan,
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
    cluster: item.cluster,
    backupChannel: item.backupChannel,
    retentionPolicy: toRetention(item.retentionPolicy),
    backupSchedule: toSchedule(item.backupSchedule),
    backupConfig: toBackupConfig(item.backupConfig),
    deactivated: item.deactivated === true,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateReason: item.stateReason,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    lastSuccessfulBackupTime: item.lastSuccessfulBackupTime,
  };
};

const getByName = (name: string) =>
  gkebackup
    .getProjectsLocationsBackupPlans({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      gkebackup.listProjectsLocationsBackupPlans.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backupPlans,
      (item) => item.labels,
    ),
  );

export const BackupPlanProvider = () =>
  Provider.succeed(BackupPlan, {
    stables: [
      "name",
      "backupPlanId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousCluster = olds?.cluster ?? output?.cluster;
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
          previousCluster !== undefined &&
          news.cluster !== undefined &&
          previousCluster !== news.cluster &&
          !previousCluster.endsWith(`/${news.cluster}`),
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
        const items = yield* listOwned(env.project);
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
      const cluster = clusterName(news.cluster, env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkebackup
          .createProjectsLocationsBackupPlans({
            parent: parentOf(env.project, location),
            backupPlanId,
            body: {
              cluster,
              retentionPolicy: news.retentionPolicy,
              backupSchedule: news.backupSchedule,
              backupConfig: news.backupConfig,
              deactivated: news.deactivated,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
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
        (item) => item.stateReason,
      );
      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.description, news.description) && "description",
        fingerprint(toRetention(current.retentionPolicy)) !==
          fingerprint(news.retentionPolicy) && "retentionPolicy",
        fingerprint(desiredSchedule(toSchedule(current.backupSchedule))) !==
          fingerprint(desiredSchedule(news.backupSchedule)) && "backupSchedule",
        fingerprint(toBackupConfig(current.backupConfig)) !==
          fingerprint(news.backupConfig) && "backupConfig",
        (current.deactivated === true) !== (news.deactivated === true) &&
          "deactivated",
      ]);

      if (mask.length > 0) {
        const operation = yield* gkebackup.patchProjectsLocationsBackupPlans({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            etag: current.etag,
            labels: desiredLabels,
            description: news.description,
            retentionPolicy: news.retentionPolicy,
            backupSchedule: news.backupSchedule,
            backupConfig: news.backupConfig,
            deactivated: news.deactivated,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateReason,
        );
        if (current === undefined) {
          return yield* new ResourceNotResolved({ name });
        }
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* gkebackup
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
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
