import * as vm from "@distilled.cloud/gcp/vmmigration_v1";
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
  collectPages,
  fieldMask,
  fingerprint,
  forEachSource,
  hasAlchemyLabelMap,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sourceOf,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type SchedulePolicy = vm.SchedulePolicy;
export type ComputeEngineTargetDefaults = vm.ComputeEngineTargetDefaults;
export type ComputeEngineDisksTargetDefaults =
  vm.ComputeEngineDisksTargetDefaults;
export type MigratingVmState = vm.MigratingVmStateEnum | (string & {});

export type SourcesMigratingVmProps = {
  /**
   * Parent source. Full name
   * `projects/{project}/locations/{location}/sources/{source}` or the
   * source id (combined with `location`). Immutable — changing it
   * replaces the migrating VM.
   */
  source: string;
  /**
   * Region used when `source` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Migrating VM id. If omitted, a unique RFC1035 name is generated.
   * Immutable — changing it replaces the migrating VM.
   */
  migratingVmId?: string;
  /**
   * Unique VM id in the source (vSphere moRef `vm-…`, AWS instance id,
   * Azure VM id). Immutable — changing it replaces the migrating VM.
   */
  sourceVmId: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * Free-text description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Replication schedule policy.
   */
  policy?: SchedulePolicy;
  /**
   * Target VM defaults in Compute Engine. Mutually exclusive with
   * `computeEngineDisksTargetDefaults`.
   */
  computeEngineTargetDefaults?: ComputeEngineTargetDefaults;
  /**
   * Target persistent-disk defaults. Mutually exclusive with
   * `computeEngineTargetDefaults`.
   */
  computeEngineDisksTargetDefaults?: ComputeEngineDisksTargetDefaults;
};

