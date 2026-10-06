import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./internal.ts";

const DEFAULT_LOCATION = "global";
const DEFAULT_USAGE =
  "FOR_VPC" satisfies networkconnectivity.InternalRangeUsageEnum;
const DEFAULT_PEERING =
  "FOR_SELF" satisfies networkconnectivity.InternalRangePeeringEnum;
const MAX_NAME_LENGTH = 63;

export type InternalRangeUsage =
  | networkconnectivity.InternalRangeUsageEnum
  | (string & {});
export type InternalRangePeering =
  | networkconnectivity.InternalRangePeeringEnum
  | (string & {});
export type InternalRangeOverlap =
  | networkconnectivity.InternalRangeOverlapsItemEnum
  | (string & {});
export type InternalRangeAllocationStrategy =
  | networkconnectivity.AllocationOptionsAllocationStrategyEnum
  | (string & {});

export type InternalRangeAllocationOptions = {
  /**
   * Auto-allocation strategy used when `ipCidrRange` is omitted and
   * `prefixLength` is set.
   */
  allocationStrategy?: InternalRangeAllocationStrategy;
  /**
   * Maximum expected parallelism of range-creation requests against the
   * same peered space. Required when `allocationStrategy` is
   * `RANDOM_FIRST_N_AVAILABLE`.
   */
  firstAvailableRangesLookupSize?: number;
};

export type InternalRangeMigration = {
  /**
   * Source subnet URI, e.g.
   * `/projects/{project}/regions/{region}/subnetworks/{subnet}`.
   * Required when `usage` is `FOR_MIGRATION`.
   */
  source: string;
  /**
   * Target subnet URI. The target project may differ (peer-network
   * migration).
   */
  target: string;
};

export type InternalRangeProps = {
  /**
   * Internal range id (the `{internal_range}` segment of
   * `projects/{project}/locations/{location}/internalRanges/{internal_range}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it replaces the
   * range.
   */
  internalRangeId?: string;
  /**
   * Location of the range. Internal ranges are global — always `"global"`.
   * Immutable — changing it replaces the range. `GLOBAL` is accepted and
   * normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * VPC network to reserve the range in. Accepts a name (`app-vpc`), a
   * resource path (`projects/{project}/global/networks/{network}`), or a
   * Compute self-link. Immutable — changing it replaces the range.
   */
  network: string;
  /**
   * How the range may be used. `FOR_VPC` can be associated with VPC
   * resources; `EXTERNAL_TO_VPC` blocks space (on-prem, advertised
   * routes); `FOR_MIGRATION` locks a subnet during peer-VPC migration.
   * Immutable — changing it replaces the range.
   * @default "FOR_VPC"
   */
  usage?: InternalRangeUsage;
  /**
   * Peering behavior. `FOR_SELF` (default) is used in this VPC and
   * visible to peers; `FOR_PEER` donates the range to peers;
   * `NOT_SHARED` keeps it local. Immutable — changing it replaces the
   * range.
   * @default "FOR_SELF"
   */
  peering?: InternalRangePeering;
  /**
   * Explicit CIDR this range reserves (e.g. `"10.0.0.0/24"`). Required
   * unless `prefixLength` is set. IPv6 ranges must set this field.
   */
  ipCidrRange?: string;
  /**
   * Auto-allocate a free block of this prefix length when
   * `ipCidrRange` is omitted. If both are set, the sizes must match.
   * Updates may resize the range.
   */
  prefixLength?: number;
  /**
   * Address spaces to search when auto-allocating. Defaults to RFC1918
   * (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
   */
  targetCidrRange?: string[];
  /**
   * CIDR blocks to skip during auto-allocation, without reserving them.
   */
  excludeCidrRanges?: string[];
  /**
   * Overlaps to allow (`OVERLAP_ROUTE_RANGE`,
   * `OVERLAP_EXISTING_SUBNET_RANGE`).
   */
  overlaps?: InternalRangeOverlap[];
  /**
   * Human-readable description of the range.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * When true, only `labels` and `description` can change after create.
   * Immutable — changing it replaces the range.
   * @default false
   */
  immutable?: boolean;
  /**
   * Auto-allocation options. Set only when allocating by `prefixLength`.
   */
  allocationOptions?: InternalRangeAllocationOptions;
  /**
   * Source and target subnet URIs. Required (and only valid) when
   * `usage` is `FOR_MIGRATION`. Immutable — changing it replaces the
   * range.
   */
  migration?: InternalRangeMigration;
};

