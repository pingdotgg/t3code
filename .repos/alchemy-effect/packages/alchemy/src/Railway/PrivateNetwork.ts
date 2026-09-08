import type {
  PrivateNetworkCreateOrGetResponse,
  PrivateNetworkEndpointCreateOrGetResponse,
  PrivateNetworkEndpointResponse,
  PrivateNetworkEndpointSyncStatus,
  PrivateNetworkEndpointValue,
  PrivateNetworksResultItem,
  ProjectResponseServicesEdgesItemNode,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createRailwayName,
  matchesAlchemyPhysicalName,
  sanitizeRailwayName,
} from "./Metadata.ts";
import { ownedProjects, projectEnvironmentIds } from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

const ALCHEMY_TAG = "alchemy";

/**
 * Environment identity a private network lives in. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId, projectId? }` stub.
 */
export type PrivateNetworkEnvironment = {
  readonly environmentId: string;
  readonly projectId?: string;
};

export interface PrivateNetworkProps {
  /**
   * Environment the named network belongs to. Accepts a
   * `Railway.Project` (primary environment), a `Railway.Environment`, or
   * `{ environmentId, projectId }`. Changing it replaces the network.
   */
  environment: Ref<PrivateNetworkEnvironment>;
  /**
   * Network name. Unique per environment. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces
   * the network — Railway has no rename mutation.
   */
  name?: string;
}

export type PrivateNetwork = Resource<
  "Railway.PrivateNetwork",
  PrivateNetworkProps,
  {
    /** Railway public network id (string identity used by endpoint APIs). */
    publicId: string;
    /** Numeric WireGuard network id, as a decimal string. */
    networkId: string;
    /** Physical network name (unique per environment). */
    name: string;
    /** Network DNS suffix (typically `railway.internal`). */
    dnsName: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the network lives in. */
    environmentId: string;
    /** Observed tags. */
    tags: string[];
    /** RFC3339 creation timestamp, if Railway reported one. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

const resolvePrivateNetworkProps = (
  props:
    | PrivateNetworkProps
    | Effect.Effect<PrivateNetworkProps, never, Providers>,
): Effect.Effect<PrivateNetworkProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const environment = Effect.isEffect(resolved.environment)
      ? yield* resolved.environment as Effect.Effect<
          PrivateNetworkEnvironment,
          never,
          Providers
        >
      : resolved.environment;
    return { ...resolved, environment };
  });

const PrivateNetworkResource = Resource<PrivateNetwork>(
  "Railway.PrivateNetwork",
);

/**
 * A Railway.PrivateNetwork is a named private mesh in an environment.
 * Every environment already has the default `*.railway.internal` mesh —
 * this resource create-or-gets an additional named network (custom DNS)
 * and is the parent of {@link PrivateNetworkEndpoint}.
 *
 * Railway has no per-network delete. Destroy is a no-op; the network is
 * removed when its Project/Environment is deleted. `create-or-get` is
 * idempotent for a given `(environment, name)`.
 *
 * @see https://docs.railway.com/networking/private-networking
 *
 * ### Create a named network
 * Pass a Project (or Environment). Alchemy generates a unique name.
 * `dnsName` is the network suffix endpoints hang off.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const net = yield* Railway.PrivateNetwork("Mesh", {
 *   environment: site,
 * });
 * ```
 *
 * ### A stable name
 * Pass `name` when you need a stable network name. Changing it later
 * replaces the resource — Railway cannot rename a network.
 *
 * **Example:** Explicit name
 * ```typescript
 * const net = yield* Railway.PrivateNetwork("Mesh", {
 *   environment: site,
 *   name: "backend",
 * });
 * ```
 *
 * :::caution[Changing `name` or `environment` replaces the network]
 * `privateNetworkCreateOrGet` is keyed by name. A new network is
 * ensured under the new name. Railway has no per-network delete, so the
 * previous name stays until the environment is deleted.
 * :::
 *
 * ### Endpoints
 * Attach a Service with a custom DNS name via
 * {@link PrivateNetworkEndpoint}.
 *
 * **Example:** Endpoint on the network
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 * });
 * const endpoint = yield* Railway.PrivateNetworkEndpoint("ApiDns", {
 *   network: net,
 *   service: api,
 *   name: "api",
 * });
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope network
 * ```typescript
 * // src/network.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Mesh = Railway.PrivateNetwork("Mesh", {
 *   environment: Site,
 * });
 * ```
 *
 * @resource
 */
export const PrivateNetwork: typeof PrivateNetworkResource = Object.assign(
  (
    id: string,
    props:
      | PrivateNetworkProps
      | Effect.Effect<PrivateNetworkProps, never, Providers>,
  ) => PrivateNetworkResource(id, resolvePrivateNetworkProps(props)),
  PrivateNetworkResource,
);

export class PrivateNetworkNotCreated extends Data.TaggedError(
  "Railway.PrivateNetworkNotCreated",
)<{
  name: string;
  environmentId: string;
}> {}

export class PrivateNetworkEnvironmentRequired extends Data.TaggedError(
  "Railway.PrivateNetworkEnvironmentRequired",
)<{
  message: string;
}> {}

type CloudNetwork =
  | PrivateNetworkCreateOrGetResponse
  | PrivateNetworksResultItem;

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const publicIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { publicId?: unknown };
  return typeof rec.publicId === "string" && rec.publicId.length > 0
    ? rec.publicId
    : undefined;
};

