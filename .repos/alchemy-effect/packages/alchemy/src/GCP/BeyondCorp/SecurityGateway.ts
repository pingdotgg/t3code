import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_GLOBAL,
  ResourceNotResolved,
  collectPages,
  encodeOwnershipLine,
  fieldMask,
  fingerprint,
  hasOwnershipMarker,
  listAtLocation,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  rfc1035,
  toPhysicalId,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "securityGateways";

export type SecurityGatewayInternetGateway = {
  /** IP addresses assigned to Cloud NAT. Output only. */
  assignedIps?: string[];
};

export type SecurityGatewayHub = {
  /** Internet gateway configuration for the hub. */
  internetGateway?: SecurityGatewayInternetGateway;
};

export type SecurityGatewayServiceDiscovery = {
  /** External API-gateway discovery settings. */
  apiGateway?: {
    /** Path used to fetch resource-model updates. */
    resourceOverride?: { path?: string };
  };
};

export type SecurityGatewayContextualHeaders = {
  /** Delegated device-info output type. */
  deviceInfo?: { outputType?: string };
  /** Delegated user-info output type. */
  userInfo?: { outputType?: string };
  /** Delegated group-info output type. */
  groupInfo?: { outputType?: string };
  /** Default output type for enabled headers. */
  outputType?: string;
};

export type SecurityGatewayProxyProtocolConfig = {
  /** Allowed client header names. */
  allowedClientHeaders?: string[];
  /** Custom metadata headers. */
  metadataHeaders?: Record<string, string>;
  /** Gateway identity included in the proxy protocol. */
  gatewayIdentity?: string;
  /** Contextual header configuration. */
  contextualHeaders?: SecurityGatewayContextualHeaders;
  /** Include the client IP when true. */
  clientIp?: boolean;
};

export type SecurityGatewayProps = {
  /**
   * SecurityGateway id (the `{securityGateway}` segment of
   * `projects/{project}/locations/{location}/securityGateways/{securityGateway}`).
   * If omitted, a unique RFC1035 name is generated. Must be 4-63
   * characters matching `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable —
   * changing it replaces the gateway.
   */
  securityGatewayId?: string;
  /**
   * Location. Security gateways live in `global`. Immutable — changing
   * it replaces the gateway.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name. Cannot exceed 64 characters. SecurityGateway
   * has no labels field, so Alchemy stamps ownership into this value
   * and strips it from attributes.
   */
  displayName?: string;
  /**
   * Regional hubs keyed by GCP region. Defaults to an internet-gateway
   * hub in the stack's GCP region (`GCP.Region`, else the profile region,
   * else `us-central1`); once created, an unset value keeps the current hubs.
   */
  hubs?: Record<string, SecurityGatewayHub>;
  /**
   * Service discovery settings.
   */
  serviceDiscovery?: SecurityGatewayServiceDiscovery;
  /**
   * Shared proxy-protocol configuration for applications.
   */
  proxyProtocolConfig?: SecurityGatewayProxyProtocolConfig;
};