export type InternalRange = Resource<
  "GCP.NetworkConnectivity.InternalRange",
  InternalRangeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/internalRanges/{internal_range}`. */
    name: string;
    /** Internal range id (last path segment). */
    internalRangeId: string;
    /** Project id. */
    project: string;
    /** Location id. Internal ranges are global — always `"global"`. */
    location: string;
    /** Network URI as reported by the API. */
    network: string | undefined;
    /** VPC network id (last path segment). */
    networkName: string | undefined;
    /** Usage mode. */
    usage: string | undefined;
    /** Peering mode. */
    peering: string | undefined;
    /** Allocated CIDR. */
    ipCidrRange: string | undefined;
    /** Prefix length used for allocation or reported size. */
    prefixLength: number | undefined;
    /** Auto-allocation search spaces. */
    targetCidrRange: ReadonlyArray<string>;
    /** CIDRs excluded from auto-allocation. */
    excludeCidrRanges: ReadonlyArray<string>;
    /** Allowed overlap types. */
    overlaps: ReadonlyArray<string>;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether the range is immutable besides labels/description. */
    immutable: boolean;
    /** Auto-allocation options, if set. */
    allocationOptions: InternalRangeAllocationOptions | undefined;
    /** Migration endpoints, if set. */
    migration: InternalRangeMigration | undefined;
    /** Resources currently using this range (output-only). */
    users: ReadonlyArray<string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Connectivity internal range — an IPAM reservation inside a
 * VPC, with usage and peering behavior.
 *
 * Ranges live at `locations/global`. `internalRangeId`, `location`,
 * `network`, `usage`, `peering`, `immutable`, and `migration` are
 * immutable. Description, labels, CIDR, prefix length, overlaps, target
 * CIDRs, exclude CIDRs, and allocation options update in place.
 *
 * ### Creating an Internal Range
 * **Example:** Generated name on a custom VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const range = yield* GCP.NetworkConnectivity.InternalRange("Reserved", {
 *   network: network.selfLink ?? network.networkName,
 *   usage: "FOR_VPC",
 *   peering: "FOR_SELF",
 *   ipCidrRange: "10.0.0.0/24",
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and description
 * ```typescript
 * const range = yield* GCP.NetworkConnectivity.InternalRange("Reserved", {
 *   internalRangeId: "app-reserved",
 *   network: "projects/{project}/global/networks/app-vpc",
 *   usage: "FOR_VPC",
 *   peering: "FOR_SELF",
 *   ipCidrRange: "10.0.0.0/24",
 *   description: "app subnet space",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Auto-allocation
 * **Example:** Free /24 from a target space
 * ```typescript
 * const range = yield* GCP.NetworkConnectivity.InternalRange("Reserved", {
 *   network: network.networkName,
 *   usage: "FOR_VPC",
 *   peering: "FOR_SELF",
 *   prefixLength: 24,
 *   targetCidrRange: ["192.168.0.0/16"],
 *   allocationOptions: { allocationStrategy: "FIRST_SMALLEST_FITTING" },
 * });
 * ```
 *
 * ### External reservation
 * **Example:** Block on-prem space
 * ```typescript
 * const range = yield* GCP.NetworkConnectivity.InternalRange("OnPrem", {
 *   network: network.networkName,
 *   usage: "EXTERNAL_TO_VPC",
 *   peering: "FOR_SELF",
 *   ipCidrRange: "172.16.0.0/24",
 *   labels: { role: "on-prem" },
 * });
 * ```
 *
 * ### Updating an Internal Range
 * **Example:** Description and labels
 * ```typescript
 * const range = yield* GCP.NetworkConnectivity.InternalRange("Reserved", {
 *   internalRangeId: "app-reserved",
 *   network: "app-vpc",
 *   usage: "FOR_VPC",
 *   peering: "FOR_SELF",
 *   ipCidrRange: "10.0.0.0/24",
 *   description: "app subnet space v2",
 *   labels: { env: "prod", role: "ipam" },
 * });
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const InternalRange = Resource<InternalRange>(
  "GCP.NetworkConnectivity.InternalRange",
);

export class InternalRangeNotResolved extends Data.TaggedError(
  "GCP.NetworkConnectivity.InternalRangeNotResolved",
)<{
  name: string;
}> {}

export class InternalRangeRangeMissing extends Data.TaggedError(
  "GCP.NetworkConnectivity.InternalRangeRangeMissing",
)<{
  name: string;
  message: string;
}> {}

export class InternalRangeStillExists extends Data.TaggedError(
  "GCP.NetworkConnectivity.InternalRangeStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `r${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "internalrange";
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const normalizeUsage = (usage: string | undefined) =>
  (usage ?? DEFAULT_USAGE).toUpperCase();

const normalizePeering = (peering: string | undefined) =>
  (peering ?? DEFAULT_PEERING).toUpperCase();

const networkNameOf = (network: string | undefined) =>
  network === undefined || network.length === 0
    ? undefined
    : lastSegment(network);

const toNetworkResource = (project: string, network: string) => {
  const trimmed = network.trim();
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/global/networks/${trimmed}`;
};

const resourceName = (
  project: string,
  location: string,
  internalRangeId: string,
) =>
  `projects/${project}/locations/${location}/internalRanges/${internalRangeId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const rangesAt = parts.lastIndexOf("internalRanges");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    internalRangeId:
      rangesAt >= 0 && parts[rangesAt + 1]
        ? parts[rangesAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  internalRangeId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (internalRangeId !== undefined) return internalRangeId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const toAllocationOptions = (
  options: networkconnectivity.AllocationOptions | undefined,
): InternalRangeAllocationOptions | undefined => {
  if (options === undefined) return undefined;
  if (
    options.allocationStrategy === undefined &&
    options.firstAvailableRangesLookupSize === undefined
  ) {
    return undefined;
  }
  return {
    allocationStrategy: options.allocationStrategy,
    firstAvailableRangesLookupSize: options.firstAvailableRangesLookupSize,
  };
};

const toMigration = (
  migration: networkconnectivity.Migration | undefined,
): InternalRangeMigration | undefined => {
  if (
    migration === undefined ||
    (migration.source === undefined && migration.target === undefined)
  ) {
    return undefined;
  }
  return {
    source: migration.source ?? "",
    target: migration.target ?? "",
  };
};

const toAttrs = (range: networkconnectivity.InternalRange, project: string) => {
  const name = range.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    internalRangeId: parsed.internalRangeId,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    network: range.network,
    networkName: networkNameOf(range.network),
    usage: range.usage,
    peering: range.peering,
    ipCidrRange: range.ipCidrRange,
    prefixLength: range.prefixLength,
    targetCidrRange: range.targetCidrRange ?? [],
    excludeCidrRanges: range.excludeCidrRanges ?? [],
    overlaps: range.overlaps ?? [],
    description: range.description,
    labels: userLabels(range.labels),
    immutable: range.immutable === true,
    allocationOptions: toAllocationOptions(range.allocationOptions),
    migration: toMigration(range.migration),
    users: range.users ?? [],
    createTime: range.createTime,
    updateTime: range.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsInternalRanges({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((range) =>
      range
        ? Effect.succeed(range)
        : Effect.fail(new InternalRangeNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.InternalRangeNotResolved",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((range) =>
      range === undefined
        ? Effect.void
        : Effect.fail(new InternalRangeStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.InternalRangeStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listOwnedInternalRanges = (parent: string, project: string) =>
  networkconnectivity.listProjectsLocationsInternalRanges
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.internalRanges ?? [])),
      Stream.filter((range) =>
        Object.keys(range.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((range) => toAttrs(range, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const sameList = (left?: readonly string[], right?: readonly string[]) =>
  [...(left ?? [])].sort().join("\0") === [...(right ?? [])].sort().join("\0");

const sameAllocation = (
  left: InternalRangeAllocationOptions | undefined,
  right: networkconnectivity.AllocationOptions | undefined,
) =>
  (left?.allocationStrategy ?? "") === (right?.allocationStrategy ?? "") &&
  (left?.firstAvailableRangesLookupSize ?? undefined) ===
    (right?.firstAvailableRangesLookupSize ?? undefined);

const sameMigration = (
  left: InternalRangeMigration | undefined,
  right: InternalRangeMigration | undefined,
) =>
  (left?.source ?? "") === (right?.source ?? "") &&
  (left?.target ?? "") === (right?.target ?? "");

const toCreateBody = (
  news: InternalRangeProps,
  project: string,
  desiredLabels: Record<string, string>,
): networkconnectivity.InternalRange => ({
  description: news.description,
  labels: desiredLabels,
  network: toNetworkResource(project, news.network),
  usage: news.usage ?? DEFAULT_USAGE,
  peering: news.peering ?? DEFAULT_PEERING,
  ipCidrRange: news.ipCidrRange,
  prefixLength: news.prefixLength,
  targetCidrRange: news.targetCidrRange,
  excludeCidrRanges: news.excludeCidrRanges,
  overlaps: news.overlaps,
  immutable: news.immutable,
  allocationOptions: news.allocationOptions,
  migration: news.migration,
});

export const InternalRangeProvider = () =>
  Provider.succeed(InternalRange, {
    stables: [
      "name",
      "internalRangeId",
      "project",
      "location",
      "networkName",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.internalRangeId ?? output?.internalRangeId;
      const nextId = news.internalRangeId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const locationChanged = previousLocation !== nextLocation;

      const previousNetwork = networkNameOf(
        olds?.network ?? output?.networkName ?? output?.network,
      );
      const nextNetwork = networkNameOf(news.network ?? previousNetwork);
      const networkChanged =
        previousNetwork !== undefined &&
        nextNetwork !== undefined &&
        previousNetwork !== nextNetwork;

      const previousUsage = normalizeUsage(olds?.usage ?? output?.usage);
      const nextUsage = normalizeUsage(
        news.usage ?? olds?.usage ?? output?.usage,
      );
      const usageChanged = previousUsage !== nextUsage;

      const previousPeering = normalizePeering(
        olds?.peering ?? output?.peering,
      );
      const nextPeering = normalizePeering(
        news.peering ?? olds?.peering ?? output?.peering,
      );
      const peeringChanged = previousPeering !== nextPeering;

      const previousImmutable = olds?.immutable ?? output?.immutable ?? false;
      const nextImmutable = news.immutable ?? previousImmutable;
      const immutableChanged = previousImmutable !== nextImmutable;

      const previousMigration = olds?.migration ?? output?.migration;
      const nextMigration = news.migration ?? previousMigration;
      const migrationChanged = !sameMigration(previousMigration, nextMigration);

      if (
        !idChanged &&
        !locationChanged &&
        !networkChanged &&
        !usageChanged &&
        !peeringChanged &&
        !immutableChanged &&
        !migrationChanged
      ) {
        return undefined;
      }

      return {
        action: "replace" as const,
        deleteFirst:
          !idChanged &&
          !locationChanged &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const internalRangeId = yield* toId(
        id,
        olds?.internalRangeId,
        output?.internalRangeId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, internalRangeId);
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
        const aggregated = yield* listOwnedInternalRanges(
          parentOf(env.project, "-"),
          env.project,
        );
        if (aggregated.length > 0) return aggregated;
        return yield* listOwnedInternalRanges(
          parentOf(env.project, DEFAULT_LOCATION),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const internalRangeId = yield* toId(
        id,
        news.internalRangeId,
        output?.internalRangeId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, internalRangeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        if (news.ipCidrRange === undefined && news.prefixLength === undefined) {
          return yield* new InternalRangeRangeMissing({
            name,
            message:
              "InternalRange requires ipCidrRange or prefixLength on create",
          });
        }
        const created = yield* networkconnectivity
          .createProjectsLocationsInternalRanges({
            parent: parentOf(env.project, location),
            internalRangeId,
            body: toCreateBody(news, env.project, desiredLabels),
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new InternalRangeNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const cidrChanged =
        news.ipCidrRange !== undefined &&
        (current.ipCidrRange ?? "") !== news.ipCidrRange;
      const prefixChanged =
        news.prefixLength !== undefined &&
        current.prefixLength !== news.prefixLength;
      const targetChanged =
        news.targetCidrRange !== undefined &&
        !sameList(news.targetCidrRange, current.targetCidrRange);
      const excludeChanged =
        news.excludeCidrRanges !== undefined &&
        !sameList(news.excludeCidrRanges, current.excludeCidrRanges);
      const overlapsChanged =
        news.overlaps !== undefined &&
        !sameList(news.overlaps, current.overlaps);
      const allocationChanged =
        news.allocationOptions !== undefined &&
        !sameAllocation(news.allocationOptions, current.allocationOptions);

      const locked = current.immutable === true;
      const mutableChanged =
        !locked &&
        (cidrChanged ||
          prefixChanged ||
          targetChanged ||
          excludeChanged ||
          overlapsChanged ||
          allocationChanged);

      if (labelsChanged || descriptionChanged || mutableChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          !locked && cidrChanged ? "ipCidrRange" : undefined,
          !locked && prefixChanged ? "prefixLength" : undefined,
          !locked && targetChanged ? "targetCidrRange" : undefined,
          !locked && excludeChanged ? "excludeCidrRanges" : undefined,
          !locked && overlapsChanged ? "overlaps" : undefined,
          !locked && allocationChanged ? "allocationOptions" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networkconnectivity.patchProjectsLocationsInternalRanges({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              ipCidrRange: news.ipCidrRange,
              prefixLength: news.prefixLength,
              targetCidrRange: news.targetCidrRange,
              excludeCidrRanges: news.excludeCidrRanges,
              overlaps: news.overlaps,
              allocationOptions: news.allocationOptions,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsInternalRanges({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