const isGoneNetwork = (network: CloudNetwork | undefined) =>
  network === undefined || network.deletedAt != null;

const toNetworkAttrs = (
  network: CloudNetwork,
  fallback?: { name?: string; projectId?: string },
): PrivateNetwork["Attributes"] => ({
  publicId: network.publicId,
  networkId: String(network.networkId),
  name: network.name || fallback?.name || "",
  dnsName: network.dnsName,
  projectId: network.projectId || fallback?.projectId || "",
  environmentId: network.environmentId,
  tags: network.tags ?? [],
  createdAt: network.createdAt ?? undefined,
});

const resolveNetworkName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeRailwayName(name);
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const listNetworks = (environmentId: string) =>
  railway.privateNetworks({ environmentId }).pipe(
    Effect.map((items) => items.filter((network) => !isGoneNetwork(network))),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as PrivateNetworksResultItem[]),
    ),
  );

const findNetwork = (
  environmentId: string,
  match: (network: CloudNetwork) => boolean,
) =>
  listNetworks(environmentId).pipe(
    Effect.map((networks) => networks.find(match)),
  );

const listEnvironmentIds = (project: {
  projectId: string;
  environmentId: string;
}) =>
  railway.environments.items({ projectId: project.projectId, first: 50 }).pipe(
    Stream.filter((env) => env.deletedAt == null),
    Stream.map((env) => env.id),
    Stream.runCollect,
    Effect.map((ids) => {
      const set = new Set(Array.from(ids));
      if (project.environmentId.length > 0) {
        set.add(project.environmentId);
      }
      return Array.from(set);
    }),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(
        project.environmentId.length > 0 ? [project.environmentId] : [],
      ),
    ),
  );

const observeNetwork = Effect.fn(function* (input: {
  environmentId: string;
  publicId?: string;
  name?: string;
}) {
  if (input.publicId !== undefined && input.publicId.length > 0) {
    const byId = yield* findNetwork(
      input.environmentId,
      (network) => network.publicId === input.publicId,
    );
    if (byId !== undefined) return byId;
  }
  if (input.name !== undefined && input.name.length > 0) {
    return yield* findNetwork(
      input.environmentId,
      (network) => network.name === input.name,
    );
  }
  return undefined;
});

const ensureNetwork = (input: {
  environmentId: string;
  projectId: string;
  name: string;
}) =>
  railway
    .privateNetworkCreateOrGet({
      input: {
        environmentId: input.environmentId,
        projectId: input.projectId,
        name: input.name,
        tags: [ALCHEMY_TAG],
      },
    })
    .pipe(
      Effect.map((network) => (isGoneNetwork(network) ? undefined : network)),
    );

