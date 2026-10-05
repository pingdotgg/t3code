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
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type HealthCheckType =
  | "TCP"
  | "SSL"
  | "HTTP"
  | "HTTPS"
  | "HTTP2"
  | "GRPC"
  | "GRPC_WITH_TLS";

export type HealthCheckPortSpecification =
  | "USE_FIXED_PORT"
  | "USE_NAMED_PORT"
  | "USE_SERVING_PORT";

export type HealthCheckProxyHeader = "NONE" | "PROXY_V1";

export type HttpHealthCheck = {
  /** Host header. Empty uses the destination IP. */
  host?: string;
  /** TCP port (default 80). */
  port?: number;
  /** Named port on the instance group. Not supported on most backends. */
  portName?: string;
  /** How the health-check port is selected. */
  portSpecification?: HealthCheckPortSpecification;
  /** Request path. Default `/`. */
  requestPath?: string;
  /** ASCII response body that must appear in the first 1024 bytes. */
  response?: string;
  /** Proxy header prepended to the probe. Default `NONE`. */
  proxyHeader?: HealthCheckProxyHeader;
};

export type HttpsHealthCheck = HttpHealthCheck;
export type Http2HealthCheck = HttpHealthCheck;

export type TcpHealthCheck = {
  /** TCP port (default 80). */
  port?: number;
  /** Named port on the instance group. Not supported on most backends. */
  portName?: string;
  /** How the health-check port is selected. */
  portSpecification?: HealthCheckPortSpecification;
  /** ASCII payload sent after the TCP handshake. */
  request?: string;
  /** ASCII response that must be received for the probe to pass. */
  response?: string;
  /** Proxy header prepended to the probe. Default `NONE`. */
  proxyHeader?: HealthCheckProxyHeader;
};

export type SslHealthCheck = TcpHealthCheck;

export type GrpcHealthCheck = {
  /** TCP port. */
  port?: number;
  /** Named port on the instance group. Not supported on most backends. */
  portName?: string;
  /** How the health-check port is selected. */
  portSpecification?: HealthCheckPortSpecification;
  /** gRPC service name. Empty checks all services at the backend. */
  grpcServiceName?: string;
};

export type HealthCheckLogConfig = {
  /** Export health-check logs. Default false. */
  enable?: boolean;
};

export type HealthCheckProps = {
  /**
   * Health check name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the resource.
   */
  healthCheckName?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute HealthCheck has no
   * labels field).
   */
  description?: string;
  /**
   * How often to probe, in seconds.
   * @default 5
   */
  checkIntervalSec?: number;
  /**
   * Probe timeout in seconds. Must be ≤ `checkIntervalSec`.
   * @default 5
   */
  timeoutSec?: number;
  /**
   * Consecutive successes before an instance is healthy.
   * @default 2
   */
  healthyThreshold?: number;
  /**
   * Consecutive failures before an instance is unhealthy.
   * @default 2
   */
  unhealthyThreshold?: number;
  /**
   * Protocol. Inferred from the nested `*HealthCheck` block when omitted.
   * @default "HTTP"
   */
  type?: HealthCheckType;
  /** HTTP probe. Used when `type` is `HTTP` (the default). */
  httpHealthCheck?: HttpHealthCheck;
  /** HTTPS probe. */
  httpsHealthCheck?: HttpsHealthCheck;
  /** HTTP/2 probe. */
  http2HealthCheck?: Http2HealthCheck;
  /** TCP probe. */
  tcpHealthCheck?: TcpHealthCheck;
  /** SSL probe. */
  sslHealthCheck?: SslHealthCheck;
  /** gRPC probe. */
  grpcHealthCheck?: GrpcHealthCheck;
  /** gRPC-with-TLS probe. */
  grpcTlsHealthCheck?: GrpcHealthCheck;
  /** Health-check logging. */
  logConfig?: HealthCheckLogConfig;
  /**
   * Source regions for global health checks. If set, exactly 3 valid
   * Google Cloud regions are required.
   */
  sourceRegions?: string[];
};

