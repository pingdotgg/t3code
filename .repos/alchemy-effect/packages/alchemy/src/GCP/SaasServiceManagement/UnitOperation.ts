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

const COLLECTION = "unitOperations";

export type UnitOperationVariable = {
  type?: saasservicemgmt.UnitVariableTypeEnum | (string & {});
  value?: string;
  variable?: string;
};

export type UnitOperationProvision = {
  /** Release to provision. Accepts a release id or full resource name. */
  release?: string;
  /** Input variables. Maximum 100. */
  inputVariables?: UnitOperationVariable[];
};

export type UnitOperationFlagUpdate = {
  /** Flag release to apply. */
  flagRelease?: string;
};

export type UnitOperationSchedule = {
  /** RFC3339 start time. If omitted, the next maintenance window is used. */
  startTime?: string;
};

export type UnitOperationCondition = {
  status: string | undefined;
  type: string | undefined;
  message: string | undefined;
  reason: string | undefined;
  lastTransitionTime: string | undefined;
};

export type UnitOperationProps = {
  /**
   * UnitOperation id (the `{unitOperation}` segment of
   * `projects/{project}/locations/{location}/unitOperations/{unitOperation}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the operation.
   */
  unitOperationId?: string;
  /**
   * Region of the operation (`us-central1`, …). Immutable — changing it
   * replaces the operation. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Unit this operation acts on. Accepts a unit id or a full resource
   * name. Immutable — changing it replaces the operation.
   */
  unit: string;
  /**
   * Provision the unit. Mutually exclusive with `upgrade`,
   * `deprovision`, and `flagUpdate`. Immutable.
   */
  provision?: UnitOperationProvision;
  /**
   * Upgrade a provisioned unit. Mutually exclusive with the other
   * operation types. Immutable.
   */
  upgrade?: UnitOperationProvision;
  /**
   * Deprovision a provisioned unit. Mutually exclusive with the other
   * operation types. Immutable.
   */
  deprovision?: boolean;
  /**
   * Push a flag release. Mutually exclusive with the other operation
   * types. Immutable.
   */
  flagUpdate?: UnitOperationFlagUpdate;
  /**
   * Parent unit operation, for tracing child work.
   */
  parentUnitOperation?: string;
  /**
   * Rollout that created this operation. Filtering only.
   */
  rollout?: string;
  /**
   * When to run the operation.
   */
  schedule?: UnitOperationSchedule;
  /**
   * Request cancellation. May fail if the operation is already
   * executing.
   */
  cancel?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations preserved across updates.
   */
  annotations?: Record<string, string>;
};

export type UnitOperation = Resource<
  "GCP.SaasServiceManagement.UnitOperation",
  UnitOperationProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/unitOperations/{unitOperation}`. */
    name: string;
    /** UnitOperation id (last path segment). */
    unitOperationId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Unit resource name. */
    unit: string | undefined;
    /** Unit id (last path segment). */
    unitId: string | undefined;
    /** Provision payload, if this is a provision. */
    provision: UnitOperationProvision | undefined;
    /** Upgrade payload, if this is an upgrade. */
    upgrade: UnitOperationProvision | undefined;
    /** Whether this is a deprovision. */
    deprovision: boolean;
    /** Flag-update payload, if this is a flag update. */
    flagUpdate: UnitOperationFlagUpdate | undefined;
    /** Parent unit operation. */
    parentUnitOperation: string | undefined;
    /** Creating rollout. */
    rollout: string | undefined;
    /** Scheduled start. */
    schedule: UnitOperationSchedule | undefined;
    /** Cancellation requested. */
    cancel: boolean;
    /** Lifecycle state. */
    state: string | undefined;
    /** Engine state (opaque). */
    engineState: string | undefined;
    /** Error category. */
    errorCategory: string | undefined;
    /** Conditions. */
    conditions: UnitOperationCondition[];
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
 * An App Lifecycle Manager unit operation — one provision, upgrade,
 * deprovision, or flag-update of a Unit.
 *
 * `unitOperationId`, `location`, `unit`, and the chosen operation type
 * replace the resource. `cancel`, labels, and annotations update in
 * place. Only one mutating unit operation runs on a unit at a time.
 *
 * ### Creating a UnitOperation
 * **Example:** Provision a unit
 * ```typescript
 * const op = yield* GCP.SaasServiceManagement.UnitOperation("Provision", {
 *   unit: unit.name,
 *   provision: { release: release.name },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Deprovision
 * ```typescript
 * const op = yield* GCP.SaasServiceManagement.UnitOperation("Teardown", {
 *   unit: unit.name,
 *   deprovision: true,
 * });
 * ```
 *
 * ### Updating a UnitOperation
 * **Example:** Cancel
 * ```typescript
 * const op = yield* GCP.SaasServiceManagement.UnitOperation("Provision", {
 *   unitOperationId: op.unitOperationId,
 *   unit: unit.name,
 *   provision: { release: release.name },
 *   cancel: true,
 * });
 * ```
 *
 * @resource
 * @category SaasServiceManagement
 */
export const UnitOperation = Resource<UnitOperation>(
  "GCP.SaasServiceManagement.UnitOperation",
);

const operationKind = (props: {
  provision?: UnitOperationProvision;
  upgrade?: UnitOperationProvision;
  deprovision?: boolean;
  flagUpdate?: UnitOperationFlagUpdate;
}) => {
  if (props.provision !== undefined) return "provision";
  if (props.upgrade !== undefined) return "upgrade";
  if (props.deprovision === true) return "deprovision";
  if (props.flagUpdate !== undefined) return "flagUpdate";
  return "";
};

const expandProvision = (
  provision: UnitOperationProvision | undefined,
  project: string,
  location: string,
): saasservicemgmt.Provision | undefined => {
  if (provision === undefined) return undefined;
  return {
    release:
      provision.release === undefined
        ? undefined
        : expandName(provision.release, project, location, "releases"),
    inputVariables: provision.inputVariables,
  };
};

const toAttrs = (item: saasservicemgmt.UnitOperation, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    unitOperationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    unit: item.unit,
    unitId: item.unit ? lastSegment(item.unit) : undefined,
    provision: item.provision,
    upgrade: item.upgrade,
    deprovision: item.deprovision !== undefined,
    flagUpdate: item.flagUpdate,
    parentUnitOperation: item.parentUnitOperation,
    rollout: item.rollout,
    schedule: item.schedule,
    cancel: item.cancel === true,
    state: item.state,
    engineState: item.engineState,
    errorCategory: item.errorCategory,
    conditions: (item.conditions ?? []).map((condition) => ({
      status: condition.status,
      type: condition.type,
      message: condition.message,
      reason: condition.reason,
      lastTransitionTime: condition.lastTransitionTime,
    })),
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
        .getProjectsLocationsUnitOperations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location: string) =>
  collectPages(
    saasservicemgmt.listProjectsLocationsUnitOperations.pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.unitOperations,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)),
    ),
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : collectPages(
            saasservicemgmt.listProjectsLocationsUnitOperations.pages({
              parent: parentOf(project, location),
              pageSize: 1000,
            }),
            (page) => page.unitOperations,
          ).pipe(
            Effect.map((fallback) =>
              fallback.filter((item) => hasAlchemyLabelKeys(item.labels)),
            ),
          ),
    ),
  );

