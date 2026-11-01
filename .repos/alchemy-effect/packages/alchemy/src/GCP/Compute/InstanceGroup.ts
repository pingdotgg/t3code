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

export type NamedPort = {
  /** RFC1035 name for this port mapping (e.g. `"http"`). */
  name: string;
  /** TCP port number (`1`–`65535`). */
  port: number;
};

export type InstanceGroupProps = {
  /**
   * Name of the instance group. Must be 1–63 characters and comply with
   * RFC1035. If omitted, a unique name is generated from the stack, stage,
   * and logical id. Changing this replaces the group.
   */
  instanceGroupName?: string;
  /**
   * Zone of the instance group (e.g. `"us-central1-a"`). Immutable —
   * changing it replaces the group.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Optional description. Unmanaged instance groups have no labels API, so
   * Alchemy stamps ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) into this field for `list` / nuke. Changing the
   * user-facing description replaces the group.
   */
  description?: string;
  /**
   * VPC network URL or name (`default`, `global/networks/default`, or
   * `projects/{project}/global/networks/{name}`). Immutable — changing it
   * replaces the group.
   */
  network?: string;
  /**
   * Named ports applied to every instance in the group.
   */
  namedPorts?: NamedPort[];
  /**
   * Member instance URLs or names. When omitted, membership is left as-is.
   * When set (including `[]`), observed members are added/removed to match.
   */
  instances?: string[];
};

