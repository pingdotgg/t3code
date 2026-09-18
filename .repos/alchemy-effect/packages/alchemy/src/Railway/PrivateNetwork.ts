import { projectServices as fetchProjectServices } from "./GraphQL.ts";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { sanitizeRailwayName } from "./Metadata.ts";
import { withEnvironmentConfigLock } from "./transient.ts";
import { ownedProjects, projectEnvironmentIds } from "./Project.ts";
import type { Providers } from "./Providers.ts";

type PrivateNetworkEndpointSyncStatus =
  railway.Scalars["PrivateNetworkEndpointSyncStatus"];

const selection = {
  createdAt: true,
  deletedAt: true,
  dnsName: true,
  environmentId: true,
  name: true,
  networkId: true,
  projectId: true,
  publicId: true,
  tags: true,
} as const satisfies railway.Selection<"PrivateNetwork">;
const endpointSelection = {
  createdAt: true,
  deletedAt: true,
  dnsName: true,
  newDnsName: true,
  privateIps: true,
  publicId: true,
  serviceInstanceId: true,
  syncStatus: true,
  tags: true,
} as const satisfies railway.Selection<"PrivateNetworkEndpoint">;
type PrivateNetworksResultItem = railway.Result<
  "PrivateNetwork!",
  typeof selection
>;
type PrivateNetworkEndpointValue = railway.Result<
  "PrivateNetworkEndpoint!",
  typeof endpointSelection
>;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

const PLATFORM_NETWORK_NAME = "railway";

const NetworkConfig = Schema.Struct({
  privateNetworkDisabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  services: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Struct({
            networking: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  privateNetworkEndpoint: Schema.optional(
                    Schema.NullOr(Schema.String),
                  ),
                }),
              ),
            ),
          }),
        ),
      ),
    ),
  ),
});

const readNetworkConfig = Effect.fn(function* (environmentId: string) {
  const environment = yield* railway.environment(
    { id: environmentId },
    { config: { where: { decryptVariables: false } } },
  );
  return yield* Schema.decodeUnknownEffect(NetworkConfig)(environment.config);
});

export class PrivateNetworkConfigPending extends Data.TaggedError(
  "Railway.PrivateNetworkConfigPending",
)<{ environmentId: string; message: string }> {}

