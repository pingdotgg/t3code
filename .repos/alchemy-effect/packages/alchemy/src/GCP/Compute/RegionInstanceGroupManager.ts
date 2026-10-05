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

const DEFAULT_TARGET_SIZE = 0;
const MAX_NAME_LENGTH = 63;
const MAX_BASE_NAME_LENGTH = 58;

export type RegionInstanceGroupManagerNamedPort = {
  /** RFC1035 name for this port mapping (e.g. `"http"`). */
  name: string;
  /** TCP port number (`1`–`65535`). */
  port: number;
};

export type RegionInstanceGroupManagerVersion = {
  /**
   * Instance template URL or name used for this version. The group
   * creates VMs from this template until `targetSize` is reached.
   */
  instanceTemplate?: string;
  /** Version name unique within this manager. */
  name?: string;
  /** Fixed count or percent of the group's `targetSize` for this version. */
  targetSize?: {
    fixed?: number;
    percent?: number;
  };
};

export type RegionInstanceGroupManagerProps = {
  /**
   * Manager name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the manager.
   */
  managerName?: string;
  /**
   * Region the manager lives in (e.g. `us-central1`). Immutable —
   * changing it replaces the manager. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Instance template URL or name used to create VMs. Accepts a name
   * (`web`), a partial URL (`projects/{project}/global/instanceTemplates/web`),
   * or a full self-link. Mutable in place via patch.
   */
  instanceTemplate: string;
  /**
   * Prefix attached to every VM name in the group (RFC1035, 1-58
   * characters). Defaults to the manager name truncated to 58 characters.
   * Immutable — changing it replaces the manager.
   */
  baseInstanceName?: string;
  /**
   * Optional description. Regional MIGs have no labels API, so Alchemy
   * stamps ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * into this field for `list` / nuke.
   */
  description?: string;
  /**
   * Target number of running VMs. Keep this `0` in tests unless you
   * intend to provision instances.
   * @default 0
   */
  targetSize?: number;
  /**
   * Named ports published on the complementary regional instance group.
   * When omitted, observed ports are left as-is. When set (including
   * `[]`), observed ports are replaced via `setNamedPorts`.
   */
  namedPorts?: RegionInstanceGroupManagerNamedPort[];
  /**
   * Canary / multi-template versions. When set, this field is patched
   * instead of the top-level `instanceTemplate`. Exactly one version must
   * leave `targetSize` unset.
   */
  versions?: RegionInstanceGroupManagerVersion[];
  /**
   * Autohealing health checks. When omitted, observed policy is left
   * as-is.
   */
  autoHealingPolicies?: compute.InstanceGroupManagerAutoHealingPolicy[];
  /**
   * Rolling-update policy (type, surge, redistribution). When omitted,
   * observed policy is left as-is.
   */
  updatePolicy?: compute.InstanceGroupManagerUpdatePolicy;
  /**
   * Zone distribution for the regional group. `zones` is immutable —
   * changing it replaces the manager. `targetShape` updates in place.
   */
  distributionPolicy?: compute.DistributionPolicy;
  /**
   * Target-pool URLs that receive new VMs. When omitted, observed pools
   * are left as-is.
   */
  targetPools?: string[];
  /**
   * Repair / failure policy for managed VMs. When omitted, observed
   * policy is left as-is.
   */
  instanceLifecyclePolicy?: compute.InstanceGroupManagerInstanceLifecyclePolicy;
};

