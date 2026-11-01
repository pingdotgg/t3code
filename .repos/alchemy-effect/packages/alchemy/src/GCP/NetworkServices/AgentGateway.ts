import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "agentGateways";

export type AgentGatewayGovernedAccessPath =
  | networkservices.AgentGatewayGoogleManagedGovernedAccessPathEnum
  | (string & {});

export type AgentGatewayProtocol =
  | networkservices.AgentGatewayProtocolsItemEnum
  | (string & {});

export type AgentGatewayGoogleManaged = {
  /**
   * Operating mode of a Google-managed Agent Gateway.
   */
  governedAccessPath?: AgentGatewayGovernedAccessPath;
};

export type AgentGatewaySelfManaged = {
  /**
   * Existing Application Load Balancer or Secure Web Proxy resource URI
   * in the same project and location.
   */
  resourceUri?: string;
};

export type AgentGatewayNetworkConfigEgress = {
  /** Network Attachment URI used for private VPC egress. */
  networkAttachment?: string;
};

export type AgentGatewayDnsPeeringConfig = {
  /** Domain names whose queries are forwarded to the target network. */
  domains?: string[];
  /** Project id that owns the target network. */
  targetProject?: string;
  /**
   * Target network in
   * `projects/{project}/global/networks/{network}` form.
   */
  targetNetwork?: string;
};

export type AgentGatewayNetworkConfig = {
  /** PSC-interface network attachment for private VPC connectivity. */
  egress?: AgentGatewayNetworkConfigEgress;
  /** DNS peering configuration for the user VPC. */
  dnsPeeringConfig?: AgentGatewayDnsPeeringConfig;
};

export type AgentGatewayOutputCard = {
  /** mTLS endpoint associated with this Agent Gateway. */
  mtlsEndpoint?: string;
  /** Root certificates agents use to validate this Agent Gateway. */
  rootCertificates?: string[];
  /** Service account used by Service Extensions. */
  serviceExtensionsServiceAccount?: string;
};

