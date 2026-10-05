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

const DEFAULT_CHECK_INTERVAL = 5;
const DEFAULT_TIMEOUT = 5;
const DEFAULT_HEALTHY = 2;
const DEFAULT_UNHEALTHY = 2;
const DEFAULT_PORT = 443;
const DEFAULT_REQUEST_PATH = "/";

export type HttpsHealthCheckProps = {
  /**
   * Health check name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the resource.
   */
  httpsHealthCheckName?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (legacy HttpsHealthCheck has
   * no labels field).
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
   * TCP port for the HTTPS probe.
   * @default 443
   */
  port?: number;
  /**
   * Request path. Query parameters are not supported.
   * @default "/"
   */
  requestPath?: string;
  /**
   * Host header. Empty uses the destination IP.
   */
  host?: string;
};

export type HttpsHealthCheckResource = Resource<
  "GCP.Compute.HttpsHealthCheck",
  HttpsHealthCheckProps,
  {
    /** Health check name. */
    httpsHealthCheckName: string;
    /** Project id. */
    project: string;
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
    /** TCP port. */
    port: number;
    /** Request path. */
    requestPath: string;
    /** Host header, if set. */
    host: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    httpsHealthCheckId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A legacy global Compute Engine HTTPS health check.
 *
 * Legacy HTTPS health checks are deprecated for most load balancers —
 * prefer `HealthCheck` with `httpsHealthCheck`. Compute HttpsHealthCheck
 * has no labels field — Alchemy ownership is stored in the description so
 * nuke can find leaked checks.
 *
 * ### Creating an HTTPS Health Check
 * **Example:** Generated name
 * ```typescript
 * const check = yield* GCP.Compute.HttpsHealthCheck("api", {});
 * ```
 *
 * **Example:** Path, port, and interval
 * ```typescript
 * const check = yield* GCP.Compute.HttpsHealthCheck("api", {
 *   description: "frontend /health",
 *   port: 443,
 *   requestPath: "/health",
 *   checkIntervalSec: 10,
 *   timeoutSec: 5,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const HttpsHealthCheck = Resource<HttpsHealthCheckResource>(
  "GCP.Compute.HttpsHealthCheck",
);

export class HttpsHealthCheckNotResolved extends Data.TaggedError(
  "GCP.Compute.HttpsHealthCheckNotResolved",
)<{
  httpsHealthCheckName: string;
}> {}

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
  return next.length > 0 ? next : "httpshealthcheck";
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

const toBody = (
  httpsHealthCheckName: string,
  props: HttpsHealthCheckProps,
  ownership: Record<string, string>,
): compute.HttpsHealthCheck => ({
  name: httpsHealthCheckName,
  description: encodeDescription(ownership, props.description),
  checkIntervalSec: props.checkIntervalSec ?? DEFAULT_CHECK_INTERVAL,
  timeoutSec: props.timeoutSec ?? DEFAULT_TIMEOUT,
  healthyThreshold: props.healthyThreshold ?? DEFAULT_HEALTHY,
  unhealthyThreshold: props.unhealthyThreshold ?? DEFAULT_UNHEALTHY,
  port: props.port ?? DEFAULT_PORT,
  requestPath: props.requestPath ?? DEFAULT_REQUEST_PATH,
  host: props.host,
});

const toAttrs = (
  check: compute.HttpsHealthCheck,
  project: string,
): HttpsHealthCheckResource["Attributes"] => {
  const parsed = parseDescription(check.description);
  const host = check.host && check.host.length > 0 ? check.host : undefined;
  return {
    httpsHealthCheckName: check.name ?? check.id ?? "",
    project,
    description: parsed.description,
    checkIntervalSec: check.checkIntervalSec ?? DEFAULT_CHECK_INTERVAL,
    timeoutSec: check.timeoutSec ?? DEFAULT_TIMEOUT,
    healthyThreshold: check.healthyThreshold ?? DEFAULT_HEALTHY,
    unhealthyThreshold: check.unhealthyThreshold ?? DEFAULT_UNHEALTHY,
    port: check.port ?? DEFAULT_PORT,
    requestPath: check.requestPath ?? DEFAULT_REQUEST_PATH,
    host,
    selfLink: check.selfLink,
    httpsHealthCheckId: check.id,
    creationTimestamp: check.creationTimestamp,
    kind: check.kind,
  };
};

const needsUpdate = (
  current: compute.HttpsHealthCheck,
  desired: compute.HttpsHealthCheck,
) => {
  if ((current.description ?? "") !== (desired.description ?? "")) return true;
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
  if ((current.port ?? DEFAULT_PORT) !== (desired.port ?? DEFAULT_PORT)) {
    return true;
  }
  if (
    (current.requestPath ?? DEFAULT_REQUEST_PATH) !==
    (desired.requestPath ?? DEFAULT_REQUEST_PATH)
  ) {
    return true;
  }
  return (current.host ?? "") !== (desired.host ?? "");
};

const getByName = (project: string, httpsHealthCheck: string) =>
  compute
    .getHttpsHealthChecks({ project, httpsHealthCheck })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, httpsHealthCheckName: string) =>
  getByName(project, httpsHealthCheckName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (check) => check !== undefined,
      times: 8,
    }),
  );

export const HttpsHealthCheckProvider = () =>
  Provider.succeed(HttpsHealthCheck, {
    stables: [
      "httpsHealthCheckName",
      "project",
      "httpsHealthCheckId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.httpsHealthCheckName ?? output?.httpsHealthCheckName;
      const nextName = news.httpsHealthCheckName;
      if (
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const httpsHealthCheckName = yield* toName(
        id,
        olds?.httpsHealthCheckName,
        output?.httpsHealthCheckName,
      );
      const existing = yield* getByName(env.project, httpsHealthCheckName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listHttpsHealthChecks
          .items({ project: env.project, maxResults: 500 })
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
      const httpsHealthCheckName = yield* toName(
        id,
        news.httpsHealthCheckName,
        output?.httpsHealthCheckName,
      );
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(httpsHealthCheckName, news, ownership);

      let current = yield* getByName(env.project, httpsHealthCheckName);

      if (current === undefined) {
        yield* compute
          .insertHttpsHealthChecks({
            project: env.project,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(env.project, httpsHealthCheckName);
      }

      if (current === undefined) {
        return yield* new HttpsHealthCheckNotResolved({
          httpsHealthCheckName,
        });
      }

      if (needsUpdate(current, desired)) {
        yield* compute
          .patchHttpsHealthChecks({
            project: env.project,
            httpsHealthCheck: httpsHealthCheckName,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, httpsHealthCheckName);
        if (current === undefined) {
          return yield* new HttpsHealthCheckNotResolved({
            httpsHealthCheckName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteHttpsHealthChecks({
          project: env.project,
          httpsHealthCheck: output.httpsHealthCheckName,
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
