import * as backupdr from "@distilled.cloud/gcp/backupdr_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  backupPlanOf,
  collectPages,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type RuleConfigInfo = {
  /** Backup rule id from the plan. */
  ruleId?: string;
  /** Last backup state for the rule. */
  lastBackupState?: string;
  /** Last backup error message. */
  lastBackupError?: string;
  /** Last successful backup consistency time. */
  lastSuccessfulBackupConsistencyTime?: string;
};

export type BackupPlanAssociationProps = {
  /**
   * Association id (the `{backupPlanAssociation}` segment of
   * `projects/{project}/locations/{location}/backupPlanAssociations/{backupPlanAssociation}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the association.
   */
  backupPlanAssociationId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the association. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Workload resource the plan is applied to. Resource name
   * (`projects/{project}/zones/{zone}/instances/{instance}`) or full URI.
   * Immutable — changing it replaces the association.
   */
  resource: string;
  /**
   * Workload resource type, e.g. `compute.googleapis.com/Instance`.
   * Immutable — changing it replaces the association.
   */
  resourceType: string;
  /**
   * Backup plan to apply. Full name
   * `projects/{project}/locations/{location}/backupPlans/{backupPlan}`
   * or a plan id combined with `location`.
   */
  backupPlan: string;
};

export type BackupPlanAssociation = Resource<
  "GCP.BackupDR.BackupPlanAssociation",
  BackupPlanAssociationProps,
  {
    /** Full resource name. */
    name: string;
    /** Association id (last path segment). */
    backupPlanAssociationId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Workload resource name. */
    resource: string | undefined;
    /** Workload resource type. */
    resourceType: string | undefined;
    /** Backup plan name. */
    backupPlan: string | undefined;
    /** Data source used as the backup storage location. */
    dataSource: string | undefined;
    /** Backup plan revision name. */
    backupPlanRevisionName: string | undefined;
    /** User-friendly revision id (`v0`, `v1`, …). */
    backupPlanRevisionId: string | undefined;
    /** Per-rule backup status. */
    rulesConfigInfo: RuleConfigInfo[];
    /** Cloud SQL instance create time, if applicable. */
    cloudSqlInstanceCreateTime: string | undefined;
    /** Filestore instance create time, if applicable. */
    filestoreInstanceCreateTime: string | undefined;
    /** AlloyDB cluster uid, if applicable. */
    alloydbClusterUid: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Backup and DR backup plan association — applies a Backup Plan to a
 * workload (Compute instance, Cloud SQL, AlloyDB, Filestore, or disk).
 *
 * Associations have no labels field. Nuke discovers them by following the
 * referenced Backup Plan's Alchemy ownership labels.
 *
 * Changing `backupPlanAssociationId`, `location`, `resource`, or
 * `resourceType` replaces the association. `backupPlan` updates in place.
 *
 * ### Creating an Association
 * **Example:** Protect a Compute instance
 * ```typescript
 * const association = yield* GCP.BackupDR.BackupPlanAssociation("VmPlan", {
 *   resource: instance.selfLink,
 *   resourceType: "compute.googleapis.com/Instance",
 *   backupPlan: plan.name,
 * });
 * ```
 *
 * ### Updating an Association
 * **Example:** Point at a new plan
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const association = yield* GCP.BackupDR.BackupPlanAssociation("VmPlan", {
 *   resource: instance.selfLink,
 *   resourceType: "compute.googleapis.com/Instance",
 *   backupPlan: otherPlan.name,
 * });
 * ```
 *
 * @resource
 * @category BackupDR
 */
export const BackupPlanAssociation = Resource<BackupPlanAssociation>(
  "GCP.BackupDR.BackupPlanAssociation",
);

const resourceName = (
  project: string,
  location: string,
  backupPlanAssociationId: string,
) =>
  `projects/${project}/locations/${location}/backupPlanAssociations/${backupPlanAssociationId}`;

const toRules = (
  rules: readonly backupdr.RuleConfigInfo[] | undefined,
): RuleConfigInfo[] =>
  (rules ?? []).map((rule) => ({
    ruleId: rule.ruleId,
    lastBackupState: rule.lastBackupState,
    lastBackupError: rule.lastBackupError?.message,
    lastSuccessfulBackupConsistencyTime:
      rule.lastSuccessfulBackupConsistencyTime,
  }));

const toAttrs = (
  item: backupdr.BackupPlanAssociation,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backupPlanAssociations", region);
  return {
    name,
    backupPlanAssociationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    resource: item.resource,
    resourceType: item.resourceType,
    backupPlan: item.backupPlan,
    dataSource: item.dataSource,
    backupPlanRevisionName: item.backupPlanRevisionName,
    backupPlanRevisionId: item.backupPlanRevisionId,
    rulesConfigInfo: toRules(item.rulesConfigInfo),
    cloudSqlInstanceCreateTime:
      item.cloudSqlInstanceBackupPlanAssociationProperties?.instanceCreateTime,
    filestoreInstanceCreateTime:
      item.filestoreInstanceBackupPlanAssociationProperties?.instanceCreateTime,
    alloydbClusterUid:
      item.alloydbClusterBackupPlanAssociationProperties?.clusterUid,
    state: item.state,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  backupdr
    .getProjectsLocationsBackupPlanAssociations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getPlan = (name: string | undefined) =>
  name === undefined || name.length === 0
    ? Effect.succeed(undefined)
    : backupdr
        .getProjectsLocationsBackupPlans({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  Effect.gen(function* () {
    const items = yield* listAtLocation(project, region, (parent) =>
      collectPages(
        backupdr.listProjectsLocationsBackupPlanAssociations.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.backupPlanAssociations,
      ),
    );
    const planNames = [
      ...new Set(
        items
          .map((item) => item.backupPlan)
          .filter(
            (name): name is string => name !== undefined && name.length > 0,
          ),
      ),
    ];
    const ownedPlans = yield* Effect.forEach(
      planNames,
      (name) =>
        getPlan(name).pipe(
          Effect.map((plan) =>
            plan !== undefined && hasAlchemyLabelMap(plan.labels)
              ? name
              : undefined,
          ),
        ),
      { concurrency: 8 },
    );
    const owned = new Set(
      ownedPlans.filter((name): name is string => name !== undefined),
    );
    return items.filter(
      (item) => item.backupPlan !== undefined && owned.has(item.backupPlan),
    );
  });

export const BackupPlanAssociationProvider = () =>
  Provider.succeed(BackupPlanAssociation, {
    stables: [
      "name",
      "backupPlanAssociationId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousResource = olds?.resource ?? output?.resource;
      const previousType = olds?.resourceType ?? output?.resourceType;
      return replaceOnIdentity({
        previousId:
          olds?.backupPlanAssociationId ?? output?.backupPlanAssociationId,
        nextId:
          news.backupPlanAssociationId ??
          olds?.backupPlanAssociationId ??
          output?.backupPlanAssociationId,
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
          (previousResource !== undefined &&
            news.resource !== undefined &&
            previousResource !== news.resource &&
            !previousResource.endsWith(`/${news.resource}`)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupPlanAssociationId = yield* toPhysicalId(
        id,
        olds?.backupPlanAssociationId,
        output?.backupPlanAssociationId,
        "backupplanassoc",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, backupPlanAssociationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      if (output !== undefined) return attrs;
      const plan = yield* getPlan(existing.backupPlan);
      return plan !== undefined && hasAlchemyLabelMap(plan.labels)
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
      const backupPlanAssociationId = yield* toPhysicalId(
        id,
        news.backupPlanAssociationId,
        output?.backupPlanAssociationId,
        "backupplanassoc",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, backupPlanAssociationId);
      const backupPlan = backupPlanOf(news.backupPlan, env.project, location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* backupdr
          .createProjectsLocationsBackupPlanAssociations({
            parent: parentOf(env.project, location),
            backupPlanAssociationId,
            body: {
              resource: news.resource,
              resourceType: news.resourceType,
              backupPlan,
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

      if (!sameText(current.backupPlan, backupPlan)) {
        const operation =
          yield* backupdr.patchProjectsLocationsBackupPlanAssociations({
            name: current.name ?? name,
            updateMask: "backupPlan",
            body: { backupPlan },
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
        .deleteProjectsLocationsBackupPlanAssociations({ name: output.name })
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
