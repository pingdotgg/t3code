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

export type NetworkEndpointType =
  | "GCE_VM_IP"
  | "GCE_VM_IP_PORT"
  | "GCE_VM_IP_PORTMAP"
  | "INTERNET_FQDN_PORT"
  | "INTERNET_IP_PORT"
  | "NON_GCP_PRIVATE_IP_PORT"
  | "PRIVATE_SERVICE_CONNECT"
  | "SERVERLESS";

export type NetworkEndpointSpec = {
  /** VM instance name or URL. Required for `GCE_VM_IP` / `GCE_VM_IP_PORT`. */
  instance?: string;
  /** IPv4 address of the endpoint. */
  ipAddress?: string;
  /** IPv6 address of the endpoint. */
  ipv6Address?: string;
  /** Port. Omitted endpoints use the group's `defaultPort`. */
  port?: number;
  /** FQDN. Only valid for FQDN internet endpoints. */
  fqdn?: string;
  /** PSC consumer destination port (`GCE_VM_IP_PORTMAP` only). */
  clientDestinationPort?: number;
};

export type NetworkEndpointGroupProps = {
  /**
   * Name of the network endpoint group. Must be 1–63 characters and comply
   * with RFC1035. If omitted, a unique name is generated from the stack,
   * stage, and logical id. Changing this replaces the group.
   */
  networkEndpointGroupName?: string;
  /**
   * Zone of the group (e.g. `"us-central1-a"`). Immutable — changing it
   * replaces the group. This resource maps to the zonal
   * `networkEndpointGroups` collection (regional/global NEGs are separate).
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Optional description. Zonal NEGs have no labels API, so Alchemy stamps
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) into this
   * field for `list` / nuke. Changing the user-facing description replaces
   * the group.
   */
  description?: string;
  /**
   * VPC network URL or name (`default`, `global/networks/default`, or
   * `projects/{project}/global/networks/{name}`). Immutable — changing it
   * replaces the group.
   * @default "default"
   */
  network?: string;
  /**
   * Subnetwork URL or name. Immutable — changing it replaces the group.
   * Optional for auto-mode networks such as `default`.
   */
  subnetwork?: string;
  /**
   * Type of endpoints in this group. Immutable — changing it replaces the
   * group.
   * @default "GCE_VM_IP_PORT"
   */
  networkEndpointType?: NetworkEndpointType;
  /**
   * Default port used when an endpoint omits `port`. Must not be set for
   * `GCE_VM_IP`. Immutable — changing it replaces the group.
   */
  defaultPort?: number;
  /**
   * Member endpoints. When omitted, membership is left as-is. When set
   * (including `[]`), observed endpoints are attached/detached to match.
   */
  networkEndpoints?: NetworkEndpointSpec[];
};