export type SecurityGateway = Resource<
  "GCP.BeyondCorp.SecurityGateway",
  SecurityGatewayProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/securityGateways/{securityGateway}`. */
    name: string;
    /** SecurityGateway id (last path segment). */
    securityGatewayId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Regional hubs. */
    hubs: Record<string, SecurityGatewayHub> | undefined;
    /** Service discovery settings. */
    serviceDiscovery: SecurityGatewayServiceDiscovery | undefined;
    /** Shared proxy-protocol configuration. */
    proxyProtocolConfig: SecurityGatewayProxyProtocolConfig | undefined;
    /** Server-reported state (`RUNNING`, `CREATING`, …). */
    state: string | undefined;
    /** Service account used for consumer-project operations. */
    delegatingServiceAccount: string | undefined;
    /** External IPs used to reach endpoints. */
    externalIps: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BeyondCorp Security Gateway that fronts Chrome Enterprise Premium
 * applications.
 *
 * The API has no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Changing `securityGatewayId` or
 * `location` replaces the gateway. Display name and hubs update in
 * place.
 *
 * ### Creating a SecurityGateway
 * **Example:** Generated name with a us-central1 hub
 * ```typescript
 * const gateway = yield* GCP.BeyondCorp.SecurityGateway("Pep", {});
 * ```
 *
 * **Example:** Explicit id and display name
 * ```typescript
 * const gateway = yield* GCP.BeyondCorp.SecurityGateway("Pep", {
 *   securityGatewayId: "app-pep",
 *   displayName: "prod gateway",
 *   hubs: {
 *     "us-central1": { internetGateway: {} },
 *   },
 * });
 * ```
 *
 * @resource
 * @category BeyondCorp
 */
export const SecurityGateway = Resource<SecurityGateway>(
  "GCP.BeyondCorp.SecurityGateway",
);

const resourceName = (
  project: string,
  location: string,
  securityGatewayId: string,
) =>
  `projects/${project}/locations/${location}/securityGateways/${securityGatewayId}`;

const hubKeys = (hubs: Record<string, SecurityGatewayHub> | undefined) =>
  Object.keys(hubs ?? {}).sort();

const toHubs = (
  hubs: beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1HubMap | undefined,
): Record<string, SecurityGatewayHub> | undefined => {
  if (hubs === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(hubs).map(([region, hub]) => [
      region,
      {
        internetGateway: hub?.internetGateway
          ? {
              assignedIps: hub.internetGateway.assignedIps
                ? [...hub.internetGateway.assignedIps]
                : undefined,
            }
          : undefined,
      },
    ]),
  );
};

const toServiceDiscovery = (
  value:
    | beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1ServiceDiscovery
    | undefined,
): SecurityGatewayServiceDiscovery | undefined => {
  if (value === undefined) return undefined;
  return {
    apiGateway: value.apiGateway
      ? {
          resourceOverride: value.apiGateway.resourceOverride
            ? { path: value.apiGateway.resourceOverride.path }
            : undefined,
        }
      : undefined,
  };
};

const toContextualHeaders = (
  value:
    | beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1ContextualHeaders
    | undefined,
): SecurityGatewayContextualHeaders | undefined => {
  if (value === undefined) return undefined;
  return {
    deviceInfo: value.deviceInfo
      ? {
          outputType:
            value.deviceInfo.outputType === undefined
              ? undefined
              : `${value.deviceInfo.outputType}`,
        }
      : undefined,
    userInfo: value.userInfo
      ? {
          outputType:
            value.userInfo.outputType === undefined
              ? undefined
              : `${value.userInfo.outputType}`,
        }
      : undefined,
    groupInfo: value.groupInfo
      ? {
          outputType:
            value.groupInfo.outputType === undefined
              ? undefined
              : `${value.groupInfo.outputType}`,
        }
      : undefined,
    outputType:
      value.outputType === undefined ? undefined : `${value.outputType}`,
  };
};

const toProxyProtocolConfig = (
  value:
    | beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1ProxyProtocolConfig
    | undefined,
): SecurityGatewayProxyProtocolConfig | undefined => {
  if (value === undefined) return undefined;
  const metadataHeaders = value.metadataHeaders;
  return {
    allowedClientHeaders: value.allowedClientHeaders
      ? [...value.allowedClientHeaders]
      : undefined,
    metadataHeaders:
      metadataHeaders === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(metadataHeaders).flatMap(([key, header]) =>
              header === undefined ? [] : [[key, header]],
            ),
          ),
    gatewayIdentity:
      value.gatewayIdentity === undefined
        ? undefined
        : `${value.gatewayIdentity}`,
    contextualHeaders: toContextualHeaders(value.contextualHeaders),
    clientIp: value.clientIp,
  };
};

const toAttrs = (
  item: beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1SecurityGateway,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  const ownership = parseOwnership(item.displayName);
  return {
    name,
    securityGatewayId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: ownership.text,
    hubs: toHubs(item.hubs),
    serviceDiscovery: toServiceDiscovery(item.serviceDiscovery),
    proxyProtocolConfig: toProxyProtocolConfig(item.proxyProtocolConfig),
    state: item.state === undefined ? undefined : `${item.state}`,
    delegatingServiceAccount: item.delegatingServiceAccount,
    externalIps: item.externalIps ? [...item.externalIps] : [],
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  beyondcorp
    .getProjectsLocationsSecurityGateways({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    collectPages(
      beyondcorp.listProjectsLocationsSecurityGateways.pages({
        parent,
        pageSize: 1000,
      }),
      (
        page,
      ):
        | readonly beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1SecurityGateway[]
        | undefined => page.securityGateways,
    ),
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(item.displayName)),
    ),
  );

const desiredHubs = (
  hubs: Record<string, SecurityGatewayHub>,
): beyondcorp.GoogleCloudBeyondcorpSecuritygatewaysV1HubMap =>
  Object.fromEntries(
    Object.entries(hubs).map(([region, hub]) => [
      region,
      { internetGateway: hub.internetGateway ? {} : undefined },
    ]),
  );

export const SecurityGatewayProvider = () =>
  Provider.succeed(SecurityGateway, {
    stables: ["name", "securityGatewayId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.securityGatewayId ?? output?.securityGatewayId,
        nextId: news.securityGatewayId
          ? rfc1035(news.securityGatewayId, "securitygateway")
          : (olds?.securityGatewayId ?? output?.securityGatewayId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          DEFAULT_GLOBAL,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          DEFAULT_GLOBAL,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const securityGatewayId = yield* toPhysicalId(
        id,
        olds?.securityGatewayId,
        output?.securityGatewayId,
        "securitygateway",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ?? resourceName(env.project, location, securityGatewayId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const securityGatewayId = yield* toPhysicalId(
        id,
        news.securityGatewayId,
        output?.securityGatewayId,
        "securitygateway",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, securityGatewayId);
      const ownership = yield* createInternalLabels(id);
      const desiredDisplayName = encodeOwnershipLine(
        ownership,
        news.displayName,
      );
      // An unset `hubs` keeps the existing hubs (a previous default or an
      // adopted gateway's) so a changed stack region never moves them.
      const hubSpec: Record<string, SecurityGatewayHub> = news.hubs ??
        (olds?.hubs === undefined ? output?.hubs : undefined) ?? {
          [env.region]: { internetGateway: {} },
        };
      const hubs = desiredHubs(hubSpec);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* beyondcorp
          .createProjectsLocationsSecurityGateways({
            parent: parentOf(env.project, location),
            securityGatewayId,
            body: {
              displayName: desiredDisplayName,
              hubs,
              serviceDiscovery: news.serviceDiscovery,
              proxyProtocolConfig: news.proxyProtocolConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(getByName(name), name, (item) =>
          item.state === undefined ? undefined : `${item.state}`,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const mask = fieldMask([
        (current.displayName ?? "") !== desiredDisplayName && "display_name",
        fingerprint(hubKeys(toHubs(current.hubs))) !==
          fingerprint(hubKeys(hubSpec)) && "hubs",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* beyondcorp.patchProjectsLocationsSecurityGateways({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              displayName: desiredDisplayName,
              hubs,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* beyondcorp
        .deleteProjectsLocationsSecurityGateways({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
