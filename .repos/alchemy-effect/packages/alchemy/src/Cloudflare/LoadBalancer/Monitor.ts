import * as loadBalancers from "@distilled.cloud/cloudflare/load-balancers";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.LoadBalancer.Monitor" as const;
type TypeId = typeof TypeId;

/**
 * Protocol a Load Balancing monitor probes origins with.
 */
export type MonitorType =
  | "http"
  | "https"
  | "tcp"
  | "udp_icmp"
  | "icmp_ping"
  | "smtp";

export interface MonitorProps {
  /**
   * The protocol to use for the health check.
   * @default "http"
   */
  type?: MonitorType;
  /**
   * Object description. Monitors have no name field, so the description
   * doubles as the monitor's identity for state recovery — if omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  description?: string;
  /**
   * The method to use for the health check. Defaults to `GET` for
   * HTTP/HTTPS based checks and `connection_established` for TCP based
   * health checks.
   */
  method?: string;
  /**
   * The endpoint path to conduct the health check against. Only valid for
   * HTTP and HTTPS monitors.
   * @default "/"
   */
  path?: string;
  /**
   * The port number to connect to for the health check. Required for TCP,
   * UDP, and SMTP checks; HTTP/HTTPS checks only need it for non-standard
   * ports.
   */
  port?: number;
  /**
   * The interval between each health check, in seconds. Shorter intervals
   * improve failover time but increase origin load. The allowed range is
   * plan-dependent.
   * @default 60
   */
  interval?: number;
  /**
   * The timeout (in seconds) before marking the health check as failed.
   * @default 5
   */
  timeout?: number;
  /**
   * The number of retries to attempt in case of a timeout before marking
   * the origin as unhealthy. Retries are attempted immediately.
   * @default 2
   */
  retries?: number;
  /**
   * To be marked healthy the monitored origin must pass this healthcheck N
   * consecutive times.
   * @default 0
   */
  consecutiveUp?: number;
  /**
   * To be marked unhealthy the monitored origin must fail this healthcheck
   * N consecutive times.
   * @default 0
   */
  consecutiveDown?: number;
  /**
   * The expected HTTP response code or code range of the health check
   * (e.g. `"2xx"`). Only valid for HTTP and HTTPS monitors.
   */
  expectedCodes?: string;
  /**
   * A case-insensitive sub-string to look for in the response body. If not
   * found, the origin is marked unhealthy. HTTP/HTTPS only.
   */
  expectedBody?: string;
  /**
   * Follow redirects returned by the origin. HTTP/HTTPS only.
   * @default false
   */
  followRedirects?: boolean;
  /**
   * Do not validate the certificate when the monitor uses HTTPS.
   * @default false
   */
  allowInsecure?: boolean;
  /**
   * The HTTP request headers to send in the health check (e.g. a `Host`
   * header). The `User-Agent` header cannot be overridden. HTTP/HTTPS only.
   */
  header?: Record<string, ReadonlyArray<string>>;
  /**
   * Assign this monitor to emulate the specified zone while probing.
   * HTTP/HTTPS only.
   */
  probeZone?: string;
}

