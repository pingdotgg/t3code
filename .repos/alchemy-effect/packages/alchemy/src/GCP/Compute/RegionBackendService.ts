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
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_PROTOCOL = "HTTP";
const DEFAULT_SCHEME = "INTERNAL_MANAGED";
const DEFAULT_TIMEOUT_SEC = 30;
const MAX_NAME_LENGTH = 63;

export type RegionBackendServiceBackend = {
  /** Fully-qualified instance group or NEG URL. */
  group: string;
  /** Optional backend description. */
  description?: string;
  /** Balancing mode (`UTILIZATION`, `RATE`, `CONNECTION`, …). */
  balancingMode?: string;
  /** Capacity scaler in `[0.0, 1.0]`. */
  capacityScaler?: number;
  /** Max requests per second (RATE mode). */
  maxRate?: number;
  /** Max RPS per instance. */
  maxRatePerInstance?: number;
  /** Target utilization in `[0.0, 1.0]`. */
  maxUtilization?: number;
  /** Whether this backend is a failover group. */
  failover?: boolean;
};

export type RegionBackendServiceLogConfigProps = {
  /**
   * Export load-balancer logs to Cloud Logging.
   * @default false
   */
  enable?: boolean;
  /**
   * Sampling rate in `[0, 1]` when logging is enabled.
   * @default 1.0
   */
  sampleRate?: number;
};

export type RegionBackendServiceProps = {
  /**
   * Name of the backend service. If omitted, a unique RFC1035 name is
   * generated from the stack, stage, and logical id. Must be 1-63
   * characters and match `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable —
   * changing it replaces the resource.
   */
  name?: string;
  /**
   * Region the backend service lives in (e.g. `us-central1`). Immutable —
   * changing it replaces the resource. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * User-facing description. Alchemy ownership is stamped into the stored
   * description (`[alchemy alchemy-stack=… alchemy-stage=… alchemy-id=…]`);
   * regional backend services have no labels API.
   */
  description?: string;
  /**
   * Protocol used to talk to backends (`HTTP`, `HTTPS`, `HTTP2`, `TCP`,
   * `SSL`, `UDP`, `GRPC`, `H2C`).
   * @default "HTTP"
   */
  protocol?: string;
  /**
   * Load balancer type. Immutable — changing it replaces the resource.
   * @default "INTERNAL_MANAGED"
   */
  loadBalancingScheme?: string;
  /**
   * Backend timeout in seconds.
   * @default 30
   */
  timeoutSec?: number;
  /**
   * Named port on instance-group backends. Ignored for NEGs and for
   * passthrough Network Load Balancers.
   */
  portName?: string;
  /**
   * Enable Cloud CDN. Only valid for some Application Load Balancer
   * schemes; ignored or rejected otherwise.
   * @default false
   */
  enableCDN?: boolean;
  /**
   * Session affinity (`NONE`, `CLIENT_IP`, `GENERATED_COOKIE`, …).
   * @default "NONE"
   */
  sessionAffinity?: string;
  /**
   * Cookie lifetime in seconds for `GENERATED_COOKIE` / `HTTP_COOKIE`
   * affinity. `0` is a session cookie.
   */
  affinityCookieTtlSec?: number;
  /**
   * Fully-qualified health-check URLs. At most one is typically allowed.
   * Required for instance-group / zonal NEG backends; forbidden for
   * internet and serverless NEGs.
   */
  healthChecks?: string[];
  /**
   * Backends (instance groups or NEGs) that serve this service.
   */
  backends?: RegionBackendServiceBackend[];
  /**
   * Connection-draining timeout in seconds. GCP defaults this to `300`
   * when omitted.
   */
  connectionDrainingTimeoutSec?: number;
  /**
   * Compress text responses (`AUTOMATIC` or `DISABLED`).
   */
  compressionMode?: string;
  /**
   * Headers the load balancer adds to proxied requests.
   */
  customRequestHeaders?: string[];
  /**
   * Headers the load balancer adds to proxied responses.
   */
  customResponseHeaders?: string[];
  /**
   * Cloud Logging options for traffic served by this backend service.
   */
  logConfig?: RegionBackendServiceLogConfigProps;
  /**
   * Intra-locality load-balancing algorithm (`ROUND_ROBIN`, `MAGLEV`,
   * `RING_HASH`, …). Applicable to `INTERNAL_MANAGED` HTTP(S) services.
   */
  localityLbPolicy?: string;
  /**
   * VPC network URL or name. Only valid for passthrough Network Load
   * Balancers (`INTERNAL` / some `EXTERNAL` HA setups). Immutable —
   * changing it replaces the resource.
   */
  network?: string;
  /**
   * User labels. Encoded into the description marker alongside Alchemy
   * ownership labels (the API has no `labels` field).
   */
  labels?: Record<string, string>;
};