export type RegionInstanceGroupManager = Resource<
  "GCP.Compute.RegionInstanceGroupManager",
  RegionInstanceGroupManagerProps,
  {
    /** Manager name. */
    managerName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User-facing description (ownership marker stripped). */
    description: string | undefined;
    /** Instance template URL currently configured on the group. */
    instanceTemplate: string | undefined;
    /** Prefix used for VM names. */
    baseInstanceName: string | undefined;
    /** Target number of running VMs. */
    targetSize: number;
    /** Named ports currently configured on the complementary group. */
    namedPorts: RegionInstanceGroupManagerNamedPort[];
    /** Template versions currently configured. */
    versions: RegionInstanceGroupManagerVersion[];
    /** Complementary instance-group URL. */
    instanceGroup: string | undefined;
    /** Server-assigned numeric id. */
    managerId: string | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Whether the group reports as stable. */
    isStable: boolean | undefined;
    /** Zone last-segments from the distribution policy, if any. */
    distributionPolicyZones: string[];
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine managed instance group.
 *
 * The manager creates and heals VMs from an instance template, spread
 * across zones in a region. Compute Engine has no labels on this
 * resource, so Alchemy stamps ownership into the description
 * (`[alchemy alchemy-stack=… alchemy-stage=… alchemy-id=…]`) so `list` /
 * `pnpm nuke:gcp` can find them.
 *
 * Name, region, `baseInstanceName`, and `distributionPolicy.zones` are
 * immutable — changing them replaces the manager. `targetSize`,
 * `instanceTemplate` / `versions`, description, autohealing, and update
 * policy patch in place. Named ports are synced onto the complementary
 * regional instance group.
 *
 * ### Creating a Regional MIG
 * **Example:** Generated name, no running VMs
 * ```typescript
 * const template = yield* GCP.Compute.InstanceTemplate("web", {});
 * const mig = yield* GCP.Compute.RegionInstanceGroupManager("web", {
 *   instanceTemplate: template.selfLink,
 *   targetSize: 0,
 * });
 * ```
 *
 * **Example:** Named group with named ports
 * ```typescript
 * const mig = yield* GCP.Compute.RegionInstanceGroupManager("web", {
 *   managerName: "web-mig",
 *   region: "us-central1",
 *   instanceTemplate:
 *     "projects/{project}/global/instanceTemplates/web",
 *   baseInstanceName: "web",
 *   targetSize: 3,
 *   namedPorts: [{ name: "http", port: 80 }],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionInstanceGroupManager = Resource<RegionInstanceGroupManager>(
  "GCP.Compute.RegionInstanceGroupManager",
);

export class RegionInstanceGroupManagerNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionInstanceGroupManagerNotResolved",
)<{
  managerName: string;
  region: string;
}> {}

export class RegionInstanceGroupManagerStillExists extends Data.TaggedError(
  "GCP.Compute.RegionInstanceGroupManagerStillExists",
)<{
  managerName: string;
  region: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.split("?")[0]!.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const rfc1035Name = (name: string, fallback: string, maxLength: number) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) {
    next = `m${next}`;
  }
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  return next.length > 0 ? next : fallback;
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return rfc1035Name(
      name ??
        existing ??
        (yield* createPhysicalName({
          id,
          maxLength: MAX_NAME_LENGTH,
          lowercase: true,
        })),
      "mig",
      MAX_NAME_LENGTH,
    );
  });

const toBaseName = (name: string | undefined, managerName: string) =>
  rfc1035Name(name ?? managerName, "mig", MAX_BASE_NAME_LENGTH);

const encodeDescription = (
  user: string | undefined,
  labels: Record<string, string>,
) => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const trimmed = user?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

const parseDescription = (description: string | undefined) => {
  if (!description?.startsWith("[alchemy ")) {
    return { user: description, labels: {} as Record<string, string> };
  }
  const end = description.indexOf("]");
  if (end < 0) {
    return { user: description, labels: {} as Record<string, string> };
  }
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description
    .slice(end + 1)
    .replace(/^\n/, "")
    .trim();
  return {
    user: rest.length > 0 ? rest : undefined,
    labels,
  };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toTemplateUrl = (project: string, template: string) =>
  template.includes("/")
    ? template
    : `projects/${project}/global/instanceTemplates/${template}`;

const canonPorts = (
  ports: readonly RegionInstanceGroupManagerNamedPort[] | undefined,
): RegionInstanceGroupManagerNamedPort[] =>
  [...(ports ?? [])]
    .map((port) => ({ name: port.name, port: port.port }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.port - b.port);

const samePorts = (
  left: readonly RegionInstanceGroupManagerNamedPort[] | undefined,
  right: readonly RegionInstanceGroupManagerNamedPort[] | undefined,
) => JSON.stringify(canonPorts(left)) === JSON.stringify(canonPorts(right));

const fromApiPorts = (
  ports: readonly compute.NamedPort[] | undefined,
): RegionInstanceGroupManagerNamedPort[] =>
  canonPorts(
    (ports ?? [])
      .filter(
        (port): port is { name: string; port: number } =>
          typeof port.name === "string" && typeof port.port === "number",
      )
      .map((port) => ({ name: port.name, port: port.port })),
  );

const fromApiVersions = (
  versions: readonly compute.InstanceGroupManagerVersion[] | undefined,
): RegionInstanceGroupManagerVersion[] =>
  (versions ?? []).map((version) => ({
    instanceTemplate: version.instanceTemplate,
    name: version.name,
    targetSize: version.targetSize
      ? {
          fixed: version.targetSize.fixed,
          percent: version.targetSize.percent,
        }
      : undefined,
  }));

const sortedRefs = (values: readonly string[] | undefined) =>
  [...(values ?? [])].map(lastSegment).filter(Boolean).sort();

const sameRefs = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => JSON.stringify(sortedRefs(left)) === JSON.stringify(sortedRefs(right));

const zonesOf = (policy: compute.DistributionPolicy | undefined) =>
  sortedRefs((policy?.zones ?? []).map((zone) => zone.zone ?? ""));

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

const versionsChanged = (
  observed: readonly compute.InstanceGroupManagerVersion[] | undefined,
  desired: readonly RegionInstanceGroupManagerVersion[] | undefined,
) => {
  if (desired === undefined) return false;
  const left = (observed ?? []).map((version) => ({
    name: version.name ?? "",
    instanceTemplate: lastSegment(version.instanceTemplate),
    targetSize: version.targetSize ?? {},
  }));
  const right = desired.map((version) => ({
    name: version.name ?? "",
    instanceTemplate: lastSegment(version.instanceTemplate),
    targetSize: version.targetSize ?? {},
  }));
  return !sameJson(left, right);
};

const toAttrs = (manager: compute.InstanceGroupManager, project: string) => {
  const { user } = parseDescription(manager.description);
  return {
    managerName: manager.name ?? lastSegment(manager.selfLink),
    project,
    region: lastSegment(manager.region).toLowerCase(),
    description: user,
    instanceTemplate: manager.instanceTemplate,
    baseInstanceName: manager.baseInstanceName,
    targetSize: manager.targetSize ?? 0,
    namedPorts: fromApiPorts(manager.namedPorts),
    versions: fromApiVersions(manager.versions),
    instanceGroup: manager.instanceGroup,
    managerId: manager.id,
    selfLink: manager.selfLink,
    creationTimestamp: manager.creationTimestamp,
    isStable: manager.status?.isStable,
    distributionPolicyZones: zonesOf(manager.distributionPolicy),
  };
};

const getByName = (
  project: string,
  region: string,
  instanceGroupManager: string,
) =>
  compute
    .getRegionInstanceGroupManagers({
      project,
      region,
      instanceGroupManager,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilPresent = (
  project: string,
  region: string,
  managerName: string,
) =>
  getByName(project, region, managerName).pipe(
    Effect.flatMap((manager) =>
      manager !== undefined
        ? Effect.succeed(manager)
        : Effect.fail(
            new RegionInstanceGroupManagerNotResolved({
              managerName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionInstanceGroupManagerNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("GCP.Compute.RegionInstanceGroupManagerNotResolved", () =>
      Effect.succeed(undefined),
    ),
  );

const waitUntilGone = (project: string, region: string, managerName: string) =>
  getByName(project, region, managerName).pipe(
    Effect.flatMap((manager) =>
      manager === undefined
        ? Effect.void
        : Effect.fail(
            new RegionInstanceGroupManagerStillExists({
              managerName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionInstanceGroupManagerStillExists",
      times: 15,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const getInstanceGroup = (
  project: string,
  region: string,
  instanceGroup: string,
) =>
  compute
    .getRegionInstanceGroups({ project, region, instanceGroup })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const syncNamedPorts = (
  project: string,
  region: string,
  managerName: string,
  instanceGroupUrl: string | undefined,
  namedPorts: RegionInstanceGroupManagerNamedPort[],
) =>
  Effect.gen(function* () {
    const instanceGroup = lastSegment(instanceGroupUrl) || managerName;
    const group = yield* getInstanceGroup(project, region, instanceGroup).pipe(
      Effect.flatMap((current) =>
        current !== undefined
          ? Effect.succeed(current)
          : Effect.fail(
              new RegionInstanceGroupManagerNotResolved({
                managerName,
                region,
              }),
            ),
      ),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.Compute.RegionInstanceGroupManagerNotResolved",
        times: 8,
        schedule: Schedule.spaced("1 second"),
      }),
    );
    const operation = yield* compute
      .setNamedPortsRegionInstanceGroups({
        project,
        region,
        instanceGroup,
        body: {
          namedPorts,
          fingerprint: group.fingerprint,
        },
      })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 5,
          schedule: Schedule.exponential("250 millis"),
        }),
      );
    yield* waitRegionOperation(project, region, operation);
  });

const toVersionBodies = (
  project: string,
  versions: readonly RegionInstanceGroupManagerVersion[],
): compute.InstanceGroupManagerVersion[] =>
  versions.map((version) => ({
    name: version.name,
    instanceTemplate:
      version.instanceTemplate !== undefined
        ? toTemplateUrl(project, version.instanceTemplate)
        : undefined,
    targetSize: version.targetSize,
  }));

export const RegionInstanceGroupManagerProvider = () =>
  Provider.succeed(RegionInstanceGroupManager, {
    stables: [
      "managerName",
      "project",
      "region",
      "baseInstanceName",
      "managerId",
      "instanceGroup",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.managerName ?? output?.managerName;
      const nextName = news.managerName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const previousBase =
        olds?.baseInstanceName ?? output?.baseInstanceName ?? previousName;
      const nextBase =
        news.baseInstanceName !== undefined
          ? toBaseName(news.baseInstanceName, nextName ?? previousName ?? "mig")
          : previousBase;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const regionChanged = previousRegion !== nextRegion;
      const baseChanged =
        previousBase !== undefined &&
        nextBase !== undefined &&
        previousBase !== nextBase;
      const previousZones =
        olds?.distributionPolicy !== undefined
          ? zonesOf(olds.distributionPolicy)
          : (output?.distributionPolicyZones ?? []);
      const nextZones = zonesOf(news.distributionPolicy);
      const zonesChanged =
        news.distributionPolicy?.zones !== undefined &&
        previousZones.length > 0 &&
        nextZones.length > 0 &&
        !sameJson(previousZones, nextZones);
      if (!nameChanged && !regionChanged && !baseChanged && !zonesChanged) {
        return undefined;
      }
      const sameIdentity =
        previousName === nextName && previousRegion === nextRegion;
      return {
        action: "replace" as const,
        deleteFirst: sameIdentity,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const managerName = yield* toName(
        id,
        olds?.managerName,
        output?.managerName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, managerName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListInstanceGroupManagers
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.entries(page.items ?? {}).flatMap(([scope, scoped]) => {
            if (!scope.startsWith("regions/")) return [];
            return (scoped?.instanceGroupManagers ?? [])
              .filter(
                (manager) =>
                  hasOwnershipMarker(manager.description) &&
                  lastSegment(manager.region).length > 0,
              )
              .map((manager) => toAttrs(manager, env.project));
          }),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const managerName = yield* toName(
        id,
        news.managerName,
        output?.managerName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(news.description, ownership);
      const instanceTemplate = toTemplateUrl(
        env.project,
        news.instanceTemplate,
      );
      const baseInstanceName = toBaseName(news.baseInstanceName, managerName);
      const targetSize = news.targetSize ?? DEFAULT_TARGET_SIZE;
      const namedPorts =
        news.namedPorts !== undefined ? canonPorts(news.namedPorts) : undefined;

      let current = yield* getByName(env.project, region, managerName);

      if (current === undefined) {
        yield* compute
          .insertRegionInstanceGroupManagers({
            project: env.project,
            region,
            body: {
              name: managerName,
              description,
              instanceTemplate,
              baseInstanceName,
              targetSize,
              namedPorts:
                namedPorts !== undefined && namedPorts.length > 0
                  ? namedPorts
                  : undefined,
              versions:
                news.versions !== undefined
                  ? toVersionBodies(env.project, news.versions)
                  : undefined,
              autoHealingPolicies: news.autoHealingPolicies,
              updatePolicy: news.updatePolicy,
              distributionPolicy: news.distributionPolicy,
              targetPools: news.targetPools,
              instanceLifecyclePolicy: news.instanceLifecyclePolicy,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.flatMap((operation) =>
              operation === undefined
                ? Effect.void
                : waitRegionOperation(env.project, region, operation, {
                    ignore: ["RESOURCE_ALREADY_EXISTS"],
                  }).pipe(Effect.asVoid),
            ),
          );
        current = yield* waitUntilPresent(env.project, region, managerName);
      }

      if (current === undefined) {
        return yield* new RegionInstanceGroupManagerNotResolved({
          managerName,
          region,
        });
      }

      const patch: compute.InstanceGroupManager = {
        fingerprint: current.fingerprint,
      };
      let dirty = false;

      if ((current.description ?? "") !== description) {
        patch.description = description;
        dirty = true;
      }
      if ((current.targetSize ?? 0) !== targetSize) {
        patch.targetSize = targetSize;
        dirty = true;
      }
      if (
        lastSegment(current.instanceTemplate) !== lastSegment(instanceTemplate)
      ) {
        patch.instanceTemplate = instanceTemplate;
        dirty = true;
      }
      if (versionsChanged(current.versions, news.versions)) {
        patch.versions = toVersionBodies(env.project, news.versions ?? []);
        dirty = true;
      }
      if (
        news.autoHealingPolicies !== undefined &&
        !subsetEqual(
          current.autoHealingPolicies ?? [],
          news.autoHealingPolicies,
        )
      ) {
        patch.autoHealingPolicies = news.autoHealingPolicies;
        dirty = true;
      }
      if (
        news.updatePolicy !== undefined &&
        !subsetEqual(current.updatePolicy ?? {}, news.updatePolicy)
      ) {
        patch.updatePolicy = news.updatePolicy;
        dirty = true;
      }
      if (
        news.targetPools !== undefined &&
        !sameRefs(current.targetPools, news.targetPools)
      ) {
        patch.targetPools = news.targetPools;
        dirty = true;
      }
      if (
        news.instanceLifecyclePolicy !== undefined &&
        !subsetEqual(
          current.instanceLifecyclePolicy ?? {},
          news.instanceLifecyclePolicy,
        )
      ) {
        patch.instanceLifecyclePolicy = news.instanceLifecyclePolicy;
        dirty = true;
      }
      if (
        news.distributionPolicy?.targetShape !== undefined &&
        news.distributionPolicy.targetShape !==
          current.distributionPolicy?.targetShape
      ) {
        patch.distributionPolicy = {
          targetShape: news.distributionPolicy.targetShape,
        };
        dirty = true;
      }

      if (dirty) {
        yield* compute
          .patchRegionInstanceGroupManagers({
            project: env.project,
            region,
            instanceGroupManager: managerName,
            body: patch,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
          );
        current =
          (yield* getByName(env.project, region, managerName)) ?? current;
      }

      if (
        namedPorts !== undefined &&
        !samePorts(fromApiPorts(current.namedPorts), namedPorts)
      ) {
        yield* syncNamedPorts(
          env.project,
          region,
          managerName,
          current.instanceGroup,
          namedPorts,
        );
        current =
          (yield* getByName(env.project, region, managerName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      const operation = yield* compute
        .deleteRegionInstanceGroupManagers({
          project,
          region,
          instanceGroupManager: output.managerName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitRegionOperation(project, region, operation, {
          ignore: ["RESOURCE_NOT_FOUND"],
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitUntilGone(project, region, output.managerName);
    }),
  });
