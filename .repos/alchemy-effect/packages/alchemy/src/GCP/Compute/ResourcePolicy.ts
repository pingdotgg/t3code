import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
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

const MAX_NAME_LENGTH = 63;

export type SnapshotSchedulePolicy =
  compute.ResourcePolicySnapshotSchedulePolicy;
export type InstanceSchedulePolicy =
  compute.ResourcePolicyInstanceSchedulePolicy;
export type GroupPlacementPolicy = compute.ResourcePolicyGroupPlacementPolicy;
export type WorkloadPolicy = compute.ResourcePolicyWorkloadPolicy;
export type DiskConsistencyGroupPolicy =
  compute.ResourcePolicyDiskConsistencyGroupPolicy;

export type ResourcePolicyProps = {
  /**
   * Resource policy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing the
   * name replaces the policy.
   */
  resourcePolicyName?: string;
  /**
   * Region the policy lives in (e.g. `us-central1`). Immutable — changing
   * it replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Compute resource policies have no labels field,
   * so Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Snapshot schedule attached to persistent disks. Mutable in place via
   * `resourcePolicies.patch`. Mutually exclusive with the other policy
   * kinds — switching kind replaces the resource.
   */
  snapshotSchedulePolicy?: SnapshotSchedulePolicy;
  /**
   * Start/stop schedule for VM instances. Mutable in place. Mutually
   * exclusive with the other policy kinds.
   */
  instanceSchedulePolicy?: InstanceSchedulePolicy;
  /**
   * Compact / collocated placement for instances. Immutable — changing it
   * replaces the policy.
   */
  groupPlacementPolicy?: GroupPlacementPolicy;
  /**
   * Workload placement for managed instance groups. Immutable — changing
   * it replaces the policy.
   */
  workloadPolicy?: WorkloadPolicy;
  /**
   * Disk consistency-group policy. Immutable — changing it replaces the
   * policy.
   */
  diskConsistencyGroupPolicy?: DiskConsistencyGroupPolicy;
};

