import { Services } from "@distilled.cloud/hetzner";
import type {
  CreateLoadBalancerRequestServicesItem,
  GetLoadBalancerResponseLoadBalancer,
  ListLoadBalancersResponseLoadBalancersItem,
} from "@distilled.cloud/hetzner/load_balancers";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { waitForAction } from "./actions.ts";
import type { Certificate } from "./Certificate.ts";
import {
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Network } from "./Network.ts";
import type { Providers } from "./Providers.ts";

const DEFAULT_LOCATION = "nbg1";
const DEFAULT_TYPE = "lb11";
const DEFAULT_ALGORITHM = "round_robin";
const MAX_NAME_LENGTH = 64;

const DEFAULT_HC_INTERVAL = 15;
const DEFAULT_HC_TIMEOUT = 10;
const DEFAULT_HC_RETRIES = 3;
const DEFAULT_COOKIE_NAME = "HCLBSTICKY";
const DEFAULT_COOKIE_LIFETIME = 300;
const DEFAULT_TIMEOUT_IDLE = 15;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Server(...)` and `Server(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Server identity a Load Balancer target can point at. A `Hetzner.Server`
 * resource satisfies this via `serverId`.
 */
export type LoadBalancerServer = {
  readonly serverId: number;
};

export type LoadBalancerAlgorithm = "round_robin" | "least_connections";

export type LoadBalancerProtocol = "tcp" | "http" | "https";

export type HealthCheckProtocol = "tcp" | "http";

export type TargetHealthStatus = "healthy" | "unhealthy" | "unknown";

export interface LoadBalancerHealthCheckHttp {
  /**
   * Host header sent with the HTTP health check. `null` omits the header.
   */
  domain?: string | null;
  /**
   * HTTP path used for the health check.
   * @default "/"
   */
  path?: string;
  /**
   * Substring that must appear in the health-check response body.
   */
  response?: string;
  /**
   * Status codes that count as healthy. `?` and `*` wildcards are allowed.
   * @default ["2??", "3??"]
   */
  statusCodes?: string[];
  /**
   * Use HTTPS for the health-check request.
   * @default false
   */
  tls?: boolean;
}

export interface LoadBalancerHealthCheck {
  /**
   * Health-check protocol. `tcp` for a connect check; `http` for an HTTP GET.
   */
  protocol: HealthCheckProtocol;
  /**
   * Port the health check is performed on.
   */
  port: number;
  /**
   * Interval between checks, in seconds.
   * @default 15
   */
  interval?: number;
  /**
   * Per-attempt timeout, in seconds.
   * @default 10
   */
  timeout?: number;
  /**
   * Consecutive failures (or successes) before flipping healthy/unhealthy.
   * @default 3
   */
  retries?: number;
  /**
   * Extra options when `protocol` is `http`.
   */
  http?: LoadBalancerHealthCheckHttp;
}

export interface LoadBalancerServiceHttp {
  /**
   * Cookie name used for sticky sessions.
   * @default "HCLBSTICKY"
   */
  cookieName?: string;
  /**
   * Sticky-session cookie lifetime in seconds.
   * @default 300
   */
  cookieLifetime?: number;
  /**
   * Idle timeout in seconds for client and server connections.
   * @default 15
   */
  timeoutIdle?: number;
  /**
   * Pin a client to one target via a cookie.
   * @default false
   */
  stickySessions?: boolean;
  /**
   * Redirect HTTP to HTTPS. Only valid when the service protocol is `https`.
   * @default false
   */
  redirectHttp?: boolean;
  /**
   * Certificates used for TLS termination. Empty means TLS passthrough.
   * Accepts `Hetzner.Certificate` resources.
   */
  certificates?: Array<Ref<Certificate>>;
}

export interface LoadBalancerService {
  /**
   * Listener protocol.
   */
  protocol: LoadBalancerProtocol;
  /**
   * Port the Load Balancer listens on. Unique per Load Balancer.
   */
  listenPort: number;
  /**
   * Port traffic is forwarded to on each target.
   */
  destinationPort: number;
  /**
   * Enable the PROXY protocol on this service.
   * @default false
   */
  proxyprotocol?: boolean;
  /**
   * Health check. Defaults to a TCP (or HTTP, for `http`/`https` services)
   * check on `destinationPort`.
   */
  healthCheck?: LoadBalancerHealthCheck;
  /**
   * HTTP/HTTPS options. Ignored for `tcp` services.
   */
  http?: LoadBalancerServiceHttp;
}

export type LoadBalancerTarget =
  | {
      type: "server";
      /**
       * Server to receive traffic. Accepts a `Hetzner.Server` or `{ serverId }`.
       */
      server: Ref<LoadBalancerServer>;
      /**
       * Route via the Server's private IP. Requires the Server and Load
       * Balancer to share a Network.
       * @default false
       */
      usePrivateIp?: boolean;
      /**
       * Optional public IP of the Server to use as the target (Primary IPv4
       * or an IPv6 host in the Server's `/64`).
       */
      ip?: string;
    }
  | {
      type: "label_selector";
      /**
       * Label selector used to pick target Servers.
       */
      selector: string;
      /**
       * Route via each Server's private IP.
       * @default false
       */
      usePrivateIp?: boolean;
    }
  | {
      type: "ip";
      /**
       * Public or vSwitch IP of a Hetzner Online Root Server owned by the
       * project owner.
       */
      ip: string;
    };

export interface LoadBalancerProps {
  /**
   * Name of the Load Balancer. Must be unique per project, 1–64 characters.
   * If omitted, a unique name is generated from the stack, stage and
   * logical ID.
   */
  name?: string;
  /**
   * Load Balancer type (`lb11`, `lb21`, `lb31`, …). Changing to a larger
   * type updates in place; Hetzner cannot downgrade a type.
   * @default "lb11"
   */
  loadBalancerType?: string;
  /**
   * Location to create the Load Balancer in (`nbg1`, `fsn1`, `hel1`, …).
   * Mutually exclusive with `networkZone`. Cannot be changed after
   * creation — changing it replaces the Load Balancer.
   * @default "nbg1"
   */
  location?: string;
  /**
   * Network zone (`eu-central`, `us-east`, …). Mutually exclusive with
   * `location`. Cannot be changed after creation.
   */
  networkZone?: string;
  /**
   * Balancing algorithm.
   * @default "round_robin"
   */
  algorithm?: LoadBalancerAlgorithm;
  /**
   * Listeners. Synced via add/update/delete service actions, keyed by
   * `listenPort`.
   */
  services?: LoadBalancerService[];
  /**
   * Backend targets. Server targets take a `Hetzner.Server` (or `{ serverId }`).
   */
  targets?: LoadBalancerTarget[];
  /**
   * Private Networks to attach. Accepts `Hetzner.Network` resources.
   */
  networks?: Array<Ref<Network>>;
  /**
   * Expose the public IPv4/IPv6 interface.
   * @default true
   */
  publicInterface?: boolean;
  /**
   * Prevent the Load Balancer from being deleted in the Cloud Console /
   * API until this is cleared. The provider disables protection before
   * delete.
   * @default false
   */
  deleteProtection?: boolean;
  /**
   * User-defined labels. Alchemy ownership labels (`alchemy.stack` /
   * `alchemy.stage` / `alchemy.id`) are always merged in.
   */
  labels?: Record<string, string>;
}

export interface LoadBalancerServiceAttr {
  protocol: LoadBalancerProtocol;
  listenPort: number;
  destinationPort: number;
  proxyprotocol: boolean;
  healthCheck: {
    protocol: HealthCheckProtocol;
    port: number;
    interval: number;
    timeout: number;
    retries: number;
    http?: {
      domain: string | null;
      path: string;
      response?: string;
      statusCodes?: string[];
      tls?: boolean;
    };
  };
  http?: {
    cookieName: string;
    cookieLifetime: number;
    timeoutIdle: number;
    stickySessions: boolean;
    redirectHttp?: boolean;
    certificates?: number[];
  };
}

export type LoadBalancerTargetAttr =
  | {
      type: "server";
      serverId: number;
      ip?: string;
      usePrivateIp: boolean;
      healthStatus: { listenPort: number; status: TargetHealthStatus }[];
    }
  | {
      type: "label_selector";
      selector: string;
      usePrivateIp: boolean;
    }
  | {
      type: "ip";
      ip: string;
      healthStatus: { listenPort: number; status: TargetHealthStatus }[];
    };

export type LoadBalancer = Resource<
  "Hetzner.LoadBalancer",
  LoadBalancerProps,
  {
    /** Numeric Hetzner Load Balancer ID. */
    id: number;
    /** Load Balancer name (unique per project). */
    name: string;
    /** Load Balancer type name (`lb11`, …). */
    loadBalancerType: string;
    /** Numeric Load Balancer type ID. */
    loadBalancerTypeId: number;
    /** Location name (`nbg1`, `fsn1`, …). */
    location: string;
    /** Numeric location ID. */
    locationId: number;
    /** Network zone (`eu-central`, …). */
    networkZone: string;
    /** Balancing algorithm. */
    algorithm: LoadBalancerAlgorithm;
    /** Public IPv4, or `null` when the public interface is disabled. */
    ipv4: string | null;
    /** Public IPv6, or `null` when the public interface is disabled. */
    ipv6: string | null;
    /** Whether the public interface is enabled. */
    publicInterface: boolean;
    /** Whether delete protection is enabled. */
    deleteProtection: boolean;
    /** Observed listeners. */
    services: LoadBalancerServiceAttr[];
    /** Observed targets. */
    targets: LoadBalancerTargetAttr[];
    /** Attached private Networks and the assigned IPs. */
    privateNetworks: { networkId: number; ip: string }[];
    /** User-defined labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    created: string;
  },
  never,
  Providers
>;

/**
 * A Hetzner Cloud Load Balancer. Create it in a Location (`nbg1` by
 * default) with type `lb11`, then sync algorithm, listeners, targets,
 * private Networks, delete protection, and labels.
 *
 * Location and network zone are immutable (changing either replaces the
 * Load Balancer). Type can grow in place. Server targets take a
 * `Hetzner.Server`; HTTPS listeners take `Hetzner.Certificate`s.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#load-balancers
 *
 * ### Creating a Load Balancer
 * **Example:** Basic TCP Load Balancer
 * ```typescript
 * const lb = yield* Hetzner.LoadBalancer("edge", {
 *   location: "nbg1",
 *   loadBalancerType: "lb11",
 *   services: [
 *     { protocol: "tcp", listenPort: 80, destinationPort: 80 },
 *   ],
 * });
 * ```
 *
 * **Example:** With a Server target
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cx23",
 *   image: "ubuntu-24.04",
 *   location: "nbg1",
 * });
 * const lb = yield* Hetzner.LoadBalancer("edge", {
 *   algorithm: "round_robin",
 *   services: [
 *     { protocol: "tcp", listenPort: 80, destinationPort: 80 },
 *   ],
 *   targets: [{ type: "server", server }],
 * });
 * ```
 *
 * ### HTTPS with a Certificate
 * **Example:** Terminate TLS
 * ```typescript
 * const cert = yield* Hetzner.Certificate("web", {
 *   certificate: pem,
 *   privateKey: key,
 * });
 * const lb = yield* Hetzner.LoadBalancer("edge", {
 *   services: [
 *     {
 *       protocol: "https",
 *       listenPort: 443,
 *       destinationPort: 80,
 *       http: { certificates: [cert], redirectHttp: true },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Private Networks
 * **Example:** Attach to a Network
 * ```typescript
 * const network = yield* Hetzner.Network("vpc", {
 *   ipRange: "10.0.0.0/16",
 *   subnets: [
 *     { type: "cloud", ipRange: "10.0.1.0/24", networkZone: "eu-central" },
 *   ],
 * });
 * const lb = yield* Hetzner.LoadBalancer("edge", {
 *   networks: [network],
 *   services: [
 *     { protocol: "tcp", listenPort: 80, destinationPort: 80 },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const LoadBalancer = Resource<LoadBalancer>("Hetzner.LoadBalancer");

type CloudLoadBalancer =
  | GetLoadBalancerResponseLoadBalancer
  | ListLoadBalancersResponseLoadBalancersItem;

export class LoadBalancerNotCreated extends Data.TaggedError(
  "Hetzner.LoadBalancerNotCreated",
)<{
  name: string;
}> {}

const asAlgorithm = (value: string): LoadBalancerAlgorithm =>
  value === "least_connections" ? "least_connections" : "round_robin";

const asProtocol = (value: string): LoadBalancerProtocol =>
  value === "https" ? "https" : value === "http" ? "http" : "tcp";

const asHealthProtocol = (value: string): HealthCheckProtocol =>
  value === "http" ? "http" : "tcp";

const asHealthStatus = (value: string): TargetHealthStatus =>
  value === "healthy" || value === "unhealthy" ? value : "unknown";

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const serverIdOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serverId?: unknown; id?: unknown };
  if (typeof rec.serverId === "number") return rec.serverId;
  if (typeof rec.id === "number") return rec.id;
  return undefined;
};

const networkIdOf = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { networkId?: unknown; id?: unknown };
  if (typeof rec.networkId === "number") return rec.networkId;
  if (typeof rec.id === "number") return rec.id;
  return undefined;
};

const certificateIdOf = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { id?: unknown };
  return typeof rec.id === "number" ? rec.id : undefined;
};

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

type NormalizedHealthHttp = {
  domain: string | null;
  path: string;
  response: string;
  statusCodes: string[];
  tls: boolean;
};

type NormalizedHealthCheck = {
  protocol: HealthCheckProtocol;
  port: number;
  interval: number;
  timeout: number;
  retries: number;
  http?: NormalizedHealthHttp;
};

type NormalizedServiceHttp = {
  cookieName: string;
  cookieLifetime: number;
  timeoutIdle: number;
  stickySessions: boolean;
  redirectHttp?: boolean;
  certificates?: number[];
};

type NormalizedService = {
  protocol: LoadBalancerProtocol;
  listenPort: number;
  destinationPort: number;
  proxyprotocol: boolean;
  healthCheck: NormalizedHealthCheck;
  http?: NormalizedServiceHttp;
};

type NormalizedTarget =
  | {
      type: "server";
      serverId: number;
      ip?: string;
      usePrivateIp: boolean;
    }
  | {
      type: "label_selector";
      selector: string;
      usePrivateIp: boolean;
    }
  | {
      type: "ip";
      ip: string;
    };

const defaultHealthCheck = (
  protocol: LoadBalancerProtocol,
  destinationPort: number,
  override?: LoadBalancerHealthCheck,
): NormalizedHealthCheck => {
  const hcProtocol =
    override?.protocol ?? (protocol === "tcp" ? "tcp" : "http");
  const httpSource = override?.http;
  return {
    protocol: hcProtocol,
    port: override?.port ?? destinationPort,
    interval: override?.interval ?? DEFAULT_HC_INTERVAL,
    timeout: override?.timeout ?? DEFAULT_HC_TIMEOUT,
    retries: override?.retries ?? DEFAULT_HC_RETRIES,
    http:
      hcProtocol === "http"
        ? {
            domain: httpSource?.domain ?? null,
            path: httpSource?.path ?? "/",
            response: httpSource?.response ?? "",
            statusCodes: [
              ...(httpSource?.statusCodes ?? ["2??", "3??"]),
            ].sort(),
            tls: httpSource?.tls ?? false,
          }
        : undefined,
  };
};

const defaultServiceHttp = (
  protocol: LoadBalancerProtocol,
  http: LoadBalancerServiceHttp | undefined,
): NormalizedServiceHttp | undefined => {
  if (protocol === "tcp") return undefined;
  const certificates = (http?.certificates ?? [])
    .map(certificateIdOf)
    .filter((id): id is number => id !== undefined)
    .sort((a, b) => a - b);
  const userProvided = http !== undefined;
  if (!userProvided && protocol !== "https") return undefined;
  return {
    cookieName: http?.cookieName ?? DEFAULT_COOKIE_NAME,
    cookieLifetime: http?.cookieLifetime ?? DEFAULT_COOKIE_LIFETIME,
    timeoutIdle: http?.timeoutIdle ?? DEFAULT_TIMEOUT_IDLE,
    stickySessions: http?.stickySessions ?? false,
    ...(protocol === "https"
      ? {
          redirectHttp: http?.redirectHttp ?? false,
          certificates,
        }
      : {}),
  };
};

const desiredServices = (
  services: readonly LoadBalancerService[] | undefined,
): NormalizedService[] =>
  (services ?? [])
    .map((service) => ({
      protocol: service.protocol,
      listenPort: service.listenPort,
      destinationPort: service.destinationPort,
      proxyprotocol: service.proxyprotocol ?? false,
      healthCheck: defaultHealthCheck(
        service.protocol,
        service.destinationPort,
        service.healthCheck,
      ),
      http: defaultServiceHttp(service.protocol, service.http),
    }))
    .sort((a, b) => a.listenPort - b.listenPort);

const observedHealthHttp = (
  value: unknown,
): NormalizedHealthHttp | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = recordOf(value);
  const statusCodes = asStringArray(rec.status_codes) ?? [];
  return {
    domain:
      rec.domain === undefined ? null : ((rec.domain as string | null) ?? null),
    path: asString(rec.path) ?? "/",
    response: asString(rec.response) ?? "",
    statusCodes: [...statusCodes].sort(),
    tls: asBoolean(rec.tls) ?? false,
  };
};

const observedHealthCheck = (
  value: unknown,
  destinationPort: number,
  protocol: LoadBalancerProtocol,
): NormalizedHealthCheck => {
  const rec = recordOf(value);
  const hcProtocol = asHealthProtocol(
    asString(rec.protocol) ?? (protocol === "tcp" ? "tcp" : "http"),
  );
  return {
    protocol: hcProtocol,
    port: asNumber(rec.port) ?? destinationPort,
    interval: asNumber(rec.interval) ?? DEFAULT_HC_INTERVAL,
    timeout: asNumber(rec.timeout) ?? DEFAULT_HC_TIMEOUT,
    retries: asNumber(rec.retries) ?? DEFAULT_HC_RETRIES,
    http: hcProtocol === "http" ? observedHealthHttp(rec.http) : undefined,
  };
};

const observedServiceHttp = (
  protocol: LoadBalancerProtocol,
  value: unknown,
): NormalizedServiceHttp | undefined => {
  if (protocol === "tcp") return undefined;
  const rec = recordOf(value);
  const certificates = Array.isArray(rec.certificates)
    ? rec.certificates
        .filter((id): id is number => typeof id === "number")
        .sort((a, b) => a - b)
    : [];
  return {
    cookieName: asString(rec.cookie_name) ?? DEFAULT_COOKIE_NAME,
    cookieLifetime: asNumber(rec.cookie_lifetime) ?? DEFAULT_COOKIE_LIFETIME,
    timeoutIdle: asNumber(rec.timeout_idle) ?? DEFAULT_TIMEOUT_IDLE,
    stickySessions: asBoolean(rec.sticky_sessions) ?? false,
    ...(protocol === "https"
      ? {
          redirectHttp: asBoolean(rec.redirect_http) ?? false,
          certificates,
        }
      : {}),
  };
};

const observedServices = (value: unknown): NormalizedService[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const rec = recordOf(item);
      const protocol = asProtocol(asString(rec.protocol) ?? "tcp");
      const destinationPort = asNumber(rec.destination_port) ?? 80;
      return {
        protocol,
        listenPort: asNumber(rec.listen_port) ?? 0,
        destinationPort,
        proxyprotocol: asBoolean(rec.proxyprotocol) ?? false,
        healthCheck: observedHealthCheck(
          rec.health_check,
          destinationPort,
          protocol,
        ),
        http: observedServiceHttp(protocol, rec.http),
      };
    })
    .sort((a, b) => a.listenPort - b.listenPort);
};

const serviceFingerprint = (service: NormalizedService): string =>
  JSON.stringify(service);

const toServiceAttr = (
  service: NormalizedService,
): LoadBalancerServiceAttr => ({
  protocol: service.protocol,
  listenPort: service.listenPort,
  destinationPort: service.destinationPort,
  proxyprotocol: service.proxyprotocol,
  healthCheck: {
    protocol: service.healthCheck.protocol,
    port: service.healthCheck.port,
    interval: service.healthCheck.interval,
    timeout: service.healthCheck.timeout,
    retries: service.healthCheck.retries,
    ...(service.healthCheck.http
      ? {
          http: {
            domain: service.healthCheck.http.domain,
            path: service.healthCheck.http.path,
            ...(service.healthCheck.http.response
              ? { response: service.healthCheck.http.response }
              : {}),
            ...(service.healthCheck.http.statusCodes.length > 0
              ? { statusCodes: service.healthCheck.http.statusCodes }
              : {}),
            ...(service.healthCheck.http.tls ? { tls: true } : {}),
          },
        }
      : {}),
  },
  ...(service.http
    ? {
        http: {
          cookieName: service.http.cookieName,
          cookieLifetime: service.http.cookieLifetime,
          timeoutIdle: service.http.timeoutIdle,
          stickySessions: service.http.stickySessions,
          ...(service.http.redirectHttp !== undefined
            ? { redirectHttp: service.http.redirectHttp }
            : {}),
          ...(service.http.certificates !== undefined
            ? { certificates: service.http.certificates }
            : {}),
        },
      }
    : {}),
});

const toHealthCheckRequest = (healthCheck: NormalizedHealthCheck) => ({
  protocol: healthCheck.protocol,
  port: healthCheck.port,
  interval: healthCheck.interval,
  timeout: healthCheck.timeout,
  retries: healthCheck.retries,
  ...(healthCheck.http
    ? {
        http: {
          ...(healthCheck.http.domain !== null
            ? { domain: healthCheck.http.domain }
            : {}),
          path: healthCheck.http.path,
          ...(healthCheck.http.response
            ? { response: healthCheck.http.response }
            : {}),
          status_codes: healthCheck.http.statusCodes,
          tls: healthCheck.http.tls,
        },
      }
    : {}),
});

const toHttpRequest = (http: NormalizedServiceHttp | undefined) => {
  if (http === undefined) return undefined;
  return {
    cookie_name: http.cookieName,
    cookie_lifetime: http.cookieLifetime,
    sticky_sessions: http.stickySessions,
    ...(http.redirectHttp !== undefined
      ? { redirect_http: http.redirectHttp }
      : {}),
    ...(http.certificates !== undefined
      ? { certificates: http.certificates }
      : {}),
  };
};

const toCreateService = (
  service: NormalizedService,
): CreateLoadBalancerRequestServicesItem =>
  ({
    protocol: service.protocol,
    listen_port: service.listenPort,
    destination_port: service.destinationPort,
    proxyprotocol: service.proxyprotocol,
    health_check: toHealthCheckRequest(service.healthCheck),
    ...(service.http ? { http: toHttpRequest(service.http) } : {}),
  }) as CreateLoadBalancerRequestServicesItem;

const desiredTargets = (
  targets: readonly LoadBalancerTarget[] | undefined,
): NormalizedTarget[] => {
  const next: NormalizedTarget[] = [];
  for (const target of targets ?? []) {
    if (target.type === "server") {
      const serverId = serverIdOf(target.server);
      if (serverId === undefined) continue;
      next.push({
        type: "server",
        serverId,
        ...(target.ip !== undefined ? { ip: target.ip } : {}),
        usePrivateIp: target.usePrivateIp ?? false,
      });
    } else if (target.type === "label_selector") {
      next.push({
        type: "label_selector",
        selector: target.selector,
        usePrivateIp: target.usePrivateIp ?? false,
      });
    } else {
      next.push({ type: "ip", ip: target.ip });
    }
  }
  return next.sort((a, b) => targetKey(a).localeCompare(targetKey(b)));
};

const targetKey = (target: NormalizedTarget): string => {
  if (target.type === "server") {
    return `server:${target.serverId}:${target.usePrivateIp ? 1 : 0}:${target.ip ?? ""}`;
  }
  if (target.type === "label_selector") {
    return `label_selector:${target.selector}:${target.usePrivateIp ? 1 : 0}`;
  }
  return `ip:${target.ip}`;
};

const observedHealthStatus = (
  value: unknown,
): { listenPort: number; status: TargetHealthStatus }[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const rec = recordOf(item);
    const listenPort = asNumber(rec.listen_port);
    if (listenPort === undefined) return [];
    return [
      {
        listenPort,
        status: asHealthStatus(asString(rec.status) ?? "unknown"),
      },
    ];
  });
};

const observedTargets = (value: unknown): NormalizedTarget[] => {
  if (!Array.isArray(value)) return [];
  const next: NormalizedTarget[] = [];
  for (const item of value) {
    const rec = recordOf(item);
    const type = asString(rec.type);
    if (type === "server") {
      const server = recordOf(rec.server);
      const serverId = asNumber(server.id);
      if (serverId === undefined) continue;
      const ip = asString(server.ip);
      next.push({
        type: "server",
        serverId,
        ...(ip !== undefined ? { ip } : {}),
        usePrivateIp: asBoolean(rec.use_private_ip) ?? false,
      });
    } else if (type === "label_selector") {
      const selector = asString(recordOf(rec.label_selector).selector);
      if (selector === undefined) continue;
      next.push({
        type: "label_selector",
        selector,
        usePrivateIp: asBoolean(rec.use_private_ip) ?? false,
      });
    } else if (type === "ip") {
      const ip = asString(recordOf(rec.ip).ip);
      if (ip === undefined) continue;
      next.push({ type: "ip", ip });
    }
  }
  return next.sort((a, b) => targetKey(a).localeCompare(targetKey(b)));
};

const toTargetAttr = (
  target: NormalizedTarget,
  raw: unknown,
): LoadBalancerTargetAttr => {
  const rec = recordOf(raw);
  if (target.type === "server") {
    return {
      type: "server",
      serverId: target.serverId,
      ...(target.ip !== undefined ? { ip: target.ip } : {}),
      usePrivateIp: target.usePrivateIp,
      healthStatus: observedHealthStatus(rec.health_status),
    };
  }
  if (target.type === "label_selector") {
    return {
      type: "label_selector",
      selector: target.selector,
      usePrivateIp: target.usePrivateIp,
    };
  }
  return {
    type: "ip",
    ip: target.ip,
    healthStatus: observedHealthStatus(rec.health_status),
  };
};

const desiredNetworkIds = (
  networks: LoadBalancerProps["networks"] | undefined,
): number[] => {
  const ids = new Set<number>();
  for (const item of networks ?? []) {
    const id = networkIdOf(item);
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
};

const observedPrivateNetworks = (
  value: unknown,
): { networkId: number; ip: string }[] => {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      const rec = recordOf(item);
      const networkId = asNumber(rec.network);
      const ip = asString(rec.ip);
      if (networkId === undefined || ip === undefined) return [];
      return [{ networkId, ip }];
    })
    .sort((a, b) => a.networkId - b.networkId);
};

const toAttrs = (lb: CloudLoadBalancer): LoadBalancer["Attributes"] => {
  const services = observedServices(lb.services);
  const rawTargets = Array.isArray(lb.targets) ? lb.targets : [];
  const targets = observedTargets(lb.targets);
  const targetAttrs = targets.map((target, index) =>
    toTargetAttr(target, rawTargets[index]),
  );
  return {
    id: lb.id,
    name: lb.name,
    loadBalancerType: lb.load_balancer_type.name,
    loadBalancerTypeId: lb.load_balancer_type.id,
    location: lb.location.name,
    locationId: lb.location.id,
    networkZone: lb.location.network_zone,
    algorithm: asAlgorithm(lb.algorithm.type),
    ipv4: lb.public_net.ipv4.ip,
    ipv6: lb.public_net.ipv6.ip,
    publicInterface: lb.public_net.enabled,
    deleteProtection: lb.protection.delete,
    services: services.map(toServiceAttr),
    targets: targetAttrs,
    privateNetworks: observedPrivateNetworks(lb.private_net),
    labels: userLabels(lb.labels),
    created: lb.created,
  };
};

const retryable = (e: { readonly _tag: string }): boolean =>
  e._tag === "TooManyRequests" ||
  e._tag === "ServiceUnavailable" ||
  e._tag === "InternalServerError" ||
  e._tag === "BadGateway" ||
  e._tag === "GatewayTimeout" ||
  e._tag === "Locked" ||
  e._tag === "Conflict";

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const busyRetry = {
  while: retryable,
  times: 8,
  schedule: backoff,
} as const;

const alreadyThere = (e: { readonly _tag: string }): boolean =>
  e._tag === "Conflict" || e._tag === "UnprocessableEntity";

const alreadyGone = (e: { readonly _tag: string }): boolean =>
  e._tag === "NotFound" || e._tag === "UnprocessableEntity";

const createLoadBalancerName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const getById = (id: number) =>
  Services.loadBalancers.getLoadBalancer({ id }).pipe(
    Effect.map(({ load_balancer }) => load_balancer),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const getByName = (name: string) =>
  Services.loadBalancers
    .listLoadBalancers({ name, per_page: 50 })
    .pipe(
      Effect.map(({ load_balancers }) =>
        load_balancers.find((item) => item.name === name),
      ),
    );

const getByLabels = (labels: Record<string, string>) =>
  Services.loadBalancers
    .listLoadBalancers({
      label_selector: labelSelector(labels),
      per_page: 50,
    })
    .pipe(Effect.map(({ load_balancers }) => load_balancers[0]));

const observe = Effect.fn(function* ({
  id,
  name,
  outputId,
}: {
  id: string;
  name?: string;
  outputId?: number;
}) {
  if (outputId !== undefined) {
    const byId = yield* getById(outputId);
    if (byId !== undefined) return byId;
  }
  if (name !== undefined) {
    const byName = yield* getByName(name);
    if (byName !== undefined) return byName;
  }
  const internal = yield* createInternalLabels(id);
  return yield* getByLabels(internal);
});

const refresh = (id: number) =>
  Services.loadBalancers.getLoadBalancer({ id }).pipe(
    Effect.map(({ load_balancer }) => load_balancer),
    Effect.retry({
      while: (e) => e._tag === "NotFound" || retryable(e),
      times: 8,
      schedule: backoff,
    }),
  );

const runAction = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<{ action: { id: number } }, E, R>,
) =>
  effect.pipe(
    Effect.retry(busyRetry),
    Effect.flatMap(({ action }) => waitForAction(action)),
  );

const matchesPlacement = (
  current: CloudLoadBalancer,
  location: string | undefined,
  networkZone: string | undefined,
): boolean => {
  if (location !== undefined && current.location.name !== location) {
    return false;
  }
  if (
    networkZone !== undefined &&
    current.location.network_zone !== networkZone
  ) {
    return false;
  }
  return true;
};

const syncMetadata = (args: {
  current: CloudLoadBalancer;
  name: string;
  labels: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const observedLabels = tagRecord(args.current.labels);
    const { removed, upsert } = diffLabels(observedLabels, args.labels);
    const labelsChanged = removed.length > 0 || upsert.length > 0;
    const nameChanged = args.current.name !== args.name;
    if (!labelsChanged && !nameChanged) return args.current;
    const updated = yield* Services.loadBalancers
      .updateLoadBalancer({
        id: args.current.id,
        name: nameChanged ? args.name : undefined,
        labels: labelsChanged ? args.labels : undefined,
      })
      .pipe(Effect.retry(busyRetry));
    return updated.load_balancer;
  });

const syncAlgorithm = (
  current: CloudLoadBalancer,
  desired: LoadBalancerAlgorithm,
) =>
  Effect.gen(function* () {
    if (asAlgorithm(current.algorithm.type) === desired) return;
    yield* runAction(
      Services.loadBalancerActions.changeLoadBalancerAlgorithm({
        id: current.id,
        type: desired,
      }),
    );
  });

const syncType = (current: CloudLoadBalancer, desired: string) =>
  Effect.gen(function* () {
    if (current.load_balancer_type.name === desired) return;
    yield* runAction(
      Services.loadBalancerActions.changeLoadBalancerType({
        id: current.id,
        load_balancer_type: desired,
      }),
    );
  });

const syncProtection = (current: CloudLoadBalancer, desired: boolean) =>
  Effect.gen(function* () {
    if (current.protection.delete === desired) return;
    yield* runAction(
      Services.loadBalancerActions.changeLoadBalancerProtection({
        id: current.id,
        delete: desired,
      }),
    );
  });

const syncPublicInterface = (current: CloudLoadBalancer, desired: boolean) =>
  Effect.gen(function* () {
    if (current.public_net.enabled === desired) return;
    if (desired) {
      yield* runAction(
        Services.loadBalancerActions.enableLoadBalancerPublicInterface({
          id: current.id,
        }),
      );
      return;
    }
    yield* runAction(
      Services.loadBalancerActions.disableLoadBalancerPublicInterface({
        id: current.id,
      }),
    );
  });

const syncServices = (
  loadBalancerId: number,
  observed: readonly NormalizedService[],
  desired: readonly NormalizedService[],
) =>
  Effect.gen(function* () {
    const observedByPort = new Map(
      observed.map((service) => [service.listenPort, service]),
    );
    const desiredByPort = new Map(
      desired.map((service) => [service.listenPort, service]),
    );

    for (const service of observed) {
      if (desiredByPort.has(service.listenPort)) continue;
      yield* runAction(
        Services.loadBalancerActions.deleteLoadBalancerService({
          id: loadBalancerId,
          listen_port: service.listenPort,
        }),
      ).pipe(Effect.catchIf(alreadyGone, () => Effect.void));
    }

    for (const service of desired) {
      const existing = observedByPort.get(service.listenPort);
      if (existing === undefined) {
        yield* runAction(
          Services.loadBalancerActions.addLoadBalancerService({
            id: loadBalancerId,
            protocol: service.protocol,
            listen_port: service.listenPort,
            destination_port: service.destinationPort,
            proxyprotocol: service.proxyprotocol,
            health_check: toHealthCheckRequest(service.healthCheck),
            http: toHttpRequest(service.http),
          }),
        ).pipe(
          Effect.catchIf(
            (e) => e._tag === "Conflict" || e._tag === "PreconditionFailed",
            () => Effect.void,
          ),
        );
        continue;
      }
      if (serviceFingerprint(existing) === serviceFingerprint(service)) {
        continue;
      }
      yield* runAction(
        Services.loadBalancerActions.updateLoadBalancerService({
          id: loadBalancerId,
          protocol: service.protocol,
          listen_port: service.listenPort,
          destination_port: service.destinationPort,
          proxyprotocol: service.proxyprotocol,
          health_check: toHealthCheckRequest(service.healthCheck),
          http: toHttpRequest(service.http),
        }),
      );
    }
  });

const addTargetRequest = (loadBalancerId: number, target: NormalizedTarget) => {
  if (target.type === "server") {
    return Services.loadBalancerActions.addLoadBalancerTarget({
      id: loadBalancerId,
      type: "server",
      server: {
        id: target.serverId,
        ...(target.ip !== undefined ? { ip: target.ip } : {}),
      },
      use_private_ip: target.usePrivateIp,
    });
  }
  if (target.type === "label_selector") {
    return Services.loadBalancerActions.addLoadBalancerTarget({
      id: loadBalancerId,
      type: "label_selector",
      label_selector: { selector: target.selector },
      use_private_ip: target.usePrivateIp,
    });
  }
  return Services.loadBalancerActions.addLoadBalancerTarget({
    id: loadBalancerId,
    type: "ip",
    ip: { ip: target.ip },
  });
};

const removeTargetRequest = (
  loadBalancerId: number,
  target: NormalizedTarget,
) => {
  if (target.type === "server") {
    return Services.loadBalancerActions.removeLoadBalancerTarget({
      id: loadBalancerId,
      type: "server",
      server: {
        id: target.serverId,
        ...(target.ip !== undefined ? { ip: target.ip } : {}),
      },
    });
  }
  if (target.type === "label_selector") {
    return Services.loadBalancerActions.removeLoadBalancerTarget({
      id: loadBalancerId,
      type: "label_selector",
      label_selector: { selector: target.selector },
    });
  }
  return Services.loadBalancerActions.removeLoadBalancerTarget({
    id: loadBalancerId,
    type: "ip",
    ip: { ip: target.ip },
  });
};

const syncTargets = (
  loadBalancerId: number,
  observed: readonly NormalizedTarget[],
  desired: readonly NormalizedTarget[],
) =>
  Effect.gen(function* () {
    const observedKeys = new Set(observed.map(targetKey));
    const desiredKeys = new Set(desired.map(targetKey));

    for (const target of observed) {
      if (desiredKeys.has(targetKey(target))) continue;
      yield* runAction(removeTargetRequest(loadBalancerId, target)).pipe(
        Effect.catchIf(alreadyGone, () => Effect.void),
      );
    }

    for (const target of desired) {
      if (observedKeys.has(targetKey(target))) continue;
      yield* addTargetRequest(loadBalancerId, target).pipe(
        Effect.retry({
          while: (e) => retryable(e) || e._tag === "UnprocessableEntity",
          times: 8,
          schedule: backoff,
        }),
        Effect.flatMap(({ action }) => waitForAction(action)),
        Effect.catchIf(alreadyThere, () => Effect.void),
      );
    }
  });

const syncNetworks = (
  loadBalancerId: number,
  observed: readonly { networkId: number }[],
  desired: readonly number[],
) =>
  Effect.gen(function* () {
    const observedIds = new Set(observed.map((item) => item.networkId));
    const desiredIds = new Set(desired);

    for (const item of observed) {
      if (desiredIds.has(item.networkId)) continue;
      yield* runAction(
        Services.loadBalancerActions.detachLoadBalancerFromNetwork({
          id: loadBalancerId,
          network: item.networkId,
        }),
      ).pipe(Effect.catchIf(alreadyGone, () => Effect.void));
    }

    for (const networkId of desired) {
      if (observedIds.has(networkId)) continue;
      yield* runAction(
        Services.loadBalancerActions.attachLoadBalancerToNetwork({
          id: loadBalancerId,
          network: networkId,
        }),
      ).pipe(Effect.catchIf(alreadyThere, () => Effect.void));
    }
  });

export const LoadBalancerProvider = () =>
  Provider.succeed(LoadBalancer, {
    stables: ["id", "location", "locationId", "networkZone", "created"],

    list: Effect.fn(function* () {
      const items = yield* Services.loadBalancers.listLoadBalancers
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      return items.map(toAttrs);
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined) {
        if (news.location !== undefined && news.location !== output.location) {
          return { action: "replace" } as const;
        }
        if (
          news.networkZone !== undefined &&
          news.networkZone !== output.networkZone
        ) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const found = yield* observe({
        id,
        name: olds?.name ?? output?.name,
        outputId: output?.id,
      });
      if (found === undefined) return undefined;
      const attrs = toAttrs(found);
      const owned = yield* hasAlchemyLabels(id, tagRecord(found.labels));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* createLoadBalancerName(id, news.name, output?.name);
      const internalLabels = yield* createInternalLabels(id);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...internalLabels,
      };
      const loadBalancerType = news.loadBalancerType ?? DEFAULT_TYPE;
      const algorithm = news.algorithm ?? DEFAULT_ALGORITHM;
      const location =
        news.location ??
        (news.networkZone === undefined ? DEFAULT_LOCATION : undefined);
      const networkZone =
        news.location === undefined ? news.networkZone : undefined;
      const publicInterface = news.publicInterface ?? true;
      const deleteProtection = news.deleteProtection ?? false;
      const services = desiredServices(news.services);
      const targets = desiredTargets(news.targets);
      const networks = desiredNetworkIds(news.networks);

      // Observe by id then desired name only. Do not fall back to
      // ownership labels — a create-first replacement still has the old
      // generation live under the same logical id.
      let current =
        output?.id !== undefined ? yield* getById(output.id) : undefined;
      if (current === undefined) {
        current = yield* getByName(name);
      }
      if (
        current !== undefined &&
        !matchesPlacement(current, location, networkZone)
      ) {
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* Services.loadBalancers
          .createLoadBalancer({
            name,
            load_balancer_type: loadBalancerType,
            algorithm: { type: algorithm },
            labels: desiredLabels,
            public_interface: publicInterface,
            ...(location !== undefined ? { location } : {}),
            ...(networkZone !== undefined ? { network_zone: networkZone } : {}),
            ...(networks[0] !== undefined ? { network: networks[0] } : {}),
            ...(services.length > 0
              ? { services: services.map(toCreateService) }
              : {}),
          })
          .pipe(
            Effect.retry(busyRetry),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          if (created.action) {
            yield* waitForAction(created.action);
          }
          current = created.load_balancer;
        } else {
          const hit = yield* getByName(name);
          if (
            hit !== undefined &&
            matchesPlacement(hit, location, networkZone)
          ) {
            current = hit;
          }
        }
      }

      if (current === undefined) {
        return yield* new LoadBalancerNotCreated({ name });
      }

      current = yield* syncMetadata({
        current,
        name,
        labels: desiredLabels,
      });
      yield* syncAlgorithm(current, algorithm);
      yield* syncType(current, loadBalancerType);
      const afterType = (yield* getById(current.id)) ?? current;
      yield* syncServices(
        current.id,
        observedServices(afterType.services),
        services,
      );
      const afterServices = (yield* getById(current.id)) ?? afterType;
      yield* syncTargets(
        current.id,
        observedTargets(afterServices.targets),
        targets,
      );
      const afterTargets = (yield* getById(current.id)) ?? afterServices;
      yield* syncNetworks(
        current.id,
        observedPrivateNetworks(afterTargets.private_net),
        networks,
      );
      const afterNetworks = (yield* getById(current.id)) ?? afterTargets;
      yield* syncPublicInterface(afterNetworks, publicInterface);
      const afterPublic = (yield* getById(current.id)) ?? afterNetworks;
      yield* syncProtection(afterPublic, deleteProtection);

      return toAttrs(yield* refresh(current.id));
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.id);
      if (current === undefined) return;

      if (current.protection.delete) {
        yield* runAction(
          Services.loadBalancerActions.changeLoadBalancerProtection({
            id: current.id,
            delete: false,
          }),
        ).pipe(Effect.catchIf(alreadyGone, () => Effect.void));
      }

      yield* Services.loadBalancers.deleteLoadBalancer({ id: current.id }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: retryable,
          times: 8,
          schedule: backoff,
        }),
      );
    }),
  });
