import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitZoneOperation } from "./operations.ts";
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

export type InstanceGroupManagerNamedPort = {
  /** RFC1035 name for this port mapping (e.g. `"http"`). */
  name: string;
  /** TCP port number (`1`–`65535`). */
  port: number;
};

export type InstanceGroupManagerAutoHealingPolicy = {
  /**
   * Health check URL or name. Names expand to
   * `projects/{project}/global/healthChecks/{name}`.
   */
  healthCheck: string;
  /**
   * Seconds to ignore failed health checks after a VM is created
   * (`0`–`3600`).
   * @default 0
   */
  initialDelaySec?: number;
};

export type InstanceGroupManagerUpdatePolicy =
  compute.InstanceGroupManagerUpdatePolicy;

export type InstanceGroupManagerProps = {
  /**
   * Name of the managed instance group. Must be 1–63 characters and comply
   * with RFC1035. If omitted, a unique name is generated from the stack,
   * stage, and logical id. Changing this replaces the group.
   */
  managerName?: string;
  /**
   * Zone of the group (e.g. `"us-central1-a"`). Immutable — changing it
   * replaces the group.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Instance template URL or name used to create VMs. Names expand to
   * `projects/{project}/global/instanceTemplates/{name}`.
   */
  instanceTemplate: string;
  /**
   * Target number of running VMs. `0` creates an empty group.
   * @default 0
   */
  targetSize?: number;
  /**
   * Prefix for VM names (RFC1035, max 58 characters). Defaults to the
   * manager name. Immutable — changing it replaces the group.
   */
  baseInstanceName?: string;
  /**
   * Optional description. Managed instance groups have no labels API, so
   * Alchemy stamps ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) into this field for `list` / nuke.
   */
  description?: string;
  /**
   * Named ports applied to the complementary instance group (the manager
   * field is output-only; updates use `instanceGroups.setNamedPorts`).
   */
  namedPorts?: InstanceGroupManagerNamedPort[];
  /**
   * Autohealing policy (one health check). Omit to leave the observed
   * policy unchanged.
   */
  autoHealingPolicies?: InstanceGroupManagerAutoHealingPolicy[];
  /**
   * Rolling-update policy. Omit to leave the observed policy unchanged.
   */
  updatePolicy?: InstanceGroupManagerUpdatePolicy;
  /**
   * Target-pool URLs or names that receive the group's VMs. Omit to leave
   * observed pools unchanged.
   */
  targetPools?: string[];
  /**
   * Repair / failure policy for managed VMs (e.g.
   * `{ defaultActionOnFailure: "DO_NOTHING" }`, which resize requests
   * require). Omit to leave the observed policy unchanged.
   */
  instanceLifecyclePolicy?: compute.InstanceGroupManagerInstanceLifecyclePolicy;
};