export type HealthCheck = Resource<
  "GCP.Compute.HealthCheck",
  HealthCheckProps,
  {
    /** Health check name. */
    healthCheckName: string;
    /** Project id. */
    project: string;
    /** Protocol. */
    type: HealthCheckType;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Probe interval in seconds. */
    checkIntervalSec: number;
    /** Probe timeout in seconds. */
    timeoutSec: number;
    /** Consecutive successes before healthy. */
    healthyThreshold: number;
    /** Consecutive failures before unhealthy. */
    unhealthyThreshold: number;
    /** HTTP probe, if this is an HTTP health check. */
    httpHealthCheck: HttpHealthCheck | undefined;
    /** HTTPS probe, if this is an HTTPS health check. */
    httpsHealthCheck: HttpsHealthCheck | undefined;
    /** HTTP/2 probe, if this is an HTTP/2 health check. */
    http2HealthCheck: Http2HealthCheck | undefined;
    /** TCP probe, if this is a TCP health check. */
    tcpHealthCheck: TcpHealthCheck | undefined;
    /** SSL probe, if this is an SSL health check. */
    sslHealthCheck: SslHealthCheck | undefined;
    /** gRPC probe, if this is a gRPC health check. */
    grpcHealthCheck: GrpcHealthCheck | undefined;
    /** gRPC-with-TLS probe, if this is a gRPC_WITH_TLS health check. */
    grpcTlsHealthCheck: GrpcHealthCheck | undefined;
    /** Logging configuration. */
    logConfig: HealthCheckLogConfig | undefined;
    /** Source regions, if set. */
    sourceRegions: string[] | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    healthCheckId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine health check.
 *
 * Health checks probe backends for load balancing and managed-instance-group
 * autohealing. This resource maps to the global `healthChecks` collection
 * (`regionHealthChecks` is a separate resource). Compute HealthCheck has no
 * labels field — Alchemy ownership is stored in the description so nuke can
 * find leaked checks.
 *
 * ### Creating a Health Check
 * **Example:** Generated name (HTTP on port 80)
 * ```typescript
 * const check = yield* GCP.Compute.HealthCheck("api", {});
 * ```
 *
 * **Example:** HTTP path and thresholds
 * ```typescript
 * const check = yield* GCP.Compute.HealthCheck("api", {
 *   description: "frontend /health",
 *   checkIntervalSec: 10,
 *   timeoutSec: 5,
 *   httpHealthCheck: { port: 80, requestPath: "/health" },
 * });
 * ```
 *
 * **Example:** TCP health check
 * ```typescript
 * const check = yield* GCP.Compute.HealthCheck("tcp", {
 *   type: "TCP",
 *   tcpHealthCheck: { port: 8080 },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const HealthCheck = Resource<HealthCheck>("GCP.Compute.HealthCheck");

export class HealthCheckNotResolved extends Data.TaggedError(
  "GCP.Compute.HealthCheckNotResolved",
)<{
  healthCheckName: string;
}> {}

const DEFAULT_CHECK_INTERVAL = 5;
const DEFAULT_TIMEOUT = 5;
const DEFAULT_HEALTHY = 2;
const DEFAULT_UNHEALTHY = 2;

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `h${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "healthcheck";
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

const inferType = (props: HealthCheckProps): HealthCheckType => {
  if (props.type) return props.type;
  if (props.httpsHealthCheck) return "HTTPS";
  if (props.http2HealthCheck) return "HTTP2";
  if (props.sslHealthCheck) return "SSL";
  if (props.tcpHealthCheck) return "TCP";
  if (props.grpcHealthCheck) return "GRPC";
  if (props.grpcTlsHealthCheck) return "GRPC_WITH_TLS";
  return "HTTP";
};

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const protocolBody = (
  type: HealthCheckType,
  props: HealthCheckProps,
): Pick<
  compute.HealthCheck,
  | "httpHealthCheck"
  | "httpsHealthCheck"
  | "http2HealthCheck"
  | "tcpHealthCheck"
  | "sslHealthCheck"
  | "grpcHealthCheck"
  | "grpcTlsHealthCheck"
> => {
  switch (type) {
    case "HTTPS":
      return {
        httpsHealthCheck: {
          port: 443,
          requestPath: "/",
          ...props.httpsHealthCheck,
        },
      };
    case "HTTP2":
      return {
        http2HealthCheck: {
          port: 443,
          requestPath: "/",
          ...props.http2HealthCheck,
        },
      };
    case "TCP":
      return { tcpHealthCheck: { port: 80, ...props.tcpHealthCheck } };
    case "SSL":
      return { sslHealthCheck: { port: 443, ...props.sslHealthCheck } };
    case "GRPC":
      return { grpcHealthCheck: { port: 443, ...props.grpcHealthCheck } };
    case "GRPC_WITH_TLS":
      return {
        grpcTlsHealthCheck: { port: 443, ...props.grpcTlsHealthCheck },
      };
    default:
      return {
        httpHealthCheck: {
          port: 80,
          requestPath: "/",
          ...props.httpHealthCheck,
        },
      };
  }
};

const toBody = (
  healthCheckName: string,
  props: HealthCheckProps,
  ownership: Record<string, string>,
): compute.HealthCheck => {
  const type = inferType(props);
  return {
    name: healthCheckName,
    description: encodeDescription(ownership, props.description),
    checkIntervalSec: props.checkIntervalSec ?? DEFAULT_CHECK_INTERVAL,
    timeoutSec: props.timeoutSec ?? DEFAULT_TIMEOUT,
    healthyThreshold: props.healthyThreshold ?? DEFAULT_HEALTHY,
    unhealthyThreshold: props.unhealthyThreshold ?? DEFAULT_UNHEALTHY,
    type,
    logConfig: { enable: props.logConfig?.enable === true },
    sourceRegions: props.sourceRegions,
    ...protocolBody(type, props),
  };
};

const asType = (type: string | undefined): HealthCheckType => {
  switch (type) {
    case "TCP":
    case "SSL":
    case "HTTP":
    case "HTTPS":
    case "HTTP2":
    case "GRPC":
    case "GRPC_WITH_TLS":
      return type;
    default:
      return "HTTP";
  }
};

const asPortSpecification = (
  value: string | undefined,
): HealthCheckPortSpecification | undefined => {
  switch (value) {
    case "USE_FIXED_PORT":
    case "USE_NAMED_PORT":
    case "USE_SERVING_PORT":
      return value;
    default:
      return undefined;
  }
};

const asProxyHeader = (
  value: string | undefined,
): HealthCheckProxyHeader | undefined => {
  switch (value) {
    case "NONE":
    case "PROXY_V1":
      return value;
    default:
      return undefined;
  }
};

const toHttpProbe = (
  check:
    | compute.HTTPHealthCheck
    | compute.HTTPSHealthCheck
    | compute.HTTP2HealthCheck
    | undefined,
): HttpHealthCheck | undefined => {
  if (check === undefined) return undefined;
  return {
    host: check.host,
    port: check.port,
    portName: check.portName,
    portSpecification: asPortSpecification(check.portSpecification),
    requestPath: check.requestPath,
    response: check.response,
    proxyHeader: asProxyHeader(check.proxyHeader),
  };
};

const toTcpProbe = (
  check: compute.TCPHealthCheck | compute.SSLHealthCheck | undefined,
): TcpHealthCheck | undefined => {
  if (check === undefined) return undefined;
  return {
    port: check.port,
    portName: check.portName,
    portSpecification: asPortSpecification(check.portSpecification),
    request: check.request,
    response: check.response,
    proxyHeader: asProxyHeader(check.proxyHeader),
  };
};

const toGrpcProbe = (
  check: compute.GRPCHealthCheck | compute.GRPCTLSHealthCheck | undefined,
): GrpcHealthCheck | undefined => {
  if (check === undefined) return undefined;
  return {
    port: check.port,
    portName: "portName" in check ? check.portName : undefined,
    portSpecification: asPortSpecification(check.portSpecification),
    grpcServiceName: check.grpcServiceName,
  };
};

const toAttrs = (
  check: compute.HealthCheck,
  project: string,
): HealthCheck["Attributes"] => {
  const parsed = parseDescription(check.description);
  return {
    healthCheckName: check.name ?? check.id ?? "",
    project,
    type: asType(check.type),
    description: parsed.description,
    checkIntervalSec: check.checkIntervalSec ?? DEFAULT_CHECK_INTERVAL,
    timeoutSec: check.timeoutSec ?? DEFAULT_TIMEOUT,
    healthyThreshold: check.healthyThreshold ?? DEFAULT_HEALTHY,
    unhealthyThreshold: check.unhealthyThreshold ?? DEFAULT_UNHEALTHY,
    httpHealthCheck: toHttpProbe(check.httpHealthCheck),
    httpsHealthCheck: toHttpProbe(check.httpsHealthCheck),
    http2HealthCheck: toHttpProbe(check.http2HealthCheck),
    tcpHealthCheck: toTcpProbe(check.tcpHealthCheck),
    sslHealthCheck: toTcpProbe(check.sslHealthCheck),
    grpcHealthCheck: toGrpcProbe(check.grpcHealthCheck),
    grpcTlsHealthCheck: toGrpcProbe(check.grpcTlsHealthCheck),
    logConfig:
      check.logConfig === undefined
        ? undefined
        : { enable: check.logConfig.enable },
    sourceRegions:
      check.sourceRegions === undefined ? undefined : [...check.sourceRegions],
    selfLink: check.selfLink,
    healthCheckId: check.id,
    creationTimestamp: check.creationTimestamp,
    kind: check.kind,
  };
};

const subsetEqual = (
  observed: Record<string, unknown> | undefined,
  desired: Record<string, unknown> | undefined,
): boolean => {
  if (desired === undefined) return true;
  const current = observed ?? {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    if (current[key] !== value) return false;
  }
  return true;
};

const asRecord = (
  value: object | undefined,
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
};

const protocolConfig = (check: compute.HealthCheck, type: HealthCheckType) => {
  switch (type) {
    case "HTTPS":
      return check.httpsHealthCheck;
    case "HTTP2":
      return check.http2HealthCheck;
    case "TCP":
      return check.tcpHealthCheck;
    case "SSL":
      return check.sslHealthCheck;
    case "GRPC":
      return check.grpcHealthCheck;
    case "GRPC_WITH_TLS":
      return check.grpcTlsHealthCheck;
    default:
      return check.httpHealthCheck;
  }
};

const sameRegions = (
  observed?: readonly string[],
  desired?: readonly string[],
) =>
  JSON.stringify([...(observed ?? [])].sort()) ===
  JSON.stringify([...(desired ?? [])].sort());

const needsUpdate = (
  current: compute.HealthCheck,
  desired: compute.HealthCheck,
) => {
  const currentType = asType(current.type);
  const desiredType = asType(desired.type);
  if (currentType !== desiredType) return true;
  if (
    (current.checkIntervalSec ?? DEFAULT_CHECK_INTERVAL) !==
    (desired.checkIntervalSec ?? DEFAULT_CHECK_INTERVAL)
  ) {
    return true;
  }
  if (
    (current.timeoutSec ?? DEFAULT_TIMEOUT) !==
    (desired.timeoutSec ?? DEFAULT_TIMEOUT)
  ) {
    return true;
  }
  if (
    (current.healthyThreshold ?? DEFAULT_HEALTHY) !==
    (desired.healthyThreshold ?? DEFAULT_HEALTHY)
  ) {
    return true;
  }
  if (
    (current.unhealthyThreshold ?? DEFAULT_UNHEALTHY) !==
    (desired.unhealthyThreshold ?? DEFAULT_UNHEALTHY)
  ) {
    return true;
  }
  if ((current.description ?? "") !== (desired.description ?? "")) return true;
  if (
    (current.logConfig?.enable === true) !==
    (desired.logConfig?.enable === true)
  ) {
    return true;
  }
  if (!sameRegions(current.sourceRegions, desired.sourceRegions)) return true;
  return !subsetEqual(
    asRecord(protocolConfig(current, desiredType)),
    asRecord(protocolConfig(desired, desiredType)),
  );
};

const getByName = (project: string, healthCheck: string) =>
  compute
    .getHealthChecks({ project, healthCheck })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, healthCheckName: string) =>
  getByName(project, healthCheckName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (check) => check !== undefined,
      times: 8,
    }),
  );