export interface MonitorAttributes {
  /** Cloudflare-assigned monitor identifier. */
  monitorId: string;
  /** The Cloudflare account the monitor belongs to. */
  accountId: string;
  /** Monitor description (carries the physical name when generated). */
  description: string;
  /** Probe protocol. */
  type: MonitorType;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type Monitor = Resource<
  TypeId,
  MonitorProps,
  MonitorAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Load Balancing monitor — an active health check (HTTP,
 * HTTPS, TCP, ICMP, or SMTP probe) that Load Balancing pools reference to
 * decide which origins are healthy.
 *
 * Monitors are account-scoped and have no name field; the `description`
 * carries the physical name so lost state can be recovered. All properties
 * are mutable in place.
 *
 * Requires the Load Balancing subscription on the account. The allowed
 * `interval` range is plan-dependent.
 * @resource
 * @product Load Balancers
 * @category Performance & Reliability
 * @section Creating a Monitor
 * @example HTTPS health check
 * ```typescript
 * const monitor = yield* Cloudflare.LoadBalancer.Monitor("ApiMonitor", {
 *   type: "https",
 *   path: "/health",
 *   expectedCodes: "2xx",
 * });
 * ```
 *
 * @example TCP port check
 * ```typescript
 * const tcp = yield* Cloudflare.LoadBalancer.Monitor("DbMonitor", {
 *   type: "tcp",
 *   port: 5432,
 * });
 * ```
 *
 * @section Using with a Pool
 * @example Attach the monitor to a pool
 * ```typescript
 * const pool = yield* Cloudflare.LoadBalancer.Pool("ApiPool", {
 *   origins: [{ name: "origin-1", address: "203.0.113.10" }],
 *   monitor: monitor.monitorId,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/load-balancing/monitors/
 */
export const Monitor = Resource<Monitor>(TypeId);

/**
 * Returns true if the given value is a Monitor resource.
 */
export const isMonitor = (value: unknown): value is Monitor =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const MonitorProvider = () =>
  Provider.succeed(Monitor, {
    stables: ["monitorId", "accountId", "createdOn"],

    // Account-scoped collection: monitors are enumerated by the account-wide
    // listMonitors endpoint, whose result items already carry the full monitor
    // shape — map each directly into the exact `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* loadBalancers.listMonitors.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((monitor) =>
              toAttributes(monitor, accountId),
            ),
          ),
        ),
      );
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.monitorId) {
        const observed = yield* getMonitor(acct, output.monitorId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // description (our physical name). Descriptions are not unique on
      // Cloudflare's side and carry no ownership marker, so report the
      // match as Unowned and let the engine gate takeover behind --adopt.
      const description = yield* createDescription(id, olds?.description);
      const match = yield* findByDescription(acct, description);
      if (match?.id) {
        const observed = yield* getMonitor(acct, match.id);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const description = yield* createDescription(id, news.description);
      const body = buildBody(news, description);

      // 1. Observe — output.monitorId is a hint, not a guarantee.
      const observed = output?.monitorId
        ? yield* getMonitor(output.accountId ?? accountId, output.monitorId)
        : undefined;

      // 2. Ensure — missing (greenfield or out-of-band delete): create.
      if (!observed?.id) {
        const created = yield* loadBalancers.createMonitor({
          accountId,
          ...body,
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — the update endpoint is a PUT requiring the full body;
      //    diff observed against desired and skip the call on a no-op.
      if (!monitorDirty(observed, body)) {
        return toAttributes(observed, accountId);
      }
      const updated = yield* loadBalancers.updateMonitor({
        accountId,
        monitorId: observed.id,
        ...body,
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A monitor still referenced by a pool cannot be deleted — the engine
      // deletes the pool first, but eventual consistency may lag, so retry
      // the typed MonitorInUse tag with bounded backoff.
      yield* loadBalancers
        .deleteMonitor({
          accountId: output.accountId,
          monitorId: output.monitorId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "MonitorInUse",
            schedule: Schedule.max([
              Schedule.exponential("1 second"),
              Schedule.recurs(6),
            ]),
          }),
          Effect.catchTag("MonitorNotFound", () => Effect.void),
        );
    }),
  });

type ObservedMonitor =
  | loadBalancers.GetMonitorResponse
  | loadBalancers.CreateMonitorResponse
  | loadBalancers.UpdateMonitorResponse;

/**
 * Read a monitor by id, mapping "gone" (`MonitorNotFound`, HTTP 404 code
 * 1001) to `undefined`.
 */
const getMonitor = (accountId: string, monitorId: string) =>
  loadBalancers
    .getMonitor({ accountId, monitorId })
    .pipe(Effect.catchTag("MonitorNotFound", () => Effect.succeed(undefined)));

/**
 * Find a monitor by exact description. If several monitors carry the same
 * description, pick the oldest for determinism.
 */
const findByDescription = (accountId: string, description: string) =>
  loadBalancers.listMonitors.items({ accountId }).pipe(
    Stream.filter((m) => m.description === description),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => (a.createdOn ?? "").localeCompare(b.createdOn ?? ""))
        .at(0),
    ),
  );

const createDescription = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    return description ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const buildBody = (news: MonitorProps, description: string) => ({
  description,
  type: news.type ?? ("http" as const),
  method: news.method,
  path: news.path,
  port: news.port,
  interval: news.interval,
  timeout: news.timeout,
  retries: news.retries,
  consecutiveUp: news.consecutiveUp,
  consecutiveDown: news.consecutiveDown,
  expectedCodes: news.expectedCodes,
  expectedBody: news.expectedBody,
  followRedirects: news.followRedirects,
  allowInsecure: news.allowInsecure,
  header:
    news.header === undefined
      ? undefined
      : (Object.fromEntries(
          Object.entries(news.header).map(([k, v]) => [k, Array.from(v)]),
        ) as Record<string, unknown>),
  probeZone: news.probeZone,
});

/**
 * Compare desired (explicitly set) fields against observed cloud state.
 * Unset desired fields defer to whatever the cloud already has.
 */
const monitorDirty = (
  observed: ObservedMonitor,
  body: ReturnType<typeof buildBody>,
): boolean => {
  const scalarDirty = (
    desired: string | number | boolean | undefined,
    actual: string | number | boolean | null | undefined,
  ) => desired !== undefined && desired !== (actual ?? undefined);
  return (
    observed.description !== body.description ||
    (observed.type ?? "http") !== body.type ||
    scalarDirty(body.method, observed.method) ||
    scalarDirty(body.path, observed.path) ||
    scalarDirty(body.port, observed.port) ||
    scalarDirty(body.interval, observed.interval) ||
    scalarDirty(body.timeout, observed.timeout) ||
    scalarDirty(body.retries, observed.retries) ||
    scalarDirty(body.consecutiveUp, observed.consecutiveUp) ||
    scalarDirty(body.consecutiveDown, observed.consecutiveDown) ||
    scalarDirty(body.expectedCodes, observed.expectedCodes) ||
    scalarDirty(body.expectedBody, observed.expectedBody) ||
    scalarDirty(body.followRedirects, observed.followRedirects) ||
    scalarDirty(body.allowInsecure, observed.allowInsecure) ||
    scalarDirty(body.probeZone, observed.probeZone) ||
    (body.header !== undefined &&
      JSON.stringify(body.header) !== JSON.stringify(observed.header ?? {}))
  );
};

const toAttributes = (
  monitor: ObservedMonitor,
  accountId: string,
): MonitorAttributes => ({
  monitorId: monitor.id ?? "",
  accountId,
  description: monitor.description ?? "",
  type: (monitor.type ?? "http") as MonitorType,
  createdOn: monitor.createdOn ?? undefined,
  modifiedOn: monitor.modifiedOn ?? undefined,
});
