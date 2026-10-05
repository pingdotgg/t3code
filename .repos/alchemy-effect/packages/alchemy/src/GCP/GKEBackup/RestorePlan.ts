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
  expandParent,
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

export type GroupKind = {
  /** API group string (empty string for the core group). */
  resourceGroup?: string;
  /** Kind in UpperCamelCase singular form. */
  resourceKind?: string;
};

export type SubstitutionRule = {
  /** Regex compared against fields matched by `targetJsonPath`. */
  originalValuePattern?: string;
  /** JSONPath that selects fields to substitute. */
  targetJsonPath?: string;
  /** Replacement value. Empty string removes the field. */
  newValue?: string;
  /** Restrict substitution to these group kinds. */
  targetGroupKinds?: GroupKind[];
  /** Restrict substitution to these namespaces. */
  targetNamespaces?: string[];
};

export type VolumeDataRestorePolicyBinding = {
  /** Policy applied to volumes in scope. */
  policy?: gkebackup.VolumeDataRestorePolicyBindingPolicyEnum | (string & {});
  /** Volume type this binding applies to. */
  volumeType?:
    | gkebackup.VolumeDataRestorePolicyBindingVolumeTypeEnum
    | (string & {});
};

export type TransformationRuleAction = {
  /** JSON Pointer for the operation path. */
  path?: string;
  /** JSON Patch operation. */
  op?: gkebackup.TransformationRuleActionOpEnum | (string & {});
  /** JSON Pointer for move/copy source. */
  fromPath?: string;
  /** Desired value for add/replace/test. */
  value?: string;
};

export type ResourceFilter = {
  /** JSONPath filtering expression. */
  jsonPath?: string;
  /** Restrict transformation to these group kinds. */
  groupKinds?: GroupKind[];
  /** Restrict transformation to these namespaces. */
  namespaces?: string[];
};

export type TransformationRule = {
  /** JSON Patch actions, executed in order. */
  fieldActions?: TransformationRuleAction[];
  /** Human-readable description of the rule. */
  description?: string;
  /** Filter selecting which restored resources the rule applies to. */
  resourceFilter?: ResourceFilter;
};

export type RestoreOrder = {
  /** Group-kind dependency pairs that order restore. */
  groupKindDependencies?: Array<{
    /** Group kind that must be restored first. */
    satisfying?: GroupKind;
    /** Group kind that depends on `satisfying`. */
    requiring?: GroupKind;
  }>;
};

export type ClusterResourceRestoreScope = {
  /** Restore only these cluster-scoped group kinds. */
  selectedGroupKinds?: GroupKind[];
  /** When true, restore no cluster-scoped resources. */
  noGroupKinds?: boolean;
  /** When true, restore all valid cluster-scoped resources. */
  allGroupKinds?: boolean;
  /** Restore all valid cluster-scoped resources except these. */
  excludedGroupKinds?: GroupKind[];
};

export type RestoreConfig = {
  /**
   * How to handle namespaced resources that already exist in the target
   * cluster.
   */
  namespacedResourceRestoreMode?:
    | gkebackup.RestoreConfigNamespacedResourceRestoreModeEnum
    | (string & {});
  /** Substitution rules applied during restore. */
  substitutionRules?: SubstitutionRule[];
  /** Namespaces excluded from restoration. */
  excludedNamespaces?: { namespaces?: string[] };
  /** Per-volume-type restore policy bindings. */
  volumeDataRestorePolicyBindings?: VolumeDataRestorePolicyBinding[];
  /** When true, restore all namespaced resources in the Backup. */
  allNamespaces?: boolean;
  /** Transformation rules applied during restore. */
  transformationRules?: TransformationRule[];
  /** Custom restore ordering. */
  restoreOrder?: RestoreOrder;
  /**
   * How volume data is restored.
   * @default "NO_VOLUME_DATA_RESTORATION"
   */
  volumeDataRestorePolicy?:
    | gkebackup.RestoreConfigVolumeDataRestorePolicyEnum
    | (string & {});
  /**
   * How to handle cluster-scoped resources that already exist.
   */
  clusterResourceConflictPolicy?:
    | gkebackup.RestoreConfigClusterResourceConflictPolicyEnum
    | (string & {});
  /** Cluster-scoped resources to restore. */
  clusterResourceRestoreScope?: ClusterResourceRestoreScope;
  /** Restore only these namespaces and their resources. */
  selectedNamespaces?: { namespaces?: string[] };
  /** Restore only these ProtectedApplications and their resources. */
  selectedApplications?: {
    namespacedNames?: Array<{
      /** Kubernetes namespace. */
      namespace?: string;
      /** Kubernetes resource name. */
      name?: string;
    }>;
  };
  /** When true, restore no namespaced resources. */
  noNamespaces?: boolean;
};