export type RegionBackendService = Resource<
  "GCP.Compute.RegionBackendService",
  RegionBackendServiceProps,
  {
    /** RFC1035 resource name. */
    name: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Server-assigned numeric id. */
    backendServiceId: string | undefined;
    /** Compute self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** User-facing description (ownership marker stripped). */
    description: string | undefined;
    /** Protocol used to talk to backends. */
    protocol: string | undefined;
    /** Load balancer type. */
    loadBalancingScheme: string | undefined;
    /** Backend timeout in seconds. */
    timeoutSec: number | undefined;
    /** Named port on instance-group backends. */
    portName: string | undefined;
    /** Whether Cloud CDN is enabled. */
    enableCDN: boolean;
    /** Session affinity mode. */
    sessionAffinity: string | undefined;
    /** Cookie TTL in seconds, if set. */
    affinityCookieTtlSec: number | undefined;
    /** Fully-qualified health-check URLs. */
    healthChecks: string[];
    /** Attached backends. */
    backends: RegionBackendServiceBackend[];
    /** Connection-draining timeout in seconds. */
    connectionDrainingTimeoutSec: number | undefined;
    /** Response compression mode. */
    compressionMode: string | undefined;
    /** Custom request headers. */
    customRequestHeaders: string[];
    /** Custom response headers. */
    customResponseHeaders: string[];
    /** Logging configuration. */
    logConfig: RegionBackendServiceLogConfigProps | undefined;
    /** Intra-locality load-balancing algorithm. */
    localityLbPolicy: string | undefined;
    /** Network URL, if set. */
    network: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Resource kind (`compute#backendService`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine backend service. Backend services define how
 * Google Cloud load balancers distribute traffic — protocol, timeout,
 * session affinity, health checks, and the backends themselves.
 *
 * Compute Engine backend services have no labels field, so Alchemy stamps
 * ownership into the description (`[alchemy alchemy-stack=… alchemy-stage=…
 * alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find them. Changing
 * `name`, `region`, `loadBalancingScheme`, or `network` replaces the
 * resource.
 *
 * ### Creating a Region Backend Service
 * **Example:** Generated name
 * ```typescript
 * const backend = yield* GCP.Compute.RegionBackendService("web", {
 *   protocol: "HTTP",
 *   loadBalancingScheme: "INTERNAL_MANAGED",
 * });
 * ```
 *
 * **Example:** Explicit name, timeout, and labels
 * ```typescript
 * const backend = yield* GCP.Compute.RegionBackendService("web", {
 *   name: "web-backend",
 *   region: "us-central1",
 *   protocol: "HTTP",
 *   loadBalancingScheme: "INTERNAL_MANAGED",
 *   timeoutSec: 30,
 *   localityLbPolicy: "ROUND_ROBIN",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Region Backend Service
 * **Example:** Raise the timeout
 * ```typescript
 * const backend = yield* GCP.Compute.RegionBackendService("web", {
 *   name: "web-backend",
 *   timeoutSec: 60,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionBackendService = Resource<RegionBackendService>(
  "GCP.Compute.RegionBackendService",
);

export class RegionBackendServiceNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionBackendServiceNotResolved",
)<{
  name: string;
  region: string;
}> {}

export class RegionBackendServiceStillExists extends Data.TaggedError(
  "GCP.Compute.RegionBackendServiceStillExists",
)<{
  name: string;
  region: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? value;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `b${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "backend";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const toNetworkUrl = (project: string, network: string) =>
  network.includes("/")
    ? network
    : `projects/${project}/global/networks/${network}`;

const encodeDescription = (
  user: string | undefined,
  labels: Record<string, string>,
): string => {
  const packed = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const marker = `[alchemy ${packed}]`;
  return user ? `${marker}\n${user}` : marker;
};

const parseDescription = (
  description: string | undefined,
): { labels: Record<string, string>; user: string | undefined } => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, user: description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, user: description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, user: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined): boolean =>
  (description ?? "").startsWith("[alchemy ");

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toBackend = (backend: compute.Backend): RegionBackendServiceBackend => ({
  group: backend.group ?? "",
  description: backend.description,
  balancingMode: backend.balancingMode,
  capacityScaler: backend.capacityScaler,
  maxRate: backend.maxRate,
  maxRatePerInstance: backend.maxRatePerInstance,
  maxUtilization: backend.maxUtilization,
  failover: backend.failover,
});

const toLogConfig = (
  logConfig: compute.BackendServiceLogConfig | undefined,
): RegionBackendServiceLogConfigProps | undefined => {
  if (logConfig === undefined) return undefined;
  return {
    enable: logConfig.enable,
    sampleRate: logConfig.sampleRate,
  };
};

const toAttrs = (service: compute.BackendService, project: string) => {
  const decoded = parseDescription(service.description);
  return {
    name: service.name ?? "",
    project,
    region: lastSegment(service.region).toLowerCase(),
    backendServiceId: service.id,
    selfLink: service.selfLink,
    creationTimestamp: service.creationTimestamp,
    fingerprint: service.fingerprint,
    description: decoded.user,
    protocol: service.protocol,
    loadBalancingScheme: service.loadBalancingScheme,
    timeoutSec: service.timeoutSec,
    portName: service.portName,
    enableCDN: service.enableCDN === true,
    sessionAffinity: service.sessionAffinity,
    affinityCookieTtlSec: service.affinityCookieTtlSec,
    healthChecks: [...(service.healthChecks ?? [])],
    backends: (service.backends ?? []).map(toBackend),
    connectionDrainingTimeoutSec:
      service.connectionDraining?.drainingTimeoutSec,
    compressionMode: service.compressionMode,
    customRequestHeaders: [...(service.customRequestHeaders ?? [])],
    customResponseHeaders: [...(service.customResponseHeaders ?? [])],
    logConfig: toLogConfig(service.logConfig),
    localityLbPolicy: service.localityLbPolicy,
    network: service.network,
    labels: userLabels(decoded.labels),
    kind: service.kind,
  };
};

const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());

const backendKey = (backend: RegionBackendServiceBackend) =>
  JSON.stringify({
    group: backend.group,
    description: backend.description ?? "",
    balancingMode: backend.balancingMode ?? "",
    capacityScaler: backend.capacityScaler ?? null,
    maxRate: backend.maxRate ?? null,
    maxRatePerInstance: backend.maxRatePerInstance ?? null,
    maxUtilization: backend.maxUtilization ?? null,
    failover: backend.failover ?? false,
  });

const sameBackends = (
  left: readonly RegionBackendServiceBackend[] | undefined,
  right: readonly RegionBackendServiceBackend[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].map(backendKey).sort()) ===
  JSON.stringify([...(right ?? [])].map(backendKey).sort());

const sameLogConfig = (
  left: RegionBackendServiceLogConfigProps | undefined,
  right: compute.BackendServiceLogConfig | undefined,
) =>
  (left?.enable ?? false) === (right?.enable ?? false) &&
  (left?.sampleRate === undefined || left.sampleRate === right?.sampleRate);

const getByName = (project: string, region: string, name: string) =>
  compute
    .getRegionBackendServices({ project, region, backendService: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitPresent = (project: string, region: string, name: string) =>
  getByName(project, region, name).pipe(
    Effect.flatMap((service) =>
      service === undefined
        ? Effect.fail(new RegionBackendServiceNotResolved({ name, region }))
        : Effect.succeed(service),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionBackendServiceNotResolved",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
    Effect.catchTag("GCP.Compute.RegionBackendServiceNotResolved", () =>
      Effect.succeed(undefined),
    ),
  );

const waitGone = (project: string, region: string, name: string) =>
  getByName(project, region, name).pipe(
    Effect.flatMap((service) =>
      service === undefined
        ? Effect.void
        : Effect.fail(new RegionBackendServiceStillExists({ name, region })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionBackendServiceStillExists",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const RegionBackendServiceProvider = () =>
  Provider.succeed(RegionBackendService, {
    stables: [
      "name",
      "project",
      "region",
      "backendServiceId",
      "selfLink",
      "creationTimestamp",
      "loadBalancingScheme",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.name ?? output?.name;
      const nextName = news.name ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? previousRegion,
        env.region,
      );
      const nameChanged =
        news.name !== undefined &&
        previousName !== undefined &&
        news.name !== previousName;
      const regionChanged = previousRegion !== nextRegion;
      const previousScheme =
        olds?.loadBalancingScheme ??
        output?.loadBalancingScheme ??
        DEFAULT_SCHEME;
      const nextScheme = news.loadBalancingScheme ?? DEFAULT_SCHEME;
      const schemeChanged = previousScheme !== nextScheme;
      const previousNetwork = lastSegment(
        olds?.network ?? output?.network,
      ).toLowerCase();
      const nextNetwork =
        news.network !== undefined
          ? lastSegment(news.network).toLowerCase()
          : previousNetwork;
      const networkChanged = previousNetwork !== nextNetwork;
      if (!nameChanged && !regionChanged && !schemeChanged && !networkChanged) {
        return undefined;
      }
      const samePhysicalName =
        previousName !== undefined &&
        (nextName === undefined || nextName === previousName) &&
        previousRegion === nextRegion;
      return {
        action: "replace" as const,
        deleteFirst: samePhysicalName && (schemeChanged || networkChanged),
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = yield* toName(id, olds?.name, output?.name);
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListBackendServices
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.backendServices ?? [])
              .filter(
                (service) =>
                  (service.region ?? "").length > 0 &&
                  hasOwnershipMarker(service.description),
              )
              .map((service) => toAttrs(service, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const name = yield* toName(id, news.name, output?.name);
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredDescription = encodeDescription(
        news.description,
        desiredLabels,
      );
      const protocol = news.protocol ?? DEFAULT_PROTOCOL;
      const loadBalancingScheme = news.loadBalancingScheme ?? DEFAULT_SCHEME;
      const timeoutSec = news.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      const enableCDN = news.enableCDN === true;
      const desiredBackends = (news.backends ?? []).map((backend) => ({
        group: backend.group,
        description: backend.description,
        balancingMode: backend.balancingMode,
        capacityScaler: backend.capacityScaler,
        maxRate: backend.maxRate,
        maxRatePerInstance: backend.maxRatePerInstance,
        maxUtilization: backend.maxUtilization,
        failover: backend.failover,
      }));
      const network =
        news.network !== undefined
          ? toNetworkUrl(env.project, news.network)
          : undefined;

      let current = yield* getByName(env.project, region, name);

      if (current === undefined) {
        yield* compute
          .insertRegionBackendServices({
            project: env.project,
            region,
            body: {
              name,
              description: desiredDescription,
              protocol,
              loadBalancingScheme,
              timeoutSec,
              portName: news.portName,
              enableCDN,
              sessionAffinity: news.sessionAffinity,
              affinityCookieTtlSec: news.affinityCookieTtlSec,
              healthChecks:
                (news.healthChecks?.length ?? 0) > 0
                  ? news.healthChecks
                  : undefined,
              backends:
                desiredBackends.length > 0 ? desiredBackends : undefined,
              connectionDraining:
                news.connectionDrainingTimeoutSec !== undefined
                  ? {
                      drainingTimeoutSec: news.connectionDrainingTimeoutSec,
                    }
                  : undefined,
              compressionMode: news.compressionMode,
              customRequestHeaders:
                (news.customRequestHeaders?.length ?? 0) > 0
                  ? news.customRequestHeaders
                  : undefined,
              customResponseHeaders:
                (news.customResponseHeaders?.length ?? 0) > 0
                  ? news.customResponseHeaders
                  : undefined,
              logConfig: news.logConfig,
              localityLbPolicy: news.localityLbPolicy,
              network,
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
        current = yield* waitPresent(env.project, region, name);
      }

      if (current === undefined) {
        return yield* new RegionBackendServiceNotResolved({ name, region });
      }

      const timeoutChanged =
        (current.timeoutSec ?? DEFAULT_TIMEOUT_SEC) !== timeoutSec;
      const protocolChanged =
        (current.protocol ?? DEFAULT_PROTOCOL) !== protocol;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const enableCDNChanged = (current.enableCDN === true) !== enableCDN;
      const sessionAffinityChanged =
        (current.sessionAffinity ?? "NONE") !==
        (news.sessionAffinity ?? "NONE");
      const affinityCookieChanged =
        news.affinityCookieTtlSec !== undefined &&
        current.affinityCookieTtlSec !== news.affinityCookieTtlSec;
      const portNameChanged =
        news.portName !== undefined && current.portName !== news.portName;
      const healthChecksChanged = !sameStringList(
        current.healthChecks,
        news.healthChecks,
      );
      const backendsChanged = !sameBackends(
        (current.backends ?? []).map(toBackend),
        news.backends,
      );
      const drainingChanged =
        news.connectionDrainingTimeoutSec !== undefined &&
        current.connectionDraining?.drainingTimeoutSec !==
          news.connectionDrainingTimeoutSec;
      const compressionChanged =
        news.compressionMode !== undefined &&
        current.compressionMode !== news.compressionMode;
      const requestHeadersChanged =
        news.customRequestHeaders !== undefined &&
        !sameStringList(
          current.customRequestHeaders,
          news.customRequestHeaders,
        );
      const responseHeadersChanged =
        news.customResponseHeaders !== undefined &&
        !sameStringList(
          current.customResponseHeaders,
          news.customResponseHeaders,
        );
      const logConfigChanged =
        news.logConfig !== undefined &&
        !sameLogConfig(news.logConfig, current.logConfig);
      const localityChanged =
        news.localityLbPolicy !== undefined &&
        (current.localityLbPolicy ?? "") !== news.localityLbPolicy;

      if (
        timeoutChanged ||
        protocolChanged ||
        descriptionChanged ||
        enableCDNChanged ||
        sessionAffinityChanged ||
        affinityCookieChanged ||
        portNameChanged ||
        healthChecksChanged ||
        backendsChanged ||
        drainingChanged ||
        compressionChanged ||
        requestHeadersChanged ||
        responseHeadersChanged ||
        logConfigChanged ||
        localityChanged
      ) {
        const patch: compute.BackendService = {
          fingerprint: current.fingerprint,
        };
        if (timeoutChanged) patch.timeoutSec = timeoutSec;
        if (protocolChanged) patch.protocol = protocol;
        if (descriptionChanged) patch.description = desiredDescription;
        if (enableCDNChanged) patch.enableCDN = enableCDN;
        if (sessionAffinityChanged) {
          patch.sessionAffinity = news.sessionAffinity ?? "NONE";
        }
        if (affinityCookieChanged) {
          patch.affinityCookieTtlSec = news.affinityCookieTtlSec;
        }
        if (portNameChanged) patch.portName = news.portName;
        if (healthChecksChanged) patch.healthChecks = news.healthChecks ?? [];
        if (backendsChanged) patch.backends = desiredBackends;
        if (drainingChanged) {
          patch.connectionDraining = {
            drainingTimeoutSec: news.connectionDrainingTimeoutSec,
          };
        }
        if (compressionChanged) patch.compressionMode = news.compressionMode;
        if (requestHeadersChanged) {
          patch.customRequestHeaders = news.customRequestHeaders;
        }
        if (responseHeadersChanged) {
          patch.customResponseHeaders = news.customResponseHeaders;
        }
        if (logConfigChanged) patch.logConfig = news.logConfig;
        if (localityChanged) patch.localityLbPolicy = news.localityLbPolicy;

        yield* compute
          .patchRegionBackendServices({
            project: env.project,
            region,
            backendService: name,
            body: patch,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );
        current = (yield* getByName(env.project, region, name)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* compute
        .deleteRegionBackendServices({
          project: output.project,
          region: output.region,
          backendService: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.flatMap((operation) =>
            operation === undefined
              ? Effect.void
              : waitRegionOperation(output.project, output.region, operation, {
                  ignore: ["RESOURCE_NOT_FOUND"],
                }).pipe(Effect.asVoid),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
          // Compute rejects the delete while another operation is still in
          // flight on the backend (e.g. packet-mirroring teardown of the
          // forwarding rule that fronted it).
          Effect.retry({
            while: (error) => error._tag === "ResourceNotReady",
            times: 20,
            schedule: Schedule.spaced("10 seconds"),
          }),
        );
      yield* waitGone(output.project, output.region, output.name);
    }),
  });