export type AgentGatewayProps = {
  /**
   * AgentGateway id (the `{agentGateway}` segment of
   * `projects/{project}/locations/{location}/agentGateways/{agentGateway}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the gateway.
   */
  agentGatewayId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * gateway. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Google-managed deployment. Mutually exclusive with `selfManaged`.
   */
  googleManaged?: AgentGatewayGoogleManaged;
  /**
   * Attach to an existing Application Load Balancer or Secure Web Proxy.
   * Mutually exclusive with `googleManaged`.
   */
  selfManaged?: AgentGatewaySelfManaged;
  /**
   * Agent registries containing agents, MCP servers, and tools. Must be
   * project-scoped
   * `//agentregistry.googleapis.com/projects/{project}/locations/{location}/...`
   * names.
   */
  registries?: string[];
  /**
   * Deprecated protocol list. Prefer `googleManaged` / `selfManaged`.
   */
  protocols?: AgentGatewayProtocol[];
  /**
   * Network configuration for private VPC connectivity.
   */
  networkConfig?: AgentGatewayNetworkConfig;
  /**
   * Human-readable description. Max length 1024 characters.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AgentGateway = Resource<
  "GCP.NetworkServices.AgentGateway",
  AgentGatewayProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/agentGateways/{agentGateway}`. */
    name: string;
    /** AgentGateway id (last path segment). */
    agentGatewayId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Google-managed deployment, if set. */
    googleManaged: AgentGatewayGoogleManaged | undefined;
    /** Self-managed proxy attachment, if set. */
    selfManaged: AgentGatewaySelfManaged | undefined;
    /** Agent registry resource names. */
    registries: string[];
    /** Deprecated protocol list. */
    protocols: string[];
    /** Network configuration, if set. */
    networkConfig: AgentGatewayNetworkConfig | undefined;
    /** Output-only Agent Gateway card. */
    agentGatewayCard: AgentGatewayOutputCard | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
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
 * A Network Services Agent Gateway — the proxy that governs access to
 * agents, MCP servers, and tools.
 *
 * Changing `agentGatewayId` or `location` replaces the gateway.
 * Description, labels, registries, network config, and deployment mode
 * update in place.
 *
 * ### Creating an AgentGateway
 * **Example:** Google-managed gateway
 * ```typescript
 * const gateway = yield* GCP.NetworkServices.AgentGateway("Agents", {
 *   googleManaged: { governedAccessPath: "AGENT_TO_ANYWHERE" },
 * });
 * ```
 *
 * **Example:** Named gateway with labels
 * ```typescript
 * const gateway = yield* GCP.NetworkServices.AgentGateway("Agents", {
 *   agentGatewayId: "app-agents",
 *   location: "us-central1",
 *   description: "prod agents",
 *   labels: { env: "prod" },
 *   googleManaged: { governedAccessPath: "CLIENT_TO_AGENT" },
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const AgentGateway = Resource<AgentGateway>(
  "GCP.NetworkServices.AgentGateway",
);

const toGoogleManaged = (
  value:
    | AgentGatewayGoogleManaged
    | networkservices.AgentGatewayGoogleManaged
    | undefined,
): AgentGatewayGoogleManaged | undefined => {
  if (value === undefined) return undefined;
  return { governedAccessPath: value.governedAccessPath };
};

const toSelfManaged = (
  value:
    | AgentGatewaySelfManaged
    | networkservices.AgentGatewaySelfManaged
    | undefined,
): AgentGatewaySelfManaged | undefined => {
  if (value === undefined) return undefined;
  return { resourceUri: value.resourceUri };
};

const toNetworkConfig = (
  value:
    | AgentGatewayNetworkConfig
    | networkservices.AgentGatewayNetworkConfig
    | undefined,
): AgentGatewayNetworkConfig | undefined => {
  if (value === undefined) return undefined;
  return {
    egress: value.egress
      ? { networkAttachment: value.egress.networkAttachment }
      : undefined,
    dnsPeeringConfig: value.dnsPeeringConfig
      ? {
          domains: value.dnsPeeringConfig.domains ?? [],
          targetProject: value.dnsPeeringConfig.targetProject,
          targetNetwork: value.dnsPeeringConfig.targetNetwork,
        }
      : undefined,
  };
};

const toCard = (
  value: networkservices.AgentGatewayAgentGatewayOutputCard | undefined,
): AgentGatewayOutputCard | undefined => {
  if (value === undefined) return undefined;
  return {
    mtlsEndpoint: value.mtlsEndpoint,
    rootCertificates: value.rootCertificates ?? [],
    serviceExtensionsServiceAccount: value.serviceExtensionsServiceAccount,
  };
};

const toAttrs = (
  gateway: networkservices.AgentGateway,
  project: string,
  region: string,
) => {
  const name = gateway.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    agentGatewayId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    googleManaged: toGoogleManaged(gateway.googleManaged),
    selfManaged: toSelfManaged(gateway.selfManaged),
    registries: gateway.registries ?? [],
    protocols: gateway.protocols ?? [],
    networkConfig: toNetworkConfig(gateway.networkConfig),
    agentGatewayCard: toCard(gateway.agentGatewayCard),
    description: gateway.description,
    labels: userLabels(gateway.labels),
    etag: gateway.etag,
    createTime: gateway.createTime,
    updateTime: gateway.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsAgentGateways({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const AgentGatewayProvider = () =>
  Provider.succeed(AgentGateway, {
    stables: ["name", "agentGatewayId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.agentGatewayId ?? output?.agentGatewayId;
      const nextId = news.agentGatewayId
        ? rfc1035(news.agentGatewayId, "agent-gateway")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const agentGatewayId = yield* toPhysicalId(
        id,
        olds?.agentGatewayId,
        output?.agentGatewayId,
        "agent-gateway",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, agentGatewayId);
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
        const items = yield* collectPages(
          networkservices.listProjectsLocationsAgentGateways.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
            returnPartialSuccess: true,
          }),
          (page) => page.agentGateways,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const agentGatewayId = yield* toPhysicalId(
        id,
        news.agentGatewayId,
        output?.agentGatewayId,
        "agent-gateway",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        agentGatewayId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredGoogle = toGoogleManaged(news.googleManaged);
      const desiredSelf = toSelfManaged(news.selfManaged);
      const desiredNetwork = toNetworkConfig(news.networkConfig);
      const desiredRegistries = news.registries ?? [];
      const desiredProtocols = news.protocols ?? [];

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsAgentGateways({
            parent: parentOf(env.project, location),
            agentGatewayId,
            body: {
              labels: desiredLabels,
              description: news.description,
              googleManaged: desiredGoogle,
              selfManaged: desiredSelf,
              registries: desiredRegistries,
              protocols: desiredProtocols,
              networkConfig: desiredNetwork,
            },
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
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const googleChanged = !sameJson(
        toGoogleManaged(current.googleManaged),
        desiredGoogle,
      );
      const selfChanged = !sameJson(
        toSelfManaged(current.selfManaged),
        desiredSelf,
      );
      const registriesChanged = !sameStringList(
        current.registries,
        desiredRegistries,
      );
      const protocolsChanged = !sameStringList(
        current.protocols,
        desiredProtocols,
      );
      const networkChanged = !sameJson(
        toNetworkConfig(current.networkConfig),
        desiredNetwork,
      );

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["googleManaged", googleChanged],
        ["selfManaged", selfChanged],
        ["registries", registriesChanged],
        ["protocols", protocolsChanged],
        ["networkConfig", networkChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsAgentGateways({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              googleManaged: desiredGoogle,
              selfManaged: desiredSelf,
              registries: desiredRegistries,
              protocols: desiredProtocols,
              networkConfig: desiredNetwork,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsAgentGateways({
          name: output.name,
          etag: output.etag,
        })
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
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
