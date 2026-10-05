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
  DEFAULT_GLOBAL,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameNumberList,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "gateways";
const DEFAULT_TYPE = "OPEN_MESH";
const DEFAULT_PORTS = [443];

export type GatewayType = networkservices.GatewayTypeEnum | (string & {});
export type GatewayIpVersion =
  | networkservices.GatewayIpVersionEnum
  | (string & {});
export type GatewayEnvoyHeaders =
  | networkservices.GatewayEnvoyHeadersEnum
  | (string & {});
export type GatewayRoutingMode =
  | networkservices.GatewayRoutingModeEnum
  | (string & {});

export type GatewayProps = {
  /**
   * Gateway id (the `{gateway}` segment of
   * `projects/{project}/locations/{location}/gateways/{gateway}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the gateway.
   */
  gatewayId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the gateway. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Customer-managed gateway type. Immutable — changing it replaces the
   * gateway.
   * @default "OPEN_MESH"
   */
  type?: GatewayType;
  /**
   * Ports (1-65535) the proxy binds. `SECURE_WEB_GATEWAY` is limited to
   * 5 ports. Mutually exclusive with `allPorts`.
   * @default [443]
   */
  ports?: number[];
  /**
   * Listen on every port. Mutually exclusive with `ports`. Only applies
   * to `SECURE_WEB_GATEWAY`.
   * @default false
   */
  allPorts?: boolean;
  /**
   * Zero or one IPv4/IPv6 address. Empty allocates from the subnetwork.
   * Only applies to `SECURE_WEB_GATEWAY`.
   */
  addresses?: string[];
  /**
   * Merge key for configuration across Gateway instances. Max 64
   * characters; must start with a letter. Defaults to the gateway id.
   * Immutable — changing it replaces the gateway.
   */
  scope?: string;
  /**
   * ServerTlsPolicy URL used to terminate TLS. Empty disables TLS
   * termination.
   */
  serverTlsPolicy?: string;
  /**
   * Certificate Manager certificate URLs presented during TLS. Only
   * applies to `SECURE_WEB_GATEWAY`.
   */
  certificateUrls?: string[];
  /**
   * GatewaySecurityPolicy URL applied to inbound connections. Only
   * applies to `SECURE_WEB_GATEWAY`.
   */
  gatewaySecurityPolicy?: string;
  /**
   * VPC network resource name, e.g.
   * `projects/{project}/global/networks/{network}`. Immutable. Only
   * applies to `SECURE_WEB_GATEWAY`.
   */
  network?: string;
  /**
   * Subnetwork resource name, e.g.
   * `projects/{project}/regions/{region}/subnetworks/{subnetwork}`.
   * Immutable. Only applies to `SECURE_WEB_GATEWAY`.
   */
  subnetwork?: string;
  /**
   * IP version (`IPV4` or `IPV6`).
   */
  ipVersion?: GatewayIpVersion;
  /**
   * Whether Envoy inserts internal debug headers on upstream requests.
   */
  envoyHeaders?: GatewayEnvoyHeaders;
  /**
   * Routing mode. Required for `SECURE_WEB_GATEWAY`.
   */
  routingMode?: GatewayRoutingMode;
  /**
   * Allow clients outside the gateway region. Only applies to
   * `SECURE_WEB_GATEWAY`.
   * @default false
   */
  allowGlobalAccess?: boolean;
  /**
   * Human-readable description. Max length 1024 characters.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Gateway = Resource<
  "GCP.NetworkServices.Gateway",
  GatewayProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/gateways/{gateway}`. */
    name: string;
    /** Gateway id (last path segment). */
    gatewayId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** Gateway type. */
    type: string;
    /** Bound ports. */
    ports: number[];
    /** Whether the gateway listens on every port. */
    allPorts: boolean;
    /** Bound addresses. */
    addresses: string[];
    /** Configuration merge scope. */
    scope: string | undefined;
    /** ServerTlsPolicy URL, if set. */
    serverTlsPolicy: string | undefined;
    /** Certificate Manager certificate URLs. */
    certificateUrls: string[];
    /** GatewaySecurityPolicy URL, if set. */
    gatewaySecurityPolicy: string | undefined;
    /** VPC network resource name, if set. */
    network: string | undefined;
    /** Subnetwork resource name, if set. */
    subnetwork: string | undefined;
    /** IP version, if set. */
    ipVersion: string | undefined;
    /** Envoy debug-header setting, if set. */
    envoyHeaders: string | undefined;
    /** Routing mode, if set. */
    routingMode: string | undefined;
    /** Whether clients outside the region are allowed. */
    allowGlobalAccess: boolean;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Services Gateway — the ip:port a Mesh or Secure Web Gateway
 * proxy listens on, plus TLS and routing policy.
 *
 * Changing `gatewayId`, `location`, `type`, `network`, or `subnetwork`
 * replaces the gateway. Description, labels, ports, scope, TLS, and
 * routing fields update in place.
 *
 * ### Creating a Gateway
 * **Example:** Open mesh gateway
 * ```typescript
 * const gateway = yield* GCP.NetworkServices.Gateway("Mesh", {
 *   type: "OPEN_MESH",
 *   ports: [443],
 * });
 * ```
 *
 * **Example:** Named gateway with labels
 * ```typescript
 * const gateway = yield* GCP.NetworkServices.Gateway("Mesh", {
 *   gatewayId: "app-mesh",
 *   description: "prod mesh",
 *   labels: { env: "prod" },
 *   type: "OPEN_MESH",
 *   ports: [80, 443],
 *   scope: "prod",
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const Gateway = Resource<Gateway>("GCP.NetworkServices.Gateway");

const toAttrs = (gateway: networkservices.Gateway, project: string) => {
  const name = gateway.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    gatewayId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    selfLink: gateway.selfLink,
    type: gateway.type ?? DEFAULT_TYPE,
    ports: gateway.ports ?? [],
    allPorts: gateway.allPorts === true,
    addresses: gateway.addresses ?? [],
    scope: gateway.scope,
    serverTlsPolicy: gateway.serverTlsPolicy,
    certificateUrls: gateway.certificateUrls ?? [],
    gatewaySecurityPolicy: gateway.gatewaySecurityPolicy,
    network: gateway.network,
    subnetwork: gateway.subnetwork,
    ipVersion: gateway.ipVersion,
    envoyHeaders: gateway.envoyHeaders,
    routingMode: gateway.routingMode,
    allowGlobalAccess: gateway.allowGlobalAccess === true,
    description: gateway.description,
    labels: userLabels(gateway.labels),
    createTime: gateway.createTime,
    updateTime: gateway.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsGateways({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const GatewayProvider = () =>
  Provider.succeed(Gateway, {
    stables: [
      "name",
      "gatewayId",
      "project",
      "location",
      "selfLink",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.gatewayId ?? output?.gatewayId;
      const nextId = news.gatewayId
        ? rfc1035(news.gatewayId, "gateway")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const previousType = olds?.type ?? output?.type ?? DEFAULT_TYPE;
      const nextType = news.type ?? previousType;
      const previousNetwork = olds?.network ?? output?.network ?? "";
      const nextNetwork = news.network ?? previousNetwork;
      const previousSubnetwork = olds?.subnetwork ?? output?.subnetwork ?? "";
      const nextSubnetwork = news.subnetwork ?? previousSubnetwork;
      const previousScope = olds?.scope ?? output?.scope ?? previousId ?? "";
      const nextScope = news.scope ?? previousScope;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        previousNetwork !== nextNetwork ||
        previousSubnetwork !== nextSubnetwork ||
        (previousScope.length > 0 && nextScope !== previousScope)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const gatewayId = yield* toPhysicalId(
        id,
        olds?.gatewayId,
        output?.gatewayId,
        "gateway",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, gatewayId);
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
        const items = yield* collectPages(
          networkservices.listProjectsLocationsGateways.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.gateways,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const gatewayId = yield* toPhysicalId(
        id,
        news.gatewayId,
        output?.gatewayId,
        "gateway",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, COLLECTION, gatewayId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const type = news.type ?? DEFAULT_TYPE;
      const allPorts = news.allPorts === true;
      const ports = allPorts ? undefined : (news.ports ?? DEFAULT_PORTS);
      const allowGlobalAccess = news.allowGlobalAccess === true;
      const scope = news.scope ?? gatewayId;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsGateways({
            parent: parentOf(env.project, location),
            gatewayId,
            body: {
              type,
              labels: desiredLabels,
              description: news.description,
              ports,
              allPorts: allPorts ? true : undefined,
              addresses: news.addresses,
              scope,
              serverTlsPolicy: news.serverTlsPolicy,
              certificateUrls: news.certificateUrls,
              gatewaySecurityPolicy: news.gatewaySecurityPolicy,
              network: news.network,
              subnetwork: news.subnetwork,
              ipVersion: news.ipVersion,
              envoyHeaders: news.envoyHeaders,
              routingMode: news.routingMode,
              allowGlobalAccess: allowGlobalAccess ? true : undefined,
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
      const portsChanged = !sameNumberList(current.ports, ports ?? []);
      const allPortsChanged = (current.allPorts === true) !== allPorts;
      const addressesChanged = !sameStringList(
        current.addresses,
        news.addresses,
      );
      const scopeChanged = (current.scope ?? "") !== scope;
      const serverTlsChanged =
        (current.serverTlsPolicy ?? "") !== (news.serverTlsPolicy ?? "");
      const certsChanged = !sameStringList(
        current.certificateUrls,
        news.certificateUrls,
      );
      const securityChanged =
        (current.gatewaySecurityPolicy ?? "") !==
        (news.gatewaySecurityPolicy ?? "");
      const ipVersionChanged =
        (current.ipVersion ?? "") !== (news.ipVersion ?? "");
      const envoyChanged =
        (current.envoyHeaders ?? "") !== (news.envoyHeaders ?? "");
      const routingChanged =
        (current.routingMode ?? "") !== (news.routingMode ?? "");
      const globalAccessChanged =
        (current.allowGlobalAccess === true) !== allowGlobalAccess;

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["ports", portsChanged],
        ["allPorts", allPortsChanged],
        ["addresses", addressesChanged],
        ["scope", scopeChanged],
        ["serverTlsPolicy", serverTlsChanged],
        ["certificateUrls", certsChanged],
        ["gatewaySecurityPolicy", securityChanged],
        ["ipVersion", ipVersionChanged],
        ["envoyHeaders", envoyChanged],
        ["routingMode", routingChanged],
        ["allowGlobalAccess", globalAccessChanged],
      ]);

      if (updateMask.length > 0) {
        const operation = yield* networkservices.patchProjectsLocationsGateways(
          {
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              type,
              labels: desiredLabels,
              description: news.description,
              ports,
              allPorts: allPorts ? true : false,
              addresses: news.addresses ?? [],
              scope,
              serverTlsPolicy: news.serverTlsPolicy,
              certificateUrls: news.certificateUrls ?? [],
              gatewaySecurityPolicy: news.gatewaySecurityPolicy,
              ipVersion: news.ipVersion,
              envoyHeaders: news.envoyHeaders,
              routingMode: news.routingMode,
              allowGlobalAccess,
            },
          },
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsGateways({ name: output.name })
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
