import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
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
const DEFAULT_SCHEME = "EXTERNAL";
const DEFAULT_TIMEOUT_SEC = 30;

export type BackendServiceBackend = {
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

export type BackendServiceLogConfigProps = {
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

export type BackendServiceProps = {
  /**
   * Name of the backend service. If omitted, a unique RFC1035 name is
   * generated from the stack, stage, and logical id. Must be 1-63
   * characters and match `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable —
   * changing it replaces the resource.
   */
  name?: string;
  /**
   * User-facing description. Alchemy ownership is stamped into the stored
   * description (`[alchemy alchemy-stack=… alchemy-stage=… alchemy-id=…]`);
   * global backend services have no labels API.
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
   * @default "EXTERNAL"
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
   * Enable Cloud CDN (global external Application / classic HTTP(S) LB).
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
  backends?: BackendServiceBackend[];
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
  logConfig?: BackendServiceLogConfigProps;
  /**
   * User labels. Encoded into the description marker alongside Alchemy
   * ownership labels (the API has no `labels` field).
   */
  labels?: Record<string, string>;
};

export type BackendService = Resource<
  "GCP.Compute.BackendService",
  BackendServiceProps,
  {
    /** RFC1035 resource name. */
    name: string;
    /** Project id. */
    project: string;
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
    backends: BackendServiceBackend[];
    /** Connection-draining timeout in seconds. */
    connectionDrainingTimeoutSec: number | undefined;
    /** Response compression mode. */
    compressionMode: string | undefined;
    /** Custom request headers. */
    customRequestHeaders: string[];
    /** Custom response headers. */
    customResponseHeaders: string[];
    /** Logging configuration. */
    logConfig: BackendServiceLogConfigProps | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Resource kind (`compute#backendService`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine backend service. Backend services define how
 * Google Cloud load balancers distribute traffic — protocol, timeout,
 * session affinity, health checks, and the backends themselves.
 *
 * Compute Engine backend services have no labels field, so Alchemy stamps
 * ownership into the description (`[alchemy alchemy-stack=… alchemy-stage=…
 * alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find them.
 *
 * ### Creating a Backend Service
 * **Example:** Generated name
 * ```typescript
 * const backend = yield* GCP.Compute.BackendService("web", {
 *   protocol: "HTTP",
 * });
 * ```
 *
 * **Example:** Explicit name, timeout, and labels
 * ```typescript
 * const backend = yield* GCP.Compute.BackendService("web", {
 *   name: "web-backend",
 *   protocol: "HTTP",
 *   loadBalancingScheme: "EXTERNAL",
 *   timeoutSec: 30,
 *   enableCDN: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backend Service
 * **Example:** Raise the timeout and enable CDN
 * ```typescript
 * const backend = yield* GCP.Compute.BackendService("web", {
 *   name: "web-backend",
 *   timeoutSec: 60,
 *   enableCDN: true,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const BackendService = Resource<BackendService>(
  "GCP.Compute.BackendService",
);

export class BackendServiceNotResolved extends Data.TaggedError(
  "GCP.Compute.BackendServiceNotResolved",
)<{
  name: string;
}> {}

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
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "backend";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

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

const toBackend = (backend: compute.Backend): BackendServiceBackend => ({
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
): BackendServiceLogConfigProps | undefined => {
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

const backendKey = (backend: BackendServiceBackend) =>
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
  left: readonly BackendServiceBackend[] | undefined,
  right: readonly BackendServiceBackend[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].map(backendKey).sort()) ===
  JSON.stringify([...(right ?? [])].map(backendKey).sort());

const sameLogConfig = (
  left: BackendServiceLogConfigProps | undefined,
  right: compute.BackendServiceLogConfig | undefined,
) =>
  (left?.enable ?? false) === (right?.enable ?? false) &&
  (left?.sampleRate === undefined || left.sampleRate === right?.sampleRate);

const getByName = (project: string, name: string) =>
  compute
    .getBackendServices({ project, backendService: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, name: string) =>
  getByName(project, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (service) => service !== undefined,
      times: 8,
    }),
  );

export const BackendServiceProvider = () =>
  Provider.succeed(BackendService, {
    stables: [
      "name",
      "project",
      "backendServiceId",
      "selfLink",
      "creationTimestamp",
      "loadBalancingScheme",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.name ?? output?.name;
      const nextName = news.name ?? previousName;
      if (
        news.name !== undefined &&
        previousName !== undefined &&
        news.name !== previousName
      ) {
        return { action: "replace" as const };
      }
      const previousScheme =
        olds?.loadBalancingScheme ??
        output?.loadBalancingScheme ??
        DEFAULT_SCHEME;
      const nextScheme = news.loadBalancingScheme ?? DEFAULT_SCHEME;
      if (previousScheme !== nextScheme) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            (nextName === undefined || nextName === previousName),
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = yield* toName(id, olds?.name, output?.name);
      const existing = yield* getByName(env.project, name);
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
        return yield* compute.listBackendServices
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((service) => hasOwnershipMarker(service.description)),
            Stream.map((service) => toAttrs(service, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const name = yield* toName(id, news.name, output?.name);
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

      let current = yield* getByName(env.project, name);

      if (current === undefined) {
        const inserted = yield* compute
          .insertBackendServices({
            project: env.project,
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
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current =
          inserted !== undefined
            ? yield* awaitResource(env.project, name)
            : yield* getByName(env.project, name);
      }

      if (current === undefined) {
        return yield* new BackendServiceNotResolved({ name });
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
        logConfigChanged
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

        yield* compute
          .patchBackendServices({
            project: env.project,
            backendService: name,
            body: patch,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* awaitResource(env.project, name);
        if (current === undefined) {
          return yield* new BackendServiceNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      yield* compute
        .deleteBackendServices({
          project: env.project,
          backendService: output.name,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitGlobalOperation(env.project, operation),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