export const PrivateNetworkProvider = () =>
  Provider.succeed(PrivateNetwork, {
    stables: ["publicId", "networkId", "projectId", "environmentId"],
    // Railway has no per-network delete; the mesh is torn down with the
    // environment/project. Skip nuke so we don't loop on a no-op delete.
    nuke: { skip: true, dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const environmentId = environmentIdOf(news.environment);
      const environmentChanged =
        environmentId !== undefined && environmentId !== output.environmentId;
      const nameChanged =
        news.name !== undefined &&
        sanitizeRailwayName(news.name) !== output.name;
      if (environmentChanged || nameChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const environmentId =
        output?.environmentId ?? environmentIdOf(olds?.environment);
      const name = yield* resolveNetworkName(id, olds?.name, output?.name);
      if (environmentId === undefined) return undefined;
      const found = yield* observeNetwork({
        environmentId,
        publicId: output?.publicId,
        name,
      });
      if (found === undefined) return undefined;
      const attrs = toNetworkAttrs(found, {
        name,
        projectId: output?.projectId ?? projectIdOf(olds?.environment),
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const envIds = yield* projectEnvironmentIds(project);
          const nested = yield* Effect.forEach(envIds, (environmentId) =>
            listNetworks(environmentId).pipe(
              Effect.map((networks) =>
                networks
                  .filter((network) => matchesAlchemyPhysicalName(network.name))
                  .map((network) =>
                    toNetworkAttrs(network, {
                      projectId: project.projectId,
                    }),
                  ),
              ),
            ),
          );
          return nested.flat();
        }),
      );
      const seen = new Set<string>();
      const unique: PrivateNetwork["Attributes"][] = [];
      for (const row of rows.flat()) {
        if (seen.has(row.publicId)) continue;
        seen.add(row.publicId);
        unique.push(row);
      }
      return unique;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as PrivateNetworkProps);
      const environmentId =
        environmentIdOf(props.environment) ?? output?.environmentId;
      const projectId = projectIdOf(props.environment) ?? output?.projectId;
      if (environmentId === undefined || projectId === undefined) {
        return yield* new PrivateNetworkEnvironmentRequired({
          message:
            "PrivateNetwork requires an environment with environmentId and projectId (pass a Railway.Project or Railway.Environment)",
        });
      }
      const name = yield* resolveNetworkName(id, props.name, output?.name);

      let current = yield* observeNetwork({
        environmentId,
        publicId: output?.publicId,
        name,
      });

      if (current === undefined) {
        current = yield* ensureNetwork({
          environmentId,
          projectId,
          name,
        });
        if (current === undefined) {
          current = yield* observeNetwork({ environmentId, name });
        }
      }

      if (current === undefined || isGoneNetwork(current)) {
        return yield* new PrivateNetworkNotCreated({
          name,
          environmentId,
        });
      }

      return toNetworkAttrs(current, { name, projectId });
    }),

    delete: Effect.fn(function* () {
      // No per-network delete. `privateNetworksForEnvironmentDelete` would
      // also tear down the default mesh. The network is removed with the
      // parent Project / Environment.
    }),
  });

/**
 * Network identity an endpoint attaches to. Accepts a
 * `Railway.PrivateNetwork` or a `{ publicId, environmentId? }` stub.
 */
export type PrivateNetworkEndpointNetwork = {
  readonly publicId: string;
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly dnsName?: string;
};

/**
 * Service identity an endpoint attaches to. Accepts a `Railway.Service`
 * or a `{ serviceId, name? }` stub.
 */
export type PrivateNetworkEndpointService = {
  readonly serviceId: string;
  readonly name?: string;
};

export interface PrivateNetworkEndpointProps {
  /**
   * Parent named network. Accepts a `Railway.PrivateNetwork` or
   * `{ publicId }`. Changing it replaces the endpoint.
   */
  network: Ref<PrivateNetworkEndpointNetwork>;
  /**
   * Service the endpoint advertises. Accepts a `Railway.Service` or
   * `{ serviceId }`. Changing it replaces the endpoint.
   */
  service: Ref<PrivateNetworkEndpointService>;
  /**
   * DNS prefix for this endpoint (the label before the network
   * `dnsName`). Defaults to the Service name. Updates in place via
   * `privateNetworkEndpointRename`.
   */
  name?: string;
}