export const UnitOperationProvider = () =>
  Provider.succeed(UnitOperation, {
    stables: [
      "name",
      "unitOperationId",
      "project",
      "location",
      "unitId",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKind = operationKind({
        provision: olds?.provision ?? output?.provision,
        upgrade: olds?.upgrade ?? output?.upgrade,
        deprovision: olds?.deprovision ?? output?.deprovision,
        flagUpdate: olds?.flagUpdate ?? output?.flagUpdate,
      });
      const nextKind = operationKind(news) || previousKind;
      return replaceOnIdentity({
        previousId: olds?.unitOperationId ?? output?.unitOperationId,
        nextId:
          news.unitOperationId ??
          olds?.unitOperationId ??
          output?.unitOperationId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          !sameRef(olds?.unit ?? output?.unit, news.unit) ||
          (previousKind.length > 0 &&
            nextKind.length > 0 &&
            previousKind !== nextKind),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const unitOperationId = yield* toPhysicalId(
        id,
        olds?.unitOperationId,
        output?.unitOperationId,
        "uop",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, unitOperationId);
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
      const unitOperationId = yield* toPhysicalId(
        id,
        news.unitOperationId,
        output?.unitOperationId,
        "uop",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        unitOperationId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const unit = expandName(news.unit, env.project, location, "units");
      const provision = expandProvision(news.provision, env.project, location);
      const upgrade = expandProvision(news.upgrade, env.project, location);
      const parentUnitOperation =
        news.parentUnitOperation === undefined
          ? undefined
          : expandName(
              news.parentUnitOperation,
              env.project,
              location,
              COLLECTION,
            );
      const annotations = news.annotations;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* saasservicemgmt
          .createProjectsLocationsUnitOperations({
            parent: parentOf(env.project, location),
            unitOperationId,
            body: {
              unit,
              provision,
              upgrade,
              deprovision: news.deprovision === true ? {} : undefined,
              flagUpdate: news.flagUpdate,
              parentUnitOperation,
              rollout: news.rollout,
              schedule: news.schedule,
              cancel: news.cancel,
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
      const cancelChanged =
        news.cancel !== undefined && (current.cancel === true) !== news.cancel;
      const scheduleChanged =
        news.schedule !== undefined &&
        fingerprint(current.schedule) !== fingerprint(news.schedule);
      const mask = fieldMask([
        labelsChanged && "labels",
        annotationsChanged && "annotations",
        cancelChanged && "cancel",
        scheduleChanged && "schedule",
      ]);

      if (mask.length > 0) {
        current = yield* saasservicemgmt.patchProjectsLocationsUnitOperations({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            cancel: news.cancel,
            schedule: news.schedule,
            labels: desiredLabels,
            annotations,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* saasservicemgmt
        .deleteProjectsLocationsUnitOperations({ name: output.name })
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
