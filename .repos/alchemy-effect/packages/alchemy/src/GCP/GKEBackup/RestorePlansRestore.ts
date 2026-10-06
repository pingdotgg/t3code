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
  expandParent,
  fieldMask,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
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
} from "./internal.ts";
import type { GroupKind, RestoreConfig } from "./RestorePlan.ts";

export type ResourceSelector = {
  /** Select resources of this group kind. */
  groupKind?: GroupKind;
  /** Select resources in this namespace. */
  namespace?: string;
  /** Select resources with all of these labels. */
  labels?: Record<string, string>;
  /** Select resources with this name. */
  name?: string;
};

export type RestoreFilter = {
  /** Restore only resources matching any of these selectors. */
  inclusionFilters?: ResourceSelector[];
  /** Exclude resources matching any of these selectors. */
  exclusionFilters?: ResourceSelector[];
};

export type VolumeDataRestorePolicyOverride = {
  /** Policy applied to the selected PVCs. */
  policy?: gkebackup.VolumeDataRestorePolicyOverridePolicyEnum | (string & {});
  /** PVCs this override applies to. */
  selectedPvcs?: {
    namespacedNames?: Array<{
      /** Kubernetes namespace. */
      namespace?: string;
      /** Kubernetes resource name. */
      name?: string;
    }>;
  };
};