export type PrivateNetworkEndpoint = Resource<
  "Railway.PrivateNetworkEndpoint",
  PrivateNetworkEndpointProps,
  {
    /** Railway public endpoint id. */
    publicId: string;
    /** Observed DNS name (`{prefix}.{networkDns}`). */
    dnsName: string;
    /** Pending DNS name while a rename is in flight, if any. */
    newDnsName: string | undefined;
    /** Internal IPs advertised on the mesh. */
    privateIps: string[];
    /** Service instance the endpoint is bound to. */
    serviceInstanceId: string;
    /** Parent service id. */
    serviceId: string;
    /** Parent network public id. */
    privateNetworkId: string;
    /** Environment the endpoint lives in. */
    environmentId: string;
    /** Parent Railway project id, if known. */
    projectId: string | undefined;
    /** Observed Railway sync status (`ACTIVE`, `CREATING`, …). */
    syncStatus: PrivateNetworkEndpointSyncStatus;
    /** Observed tags. */
    tags: string[];
    /** RFC3339 creation timestamp, if Railway reported one. */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

const resolvePrivateNetworkEndpointProps = (
  props:
    | PrivateNetworkEndpointProps
    | Effect.Effect<PrivateNetworkEndpointProps, never, Providers>,
): Effect.Effect<PrivateNetworkEndpointProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const network = Effect.isEffect(resolved.network)
      ? yield* resolved.network as Effect.Effect<
          PrivateNetworkEndpointNetwork,
          never,
          Providers
        >
      : resolved.network;
    const service = Effect.isEffect(resolved.service)
      ? yield* resolved.service as Effect.Effect<
          PrivateNetworkEndpointService,
          never,
          Providers
        >
      : resolved.service;
    return { ...resolved, network, service };
  });

const PrivateNetworkEndpointResource = Resource<PrivateNetworkEndpoint>(
  "Railway.PrivateNetworkEndpoint",
);

/**
 * A Railway.PrivateNetworkEndpoint is a per-service DNS name on a
 * {@link PrivateNetwork}. Create-or-get is idempotent for a given
 * `(network, service)`. `name` is the DNS prefix and updates in place.
 *
 * @see https://docs.railway.com/networking/private-networking
 *
 * ### Attach a service
 * Pass the network and the Service. Omit `name` to use the Service name
 * as the DNS prefix.
 *
 * **Example:** Default prefix
 * ```typescript
 * const endpoint = yield* Railway.PrivateNetworkEndpoint("ApiDns", {
 *   network: net,
 *   service: api,
 * });
 * ```
 *
 * ### Custom DNS name
 * `name` is the label other services use (`name.{network.dnsName}`).
 * Updating it renames in place.
 *
 * **Example:** Custom prefix
 * ```typescript
 * const endpoint = yield* Railway.PrivateNetworkEndpoint("ApiDns", {
 *   network: net,
 *   service: api,
 *   name: "api",
 * });
 * ```
 *
 * :::caution[Changing `network` or `service` replaces the endpoint]
 * The old endpoint is deleted. The new pair is create-or-got.
 * :::
 *
 * @resource
 */
export const PrivateNetworkEndpoint: typeof PrivateNetworkEndpointResource =
  Object.assign(
    (
      id: string,
      props:
        | PrivateNetworkEndpointProps
        | Effect.Effect<PrivateNetworkEndpointProps, never, Providers>,
    ) =>
      PrivateNetworkEndpointResource(
        id,
        resolvePrivateNetworkEndpointProps(props),
      ),
    PrivateNetworkEndpointResource,
  );

export class PrivateNetworkEndpointNotCreated extends Data.TaggedError(
  "Railway.PrivateNetworkEndpointNotCreated",
)<{
  privateNetworkId: string;
  serviceId: string;
}> {}

export class PrivateNetworkEndpointTargetMissing extends Data.TaggedError(
  "Railway.PrivateNetworkEndpointTargetMissing",
)<{
  message: string;
}> {}

type CloudEndpoint =
  | PrivateNetworkEndpointValue
  | PrivateNetworkEndpointCreateOrGetResponse
  | PrivateNetworkEndpointResponse;

const serviceIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serviceId?: unknown };
  return typeof rec.serviceId === "string" && rec.serviceId.length > 0
    ? rec.serviceId
    : undefined;
};

const serviceNameOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { name?: unknown };
  return typeof rec.name === "string" && rec.name.length > 0
    ? rec.name
    : undefined;
};

const goneEndpointStatus = (status: PrivateNetworkEndpointSyncStatus) =>
  status === "DELETED" || status === "DELETING";

const isGoneEndpoint = (endpoint: CloudEndpoint | null | undefined) =>
  endpoint == null ||
  endpoint.deletedAt != null ||
  goneEndpointStatus(endpoint.syncStatus);