export type SourcesMigratingVm = Resource<
  "GCP.VMMigration.SourcesMigratingVm",
  SourcesMigratingVmProps,
  {
    /** Full resource name. */
    name: string;
    /** Migrating VM id (last path segment). */
    migratingVmId: string;
    /** Parent source resource name. */
    source: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Unique VM id in the source. */
    sourceVmId: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** Free-text description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Replication schedule policy. */
    policy: SchedulePolicy | undefined;
    /** Compute Engine VM target defaults. */
    computeEngineTargetDefaults: ComputeEngineTargetDefaults | undefined;
    /** Compute Engine disk target defaults. */
    computeEngineDisksTargetDefaults:
      | ComputeEngineDisksTargetDefaults
      | undefined;
    /** Group this migrating VM belongs to. */
    group: string | undefined;
    /** Replication state. */
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
 * A VM Migration migrating VM: a source VM plus the replication and
 * target defaults used to clone or cut over into Compute Engine.
 *
 * Source, migrating VM id, and `sourceVmId` are immutable. Display
 * name, description, labels, policy, and target defaults update in
 * place.
 *
 * ### Creating a Migrating VM
 * **Example:** Compute Engine VM target
 * ```typescript
 * const vm = yield* GCP.VMMigration.SourcesMigratingVm("Web", {
 *   source: source.name,
 *   sourceVmId: "vm-123",
 *   displayName: "web-1",
 *   computeEngineTargetDefaults: {
 *     vmName: "web-1",
 *     machineType: "n2-standard-4",
 *     zone: "us-central1-a",
 *     targetProject: target.name,
 *   },
 * });
 * ```
 *
 * @resource
 * @category VMMigration
 */
export const SourcesMigratingVm = Resource<SourcesMigratingVm>(
  "GCP.VMMigration.SourcesMigratingVm",
);

const resourceName = (source: string, migratingVmId: string) =>
  `${source}/migratingVms/${migratingVmId}`;

const userVmTarget = (target: ComputeEngineTargetDefaults | undefined) => {
  if (target === undefined) return undefined;
  const { appliedLicense: _applied, bootOption: _boot, ...rest } = target;
  return rest;
};

const userDisksTarget = (
  target: ComputeEngineDisksTargetDefaults | undefined,
) => {
  if (target === undefined) return undefined;
  return {
    targetProject: target.targetProject,
    zone: target.zone,
    disks: target.disks,
    vmTargetDefaults: target.vmTargetDefaults,
  };
};

const toAttrs = (
  migrating: vm.MigratingVm,
  project: string,
  region: string,
) => {
  const name = migrating.name ?? "";
  const parsed = parseName(name, "migratingVms", region);
  return {
    name,
    migratingVmId: parsed.id,
    source: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    sourceVmId: migrating.sourceVmId,
    displayName: migrating.displayName,
    description: migrating.description,
    labels: userLabels(migrating.labels),
    policy: migrating.policy,
    computeEngineTargetDefaults: migrating.computeEngineTargetDefaults,
    computeEngineDisksTargetDefaults:
      migrating.computeEngineDisksTargetDefaults,
    group: migrating.group,
    state: migrating.state,
    createTime: migrating.createTime,
    updateTime: migrating.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vm
        .getProjectsLocationsSourcesMigratingVms({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listChildren = (parent: string) =>
  collectPages(
    vm.listProjectsLocationsSourcesMigratingVms.pages({
      parent,
      pageSize: 1000,
      view: "MIGRATING_VM_VIEW_BASIC",
    }),
    (page) => page.migratingVms,
  ).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([] as vm.MigratingVm[])),
  );

export const SourcesMigratingVmProvider = () =>
  Provider.succeed(SourcesMigratingVm, {
    stables: [
      "name",
      "migratingVmId",
      "source",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousSource = olds?.source ?? output?.source;
      const previousVm = olds?.sourceVmId ?? output?.sourceVmId;
      const nextVm = news.sourceVmId ?? previousVm;
      return replaceOnIdentity({
        previousId: olds?.migratingVmId ?? output?.migratingVmId,
        nextId:
          news.migratingVmId ?? olds?.migratingVmId ?? output?.migratingVmId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: previousSource,
        nextParent: news.source ?? previousSource,
        extra: previousVm !== nextVm,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const migratingVmId = yield* toPhysicalId(
        id,
        olds?.migratingVmId,
        output?.migratingVmId,
        "migratingvm",
      );
      const source =
        olds?.source !== undefined
          ? sourceOf(olds.source, env.project, location)
          : (output?.source ?? "");
      const name =
        output?.name ??
        (source.length > 0 ? resourceName(source, migratingVmId) : "");
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
        const items = yield* forEachSource(
          env.project,
          listChildren,
          env.region,
        );
        return items
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const source = sourceOf(news.source, env.project, location);
      const migratingVmId = yield* toPhysicalId(
        id,
        news.migratingVmId,
        output?.migratingVmId,
        "migratingvm",
      );
      const name = resourceName(source, migratingVmId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? migratingVmId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vm
          .createProjectsLocationsSourcesMigratingVms({
            parent: source,
            migratingVmId,
            body: {
              sourceVmId: news.sourceVmId,
              displayName,
              description: news.description,
              labels: desiredLabels,
              policy: news.policy,
              computeEngineTargetDefaults: news.computeEngineTargetDefaults,
              computeEngineDisksTargetDefaults:
                news.computeEngineDisksTargetDefaults,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const policyChanged =
        fingerprint(current.policy) !== fingerprint(news.policy);
      const vmTargetChanged =
        fingerprint(userVmTarget(current.computeEngineTargetDefaults)) !==
        fingerprint(userVmTarget(news.computeEngineTargetDefaults));
      const disksTargetChanged =
        fingerprint(
          userDisksTarget(current.computeEngineDisksTargetDefaults),
        ) !==
        fingerprint(userDisksTarget(news.computeEngineDisksTargetDefaults));
      const mask = fieldMask([
        labelsChanged && "labels",
        displayNameChanged && "displayName",
        descriptionChanged && "description",
        policyChanged && "policy",
        vmTargetChanged && "computeEngineTargetDefaults",
        disksTargetChanged && "computeEngineDisksTargetDefaults",
      ]);

      if (mask.length > 0) {
        const operation = yield* vm.patchProjectsLocationsSourcesMigratingVms({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            description: news.description,
            labels: desiredLabels,
            policy: news.policy,
            computeEngineTargetDefaults: news.computeEngineTargetDefaults,
            computeEngineDisksTargetDefaults:
              news.computeEngineDisksTargetDefaults,
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
      const operation = yield* vm
        .deleteProjectsLocationsSourcesMigratingVms({ name: output.name })
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
