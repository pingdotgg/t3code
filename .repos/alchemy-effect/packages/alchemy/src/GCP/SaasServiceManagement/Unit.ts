import * as saasservicemgmt from "@distilled.cloud/gcp/saasservicemgmt_v1";
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
  ResourceNotResolved,
  collectPages,
  expandName,
  fieldMask,
  fingerprint,
  hasAlchemyLabelKeys,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameRef,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "units";

export type UnitManagementMode =
  | saasservicemgmt.UnitManagementModeEnum
  | (string & {});

export type UnitMaintenanceSettings = {
  /** Pin the unit to its current release until this RFC3339 timestamp. */
  pinnedUntilTime?: string;
};

export type UnitVariable = {
  type?: saasservicemgmt.UnitVariableTypeEnum | (string & {});
  value?: string;
  variable?: string;
};

export type UnitDependency = {
  unit?: string;
  alias?: string;
};

export type UnitCondition = {
  lastTransitionTime: string | undefined;
  status: string | undefined;
  type: string | undefined;
  message: string | undefined;
  reason: string | undefined;
};

export type UnitProps = {
  /**
   * Unit id (the `{unit}` segment of
   * `projects/{project}/locations/{location}/units/{unit}`). If omitted,
   * a unique RFC1035 name is generated. Immutable — changing it
   * replaces the unit.
   */
  unitId?: string;
  /**
   * Region of the unit (`us-central1`, …). Immutable — changing it
   * replaces the unit. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * UnitKind this unit belongs to. Accepts a unit kind id or a full
   * resource name. Immutable — changing it replaces the unit.
   */
  unitKind?: string;
  /**
   * Tenant this unit belongs to. Accepts a tenant id or a full resource
   * name. Immutable — changing it replaces the unit.
   */
  tenant?: string;
  /**
   * Whether the unit lifecycle is user- or system-managed. Immutable —
   * changing it replaces the unit.
   */
  managementMode?: UnitManagementMode;
  /**
   * Maintenance pin. Updates in place.
   */
  maintenance?: UnitMaintenanceSettings;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations preserved across updates.
   */
  annotations?: Record<string, string>;
};

export type Unit = Resource<
  "GCP.SaasServiceManagement.Unit",
  UnitProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/units/{unit}`. */
    name: string;
    /** Unit id (last path segment). */
    unitId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** UnitKind resource name. */
    unitKind: string | undefined;
    /** UnitKind id (last path segment). */
    unitKindId: string | undefined;
    /** Tenant resource name. */
    tenant: string | undefined;
    /** Tenant id (last path segment). */
    tenantId: string | undefined;
    /** Management mode. */
    managementMode: string | undefined;
    /** System-managed state. */
    systemManagedState: string | undefined;
    /** Current release resource name. */
    release: string | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** Maintenance pin. */
    maintenance: UnitMaintenanceSettings | undefined;
    /** Input variables currently deployed. */
    inputVariables: UnitVariable[];
    /** Output variables from actuation. */
    outputVariables: UnitVariable[];
    /** Dependencies of this unit. */
    dependencies: UnitDependency[];
    /** Units that depend on this unit. */
    dependents: UnitDependency[];
    /** Conditions. */
    conditions: UnitCondition[];
    /** Ongoing unit operations. */
    ongoingOperations: ReadonlyArray<string>;
    /** Pending unit operations. */
    pendingOperations: ReadonlyArray<string>;
    /** Flag revisions in use. */
    flagRevisions: ReadonlyArray<string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Server UUID. */
    uid: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Lifecycle Manager unit — one deployable instance of a UnitKind.
 *
 * A unit is actuated by a blueprint engine (Terraform, Helm, …) under
 * the hood. `unitId`, `location`, `unitKind`, `tenant`, and
 * `managementMode` replace the unit. Maintenance pins, labels, and
 * annotations update in place.
 *
 * ### Creating a Unit
 * **Example:** User-managed unit
 * ```typescript
 * const unit = yield* GCP.SaasServiceManagement.Unit("Store1", {
 *   unitKind: kind.name,
 *   tenant: tenant.name,
 *   managementMode: "MANAGEMENT_MODE_USER",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Unit
 * **Example:** Pin maintenance
 * ```typescript
 * const unit = yield* GCP.SaasServiceManagement.Unit("Store1", {
 *   unitId: unit.unitId,
 *   unitKind: kind.name,
 *   maintenance: { pinnedUntilTime: "2030-01-01T00:00:00Z" },
 * });
 * ```
 *
 * @resource
 * @category SaasServiceManagement
 */
export const Unit = Resource<Unit>("GCP.SaasServiceManagement.Unit");

const toAttrs = (item: saasservicemgmt.Unit, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    unitId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    unitKind: item.unitKind,
    unitKindId: item.unitKind ? lastSegment(item.unitKind) : undefined,
    tenant: item.tenant,
    tenantId: item.tenant ? lastSegment(item.tenant) : undefined,
    managementMode: item.managementMode,
    systemManagedState: item.systemManagedState,
    release: item.release,
    state: item.state,
    maintenance: item.maintenance
      ? { pinnedUntilTime: item.maintenance.pinnedUntilTime }
      : undefined,
    inputVariables: item.inputVariables ?? [],
    outputVariables: item.outputVariables ?? [],
    dependencies: item.dependencies ?? [],
    dependents: item.dependents ?? [],
    conditions: (item.conditions ?? []).map((condition) => ({
      lastTransitionTime: condition.lastTransitionTime,
      status: condition.status,
      type: condition.type,
      message: condition.message,
      reason: condition.reason,
    })),
    ongoingOperations: item.ongoingOperations ?? [],
    pendingOperations: item.pendingOperations ?? [],
    flagRevisions: item.flagRevisions ?? [],
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    uid: item.uid,
    etag: item.etag,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : saasservicemgmt
        .getProjectsLocationsUnits({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location: string) =>
  collectPages(
    saasservicemgmt.listProjectsLocationsUnits.pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.units,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)),
    ),
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : collectPages(
            saasservicemgmt.listProjectsLocationsUnits.pages({
              parent: parentOf(project, location),
              pageSize: 1000,
            }),
            (page) => page.units,
          ).pipe(
            Effect.map((fallback) =>
              fallback.filter((item) => hasAlchemyLabelKeys(item.labels)),
            ),
          ),
    ),
  );