export type NetworkEndpointGroup = Resource<
  "GCP.Compute.NetworkEndpointGroup",
  NetworkEndpointGroupProps,
  {
    /** Network endpoint group name. */
    networkEndpointGroupName: string;
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
    /** Endpoint type. */
    networkEndpointType: NetworkEndpointType;
    /** Default port, if set. */
    defaultPort: number | undefined;
    /** Number of member endpoints. */
    size: number;
    /** Server-generated resource URL. */
    selfLink: string | undefined;
    /** Server-generated numeric id. */
    id: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine network endpoint group (NEG).
 *
 * Zonal NEGs hold VM IP/port endpoints (or hybrid `NON_GCP_PRIVATE_IP_PORT`
 * endpoints) for load balancing. They have no labels API — Alchemy records
 * ownership in the description so `list` / `pnpm nuke:gcp` can find them.
 * Serverless, PSC, and internet NEGs use the regional/global collections
 * and are not this resource.
 *
 * ### Creating a Network Endpoint Group
 * **Example:** Generated name
 * ```typescript
 * const neg = yield* GCP.Compute.NetworkEndpointGroup("web", {
 *   defaultPort: 80,
 * });
 * ```
 *
 * **Example:** Explicit name, zone, and default port
 * ```typescript
 * const neg = yield* GCP.Compute.NetworkEndpointGroup("web", {
 *   networkEndpointGroupName: "web-neg",
 *   zone: "us-central1-a",
 *   network: "default",
 *   defaultPort: 80,
 *   description: "HTTP backends",
 * });
 * ```
 *
 * ### Endpoints
 * **Example:** Attach VM endpoints
 * ```typescript
 * const neg = yield* GCP.Compute.NetworkEndpointGroup("web", {
 *   zone: "us-central1-a",
 *   defaultPort: 80,
 *   networkEndpoints: [
 *     { instance: vm.instanceName, port: 80 },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const NetworkEndpointGroup = Resource<NetworkEndpointGroup>(
  "GCP.Compute.NetworkEndpointGroup",
);

export class NetworkEndpointGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.NetworkEndpointGroupNotResolved",
)<{
  networkEndpointGroupName: string;
  zone: string;
}> {}

export class NetworkEndpointGroupStillExists extends Data.TaggedError(
  "GCP.Compute.NetworkEndpointGroupStillExists",
)<{
  networkEndpointGroupName: string;
  zone: string;
}> {}

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_NETWORK = "default";
const DEFAULT_TYPE: NetworkEndpointType = "GCE_VM_IP_PORT";

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
    next = `n${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/g, "");
  return next.length > 0 ? next : "neg";
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

const zoneToRegion = (zone: string) => {
  const idx = zone.lastIndexOf("-");
  return idx > 0 ? zone.slice(0, idx) : zone;
};

const toNetworkUrl = (project: string, network: string | undefined) => {
  if (network === undefined || network.length === 0) {
    return `projects/${project}/global/networks/${DEFAULT_NETWORK}`;
  }
  if (network.includes("/")) return network;
  return `projects/${project}/global/networks/${network}`;
};

const toSubnetworkUrl = (
  project: string,
  zone: string,
  subnetwork: string | undefined,
) => {
  if (subnetwork === undefined || subnetwork.length === 0) return undefined;
  if (subnetwork.includes("/")) return subnetwork;
  return `projects/${project}/regions/${zoneToRegion(zone)}/subnetworks/${subnetwork}`;
};

const toInstanceUrl = (project: string, zone: string, instance: string) =>
  instance.includes("/")
    ? instance
    : `projects/${project}/zones/${zone}/instances/${instance}`;

const asType = (value: string | undefined): NetworkEndpointType => {
  switch (value) {
    case "GCE_VM_IP":
    case "GCE_VM_IP_PORT":
    case "GCE_VM_IP_PORTMAP":
    case "INTERNET_FQDN_PORT":
    case "INTERNET_IP_PORT":
    case "NON_GCP_PRIVATE_IP_PORT":
    case "PRIVATE_SERVICE_CONNECT":
    case "SERVERLESS":
      return value;
    default:
      return DEFAULT_TYPE;
  }
};

const toAttrs = (
  group: compute.NetworkEndpointGroup,
  project: string,
): NetworkEndpointGroup["Attributes"] => {
  const { user } = parseDescription(group.description);
  return {
    networkEndpointGroupName: group.name ?? lastSegment(group.selfLink ?? ""),
    zone: lastSegment(group.zone ?? DEFAULT_ZONE),
    project,
    description: user,
    network: group.network,
    subnetwork: group.subnetwork,
    networkEndpointType: asType(group.networkEndpointType),
    defaultPort: group.defaultPort,
    size: group.size ?? 0,
    selfLink: group.selfLink,
    id: group.id,
    creationTimestamp: group.creationTimestamp,
    kind: group.kind,
  };
};

const getByName = (
  project: string,
  zone: string,
  networkEndpointGroup: string,
) =>
  compute
    .getNetworkEndpointGroups({ project, zone, networkEndpointGroup })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toApiEndpoint = (
  project: string,
  zone: string,
  endpoint: NetworkEndpointSpec,
): compute.NetworkEndpoint => ({
  instance:
    endpoint.instance !== undefined
      ? toInstanceUrl(project, zone, endpoint.instance)
      : undefined,
  ipAddress: endpoint.ipAddress,
  ipv6Address: endpoint.ipv6Address,
  port: endpoint.port,
  fqdn: endpoint.fqdn,
  clientDestinationPort: endpoint.clientDestinationPort,
});

const endpointKey = (endpoint: {
  instance?: string;
  ipAddress?: string;
  ipv6Address?: string;
  port?: number;
  fqdn?: string;
  clientDestinationPort?: number;
}) =>
  [
    endpoint.instance ? lastSegment(endpoint.instance) : "",
    endpoint.ipAddress ?? "",
    endpoint.ipv6Address ?? "",
    endpoint.port ?? "",
    endpoint.fqdn ?? "",
    endpoint.clientDestinationPort ?? "",
  ].join("|");

const listEndpoints = (
  project: string,
  zone: string,
  networkEndpointGroup: string,
) =>
  compute.listNetworkEndpointsNetworkEndpointGroups
    .items({
      project,
      zone,
      networkEndpointGroup,
      body: { healthStatus: "SKIP" },
    })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .map((item) => item.networkEndpoint)
          .filter(
            (endpoint): endpoint is compute.NetworkEndpoint =>
              endpoint !== undefined,
          ),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as compute.NetworkEndpoint[]),
      ),
    );