export type InstanceGroupManager = Resource<
  "GCP.Compute.InstanceGroupManager",
  InstanceGroupManagerProps,
  {
    /** Managed instance group name. */
    managerName: string;
    /** Zone (short name, e.g. `"us-central1-a"`). */
    zone: string;
    /** Project id. */
    project: string;
    /** Instance template URL. */
    instanceTemplate: string | undefined;
    /** Target number of running VMs. */
    targetSize: number;
    /** Prefix used for VM names. */
    baseInstanceName: string | undefined;
    /** User-facing description (ownership marker stripped). */
    description: string | undefined;
    /** Named ports currently configured on the group. */
    namedPorts: InstanceGroupManagerNamedPort[];
    /** Complementary unmanaged instance group URL. */
    instanceGroup: string | undefined;
    /** Whether the group is currently stable. */
    isStable: boolean | undefined;
    /** Server-generated resource URL. */
    selfLink: string | undefined;
    /** Server-generated numeric id. */
    id: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine managed instance group (MIG).
 *
 * The group creates VMs from an instance template and maintains
 * `targetSize`. Alchemy records ownership in the description so
 * `list` / `pnpm nuke:gcp` can find groups (MIGs have no labels API).
 * Changing `managerName`, `zone`, or `baseInstanceName` replaces the
 * group.
 *
 * ### Creating a Managed Instance Group
 * **Example:** Generated name, empty group
 * ```typescript
 * const template = yield* GCP.Compute.InstanceTemplate("web", {});
 * const group = yield* GCP.Compute.InstanceGroupManager("web", {
 *   instanceTemplate: template.templateName,
 * });
 * ```
 *
 * **Example:** Named ports and target size
 * ```typescript
 * const template = yield* GCP.Compute.InstanceTemplate("web", {});
 * const group = yield* GCP.Compute.InstanceGroupManager("web", {
 *   managerName: "web-mig",
 *   zone: "us-central1-a",
 *   instanceTemplate: template.templateName,
 *   targetSize: 2,
 *   namedPorts: [{ name: "http", port: 80 }],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const InstanceGroupManager = Resource<InstanceGroupManager>(
  "GCP.Compute.InstanceGroupManager",
);

export class InstanceGroupManagerNotResolved extends Data.TaggedError(
  "GCP.Compute.InstanceGroupManagerNotResolved",
)<{
  managerName: string;
  zone: string;
}> {}

export class InstanceGroupManagerStillExists extends Data.TaggedError(
  "GCP.Compute.InstanceGroupManagerStillExists",
)<{
  managerName: string;
  zone: string;
}> {}

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_TARGET_SIZE = 0;
const MAX_NAME_LENGTH = 63;
const MAX_BASE_NAME_LENGTH = 58;

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? value;
};

const rfc1035Name = (name: string, maxLength = MAX_NAME_LENGTH) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) {
    next = `m${next}`;
  }
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  return next.length > 0 ? next : "mig";
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
    );
  });

const toBaseInstanceName = (managerName: string, explicit?: string) =>
  rfc1035Name(explicit ?? managerName, MAX_BASE_NAME_LENGTH);

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

const toHealthCheckUrl = (project: string, healthCheck: string) =>
  healthCheck.includes("/")
    ? healthCheck
    : `projects/${project}/global/healthChecks/${healthCheck}`;

const toTargetPoolUrl = (project: string, zone: string, pool: string) => {
  if (pool.includes("/")) return pool;
  const region = zone.slice(0, zone.lastIndexOf("-"));
  return `projects/${project}/regions/${region}/targetPools/${pool}`;
};

const canonPorts = (
  ports: readonly InstanceGroupManagerNamedPort[] | undefined,
): InstanceGroupManagerNamedPort[] =>
  [...(ports ?? [])]
    .map((port) => ({ name: port.name, port: port.port }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.port - b.port);

const samePorts = (
  left: readonly InstanceGroupManagerNamedPort[] | undefined,
  right: readonly InstanceGroupManagerNamedPort[] | undefined,
) => JSON.stringify(canonPorts(left)) === JSON.stringify(canonPorts(right));

const fromApiPorts = (
  ports: readonly compute.NamedPort[] | undefined,
): InstanceGroupManagerNamedPort[] =>
  canonPorts(
    (ports ?? [])
      .filter(
        (port): port is { name: string; port: number } =>
          typeof port.name === "string" && typeof port.port === "number",
      )
      .map((port) => ({ name: port.name, port: port.port })),
  );

const sameSegments = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => {
  const a = [...(left ?? [])].map(lastSegment).sort();
  const b = [...(right ?? [])].map(lastSegment).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const toHealing = (
  project: string,
  policies: readonly InstanceGroupManagerAutoHealingPolicy[],
): compute.InstanceGroupManagerAutoHealingPolicy[] =>
  policies.map((policy) => ({
    healthCheck: toHealthCheckUrl(project, policy.healthCheck),
    initialDelaySec: policy.initialDelaySec,
  }));

const fromApiHealing = (
  policies:
    | readonly compute.InstanceGroupManagerAutoHealingPolicy[]
    | undefined,
): InstanceGroupManagerAutoHealingPolicy[] =>
  (policies ?? [])
    .filter(
      (policy): policy is { healthCheck: string } & typeof policy =>
        typeof policy.healthCheck === "string",
    )
    .map((policy) => ({
      healthCheck: policy.healthCheck,
      initialDelaySec: policy.initialDelaySec,
    }));

const sameHealing = (
  left:
    | readonly { healthCheck?: string; initialDelaySec?: number }[]
    | undefined,
  right:
    | readonly { healthCheck?: string; initialDelaySec?: number }[]
    | undefined,
) => {
  const canon = (
    policies: readonly { healthCheck?: string; initialDelaySec?: number }[],
  ) =>
    [...policies]
      .map((policy) => ({
        healthCheck: lastSegment(policy.healthCheck ?? ""),
        initialDelaySec: policy.initialDelaySec ?? 0,
      }))
      .sort((a, b) => a.healthCheck.localeCompare(b.healthCheck));
  return (
    JSON.stringify(canon(left ?? [])) === JSON.stringify(canon(right ?? []))
  );
};

const sameUpdatePolicy = (
  left: compute.InstanceGroupManagerUpdatePolicy | undefined,
  right: compute.InstanceGroupManagerUpdatePolicy | undefined,
) => JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});

const toAttrs = (manager: compute.InstanceGroupManager, project: string) => {
  const { user } = parseDescription(manager.description);
  return {
    managerName: manager.name ?? lastSegment(manager.selfLink),
    zone: lastSegment(manager.zone) || DEFAULT_ZONE,
    project,
    instanceTemplate: manager.instanceTemplate,
    targetSize: manager.targetSize ?? DEFAULT_TARGET_SIZE,
    baseInstanceName: manager.baseInstanceName,
    description: user,
    namedPorts: fromApiPorts(manager.namedPorts),
    instanceGroup: manager.instanceGroup,
    isStable: manager.status?.isStable,
    selfLink: manager.selfLink,
    id: manager.id,
    creationTimestamp: manager.creationTimestamp,
  };
};

const getByName = (
  project: string,
  zone: string,
  instanceGroupManager: string,
) =>
  compute
    .getInstanceGroupManagers({ project, zone, instanceGroupManager })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitGone = (project: string, zone: string, managerName: string) =>
  getByName(project, zone, managerName).pipe(
    Effect.flatMap((manager) =>
      manager === undefined
        ? Effect.void
        : Effect.fail(
            new InstanceGroupManagerStillExists({ managerName, zone }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InstanceGroupManagerStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitPresent = (project: string, zone: string, managerName: string) =>
  getByName(project, zone, managerName).pipe(
    Effect.flatMap((manager) =>
      manager === undefined
        ? Effect.fail(
            new InstanceGroupManagerNotResolved({ managerName, zone }),
          )
        : Effect.succeed(manager),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InstanceGroupManagerNotResolved",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
    Effect.catchTag("GCP.Compute.InstanceGroupManagerNotResolved", () =>
      Effect.succeed(undefined),
    ),
  );

const runOp = <E, R>(
  project: string,
  zone: string,
  start: Effect.Effect<compute.Operation, E, R>,
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitZoneOperation(project, zone, operation, {
        ignore: ["RESOURCE_ALREADY_EXISTS"],
      }),
    ),
  );

const syncNamedPorts = (
  project: string,
  zone: string,
  instanceGroupUrl: string | undefined,
  namedPorts: InstanceGroupManagerNamedPort[],
) =>
  Effect.gen(function* () {
    const instanceGroup = lastSegment(instanceGroupUrl);
    if (instanceGroup.length === 0) return;
    const group = yield* compute
      .getInstanceGroups({ project, zone, instanceGroup })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (group === undefined) return;
    if (samePorts(fromApiPorts(group.namedPorts), namedPorts)) return;
    yield* runOp(
      project,
      zone,
      compute.setNamedPortsInstanceGroups({
        project,
        zone,
        instanceGroup,
        body: {
          namedPorts,
          fingerprint: group.fingerprint,
        },
      }),
    ).pipe(
      Effect.retry({
        while: (error) => error._tag === "Conflict",
        times: 5,
        schedule: Schedule.exponential("250 millis"),
      }),
    );
  });

export const InstanceGroupManagerProvider = () =>
  Provider.succeed(InstanceGroupManager, {
    stables: [
      "managerName",
      "zone",
      "project",
      "baseInstanceName",
      "id",
      "selfLink",
      "instanceGroup",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.managerName ?? output?.managerName;
      const nextName = news.managerName ?? previousName;
      const previousZone = lastSegment(olds?.zone ?? output?.zone);
      const nextZone = lastSegment(news.zone ?? DEFAULT_ZONE);
      const previousBase = olds?.baseInstanceName ?? output?.baseInstanceName;
      const nextBase =
        news.baseInstanceName !== undefined
          ? toBaseInstanceName(
              nextName ?? news.baseInstanceName,
              news.baseInstanceName,
            )
          : previousBase;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const zoneChanged = previousZone.length > 0 && previousZone !== nextZone;
      const baseChanged =
        previousBase !== undefined &&
        nextBase !== undefined &&
        lastSegment(previousBase) !== lastSegment(nextBase);
      if (!nameChanged && !zoneChanged && !baseChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          previousName !== undefined &&
          nextName !== undefined &&
          previousName === nextName &&
          previousZone === nextZone,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const managerName = yield* toName(
        id,
        olds?.managerName,
        output?.managerName,
      );
      const zone = lastSegment(olds?.zone ?? output?.zone ?? DEFAULT_ZONE);
      const existing = yield* getByName(env.project, zone, managerName);
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
            if (!scope.startsWith("zones/")) return [];
            return (scoped?.instanceGroupManagers ?? [])
              .filter((manager) => hasOwnershipMarker(manager.description))
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
      const zone = lastSegment(news.zone ?? output?.zone ?? DEFAULT_ZONE);
      const instanceTemplate = toTemplateUrl(
        env.project,
        news.instanceTemplate,
      );
      const targetSize = news.targetSize ?? DEFAULT_TARGET_SIZE;
      const baseInstanceName = toBaseInstanceName(
        managerName,
        news.baseInstanceName ?? output?.baseInstanceName,
      );
      const namedPorts = canonPorts(news.namedPorts);
      const desiredLabels = yield* createInternalLabels(id);
      const description = encodeDescription(news.description, desiredLabels);

      let current = yield* getByName(env.project, zone, managerName);

      if (current === undefined) {
        yield* compute
          .insertInstanceGroupManagers({
            project: env.project,
            zone,
            body: {
              name: managerName,
              description,
              instanceTemplate,
              baseInstanceName,
              targetSize,
              namedPorts: namedPorts.length > 0 ? namedPorts : undefined,
              autoHealingPolicies:
                news.autoHealingPolicies !== undefined
                  ? toHealing(env.project, news.autoHealingPolicies)
                  : undefined,
              updatePolicy: news.updatePolicy,
              targetPools:
                news.targetPools !== undefined
                  ? news.targetPools.map((pool) =>
                      toTargetPoolUrl(env.project, zone, pool),
                    )
                  : undefined,
              instanceLifecyclePolicy: news.instanceLifecyclePolicy,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.flatMap((operation) =>
              operation === undefined
                ? Effect.void
                : waitZoneOperation(env.project, zone, operation, {
                    ignore: ["RESOURCE_ALREADY_EXISTS"],
                  }).pipe(Effect.asVoid),
            ),
          );
        current = yield* waitPresent(env.project, zone, managerName);
      }

      if (current === undefined) {
        return yield* new InstanceGroupManagerNotResolved({
          managerName,
          zone,
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
      if ((current.targetSize ?? DEFAULT_TARGET_SIZE) !== targetSize) {
        patch.targetSize = targetSize;
        dirty = true;
      }
      if (
        lastSegment(current.instanceTemplate) !== lastSegment(instanceTemplate)
      ) {
        patch.instanceTemplate = instanceTemplate;
        dirty = true;
      }
      if (news.autoHealingPolicies !== undefined) {
        const desiredHealing = toHealing(env.project, news.autoHealingPolicies);
        if (
          !sameHealing(
            fromApiHealing(current.autoHealingPolicies),
            desiredHealing,
          )
        ) {
          patch.autoHealingPolicies = desiredHealing;
          dirty = true;
        }
      }
      if (
        news.updatePolicy !== undefined &&
        !sameUpdatePolicy(current.updatePolicy, news.updatePolicy)
      ) {
        patch.updatePolicy = news.updatePolicy;
        dirty = true;
      }
      if (news.targetPools !== undefined) {
        const desiredPools = news.targetPools.map((pool) =>
          toTargetPoolUrl(env.project, zone, pool),
        );
        if (!sameSegments(current.targetPools, desiredPools)) {
          patch.targetPools = desiredPools;
          dirty = true;
        }
      }
      const observedLifecycle: Record<string, unknown> = {
        ...current.instanceLifecyclePolicy,
      };
      if (
        news.instanceLifecyclePolicy !== undefined &&
        Object.entries(news.instanceLifecyclePolicy).some(
          ([key, value]) =>
            JSON.stringify(observedLifecycle[key] ?? null) !==
            JSON.stringify(value ?? null),
        )
      ) {
        patch.instanceLifecyclePolicy = news.instanceLifecyclePolicy;
        dirty = true;
      }

      if (dirty) {
        yield* runOp(
          env.project,
          zone,
          compute.patchInstanceGroupManagers({
            project: env.project,
            zone,
            instanceGroupManager: managerName,
            body: patch,
          }),
        ).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 5,
            schedule: Schedule.exponential("250 millis"),
          }),
        );
        current = (yield* getByName(env.project, zone, managerName)) ?? current;
      }

      if (!samePorts(fromApiPorts(current.namedPorts), namedPorts)) {
        yield* syncNamedPorts(
          env.project,
          zone,
          current.instanceGroup,
          namedPorts,
        );
        current = (yield* getByName(env.project, zone, managerName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* compute
        .deleteInstanceGroupManagers({
          project: output.project,
          zone: output.zone,
          instanceGroupManager: output.managerName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.flatMap((operation) =>
            operation === undefined
              ? Effect.void
              : waitZoneOperation(output.project, output.zone, operation, {
                  ignore: ["RESOURCE_NOT_FOUND"],
                }).pipe(Effect.asVoid),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitGone(output.project, output.zone, output.managerName);
    }),
  });