export type RestorePlanProps = {
  /**
   * Restore plan id (the `{restorePlan}` segment of
   * `projects/{project}/locations/{location}/restorePlans/{restorePlan}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the plan.
   */
  restorePlanId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the plan. Must match the target cluster region.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Target GKE cluster. Full name or a cluster id combined with
   * `location`. Immutable — changing it replaces the plan.
   */
  cluster: string;
  /**
   * Source BackupPlan. Full name
   * `projects/{project}/locations/{location}/backupPlans/{backupPlan}`
   * or a plan id combined with `location`. Immutable — changing it
   * replaces the plan.
   */
  backupPlan: string;
  /**
   * Configuration of Restores created via this plan.
   */
  restoreConfig: RestoreConfig;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type RestorePlan = Resource<
  "GCP.GKEBackup.RestorePlan",
  RestorePlanProps,
  {
    /** Full resource name. */
    name: string;
    /** Restore plan id (last path segment). */
    restorePlanId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Target cluster name. */
    cluster: string | undefined;
    /** Source BackupPlan name. */
    backupPlan: string | undefined;
    /** Cross-project restore channel, if any. */
    restoreChannel: string | undefined;
    /** Restore configuration. */
    restoreConfig: RestoreConfig | undefined;
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
  },
  never,
  Providers
>;

/**
 * A Backup for GKE restore plan — the configuration for restoring
 * Backups from a BackupPlan into a target cluster.
 *
 * Changing `restorePlanId`, `location`, `cluster`, or `backupPlan`
 * replaces the plan. Description, labels, and `restoreConfig` update in
 * place.
 *
 * ### Creating a Restore Plan
 * **Example:** Restore all namespaces
 * ```typescript
 * const plan = yield* GCP.GKEBackup.RestorePlan("Rollback", {
 *   cluster: cluster.name,
 *   backupPlan: backupPlan.name,
 *   restoreConfig: {
 *     allNamespaces: true,
 *     namespacedResourceRestoreMode: "FAIL_ON_CONFLICT",
 *     volumeDataRestorePolicy: "NO_VOLUME_DATA_RESTORATION",
 *   },
 * });
 * ```
 *
 * **Example:** Selected namespaces
 * ```typescript
 * const plan = yield* GCP.GKEBackup.RestorePlan("Rollback", {
 *   cluster: cluster.name,
 *   backupPlan: backupPlan.name,
 *   restoreConfig: {
 *     selectedNamespaces: { namespaces: ["app"] },
 *     namespacedResourceRestoreMode: "MERGE_SKIP_ON_CONFLICT",
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Restore Plan
 * **Example:** Description and labels
 * ```typescript
 * const plan = yield* GCP.GKEBackup.RestorePlan("Rollback", {
 *   cluster: cluster.name,
 *   backupPlan: backupPlan.name,
 *   restoreConfig: { allNamespaces: true },
 *   description: "rollback v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category GKEBackup
 */
export const RestorePlan = Resource<RestorePlan>("GCP.GKEBackup.RestorePlan");

const resourceName = (
  project: string,
  location: string,
  restorePlanId: string,
) => `projects/${project}/locations/${location}/restorePlans/${restorePlanId}`;

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

const toAttrs = (
  item: gkebackup.RestorePlan,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "restorePlans", region);
  return {
    name,
    restorePlanId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    cluster: item.cluster,
    backupPlan: item.backupPlan,
    restoreChannel: item.restoreChannel,
    restoreConfig: toRestoreConfig(item.restoreConfig),
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateReason: item.stateReason,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  gkebackup
    .getProjectsLocationsRestorePlans({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      gkebackup.listProjectsLocationsRestorePlans.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.restorePlans,
      (item) => item.labels,
    ),
  );

export const RestorePlanProvider = () =>
  Provider.succeed(RestorePlan, {
    stables: [
      "name",
      "restorePlanId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousCluster = olds?.cluster ?? output?.cluster;
      const previousPlan = olds?.backupPlan ?? output?.backupPlan;
      return replaceOnIdentity({
        previousId: olds?.restorePlanId ?? output?.restorePlanId,
        nextId:
          news.restorePlanId ?? olds?.restorePlanId ?? output?.restorePlanId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousCluster !== undefined &&
            news.cluster !== undefined &&
            previousCluster !== news.cluster &&
            !previousCluster.endsWith(`/${news.cluster}`)) ||
          (previousPlan !== undefined &&
            news.backupPlan !== undefined &&
            previousPlan !== news.backupPlan &&
            !previousPlan.endsWith(`/${news.backupPlan}`)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const restorePlanId = yield* toPhysicalId(
        id,
        olds?.restorePlanId,
        output?.restorePlanId,
        "restoreplan",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, restorePlanId);
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
      const restorePlanId = yield* toPhysicalId(
        id,
        news.restorePlanId,
        output?.restorePlanId,
        "restoreplan",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, restorePlanId);
      const cluster = clusterName(news.cluster, env.project, location);
      const backupPlan = expandParent(
        news.backupPlan,
        env.project,
        location,
        "backupPlans",
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkebackup
          .createProjectsLocationsRestorePlans({
            parent: parentOf(env.project, location),
            restorePlanId,
            body: {
              cluster,
              backupPlan,
              restoreConfig: news.restoreConfig,
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
        fingerprint(toRestoreConfig(current.restoreConfig)) !==
          fingerprint(news.restoreConfig) && "restoreConfig",
      ]);

      if (mask.length > 0) {
        const operation = yield* gkebackup.patchProjectsLocationsRestorePlans({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            etag: current.etag,
            labels: desiredLabels,
            description: news.description,
            restoreConfig: news.restoreConfig,
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
        .deleteProjectsLocationsRestorePlans({
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