const dnsPrefix = (dnsName: string) =>
  dnsName
    .replace(/\.+$/, "")
    .replace(/\.railway\.internal$/i, "")
    .split(".")
    .filter((part) => part.length > 0)[0] ?? dnsName;

const toEndpointAttrs = (
  endpoint: NonNullable<CloudEndpoint>,
  fallback: {
    serviceId: string;
    privateNetworkId: string;
    environmentId: string;
    projectId?: string;
  },
): PrivateNetworkEndpoint["Attributes"] => ({
  publicId: endpoint.publicId,
  dnsName: endpoint.dnsName,
  newDnsName: endpoint.newDnsName ?? undefined,
  privateIps: endpoint.privateIps ?? [],
  serviceInstanceId: endpoint.serviceInstanceId,
  serviceId: fallback.serviceId,
  privateNetworkId: fallback.privateNetworkId,
  environmentId: fallback.environmentId,
  projectId: fallback.projectId,
  syncStatus: endpoint.syncStatus,
  tags: endpoint.tags ?? [],
  createdAt: endpoint.createdAt ?? undefined,
});

const getEndpoint = (input: {
  environmentId: string;
  privateNetworkId: string;
  serviceId: string;
}) =>
  railway.privateNetworkEndpoint(input).pipe(
    Effect.map((endpoint) =>
      endpoint == null || isGoneEndpoint(endpoint) ? undefined : endpoint,
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const resolveServiceName = (serviceId: string, hint?: string) =>
  hint !== undefined && hint.length > 0
    ? Effect.succeed(hint)
    : railway.service({ id: serviceId }).pipe(
        Effect.map((service) => service.name),
        Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
          Effect.succeed(sanitizeRailwayName(serviceId)),
        ),
      );

const listProjectServices = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) =>
      project.services.edges
        .map((edge) => edge.node)
        .filter((node) => node.deletedAt == null),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as ProjectResponseServicesEdgesItemNode[]),
    ),
  );