export const HealthCheckProvider = () =>
  Provider.succeed(HealthCheck, {
    stables: [
      "healthCheckName",
      "project",
      "healthCheckId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.healthCheckName ?? output?.healthCheckName;
      const nextName = news.healthCheckName;
      if (
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName
      ) {
        return { action: "replace" as const };
      }
      const previousType =
        (olds !== undefined ? inferType(olds) : undefined) ?? output?.type;
      const nextType = inferType(news);
      if (previousType !== undefined && previousType !== nextType) {
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
      const healthCheckName = yield* toName(
        id,
        olds?.healthCheckName,
        output?.healthCheckName,
      );
      const existing = yield* getByName(env.project, healthCheckName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listHealthChecks
          .items({ project: env.project })
          .pipe(
            Stream.filter((check) => {
              const { labels } = parseDescription(check.description);
              return Object.keys(labels).some((key) =>
                key.startsWith("alchemy-"),
              );
            }),
            Stream.map((check) => toAttrs(check, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const healthCheckName = yield* toName(
        id,
        news.healthCheckName,
        output?.healthCheckName,
      );
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(healthCheckName, news, ownership);

      let current = yield* getByName(env.project, healthCheckName);

      if (current === undefined) {
        yield* compute
          .insertHealthChecks({
            project: env.project,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(env.project, healthCheckName);
      }

      if (current === undefined) {
        return yield* new HealthCheckNotResolved({ healthCheckName });
      }

      if (needsUpdate(current, desired)) {
        yield* compute
          .updateHealthChecks({
            project: env.project,
            healthCheck: healthCheckName,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, healthCheckName);
        if (current === undefined) {
          return yield* new HealthCheckNotResolved({ healthCheckName });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteHealthChecks({
          project: env.project,
          healthCheck: output.healthCheckName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