export type InstanceGroup = Resource<
  "GCP.Compute.InstanceGroup",
  InstanceGroupProps,
  {
    /** Instance group name. */
    instanceGroupName: string;
    /** Zone (short name, e.g. `"us-central1-a"`). */
    zone: string;
    /** Project id. */
    project: string;
    /** User-facing description (ownership marker stripped). */
    description: string | undefined;
    /** Network URL, if set. */
    network: string | undefined;
    /** Subnetwork URL, if set. */
    subnetwork: string | undefined;
    /** Named ports currently configured on the group. */
    namedPorts: NamedPort[];
    /** Number of member instances. */
    size: number;
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
 * A zonal unmanaged Compute Engine instance group.
 *
 * Unmanaged groups hold an explicit list of VMs and optional named ports
 * for load balancing. They have no labels API — Alchemy records ownership
 * in the description so `list` / `pnpm nuke:gcp` can find them.
 *
 * ### Creating an Instance Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.Compute.InstanceGroup("web", {
 *   namedPorts: [{ name: "http", port: 80 }],
 * });
 * ```
 *
 * **Example:** Explicit name, zone, and named ports
 * ```typescript
 * const group = yield* GCP.Compute.InstanceGroup("web", {
 *   instanceGroupName: "web-backends",
 *   zone: "us-central1-a",
 *   description: "HTTP backends",
 *   namedPorts: [
 *     { name: "http", port: 80 },
 *     { name: "https", port: 443 },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const InstanceGroup = Resource<InstanceGroup>(
  "GCP.Compute.InstanceGroup",
);

export class InstanceGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.InstanceGroupNotResolved",
)<{
  instanceGroupName: string;
  zone: string;
}> {}

export class InstanceGroupStillExists extends Data.TaggedError(
  "GCP.Compute.InstanceGroupStillExists",
)<{
  instanceGroupName: string;
  zone: string;
}> {}

const DEFAULT_ZONE = "us-central1-a";

const lastSegment = (value: string) => {
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? value;
};

const rfc1035Name = (name: string) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) {
    next = `g${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/g, "");
  return next.length > 0 ? next : "group";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return rfc1035Name(
      name ??
        existing ??
        (yield* createPhysicalName({
          id,
          maxLength: 63,
          lowercase: true,
        })),
    );
  });

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

const toNetworkUrl = (project: string, network: string | undefined) => {
  if (network === undefined || network.length === 0) return undefined;
  if (network.includes("/")) return network;
  return `projects/${project}/global/networks/${network}`;
};

const toInstanceUrl = (project: string, zone: string, instance: string) =>
  instance.includes("/")
    ? instance
    : `projects/${project}/zones/${zone}/instances/${instance}`;

const canonPorts = (ports: readonly NamedPort[] | undefined): NamedPort[] =>
  [...(ports ?? [])]
    .map((port) => ({ name: port.name, port: port.port }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.port - b.port);

const samePorts = (
  left: readonly NamedPort[] | undefined,
  right: readonly NamedPort[] | undefined,
) => JSON.stringify(canonPorts(left)) === JSON.stringify(canonPorts(right));

const fromApiPorts = (
  ports: readonly compute.NamedPort[] | undefined,
): NamedPort[] =>
  canonPorts(
    (ports ?? [])
      .filter(
        (port): port is { name: string; port: number } =>
          typeof port.name === "string" && typeof port.port === "number",
      )
      .map((port) => ({ name: port.name, port: port.port })),
  );

const toAttrs = (group: compute.InstanceGroup, project: string) => {
  const { user } = parseDescription(group.description);
  return {
    instanceGroupName: group.name ?? lastSegment(group.selfLink ?? ""),
    zone: lastSegment(group.zone ?? DEFAULT_ZONE),
    project,
    description: user,
    network: group.network,
    subnetwork: group.subnetwork,
    namedPorts: fromApiPorts(group.namedPorts),
    size: group.size ?? 0,
    selfLink: group.selfLink,
    id: group.id,
    creationTimestamp: group.creationTimestamp,
  };
};

const getByName = (project: string, zone: string, instanceGroup: string) =>
  compute
    .getInstanceGroups({ project, zone, instanceGroup })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listMembers = (project: string, zone: string, instanceGroup: string) =>
  compute.listInstancesInstanceGroups
    .items({
      project,
      zone,
      instanceGroup,
      body: { instanceState: "ALL" },
    })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .map((item) => item.instance)
          .filter((url): url is string => typeof url === "string"),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const waitGone = (project: string, zone: string, instanceGroupName: string) =>
  getByName(project, zone, instanceGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new InstanceGroupStillExists({ instanceGroupName, zone }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.InstanceGroupStillExists",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
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

export const InstanceGroupProvider = () =>
  Provider.succeed(InstanceGroup, {
    stables: [
      "instanceGroupName",
      "zone",
      "project",
      "id",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.instanceGroupName ?? output?.instanceGroupName;
      const nextName = news.instanceGroupName ?? previousName;
      const previousZone = olds?.zone ?? output?.zone;
      const nextZone = news.zone ?? DEFAULT_ZONE;
      const previousNetwork = olds?.network ?? output?.network;
      const nextNetwork = news.network;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const zoneChanged =
        previousZone !== undefined &&
        lastSegment(previousZone) !== lastSegment(nextZone);
      const networkChanged =
        nextNetwork !== undefined &&
        previousNetwork !== undefined &&
        lastSegment(previousNetwork) !== lastSegment(nextNetwork);
      const descriptionChanged =
        olds !== undefined &&
        (olds.description ?? "") !== (news.description ?? "");
      if (
        !nameChanged &&
        !zoneChanged &&
        !networkChanged &&
        !descriptionChanged
      ) {
        return undefined;
      }
      const sameIdentity =
        previousName === nextName &&
        lastSegment(previousZone ?? "") === lastSegment(nextZone);
      return {
        action: "replace" as const,
        deleteFirst: sameIdentity,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceGroupName = yield* toName(
        id,
        olds?.instanceGroupName,
        output?.instanceGroupName,
      );
      const zone = lastSegment(olds?.zone ?? output?.zone ?? DEFAULT_ZONE);
      const existing = yield* getByName(env.project, zone, instanceGroupName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListInstanceGroups
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.instanceGroups ?? [])
              .filter((group) => hasOwnershipMarker(group.description))
              .map((group) => toAttrs(group, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceGroupName = yield* toName(
        id,
        news.instanceGroupName,
        output?.instanceGroupName,
      );
      const zone = lastSegment(news.zone ?? output?.zone ?? DEFAULT_ZONE);
      const namedPorts = canonPorts(news.namedPorts);
      const network = toNetworkUrl(env.project, news.network);
      const desiredLabels = yield* createInternalLabels(id);
      const description = encodeDescription(news.description, desiredLabels);

      let current = yield* getByName(env.project, zone, instanceGroupName);

      if (current === undefined) {
        yield* compute
          .insertInstanceGroups({
            project: env.project,
            zone,
            body: {
              name: instanceGroupName,
              description,
              namedPorts: namedPorts.length > 0 ? namedPorts : undefined,
              network,
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
        current = yield* getByName(env.project, zone, instanceGroupName).pipe(
          Effect.flatMap((group) =>
            group === undefined
              ? Effect.fail(
                  new InstanceGroupNotResolved({ instanceGroupName, zone }),
                )
              : Effect.succeed(group),
          ),
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.Compute.InstanceGroupNotResolved",
            times: 8,
            schedule: Schedule.exponential("250 millis"),
          }),
          Effect.catchTag("GCP.Compute.InstanceGroupNotResolved", () =>
            Effect.succeed(undefined),
          ),
        );
      }

      if (current === undefined) {
        return yield* new InstanceGroupNotResolved({
          instanceGroupName,
          zone,
        });
      }

      if (!samePorts(fromApiPorts(current.namedPorts), namedPorts)) {
        yield* runOp(
          env.project,
          zone,
          compute.setNamedPortsInstanceGroups({
            project: env.project,
            zone,
            instanceGroup: instanceGroupName,
            body: {
              namedPorts,
              fingerprint: current.fingerprint,
            },
          }),
        ).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 5,
            schedule: Schedule.exponential("250 millis"),
          }),
        );
        current =
          (yield* getByName(env.project, zone, instanceGroupName)) ?? current;
      }

      if (news.instances !== undefined) {
        const observed = yield* listMembers(
          env.project,
          zone,
          instanceGroupName,
        );
        const desired = news.instances.map((instance) =>
          toInstanceUrl(env.project, zone, instance),
        );
        const observedKeys = new Set(observed.map(lastSegment));
        const desiredKeys = new Set(desired.map(lastSegment));
        const toAdd = desired.filter(
          (instance) => !observedKeys.has(lastSegment(instance)),
        );
        const toRemove = observed.filter(
          (instance) => !desiredKeys.has(lastSegment(instance)),
        );
        if (toAdd.length > 0) {
          yield* runOp(
            env.project,
            zone,
            compute.addInstancesInstanceGroups({
              project: env.project,
              zone,
              instanceGroup: instanceGroupName,
              body: {
                instances: toAdd.map((instance) => ({ instance })),
              },
            }),
          );
        }
        if (toRemove.length > 0) {
          yield* runOp(
            env.project,
            zone,
            compute.removeInstancesInstanceGroups({
              project: env.project,
              zone,
              instanceGroup: instanceGroupName,
              body: {
                instances: toRemove.map((instance) => ({ instance })),
              },
            }),
          );
        }
        current =
          (yield* getByName(env.project, zone, instanceGroupName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* compute
        .deleteInstanceGroups({
          project: output.project,
          zone: output.zone,
          instanceGroup: output.instanceGroupName,
        })
        .pipe(
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
      yield* waitGone(output.project, output.zone, output.instanceGroupName);
    }),
  });