const waitGone = (
  project: string,
  zone: string,
  networkEndpointGroupName: string,
) =>
  getByName(project, zone, networkEndpointGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new NetworkEndpointGroupStillExists({
              networkEndpointGroupName,
              zone,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.NetworkEndpointGroupStillExists",
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

export const NetworkEndpointGroupProvider = () =>
  Provider.succeed(NetworkEndpointGroup, {
    stables: [
      "networkEndpointGroupName",
      "zone",
      "project",
      "networkEndpointType",
      "id",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.networkEndpointGroupName ?? output?.networkEndpointGroupName;
      const nextName = news.networkEndpointGroupName ?? previousName;
      const previousZone = olds?.zone ?? output?.zone;
      const nextZone = news.zone ?? DEFAULT_ZONE;
      const previousNetwork = olds?.network ?? output?.network;
      const nextNetwork = news.network;
      const previousSubnetwork = olds?.subnetwork ?? output?.subnetwork;
      const nextSubnetwork = news.subnetwork;
      const previousType =
        olds?.networkEndpointType ?? output?.networkEndpointType;
      const nextType = news.networkEndpointType ?? previousType ?? DEFAULT_TYPE;
      const previousPort = olds?.defaultPort ?? output?.defaultPort;
      const nextPort = news.defaultPort;
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
      const subnetworkChanged =
        nextSubnetwork !== undefined &&
        previousSubnetwork !== undefined &&
        lastSegment(previousSubnetwork) !== lastSegment(nextSubnetwork);
      const typeChanged =
        previousType !== undefined && previousType !== nextType;
      const portChanged =
        nextPort !== undefined &&
        previousPort !== undefined &&
        nextPort !== previousPort;
      const descriptionChanged =
        olds !== undefined &&
        (olds.description ?? "") !== (news.description ?? "");
      if (
        !nameChanged &&
        !zoneChanged &&
        !networkChanged &&
        !subnetworkChanged &&
        !typeChanged &&
        !portChanged &&
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
      const networkEndpointGroupName = yield* toName(
        id,
        olds?.networkEndpointGroupName,
        output?.networkEndpointGroupName,
      );
      const zone = lastSegment(olds?.zone ?? output?.zone ?? DEFAULT_ZONE);
      const existing = yield* getByName(
        env.project,
        zone,
        networkEndpointGroupName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListNetworkEndpointGroups
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.networkEndpointGroups ?? [])
              .filter((group) => hasOwnershipMarker(group.description))
              .map((group) => toAttrs(group, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkEndpointGroupName = yield* toName(
        id,
        news.networkEndpointGroupName,
        output?.networkEndpointGroupName,
      );
      const zone = lastSegment(news.zone ?? output?.zone ?? DEFAULT_ZONE);
      const networkEndpointType = asType(
        news.networkEndpointType ?? output?.networkEndpointType,
      );
      const network = toNetworkUrl(
        env.project,
        news.network ??
          (output?.network !== undefined
            ? lastSegment(output.network)
            : DEFAULT_NETWORK),
      );
      const subnetwork = toSubnetworkUrl(
        env.project,
        zone,
        news.subnetwork ??
          (output?.subnetwork !== undefined
            ? lastSegment(output.subnetwork)
            : undefined),
      );
      const desiredLabels = yield* createInternalLabels(id);
      const description = encodeDescription(news.description, desiredLabels);

      let current = yield* getByName(
        env.project,
        zone,
        networkEndpointGroupName,
      );

      if (current === undefined) {
        yield* compute
          .insertNetworkEndpointGroups({
            project: env.project,
            zone,
            body: {
              name: networkEndpointGroupName,
              description,
              network,
              subnetwork,
              networkEndpointType,
              defaultPort: news.defaultPort ?? output?.defaultPort,
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
        current = yield* getByName(
          env.project,
          zone,
          networkEndpointGroupName,
        ).pipe(
          Effect.flatMap((group) =>
            group === undefined
              ? Effect.fail(
                  new NetworkEndpointGroupNotResolved({
                    networkEndpointGroupName,
                    zone,
                  }),
                )
              : Effect.succeed(group),
          ),
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.Compute.NetworkEndpointGroupNotResolved",
            times: 8,
            schedule: Schedule.exponential("250 millis"),
          }),
          Effect.catchTag("GCP.Compute.NetworkEndpointGroupNotResolved", () =>
            Effect.succeed(undefined),
          ),
        );
      }

      if (current === undefined) {
        return yield* new NetworkEndpointGroupNotResolved({
          networkEndpointGroupName,
          zone,
        });
      }

      if (news.networkEndpoints !== undefined) {
        const observed = yield* listEndpoints(
          env.project,
          zone,
          networkEndpointGroupName,
        );
        const desired = news.networkEndpoints.map((endpoint) =>
          toApiEndpoint(env.project, zone, endpoint),
        );
        const observedKeys = new Set(observed.map(endpointKey));
        const desiredKeys = new Set(desired.map(endpointKey));
        const toAdd = desired.filter(
          (endpoint) => !observedKeys.has(endpointKey(endpoint)),
        );
        const toRemove = observed.filter(
          (endpoint) => !desiredKeys.has(endpointKey(endpoint)),
        );
        if (toAdd.length > 0) {
          yield* runOp(
            env.project,
            zone,
            compute.attachNetworkEndpointsNetworkEndpointGroups({
              project: env.project,
              zone,
              networkEndpointGroup: networkEndpointGroupName,
              body: { networkEndpoints: toAdd },
            }),
          ).pipe(Effect.catchTag("Conflict", () => Effect.void));
        }
        if (toRemove.length > 0) {
          yield* runOp(
            env.project,
            zone,
            compute.detachNetworkEndpointsNetworkEndpointGroups({
              project: env.project,
              zone,
              networkEndpointGroup: networkEndpointGroupName,
              body: { networkEndpoints: toRemove },
            }),
          ).pipe(Effect.catchTag(["NotFound", "Conflict"], () => Effect.void));
        }
        current =
          (yield* getByName(env.project, zone, networkEndpointGroupName)) ??
          current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* compute
        .deleteNetworkEndpointGroups({
          project: output.project,
          zone: output.zone,
          networkEndpointGroup: output.networkEndpointGroupName,
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
      yield* waitGone(
        output.project,
        output.zone,
        output.networkEndpointGroupName,
      );
    }),
  });