const waitForNetworkConfig = (
  environmentId: string,
  ready: (config: typeof NetworkConfig.Type) => boolean,
) =>
  readNetworkConfig(environmentId).pipe(
    Effect.flatMap((config) =>
      ready(config)
        ? Effect.void
        : Effect.fail(
            new PrivateNetworkConfigPending({
              environmentId,
              message: "Waiting for Railway private-network configuration",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "Railway.PrivateNetworkConfigPending",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

export class PrivateNetworkNameUnsupported extends Data.TaggedError(
  "Railway.PrivateNetworkNameUnsupported",
)<{ name: string }> {
  override get message() {
    return `Railway manages one private network per environment. Custom network '${this.name}' is no longer supported; remove the legacy declaration and use PrivateNetwork without a name.`;
  }
}

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
   * Environment whose platform-managed private network is enabled. Accepts a
   * `Railway.Project`, `Railway.Environment`, or `{ environmentId, projectId }`.
   * Changing it replaces the configuration resource.
   */
  environment: Ref<PrivateNetworkEnvironment>;
  /**
   * Only the platform name `railway` is supported. Custom names are rejected.
   * @deprecated Omit this property; Railway names the environment's network.
   */
  name?: string;
}

export type PrivateNetwork = Resource<
  "Railway.PrivateNetwork",
  PrivateNetworkProps,
  {
    /** Railway public network id (string identity used by endpoint APIs). */
    publicId: string;
    /** Private-networking setting to restore when this resource is removed. */
    previousPrivateNetworkDisabled?: boolean;
    /** Numeric WireGuard network id, as a decimal string. */
    networkId: string;
    /** Physical network name (unique per environment). */
    name: string;
    /** Network DNS label reported by Railway. */
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
 * Enable Railway's platform-managed private network for an environment.
 * This resource manages the environment's networking setting, not a separately
 * created network. Use one PrivateNetwork resource per environment.
 *
 * Destroy restores the setting captured before reconciliation. A network that
 * was already enabled stays enabled; one enabled by this resource is disabled.
 * Platform network objects follow the environment's lifecycle.
 *
 * :::caution[Named networks are no longer supported]
 * Railway removed named-network creation. Remove legacy named-network
 * declarations before adding this environment-managed resource. Custom names
 * are rejected rather than silently mapped to the platform network.
 * :::
 *
 * ### Enable private networking
 * Pass a Project or Environment. `dnsName` is Railway's network DNS label.
 *
 * **Example:** Environment-managed network
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const net = yield* Railway.PrivateNetwork("Mesh", {
 *   environment: site,
 * });
 * ```
 *
 * ### Endpoints
 * Configure a deployed service's DNS prefix via
 * {@link PrivateNetworkEndpoint}.
 *
 * **Example:** Endpoint on the network
 * ```typescript
 * const endpoint = yield* Railway.PrivateNetworkEndpoint("ApiDns", {
 *   network: net,
 *   service: { serviceId: "deployed-service-id" },
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

type CloudNetwork = PrivateNetworksResultItem;

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

const resolveNetworkName = Effect.fn(function* (name?: string) {
  if (name !== undefined && name !== PLATFORM_NETWORK_NAME) {
    return yield* new PrivateNetworkNameUnsupported({ name });
  }
  return PLATFORM_NETWORK_NAME;
});

const listNetworks = (environmentId: string) =>
  railway.privateNetworks({ environmentId }, selection).pipe(
    Effect.map((items) => items.filter((network) => !isGoneNetwork(network))),
    railway.catchTags(["RailwayNotFound"], () =>
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

const ensureNetwork = Effect.fn(function* (environmentId: string) {
  const previousPrivateNetworkDisabled = yield* withEnvironmentConfigLock(
    environmentId,
    Effect.gen(function* () {
      const config = yield* readNetworkConfig(environmentId);
      const network = yield* observeNetwork({
        environmentId,
        name: PLATFORM_NETWORK_NAME,
      });
      if (config.privateNetworkDisabled === true || network === undefined) {
        yield* railway.environmentPatchCommit({
          environmentId,
          commitMessage: "Enable private networking",
          patch: { privateNetworkDisabled: false },
        });
        yield* waitForNetworkConfig(
          environmentId,
          (observed) => observed.privateNetworkDisabled === false,
        );
      }
      return config.privateNetworkDisabled === true;
    }),
  );
  const network = yield* observeNetwork({
    environmentId,
    name: PLATFORM_NETWORK_NAME,
  }).pipe(
    Effect.flatMap((network) =>
      network === undefined
        ? Effect.fail(
            new PrivateNetworkNotCreated({
              name: PLATFORM_NETWORK_NAME,
              environmentId,
            }),
          )
        : Effect.succeed(network),
    ),
    Effect.retry({
      while: (error) => error._tag === "Railway.PrivateNetworkNotCreated",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
  return { network, previousPrivateNetworkDisabled };
});

export const PrivateNetworkProvider = () =>
  Provider.succeed(PrivateNetwork, {
    stables: ["projectId", "environmentId"],
    // Platform-managed networking is released, never independently deleted.
    nuke: { skip: true, dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const environmentId = environmentIdOf(news.environment);
      const environmentChanged =
        environmentId !== undefined && environmentId !== output.environmentId;
      if (environmentChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const environmentId =
        output?.environmentId ?? environmentIdOf(olds?.environment);
      const name = output?.name ?? olds?.name ?? PLATFORM_NETWORK_NAME;
      if (environmentId === undefined) return undefined;
      const config = yield* readNetworkConfig(environmentId).pipe(
        railway.catchTags("RailwayNotFound", () => Effect.succeed(undefined)),
      );
      if (config === undefined || config.privateNetworkDisabled === true) {
        return undefined;
      }
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
      return {
        ...attrs,
        previousPrivateNetworkDisabled: output?.previousPrivateNetworkDisabled,
      };
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
                  .filter((network) => network.name === PLATFORM_NETWORK_NAME)
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

    reconcile: Effect.fn(function* ({ news, output }) {
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
      const name = yield* resolveNetworkName(props.name ?? output?.name);
      const current = yield* ensureNetwork(environmentId);
      return {
        ...toNetworkAttrs(current.network, { name, projectId }),
        previousPrivateNetworkDisabled:
          output?.previousPrivateNetworkDisabled ??
          current.previousPrivateNetworkDisabled,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      // Legacy named-network state has no environment setting to restore.
      if (output.previousPrivateNetworkDisabled !== true) return;
      yield* withEnvironmentConfigLock(
        output.environmentId,
        Effect.gen(function* () {
          const config = yield* readNetworkConfig(output.environmentId);
          if (config.privateNetworkDisabled === true) return;
          yield* railway.environmentPatchCommit({
            environmentId: output.environmentId,
            commitMessage: "Restore private networking setting",
            patch: { privateNetworkDisabled: true },
          });
          yield* waitForNetworkConfig(
            output.environmentId,
            (observed) => observed.privateNetworkDisabled === true,
          );
        }),
      ).pipe(railway.catchTags("RailwayNotFound", () => Effect.void));
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
   * Platform-managed network. Accepts a `Railway.PrivateNetwork` or
   * `{ publicId, environmentId }`. Changing it replaces the configuration resource.
   */
  network: Ref<PrivateNetworkEndpointNetwork>;
  /**
   * Service the endpoint advertises. Accepts a `Railway.Service` or
   * `{ serviceId }`. Changing it replaces the endpoint.
   */
  service: Ref<PrivateNetworkEndpointService>;
  /**
   * Service DNS prefix. Defaults to the service name.
   * Updates the service's environment configuration without replacing its endpoint.
   */
  name?: string;
}

export type PrivateNetworkEndpoint = Resource<
  "Railway.PrivateNetworkEndpoint",
  PrivateNetworkEndpointProps,
  {
    /** Railway public endpoint id. */
    publicId: string;
    /** Observed DNS prefix, not a fully qualified hostname. */
    dnsName: string;
    /** Pending DNS name while a rename is in flight, if any. */
    newDnsName: string | undefined;
    /** Internal IPs advertised on the mesh. */
    privateIps: string[];
    /** Service instance the endpoint is bound to. */
    serviceInstanceId: string;
    /** Previous DNS override to restore on removal; null restores the platform default. */
    previousDnsPrefix?: string | null;
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
 * Configure the DNS prefix of a service's platform-managed endpoint on a
 * {@link PrivateNetwork}. The service must already have an instance in the
 * environment. Use one endpoint configuration resource per service/environment.
 *
 * Destroy restores the previous DNS override if the current override still
 * matches this resource's value. Unrelated or externally changed settings are
 * preserved. The platform endpoint itself follows the service's lifecycle.
 * Legacy state without a captured DNS override cannot be restored: deletion
 * fails explicitly while the endpoint exists, rather than silently forgetting it.
 *
 * ### Configure a service
 * Pass the network and service. Omit `name` to use the service name
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
 * `name` sets the service's private DNS prefix.
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
 * :::caution[Changing the target replaces the configuration resource]
 * Changing `network` or `service` restores the old target's prior DNS override
 * and applies the desired prefix to the new target. It does not delete either
 * platform-managed endpoint.
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
  expectedPrefix?: string;
  observedPrefix?: string;
  pendingPrefix?: string;
}> {
  override get message() {
    return `Private endpoint for ${this.serviceId} is not ready: expected ${this.expectedPrefix ?? "an endpoint"}, observed ${this.observedPrefix ?? "missing"}, pending ${this.pendingPrefix ?? "none"}`;
  }
}

export class PrivateNetworkEndpointRestoreUnavailable extends Data.TaggedError(
  "Railway.PrivateNetworkEndpointRestoreUnavailable",
)<{ serviceId: string; environmentId: string }> {
  override get message() {
    return "Cannot restore this endpoint: legacy state has no previous DNS configuration and Railway removed endpoint deletion. Remove its service instance or explicitly release the resource from Alchemy state.";
  }
}

export class PrivateNetworkEndpointTargetMissing extends Data.TaggedError(
  "Railway.PrivateNetworkEndpointTargetMissing",
)<{
  message: string;
}> {}

type CloudEndpoint = PrivateNetworkEndpointValue;

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
  railway
    .privateNetworkEndpoint(
      {
        environmentId: input.environmentId,
        privateNetworkId: input.privateNetworkId,
        serviceId: input.serviceId,
      },
      endpointSelection,
    )
    .pipe(
      Effect.map((endpoint) =>
        endpoint == null || isGoneEndpoint(endpoint) ? undefined : endpoint,
      ),
      railway.catchTags(["RailwayNotFound"], () => Effect.succeed(undefined)),
    );

const resolveServiceName = (serviceId: string, hint?: string) =>
  hint !== undefined && hint.length > 0
    ? Effect.succeed(hint)
    : railway.service({ id: serviceId }, { name: true }).pipe(
        Effect.map((service) => service.name),
        railway.catchTags(["RailwayNotFound"], () =>
          Effect.succeed(sanitizeRailwayName(serviceId)),
        ),
      );

export class PrivateNetworkEndpointNameUnavailable extends Data.TaggedError(
  "Railway.PrivateNetworkEndpointNameUnavailable",
)<{
  name: string;
  privateNetworkId: string;
  serviceId: string;
}> {}

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
            expectedPrefix: input.prefix,
            observedPrefix: endpoint?.dnsName,
            pendingPrefix: endpoint?.newDnsName ?? undefined,
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
      skip: true,
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
      return {
        ...toEndpointAttrs(found, {
          serviceId,
          privateNetworkId,
          environmentId,
          projectId: output?.projectId ?? projectIdOf(olds?.network),
        }),
        previousDnsPrefix: output?.previousDnsPrefix,
      };
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const environmentIds = yield* projectEnvironmentIds(project);
          const networks = (yield* Effect.forEach(
            environmentIds,
            listNetworks,
          )).flat();
          const owned = networks.filter(
            (network) => network.name === PLATFORM_NETWORK_NAME,
          );
          const live = yield* fetchProjectServices(project.projectId, {
            id: true,
            name: true,
            deletedAt: true,
          }).pipe(
            railway.catchTags(["RailwayNotFound"], () =>
              Effect.succeed(undefined),
            ),
          );
          const services = (live ?? []).filter(
            (service) => service.deletedAt == null,
          );
          const nested = yield* Effect.forEach(owned, (network) =>
            Effect.forEach(services, (service) =>
              getEndpoint({
                environmentId: network.environmentId,
                privateNetworkId: network.publicId,
                serviceId: service.id,
              }).pipe(
                Effect.map((endpoint) =>
                  endpoint === undefined
                    ? undefined
                    : toEndpointAttrs(endpoint, {
                        serviceId: service.id,
                        privateNetworkId: network.publicId,
                        environmentId: network.environmentId,
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
      const desiredOverride =
        props.name === undefined ? null : sanitizeRailwayName(props.name);
      const desiredPrefix = desiredOverride ?? sanitizeRailwayName(serviceName);

      const network = yield* observeNetwork({
        environmentId,
        publicId: privateNetworkId,
      });
      if (network?.name !== PLATFORM_NETWORK_NAME) {
        return yield* new PrivateNetworkEndpointTargetMissing({
          message:
            "PrivateNetworkEndpoint requires the platform-managed Railway network; legacy named networks are no longer supported",
        });
      }

      const previousDnsPrefix = yield* withEnvironmentConfigLock(
        environmentId,
        Effect.gen(function* () {
          const config = yield* readNetworkConfig(environmentId);
          if (config.privateNetworkDisabled === true) {
            return yield* new PrivateNetworkEndpointTargetMissing({
              message:
                "Enable private networking with PrivateNetwork before configuring an endpoint",
            });
          }
          const configuredPrefix =
            config.services?.[serviceId]?.networking?.privateNetworkEndpoint;
          const current = yield* getEndpoint({
            environmentId,
            privateNetworkId,
            serviceId,
          });
          const hasDesiredName =
            current !== undefined &&
            dnsPrefix(current.dnsName) === desiredPrefix;
          if ((configuredPrefix ?? null) === desiredOverride) {
            return configuredPrefix ?? null;
          }
          if (
            !hasDesiredName &&
            dnsPrefix(current?.newDnsName ?? "") !== desiredPrefix
          ) {
            const available =
              yield* railway.privateNetworkEndpointNameAvailable({
                environmentId,
                privateNetworkId,
                prefix: desiredPrefix,
              });
            if (!available) {
              return yield* new PrivateNetworkEndpointNameUnavailable({
                name: desiredPrefix,
                privateNetworkId,
                serviceId,
              });
            }
          }
          yield* railway.environmentPatchCommit({
            environmentId,
            commitMessage: "Configure private networking DNS prefix",
            patch: {
              services: {
                [serviceId]: {
                  networking: { privateNetworkEndpoint: desiredOverride },
                },
              },
            },
          });
          return configuredPrefix ?? null;
        }),
      );
      const current = yield* waitUntilEndpointNamed({
        environmentId,
        privateNetworkId,
        serviceId,
        prefix: desiredPrefix,
      });

      return {
        ...toEndpointAttrs(current, {
          serviceId,
          privateNetworkId,
          environmentId,
          projectId,
        }),
        previousDnsPrefix:
          output?.previousDnsPrefix !== undefined
            ? output.previousDnsPrefix
            : previousDnsPrefix,
      };
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if (output.previousDnsPrefix === undefined) {
        const endpoint = yield* getEndpoint({
          environmentId: output.environmentId,
          privateNetworkId: output.privateNetworkId,
          serviceId: output.serviceId,
        });
        if (endpoint === undefined) return;
        return yield* new PrivateNetworkEndpointRestoreUnavailable({
          serviceId: output.serviceId,
          environmentId: output.environmentId,
        });
      }
      const previousDnsPrefix = output.previousDnsPrefix;
      const managedPrefix =
        olds.name === undefined ? null : sanitizeRailwayName(olds.name);
      yield* withEnvironmentConfigLock(
        output.environmentId,
        Effect.gen(function* () {
          const config = yield* readNetworkConfig(output.environmentId);
          const configuredPrefix =
            config.services?.[output.serviceId]?.networking
              ?.privateNetworkEndpoint;
          if (
            (configuredPrefix ?? null) !== managedPrefix ||
            (configuredPrefix ?? null) === previousDnsPrefix
          ) {
            return;
          }
          yield* railway.environmentPatchCommit({
            environmentId: output.environmentId,
            commitMessage: "Restore private networking DNS prefix",
            patch: {
              services: {
                [output.serviceId]: {
                  networking: { privateNetworkEndpoint: previousDnsPrefix },
                },
              },
            },
          });
          yield* waitForNetworkConfig(
            output.environmentId,
            (observed) =>
              (observed.services?.[output.serviceId]?.networking
                ?.privateNetworkEndpoint ?? null) === previousDnsPrefix,
          );
        }),
      ).pipe(railway.catchTags("RailwayNotFound", () => Effect.void));
    }),
  });
