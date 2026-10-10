import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
  fieldMask,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_DAILY = 2;
const DEFAULT_WEEKLY = 1;
const DEFAULT_MONTHLY = 1;

export type BackupPolicyProps = {
  /**
   * Backup policy id (the `{backupPolicy}` segment of
   * `projects/{project}/locations/{location}/backupPolicies/{backupPolicy}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the policy.
   */
  backupPolicyId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Number of daily backups to keep. Minimum is 2.
   * @default 2
   */
  dailyBackupLimit?: number;
  /**
   * Number of weekly backups to keep.
   * @default 1
   */
  weeklyBackupLimit?: number;
  /**
   * Number of monthly backups to keep.
   * @default 1
   */
  monthlyBackupLimit?: number;
  /**
   * Whether scheduled backups are enabled for attached volumes.
   * @default true
   */
  enabled?: boolean;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackupPolicy = Resource<
  "GCP.NetApp.BackupPolicy",
  BackupPolicyProps,
  {
    /** Full resource name. */
    name: string;
    /** Backup policy id (last path segment). */
    backupPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Daily backup retention count. */
    dailyBackupLimit: number | undefined;
    /** Weekly backup retention count. */
    weeklyBackupLimit: number | undefined;
    /** Monthly backup retention count. */
    monthlyBackupLimit: number | undefined;
    /** Whether scheduled backups are enabled. */
    enabled: boolean | undefined;
    /** Number of volumes using this policy. */
    assignedVolumeCount: number | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes backup policy that schedules daily, weekly, and
 * monthly volume backups.
 *
 * Changing `backupPolicyId` or `location` replaces the policy. Retention
 * limits, `enabled`, description, and labels update in place.
 *
 * ### Creating a Backup Policy
 * **Example:** Generated name
 * ```typescript
 * const policy = yield* GCP.NetApp.BackupPolicy("Nightly", {});
 * ```
 *
 * **Example:** Explicit id and limits
 * ```typescript
 * const policy = yield* GCP.NetApp.BackupPolicy("Nightly", {
 *   backupPolicyId: "app-nightly",
 *   dailyBackupLimit: 2,
 *   weeklyBackupLimit: 1,
 *   monthlyBackupLimit: 1,
 *   description: "nightly backups",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup Policy
 * **Example:** Description and labels
 * ```typescript
 * const policy = yield* GCP.NetApp.BackupPolicy("Nightly", {
 *   description: "nightly backups v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const BackupPolicy = Resource<BackupPolicy>("GCP.NetApp.BackupPolicy");

const resourceName = (
  project: string,
  location: string,
  backupPolicyId: string,
) =>
  `projects/${project}/locations/${location}/backupPolicies/${backupPolicyId}`;

const toAttrs = (
  policy: netapp.BackupPolicy,
  project: string,
  region: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseName(name, "backupPolicies", region);
  return {
    name,
    backupPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    dailyBackupLimit: policy.dailyBackupLimit,
    weeklyBackupLimit: policy.weeklyBackupLimit,
    monthlyBackupLimit: policy.monthlyBackupLimit,
    enabled: policy.enabled,
    assignedVolumeCount: policy.assignedVolumeCount,
    description: policy.description,
    labels: userLabels(policy.labels),
    state: policy.state,
    createTime: policy.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsBackupPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    netapp.listProjectsLocationsBackupPolicies
      .pages({ parent, pageSize: 1000 })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.backupPolicies ?? []),
        ),
        Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      ),
  );

export const BackupPolicyProvider = () =>
  Provider.succeed(BackupPolicy, {
    stables: ["name", "backupPolicyId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.backupPolicyId ?? output?.backupPolicyId,
        nextId:
          news.backupPolicyId ?? olds?.backupPolicyId ?? output?.backupPolicyId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupPolicyId = yield* toPhysicalId(
        id,
        olds?.backupPolicyId,
        output?.backupPolicyId,
        "backuppolicy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, backupPolicyId);
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
      const backupPolicyId = yield* toPhysicalId(
        id,
        news.backupPolicyId,
        output?.backupPolicyId,
        "backuppolicy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, backupPolicyId);
      const dailyBackupLimit = news.dailyBackupLimit ?? DEFAULT_DAILY;
      const weeklyBackupLimit = news.weeklyBackupLimit ?? DEFAULT_WEEKLY;
      const monthlyBackupLimit = news.monthlyBackupLimit ?? DEFAULT_MONTHLY;
      const enabled = news.enabled ?? true;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsBackupPolicies({
            parent: parentOf(env.project, location),
            backupPolicyId,
            body: {
              dailyBackupLimit,
              weeklyBackupLimit,
              monthlyBackupLimit,
              enabled,
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
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const dailyChanged =
        (current.dailyBackupLimit ?? DEFAULT_DAILY) !== dailyBackupLimit;
      const weeklyChanged =
        (current.weeklyBackupLimit ?? DEFAULT_WEEKLY) !== weeklyBackupLimit;
      const monthlyChanged =
        (current.monthlyBackupLimit ?? DEFAULT_MONTHLY) !== monthlyBackupLimit;
      const enabledChanged = (current.enabled ?? true) !== enabled;
      const mask = fieldMask([
        labelsChanged && "labels",
        descriptionChanged && "description",
        dailyChanged && "dailyBackupLimit",
        weeklyChanged && "weeklyBackupLimit",
        monthlyChanged && "monthlyBackupLimit",
        enabledChanged && "enabled",
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsBackupPolicies({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
            dailyBackupLimit,
            weeklyBackupLimit,
            monthlyBackupLimit,
            enabled,
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
      const operation = yield* netapp
        .deleteProjectsLocationsBackupPolicies({ name: output.name })
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