export type RestorePlansRestoreProps = {
  /**
   * Parent RestorePlan. Full name
   * `projects/{project}/locations/{location}/restorePlans/{restorePlan}`
   * or the plan id (combined with `location`). Immutable — changing it
   * replaces the restore.
   */
  restorePlan: string;
  /**
   * Region used when `restorePlan` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Restore id (the `{restore}` segment). If omitted, a unique RFC1035
   * name is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the restore.
   */
  restoreId?: string;
  /**
   * Source Backup. Full name
   * `projects/{project}/locations/{location}/backupPlans/{backupPlan}/backups/{backup}`
   * or a backup id under the RestorePlan's BackupPlan. Immutable —
   * changing it replaces the restore.
   */
  backup: string;
  /**
   * Filter that further refines resource selection. Immutable.
   */
  filter?: RestoreFilter;
  /**
   * Per-PVC volume restore policy overrides. Immutable.
   */
  volumeDataRestorePolicyOverrides?: VolumeDataRestorePolicyOverride[];
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type RestorePlansRestore = Resource<
  "GCP.GKEBackup.RestorePlansRestore",
  RestorePlansRestoreProps,
  {
    /** Full resource name. */
    name: string;
    /** Restore id (last path segment). */
    restoreId: string;
    /** Parent RestorePlan name. */
    restorePlan: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Source Backup name. */
    backup: string | undefined;
    /** Target cluster name. */
    cluster: string | undefined;
    /** Restore configuration inherited from the plan. */
    restoreConfig: RestoreConfig | undefined;
    /** Resource filter applied to this Restore. */
    filter: RestoreFilter | undefined;
    /** Volume policy overrides. */
    volumeDataRestorePolicyOverrides:
      | VolumeDataRestorePolicyOverride[]
      | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** Human-readable state reason. */
    stateReason: string | undefined;
    /** Resources restored. */
    resourcesRestoredCount: number | undefined;
    /** Resources that failed to restore. */
    resourcesFailedCount: number | undefined;
    /** Resources excluded. */
    resourcesExcludedCount: number | undefined;
    /** Volumes restored. */
    volumesRestoredCount: number | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 completion timestamp. */
    completeTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Backup for GKE restore — a request to restore a Backup into the
 * target cluster of a RestorePlan.
 *
 * Changing `restoreId`, `restorePlan`, `location`, `backup`, `filter`,
 * or `volumeDataRestorePolicyOverrides` replaces the restore.
 * Description and labels update in place.
 *
 * ### Creating a Restore
 * **Example:** Restore a backup
 * ```typescript
 * const restore = yield* GCP.GKEBackup.RestorePlansRestore("Rollback", {
 *   restorePlan: plan.name,
 *   backup: backup.name,
 * });
 * ```
 *
 * **Example:** Filtered restore
 * ```typescript
 * const restore = yield* GCP.GKEBackup.RestorePlansRestore("Rollback", {
 *   restorePlan: plan.name,
 *   backup: backup.name,
 *   filter: {
 *     inclusionFilters: [{ namespace: "app" }],
 *   },
 *   description: "app-only rollback",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Restore
 * **Example:** Description and labels
 * ```typescript
 * const restore = yield* GCP.GKEBackup.RestorePlansRestore("Rollback", {
 *   restorePlan: plan.name,
 *   backup: backup.name,
 *   description: "app-only rollback v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category GKEBackup
 */
export const RestorePlansRestore = Resource<RestorePlansRestore>(
  "GCP.GKEBackup.RestorePlansRestore",
);

const resourceName = (plan: string, restoreId: string) =>
  `${plan}/restores/${restoreId}`;

const toSelector = (item: gkebackup.ResourceSelector): ResourceSelector => ({
  groupKind: item.groupKind,
  namespace: item.namespace,
  labels:
    item.labels === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(item.labels).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
  name: item.name,
});

const toFilter = (
  filter: gkebackup.Filter | undefined,
): RestoreFilter | undefined =>
  filter === undefined
    ? undefined
    : {
        inclusionFilters: filter.inclusionFilters?.map(toSelector),
        exclusionFilters: filter.exclusionFilters?.map(toSelector),
      };

const toOverrides = (
  overrides: gkebackup.VolumeDataRestorePolicyOverrideList | undefined,
): VolumeDataRestorePolicyOverride[] | undefined =>
  overrides === undefined
    ? undefined
    : overrides.map((item) => ({
        policy: item.policy,
        selectedPvcs: item.selectedPvcs,
      }));

const toRestoreConfig = (
  config: gkebackup.RestoreConfig | undefined,
): RestoreConfig | undefined =>
  config === undefined
    ? undefined
    : {
        namespacedResourceRestoreMode: config.namespacedResourceRestoreMode,
        substitutionRules: config.substitutionRules,
        excludedNamespaces: config.excludedNamespaces,
        volumeDataRestorePolicyBindings: config.volumeDataRestorePolicyBindings,
        allNamespaces: config.allNamespaces,
        transformationRules: config.transformationRules,
        restoreOrder: config.restoreOrder,
        volumeDataRestorePolicy: config.volumeDataRestorePolicy,
        clusterResourceConflictPolicy: config.clusterResourceConflictPolicy,
        clusterResourceRestoreScope: config.clusterResourceRestoreScope,
        selectedNamespaces: config.selectedNamespaces,
        selectedApplications: config.selectedApplications,
        noNamespaces: config.noNamespaces,
      };

const toAttrs = (item: gkebackup.Restore, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "restores", region);
  return {
    name,
    restoreId: parsed.id,
    restorePlan: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    backup: item.backup,
    cluster: item.cluster,
    restoreConfig: toRestoreConfig(item.restoreConfig),
    filter: toFilter(item.filter),
    volumeDataRestorePolicyOverrides: toOverrides(
      item.volumeDataRestorePolicyOverrides,
    ),
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateReason: item.stateReason,
    resourcesRestoredCount: item.resourcesRestoredCount,
    resourcesFailedCount: item.resourcesFailedCount,
    resourcesExcludedCount: item.resourcesExcludedCount,
    volumesRestoredCount: item.volumesRestoredCount,
    uid: item.uid,
    createTime: item.createTime,
    completeTime: item.completeTime,
  };
};

const getByName = (name: string) =>
  gkebackup
    .getProjectsLocationsRestorePlansRestores({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "restorePlans/-", (parent) =>
    listLabeledPages(
      gkebackup.listProjectsLocationsRestorePlansRestores.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.restores,
      (item) => item.labels,
    ),
  );

const expandBackup = (value: string, restorePlan: string) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  const parts = restorePlan.split("/").filter((part) => part.length > 0);
  const restorePlansAt = parts.lastIndexOf("restorePlans");
  const locationParent =
    restorePlansAt > 0 ? parts.slice(0, restorePlansAt).join("/") : restorePlan;
  // Callers that pass a bare backup id must also pass a full backup
  // plan path via restorePlan's backupPlan attribute at create time;
  // without it we cannot guess the BackupPlan id, so treat the value as
  // already relative to the restore plan's location.
  return `${locationParent}/backupPlans/-/backups/${value}`;
};

export const RestorePlansRestoreProvider = () =>
  Provider.succeed(RestorePlansRestore, {
    stables: [
      "name",
      "restoreId",
      "restorePlan",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousBackup = olds?.backup ?? output?.backup;
      return replaceOnIdentity({
        previousId: olds?.restoreId ?? output?.restoreId,
        nextId: news.restoreId ?? olds?.restoreId ?? output?.restoreId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.restorePlan ?? output?.restorePlan,
        nextParent: news.restorePlan,
        extra:
          previousBackup !== undefined &&
          news.backup !== undefined &&
          previousBackup !== news.backup &&
          !previousBackup.endsWith(`/${news.backup}`),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const restoreId = yield* toPhysicalId(
        id,
        olds?.restoreId,
        output?.restoreId,
        "restore",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const plan = expandParent(
        olds?.restorePlan ?? output?.restorePlan ?? "",
        env.project,
        location,
        "restorePlans",
      );
      const name = output?.name ?? resourceName(plan, restoreId);
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
      const restoreId = yield* toPhysicalId(
        id,
        news.restoreId,
        output?.restoreId,
        "restore",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const plan = expandParent(
        news.restorePlan,
        env.project,
        location,
        "restorePlans",
      );
      const name = resourceName(plan, restoreId);
      const backup = news.backup.includes("/")
        ? news.backup.replace(/\/+$/, "")
        : expandBackup(news.backup, plan);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkebackup
          .createProjectsLocationsRestorePlansRestores({
            parent: plan,
            restoreId,
            body: {
              backup,
              filter: news.filter,
              volumeDataRestorePolicyOverrides:
                news.volumeDataRestorePolicyOverrides,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.description, news.description) && "description",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* gkebackup.patchProjectsLocationsRestorePlansRestores({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* gkebackup
        .deleteProjectsLocationsRestorePlansRestores({
          name: output.name,
          force: true,
        })
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