export type ResourcePolicy = Resource<
  "GCP.Compute.ResourcePolicy",
  ResourcePolicyProps,
  {
    /** Resource policy name. */
    resourcePolicyName: string;
    /** Server-assigned numeric id. */
    resourcePolicyId: string | undefined;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported status (`READY`, `CREATING`, `DELETING`, …). */
    status: string | undefined;
    /** Snapshot schedule, if this is a snapshot policy. */
    snapshotSchedulePolicy: SnapshotSchedulePolicy | undefined;
    /** Instance start/stop schedule, if this is an instance-schedule policy. */
    instanceSchedulePolicy: InstanceSchedulePolicy | undefined;
    /** Group placement policy, if any. */
    groupPlacementPolicy: GroupPlacementPolicy | undefined;
    /** Workload policy, if any. */
    workloadPolicy: WorkloadPolicy | undefined;
    /** Disk consistency-group policy, if any. */
    diskConsistencyGroupPolicy: DiskConsistencyGroupPolicy | undefined;
    /** Output-only system status (e.g. next instance-schedule run). */
    resourceStatus: compute.ResourcePolicyResourceStatus | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine resource policy.
 *
 * Resource policies schedule snapshots, start/stop VMs, or describe
 * placement. Compute Engine has no labels on this resource, so Alchemy
 * stamps ownership into the description (`[alchemy alchemy-stack=…
 * alchemy-stage=… alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find
 * them.
 *
 * Name, region, and policy kind (`snapshotSchedulePolicy` vs
 * `instanceSchedulePolicy` vs placement/workload/consistency) are
 * immutable — changing them replaces the policy. Description and the
 * nested snapshot / instance schedules update in place via
 * `resourcePolicies.patch`.
 *
 * ### Creating a Resource Policy
 * **Example:** Daily snapshot schedule
 * ```typescript
 * const nightly = yield* GCP.Compute.ResourcePolicy("Nightly", {
 *   snapshotSchedulePolicy: {
 *     schedule: {
 *       dailySchedule: { daysInCycle: 1, startTime: "04:00" },
 *     },
 *     retentionPolicy: { maxRetentionDays: 7 },
 *   },
 * });
 * ```
 *
 * **Example:** Named policy with labels in the snapshot properties
 * ```typescript
 * const backups = yield* GCP.Compute.ResourcePolicy("Backups", {
 *   resourcePolicyName: "app-disk-nightly",
 *   region: "us-central1",
 *   description: "nightly disk snapshots",
 *   snapshotSchedulePolicy: {
 *     schedule: {
 *       dailySchedule: { daysInCycle: 1, startTime: "04:00" },
 *     },
 *     retentionPolicy: {
 *       maxRetentionDays: 14,
 *       onSourceDiskDelete: "KEEP_AUTO_SNAPSHOTS",
 *     },
 *     snapshotProperties: {
 *       storageLocations: ["us"],
 *       labels: { env: "prod" },
 *     },
 *   },
 * });
 * ```
 *
 * ### Instance Schedules
 * **Example:** Start and stop VMs on weekdays
 * ```typescript
 * const hours = yield* GCP.Compute.ResourcePolicy("OfficeHours", {
 *   instanceSchedulePolicy: {
 *     timeZone: "America/Chicago",
 *     vmStartSchedule: { schedule: "0 8 * * 1-5" },
 *     vmStopSchedule: { schedule: "0 18 * * 1-5" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const ResourcePolicy = Resource<ResourcePolicy>(
  "GCP.Compute.ResourcePolicy",
);

export class ResourcePolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.ResourcePolicyNotResolved",
)<{
  resourcePolicyName: string;
  region: string;
}> {}

export class ResourcePolicyNotReady extends Data.TaggedError(
  "GCP.Compute.ResourcePolicyNotReady",
)<{
  resourcePolicyName: string;
  status: string;
}> {}

export class ResourcePolicyFailed extends Data.TaggedError(
  "GCP.Compute.ResourcePolicyFailed",
)<{
  resourcePolicyName: string;
  status: string;
}> {}

export class ResourcePolicyStillExists extends Data.TaggedError(
  "GCP.Compute.ResourcePolicyStillExists",
)<{
  resourcePolicyName: string;
  status: string;
}> {}

type PolicyKind =
  | "snapshot"
  | "instance"
  | "placement"
  | "workload"
  | "consistency"
  | "none";

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `p${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const policyKindOf = (props: {
  snapshotSchedulePolicy?: unknown;
  instanceSchedulePolicy?: unknown;
  groupPlacementPolicy?: unknown;
  workloadPolicy?: unknown;
  diskConsistencyGroupPolicy?: unknown;
}): PolicyKind => {
  if (props.snapshotSchedulePolicy !== undefined) return "snapshot";
  if (props.instanceSchedulePolicy !== undefined) return "instance";
  if (props.groupPlacementPolicy !== undefined) return "placement";
  if (props.workloadPolicy !== undefined) return "workload";
  if (props.diskConsistencyGroupPolicy !== undefined) return "consistency";
  return "none";
};

const toBody = (
  resourcePolicyName: string,
  props: ResourcePolicyProps,
  ownership: Record<string, string>,
): compute.ResourcePolicy => ({
  name: resourcePolicyName,
  description: encodeDescription(ownership, props.description),
  snapshotSchedulePolicy: props.snapshotSchedulePolicy,
  instanceSchedulePolicy: props.instanceSchedulePolicy,
  groupPlacementPolicy: props.groupPlacementPolicy,
  workloadPolicy: props.workloadPolicy,
  diskConsistencyGroupPolicy: props.diskConsistencyGroupPolicy,
});

const toAttrs = (policy: compute.ResourcePolicy, project: string) => {
  const parsed = parseDescription(policy.description);
  return {
    resourcePolicyName: policy.name ?? policy.id ?? "",
    resourcePolicyId: policy.id,
    project,
    region: lastSegment(policy.region).toLowerCase(),
    description: parsed.description,
    status: policy.status,
    snapshotSchedulePolicy: policy.snapshotSchedulePolicy,
    instanceSchedulePolicy: policy.instanceSchedulePolicy,
    groupPlacementPolicy: policy.groupPlacementPolicy,
    workloadPolicy: policy.workloadPolicy,
    diskConsistencyGroupPolicy: policy.diskConsistencyGroupPolicy,
    resourceStatus: policy.resourceStatus,
    selfLink: policy.selfLink,
    creationTimestamp: policy.creationTimestamp,
  };
};

const normalizeTime = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return undefined;
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return value;
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
};

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].map((value) => value.toLowerCase()).sort();

const canonSnapshot = (policy: SnapshotSchedulePolicy | undefined) => {
  if (policy === undefined) return undefined;
  const weekly = [...(policy.schedule?.weeklySchedule?.dayOfWeeks ?? [])]
    .map((day) => ({
      day: day.day,
      startTime: normalizeTime(day.startTime),
    }))
    .sort((left, right) => (left.day ?? "").localeCompare(right.day ?? ""));
  return {
    retention: policy.retentionPolicy
      ? {
          maxRetentionDays: policy.retentionPolicy.maxRetentionDays,
          onSourceDiskDelete: policy.retentionPolicy.onSourceDiskDelete,
        }
      : undefined,
    properties: policy.snapshotProperties
      ? {
          storageLocations: sorted(policy.snapshotProperties.storageLocations),
          guestFlush: policy.snapshotProperties.guestFlush === true,
          chainName: policy.snapshotProperties.chainName ?? "",
          labels: policy.snapshotProperties.labels ?? {},
        }
      : undefined,
    daily: policy.schedule?.dailySchedule
      ? {
          daysInCycle: policy.schedule.dailySchedule.daysInCycle,
          startTime: normalizeTime(policy.schedule.dailySchedule.startTime),
        }
      : undefined,
    weekly: weekly.length > 0 ? weekly : undefined,
    hourly: policy.schedule?.hourlySchedule
      ? {
          hoursInCycle: policy.schedule.hourlySchedule.hoursInCycle,
          startTime: normalizeTime(policy.schedule.hourlySchedule.startTime),
        }
      : undefined,
  };
};

const canonInstance = (policy: InstanceSchedulePolicy | undefined) => {
  if (policy === undefined) return undefined;
  return {
    timeZone: policy.timeZone,
    startTime: policy.startTime,
    expirationTime: policy.expirationTime,
    vmStart: policy.vmStartSchedule?.schedule,
    vmStop: policy.vmStopSchedule?.schedule,
  };
};

const subsetEqual = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (typeof desired !== typeof observed) return false;
  if (desired === null || observed === null) return desired === observed;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || desired.length !== observed.length) {
      return false;
    }
    return desired.every((item, index) => subsetEqual(observed[index], item));
  }
  if (typeof desired === "object") {
    if (typeof observed !== "object") return false;
    const current = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => value === undefined || subsetEqual(current[key], value),
    );
  }
  return observed === desired;
};

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const snapshotChanged = (
  observed: SnapshotSchedulePolicy | undefined,
  desired: SnapshotSchedulePolicy | undefined,
) => {
  if (desired === undefined) return false;
  return !subsetEqual(canonSnapshot(observed), canonSnapshot(desired));
};

const instanceChanged = (
  observed: InstanceSchedulePolicy | undefined,
  desired: InstanceSchedulePolicy | undefined,
) => {
  if (desired === undefined) return false;
  return !subsetEqual(canonInstance(observed), canonInstance(desired));
};

const immutablePolicyChanged = (
  news: ResourcePolicyProps,
  olds: Partial<ResourcePolicyProps> | undefined,
  output: ResourcePolicy["Attributes"] | undefined,
) => {
  const previousKind = policyKindOf(olds ?? output ?? {});
  const nextKind = policyKindOf(news);
  if (
    nextKind !== "none" &&
    previousKind !== "none" &&
    previousKind !== nextKind
  ) {
    return true;
  }
  if (nextKind === "placement") {
    return !sameJson(
      news.groupPlacementPolicy,
      olds?.groupPlacementPolicy ?? output?.groupPlacementPolicy,
    );
  }
  if (nextKind === "workload") {
    return !sameJson(
      news.workloadPolicy,
      olds?.workloadPolicy ?? output?.workloadPolicy,
    );
  }
  if (nextKind === "consistency") {
    const previous =
      olds?.diskConsistencyGroupPolicy ?? output?.diskConsistencyGroupPolicy;
    const next = news.diskConsistencyGroupPolicy;
    return (previous === undefined) !== (next === undefined);
  }
  return false;
};

const getByName = (project: string, region: string, resourcePolicy: string) =>
  compute
    .getResourcePolicies({ project, region, resourcePolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitPolicyReady = (
  project: string,
  region: string,
  resourcePolicyName: string,
) =>
  getByName(project, region, resourcePolicyName).pipe(
    Effect.flatMap((policy) =>
      policy?.status === "INVALID"
        ? Effect.fail(
            new ResourcePolicyFailed({
              resourcePolicyName,
              status: "INVALID",
            }),
          )
        : Effect.succeed(policy),
    ),
    Effect.filterOrFail(
      (policy): policy is compute.ResourcePolicy =>
        policy !== undefined && policy.status === "READY",
      (policy) =>
        new ResourcePolicyNotReady({
          resourcePolicyName,
          status: policy?.status ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.ResourcePolicyNotReady",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitPolicyGone = (
  project: string,
  region: string,
  resourcePolicyName: string,
) =>
  getByName(project, region, resourcePolicyName).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(
            new ResourcePolicyStillExists({
              resourcePolicyName,
              status: policy.status ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourcePolicyStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const ResourcePolicyProvider = () =>
  Provider.succeed(ResourcePolicy, {
    stables: [
      "resourcePolicyName",
      "resourcePolicyId",
      "project",
      "region",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousName =
        olds?.resourcePolicyName ?? output?.resourcePolicyName;
      const nextName = news.resourcePolicyName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;

      if (nameChanged || regionChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutablePolicyChanged(news, olds, output)) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const resourcePolicyName = yield* toName(
        id,
        olds?.resourcePolicyName,
        output?.resourcePolicyName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        resourcePolicyName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListResourcePolicies
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.resourcePolicies ?? [])
              .filter((policy) => hasOwnershipMarker(policy.description))
              .map((policy) => toAttrs(policy, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const resourcePolicyName = yield* toName(
        id,
        news.resourcePolicyName,
        output?.resourcePolicyName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(resourcePolicyName, news, ownership);

      let current = yield* getByName(env.project, region, resourcePolicyName);
      if (current?.status === "DELETING") {
        yield* waitPolicyGone(env.project, region, resourcePolicyName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertResourcePolicies({
            project: env.project,
            region,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitRegionOperation(env.project, region, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitPolicyReady(
          env.project,
          region,
          resourcePolicyName,
        );
      }

      if (current === undefined) {
        return yield* new ResourcePolicyNotResolved({
          resourcePolicyName,
          region,
        });
      }

      if (current.status === "CREATING") {
        current = yield* waitPolicyReady(
          env.project,
          region,
          resourcePolicyName,
        );
      }

      if (current === undefined) {
        return yield* new ResourcePolicyNotResolved({
          resourcePolicyName,
          region,
        });
      }

      const descriptionChanged =
        (current.description ?? "") !== (desired.description ?? "");
      const snapshotNeedsPatch = snapshotChanged(
        current.snapshotSchedulePolicy,
        news.snapshotSchedulePolicy,
      );
      const instanceNeedsPatch = instanceChanged(
        current.instanceSchedulePolicy,
        news.instanceSchedulePolicy,
      );

      if (descriptionChanged || snapshotNeedsPatch || instanceNeedsPatch) {
        const patched = yield* compute.patchResourcePolicies({
          project: env.project,
          region,
          resourcePolicy: resourcePolicyName,
          body: desired,
        });
        yield* waitRegionOperation(env.project, region, patched);
        current =
          (yield* getByName(env.project, region, resourcePolicyName)) ??
          (yield* waitPolicyReady(env.project, region, resourcePolicyName));
      }

      if (current === undefined) {
        return yield* new ResourcePolicyNotResolved({
          resourcePolicyName,
          region,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      const deleted = yield* compute
        .deleteResourcePolicies({
          project,
          region,
          resourcePolicy: output.resourcePolicyName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (deleted !== undefined) {
        yield* waitRegionOperation(project, region, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitPolicyGone(project, region, output.resourcePolicyName);
    }),
  });