export const UnitProvider = () =>
  Provider.succeed(Unit, {
    stables: [
      "name",
      "unitId",
      "project",
      "location",
      "unitKindId",
      "tenantId",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousMode = olds?.managementMode ?? output?.managementMode;
      const nextMode = news.managementMode ?? previousMode;
      return replaceOnIdentity({
        previousId: olds?.unitId ?? output?.unitId,
        nextId: news.unitId ?? olds?.unitId ?? output?.unitId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          (news.unitKind !== undefined &&
            !sameRef(olds?.unitKind ?? output?.unitKind, news.unitKind)) ||
          (news.tenant !== undefined &&
            !sameRef(olds?.tenant ?? output?.tenant, news.tenant)) ||
          (previousMode !== undefined &&
            nextMode !== undefined &&
            previousMode !== nextMode),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const unitId = yield* toPhysicalId(
        id,
        olds?.unitId,
        output?.unitId,
        "unit",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, COLLECTION, unitId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const unitId = yield* toPhysicalId(
        id,
        news.unitId,
        output?.unitId,
        "unit",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, COLLECTION, unitId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const unitKind =
        news.unitKind === undefined
          ? undefined
          : expandName(news.unitKind, env.project, location, "unitKinds");
      const tenant =
        news.tenant === undefined
          ? undefined
          : expandName(news.tenant, env.project, location, "tenants");
      const annotations = news.annotations;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* saasservicemgmt
          .createProjectsLocationsUnits({
            parent: parentOf(env.project, location),
            unitId,
            body: {
              unitKind,
              tenant,
              managementMode: news.managementMode,
              maintenance: news.maintenance,
              labels: desiredLabels,
              annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const annotationsChanged =
        annotations !== undefined &&
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(annotations);
      const maintenanceChanged =
        news.maintenance !== undefined &&
        fingerprint(current.maintenance) !== fingerprint(news.maintenance);
      const mask = fieldMask([
        labelsChanged && "labels",
        annotationsChanged && "annotations",
        maintenanceChanged && "maintenance",
      ]);

      if (mask.length > 0) {
        current = yield* saasservicemgmt.patchProjectsLocationsUnits({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            maintenance: news.maintenance,
            labels: desiredLabels,
            annotations,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* saasservicemgmt
        .deleteProjectsLocationsUnits({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