const waitUntilEndpointGone = (input: {
  environmentId: string;
  privateNetworkId: string;
  serviceId: string;
}) =>
  getEndpoint(input).pipe(
    Effect.map((endpoint) => endpoint === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

const waitUntilEndpointNamed = (input: {
  environmentId: string;
  privateNetworkId: string;
  serviceId: string;
  prefix: string;
}) =>
  getEndpoint(input).pipe(
    Effect.flatMap((endpoint) => {
      if (endpoint == null || dnsPrefix(endpoint.dnsName) !== input.prefix) {
        return Effect.fail(
          new PrivateNetworkEndpointNotCreated({
            privateNetworkId: input.privateNetworkId,
            serviceId: input.serviceId,
          }),
        );
      }
      return Effect.succeed(endpoint);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.PrivateNetworkEndpointNotCreated",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("Railway.PrivateNetworkEndpointNotCreated", () =>
      getEndpoint(input),
    ),
  );

export const PrivateNetworkEndpointProvider = () =>
  Provider.succeed(PrivateNetworkEndpoint, {
    stables: [
      "publicId",
      "serviceId",
      "privateNetworkId",
      "environmentId",
      "serviceInstanceId",
    ],
    nuke: {
      dependsOn: [
        "Railway.PrivateNetwork",
        "Railway.Service",
        "Railway.Project",
      ],
    },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const serviceId = serviceIdOf(news.service);
      const serviceChanged =
        serviceId !== undefined && serviceId !== output.serviceId;
      const networkId = publicIdOf(news.network);
      const networkChanged =
        networkId !== undefined && networkId !== output.privateNetworkId;
      if (serviceChanged || networkChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const serviceId = output?.serviceId ?? serviceIdOf(olds?.service);
      const privateNetworkId =
        output?.privateNetworkId ?? publicIdOf(olds?.network);
      const environmentId =
        output?.environmentId ??
        environmentIdOf(olds?.network) ??
        environmentIdOf(olds);
      if (
        serviceId === undefined ||
        privateNetworkId === undefined ||
        environmentId === undefined
      ) {
        return undefined;
      }
      const found = yield* getEndpoint({
        environmentId,
        privateNetworkId,
        serviceId,
      });
      if (found === undefined) return undefined;
      return toEndpointAttrs(found, {
        serviceId,
        privateNetworkId,
        environmentId,
        projectId: output?.projectId ?? projectIdOf(olds?.network),
      });
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const networks = yield* listNetworks(project.environmentId);
          const owned = networks.filter((network) =>
            matchesAlchemyPhysicalName(network.name),
          );
          const live = yield* railway
            .project({ id: project.projectId })
            .pipe(
              Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
                Effect.succeed(undefined),
              ),
            );
          const services = (
            live?.services.edges.map((edge) => edge.node) ?? []
          ).filter((service) => service.deletedAt == null);
          const nested = yield* Effect.forEach(owned, (network) =>
            Effect.forEach(services, (service) =>
              getEndpoint({
                environmentId: project.environmentId,
                privateNetworkId: network.publicId,
                serviceId: service.id,
              }).pipe(
                Effect.map((endpoint) =>
                  endpoint === undefined
                    ? undefined
                    : toEndpointAttrs(endpoint, {
                        serviceId: service.id,
                        privateNetworkId: network.publicId,
                        environmentId: project.environmentId,
                        projectId: project.projectId,
                      }),
                ),
              ),
            ).pipe(
              Effect.map((items) =>
                items.filter(
                  (item): item is PrivateNetworkEndpoint["Attributes"] =>
                    item !== undefined,
                ),
              ),
            ),
          );
          return nested.flat();
        }),
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const props = news ?? ({} as PrivateNetworkEndpointProps);
      const serviceId = serviceIdOf(props.service) ?? output?.serviceId;
      const privateNetworkId =
        publicIdOf(props.network) ?? output?.privateNetworkId;
      const environmentId =
        environmentIdOf(props.network) ?? output?.environmentId;
      const projectId = projectIdOf(props.network) ?? output?.projectId;
      if (
        serviceId === undefined ||
        privateNetworkId === undefined ||
        environmentId === undefined
      ) {
        return yield* new PrivateNetworkEndpointTargetMissing({
          message:
            "PrivateNetworkEndpoint requires a network (publicId + environmentId) and a service",
        });
      }

      const serviceName = yield* resolveServiceName(
        serviceId,
        serviceNameOf(props.service),
      );
      const desiredPrefix =
        props.name !== undefined
          ? sanitizeRailwayName(props.name)
          : sanitizeRailwayName(serviceName);

      let current: CloudEndpoint | undefined = yield* getEndpoint({
        environmentId,
        privateNetworkId,
        serviceId,
      });

      if (current === undefined) {
        const created = yield* railway
          .privateNetworkEndpointCreateOrGet({
            input: {
              environmentId,
              privateNetworkId,
              serviceId,
              serviceName: desiredPrefix,
              tags: [ALCHEMY_TAG],
            },
          })
          .pipe(
            Effect.map((endpoint) =>
              isGoneEndpoint(endpoint) ? undefined : endpoint,
            ),
          );
        current =
          created ??
          (yield* getEndpoint({
            environmentId,
            privateNetworkId,
            serviceId,
          }));
      }

      if (current === undefined || isGoneEndpoint(current)) {
        return yield* new PrivateNetworkEndpointNotCreated({
          privateNetworkId,
          serviceId,
        });
      }

      if (current != null && dnsPrefix(current.dnsName) !== desiredPrefix) {
        const available = yield* railway.privateNetworkEndpointNameAvailable({
          environmentId,
          privateNetworkId,
          prefix: desiredPrefix,
        });
        if (available) {
          yield* railway.privateNetworkEndpointRename({
            dnsName: desiredPrefix,
            id: current.publicId,
            privateNetworkId,
          });
          current =
            (yield* waitUntilEndpointNamed({
              environmentId,
              privateNetworkId,
              serviceId,
              prefix: desiredPrefix,
            })) ?? current;
        }
      }

      return toEndpointAttrs(current, {
        serviceId,
        privateNetworkId,
        environmentId,
        projectId,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const id = output.publicId;
      if (id.length === 0) return;
      yield* railway
        .privateNetworkEndpointDelete({ id })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      if (
        output.environmentId.length > 0 &&
        output.privateNetworkId.length > 0 &&
        output.serviceId.length > 0
      ) {
        yield* waitUntilEndpointGone({
          environmentId: output.environmentId,
          privateNetworkId: output.privateNetworkId,
          serviceId: output.serviceId,
        });
      }
    }),
  });
