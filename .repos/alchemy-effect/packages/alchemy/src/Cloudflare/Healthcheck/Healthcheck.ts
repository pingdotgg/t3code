import * as healthchecks from "@distilled.cloud/cloudflare/healthchecks";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEqualsUnordered } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Healthcheck.Healthcheck" as const;
type TypeId = typeof TypeId;

/**
 * Protocol used by a standalone health check probe.
 */
export type Type = "HTTP" | "HTTPS" | "TCP";

/**
 * Region a health check can probe from. `null`/omitted lets Cloudflare pick
 * a default region; multiple regions require a Business or Enterprise plan.
 */
export type Region =
  | "WNAM"
  | "ENAM"
  | "WEU"
  | "EEU"
  | "NSAM"
  | "SSAM"
  | "OC"
  | "ME"
  | "NAF"
  | "SAF"
  | "IN"
  | "SEAS"
  | "NEAS"
  | "ALL_REGIONS";

/**
 * Health status Cloudflare reports for the monitored origin. New checks
 * start as `unknown` until the first probes complete.
 */
export type Status = "unknown" | "healthy" | "unhealthy" | "suspended";

/**
 * Parameters specific to an HTTP or HTTPS health check.
 */
export interface HttpConfig {
  /**
   * Do not validate the certificate when the health check uses HTTPS.
   * @default false
   */
  allowInsecure?: boolean;
  /**
   * A case-insensitive substring to look for in the response body. If this
   * string is not found, the origin will be marked as unhealthy.
   */
  expectedBody?: string;
  /**
   * The expected HTTP response codes (e.g. `"200"`) or code ranges
   * (e.g. `"2xx"`) of the health check.
   * @default ["200"]
   */
  expectedCodes?: string[];
  /**
   * Follow redirects if the origin returns a 3xx status code.
   * @default false
   */
  followRedirects?: boolean;
  /**
   * HTTP request headers to send in the health check. It is recommended to
   * set a `Host` header by default. The `User-Agent` header cannot be
   * overridden.
   */
  header?: Record<string, string[]>;
  /**
   * The HTTP method to use for the health check.
   * @default "GET"
   */
  method?: "GET" | "HEAD";
  /**
   * The endpoint path to health check against.
   * @default "/"
   */
  path?: string;
  /**
   * Port number to connect to for the health check.
   * @default 80 for HTTP, 443 for HTTPS
   */
  port?: number;
}

/**
 * Parameters specific to a TCP health check.
 */
export interface TcpConfig {
  /**
   * The TCP connection method to use for the health check.
   * @default "connection_established"
   */
  method?: "connection_established";
  /**
   * Port number to connect to for the health check.
   * @default 80
   */
  port?: number;
}

export interface Props {
  /**
   * Zone the health check belongs to. Stable — changing the zone triggers
   * a replacement.
   */
  zoneId: string;
  /**
   * A short name to identify the health check. Only alphanumeric
   * characters, hyphens and underscores are allowed. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   *
   * Mutable — Cloudflare supports renaming in place.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The hostname or IP address of the origin server to run health checks
   * on.
   */
  address: string;
  /**
   * The protocol to use for the health check. Currently supported
   * protocols are `HTTP`, `HTTPS` and `TCP`.
   * @default "HTTP"
   */
  type?: Type;
  /**
   * A human-readable description of the health check.
   */
  description?: string;
  /**
   * A list of regions from which to run health checks. Omitting it lets
   * Cloudflare pick a default region. Multiple regions require a Business
   * or Enterprise plan.
   */
  checkRegions?: Region[];
  /**
   * The number of consecutive fails required from a health check before
   * changing the health to unhealthy.
   * @default 1
   */
  consecutiveFails?: number;
  /**
   * The number of consecutive successes required from a health check
   * before changing the health to healthy.
   * @default 1
   */
  consecutiveSuccesses?: number;
  /**
   * The interval between each health check, in seconds. Shorter intervals
   * may give quicker notifications but increase load on the origin.
   * Plan-gated minimums apply (Pro: 60, Business: 15, Enterprise: 10).
   * @default 60
   */
  interval?: number;
  /**
   * The number of retries to attempt in case of a timeout before marking
   * the origin as unhealthy. Retries are attempted immediately.
   * @default 2
   */
  retries?: number;
  /**
   * The timeout (in seconds) before marking the health check as failed.
   * @default 5
   */
  timeout?: number;
  /**
   * If suspended, no health checks are sent to the origin.
   * @default false
   */
  suspended?: boolean;
  /**
   * Parameters specific to an HTTP or HTTPS health check. Only valid when
   * `type` is `HTTP` or `HTTPS`.
   */
  httpConfig?: HttpConfig;
  /**
   * Parameters specific to a TCP health check. Only valid when `type` is
   * `TCP`.
   */
  tcpConfig?: TcpConfig;
}

export interface Attributes {
  /** Cloudflare-assigned health check identifier. */
  healthcheckId: string;
  /** Zone that owns this health check. */
  zoneId: string;
  /** Health check name. */
  name: string;
  /** The hostname or IP address being monitored. */
  address: string;
  /** Probe protocol (`HTTP`, `HTTPS` or `TCP`). */
  type: Type;
  /** Current origin status according to the health check. */
  status: Status;
  /** The current failure reason if status is unhealthy. */
  failureReason: string | undefined;
  /** Whether probing is suspended. */
  suspended: boolean;
  /** Probe interval in seconds. */
  interval: number;
  /** Number of immediate retries on timeout. */
  retries: number;
  /** Probe timeout in seconds. */
  timeout: number;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type Healthcheck = Resource<TypeId, Props, Attributes, never, Providers>;

/**
 * A Cloudflare standalone Health Check — monitors an origin server from
 * Cloudflare's edge and powers Health Check notifications and analytics.
 *
 * Zone-scoped and available on paid zone plans (Pro: 2 checks,
 * Business: 10, Enterprise: more). Distinct from Load Balancing
 * *Monitors*, which are account-scoped and attached to LB pools.
 *
 * Every property except `zoneId` is mutable in place (the API supports
 * full PUT updates, including renames); changing the zone triggers a
 * replacement.
 *
 * Safety: health checks carry no ownership markers, so when there is no
 * prior state `read` matches by deterministic name and reports an
 * existing check as `Unowned` — the engine refuses to take it over
 * unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Health Checks
 * @category Performance & Reliability
 * @section Creating a Health Check
 * @example Basic HTTP health check
 * ```typescript
 * const check = yield* Cloudflare.Healthcheck.Healthcheck("origin-check", {
 *   zoneId: zone.zoneId,
 *   address: "origin.example.com",
 * });
 * ```
 *
 * @example HTTPS health check with custom path and expected codes
 * ```typescript
 * const check = yield* Cloudflare.Healthcheck.Healthcheck("api-health", {
 *   zoneId: zone.zoneId,
 *   address: "api.example.com",
 *   type: "HTTPS",
 *   interval: 60,
 *   retries: 2,
 *   timeout: 5,
 *   httpConfig: {
 *     path: "/healthz",
 *     expectedCodes: ["200"],
 *     followRedirects: true,
 *   },
 * });
 * ```
 *
 * @section TCP health checks
 * @example Probe a TCP port
 * ```typescript
 * const check = yield* Cloudflare.Healthcheck.Healthcheck("db-port", {
 *   zoneId: zone.zoneId,
 *   address: "db.example.com",
 *   type: "TCP",
 *   tcpConfig: { port: 5432 },
 * });
 * ```
 *
 * @section Suspending a check
 * @example Temporarily stop probing the origin
 * ```typescript
 * const check = yield* Cloudflare.Healthcheck.Healthcheck("origin-check", {
 *   zoneId: zone.zoneId,
 *   address: "origin.example.com",
 *   suspended: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/health-checks/
 */
export const Healthcheck = Resource<Healthcheck>(TypeId, {
  aliases: ["Cloudflare.Healthcheck"],
});

/**
 * Returns true if the given value is a Healthcheck resource.
 */
export const isHealthcheck = (value: unknown): value is Healthcheck =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const HealthcheckProvider = () =>
  Provider.succeed(Healthcheck, {
    stables: ["healthcheckId", "zoneId", "createdOn"],

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as Props;
      const n = news as Props;
      // zoneId is Input<string>; by diff time both sides are concrete
      // strings when statically known.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      // Owned path: we have persisted state (our own id) — refresh it.
      if (output?.healthcheckId) {
        const observed = yield* getHealthcheck(
          output.zoneId,
          output.healthcheckId,
        );
        if (observed) return toAttributes(observed, output.zoneId);
        return undefined;
      }
      // Adoption path: no state of our own, but a check with our
      // deterministic name may already exist. Health checks carry no
      // ownership markers we can inspect, so we cannot prove we created
      // it — brand it `Unowned` so the engine refuses to take over
      // unless `adopt` is set.
      const zoneId = olds?.zoneId as string | undefined;
      if (!zoneId) return undefined;
      const name = yield* createHealthcheckName(id, olds?.name);
      const match = yield* findByName(zoneId, name);
      if (match) {
        const attrs = toAttributes(match, zoneId);
        if (attrs) return Unowned(attrs);
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const name = yield* createHealthcheckName(id, news.name);
      const desired = buildDesiredBody(news, name);

      // 1. Observe — the id cached on `output` is a hint, not a
      //    guarantee: a 404 falls through to "missing".
      let observed: ObservedHealthcheck | undefined;
      if (output?.healthcheckId) {
        observed = yield* getHealthcheck(zoneId, output.healthcheckId);
      }
      // Fall back to matching by name (names are unique per zone), which
      // also recovers from lost ids after the adopt gate has passed.
      if (!observed) {
        observed = yield* findByName(zoneId, name);
      }

      // 2. Ensure — create when missing; a concurrent create of the same
      //    name surfaces as `HealthcheckAlreadyExists`, which we treat as
      //    a race: re-read by name and converge via update below.
      let justCreated = false;
      if (!observed) {
        observed = yield* healthchecks
          .createHealthcheck({ zoneId, ...desired })
          .pipe(
            Effect.map((created): ObservedHealthcheck | undefined => created),
            Effect.catchTag("HealthcheckAlreadyExists", () =>
              findByName(zoneId, name),
            ),
          );
        justCreated = observed !== undefined;
      }

      // 3. Sync — the update endpoint is a PUT that takes the full body;
      //    diff observed cloud state against desired and skip the call
      //    entirely on a no-op.
      if (
        observed?.id &&
        !justCreated &&
        !desiredEqualsObserved(desired, observed)
      ) {
        observed = yield* healthchecks.updateHealthcheck({
          zoneId,
          healthcheckId: observed.id,
          ...desired,
        });
      }

      // 4. Return.
      const attrs = observed ? toAttributes(observed, zoneId) : undefined;
      if (!attrs) {
        return yield* Effect.fail(
          new Error(
            `Cloudflare did not return a usable health check for "${name}"`,
          ),
        );
      }
      return attrs;
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* healthchecks
        .deleteHealthcheck({
          zoneId: output.zoneId,
          healthcheckId: output.healthcheckId,
        })
        .pipe(
          // Already gone — deletion is idempotent.
          Effect.catchTag("HealthcheckNotFound", () => Effect.void),
        );
    }),

    // Health checks are zone-scoped (`/zones/{zone_id}/healthchecks`) with no
    // account-wide enumeration API, so fan out over every zone and list per
    // zone. A scoped token may lack permission on a zone (eventual consistency)
    // or a zone may be partially provisioned — skip those zones (-> []) rather
    // than failing the whole enumeration.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          healthchecks.listHealthchecks.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).flatMap((h) => {
                  const attrs = toAttributes(h, zone.id);
                  return attrs ? [attrs] : [];
                }),
              ),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed([] as Attributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

type ObservedHealthcheck = healthchecks.GetHealthcheckResponse;

/**
 * Read a health check by id, mapping "gone" (`HealthcheckNotFound`,
 * HTTP 404) to `undefined`.
 */
const getHealthcheck = (zoneId: string, healthcheckId: string) =>
  healthchecks
    .getHealthcheck({ zoneId, healthcheckId })
    .pipe(
      Effect.catchTag("HealthcheckNotFound", () => Effect.succeed(undefined)),
    );

/**
 * Find a health check by exact name. Names are unique per zone, so the
 * first exact match is the resource.
 */
const findByName = (zoneId: string, name: string) =>
  healthchecks.listHealthchecks.items({ zoneId }).pipe(
    Stream.filter((h) => h.name === name),
    Stream.runHead,
    Effect.map((h): ObservedHealthcheck | undefined =>
      Option.getOrUndefined(h),
    ),
  );

const createHealthcheckName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

interface DesiredBody {
  name: string;
  address: string;
  type: Type;
  description?: string;
  checkRegions?: Region[];
  consecutiveFails: number;
  consecutiveSuccesses: number;
  interval: number;
  retries: number;
  timeout: number;
  suspended: boolean;
  httpConfig?: HttpConfig;
  tcpConfig?: TcpConfig;
}

/**
 * The full desired body sent on both create and PUT update. Documented
 * Cloudflare defaults are filled in so the observed-vs-desired diff is
 * exact and removing a prop converges back to the default.
 */
const buildDesiredBody = (news: Props, name: string): DesiredBody => ({
  name,
  address: news.address,
  type: news.type ?? "HTTP",
  description: news.description ?? "",
  checkRegions: news.checkRegions,
  consecutiveFails: news.consecutiveFails ?? 1,
  consecutiveSuccesses: news.consecutiveSuccesses ?? 1,
  interval: news.interval ?? 60,
  retries: news.retries ?? 2,
  timeout: news.timeout ?? 5,
  suspended: news.suspended ?? false,
  httpConfig: news.httpConfig,
  tcpConfig: news.tcpConfig,
});

const desiredEqualsObserved = (
  desired: DesiredBody,
  observed: ObservedHealthcheck,
): boolean => {
  if (desired.name !== observed.name) return false;
  if (desired.address !== observed.address) return false;
  if (desired.type !== observed.type) return false;
  if (desired.description !== (observed.description ?? "")) return false;
  if (
    desired.checkRegions !== undefined &&
    !arrayEqualsUnordered(desired.checkRegions, observed.checkRegions ?? [])
  ) {
    return false;
  }
  if (desired.consecutiveFails !== (observed.consecutiveFails ?? 1)) {
    return false;
  }
  if (desired.consecutiveSuccesses !== (observed.consecutiveSuccesses ?? 1)) {
    return false;
  }
  if (desired.interval !== (observed.interval ?? 60)) return false;
  if (desired.retries !== (observed.retries ?? 2)) return false;
  if (desired.timeout !== (observed.timeout ?? 5)) return false;
  if (desired.suspended !== (observed.suspended ?? false)) return false;
  if (
    desired.httpConfig !== undefined &&
    !httpConfigEquals(desired.httpConfig, observed.httpConfig ?? undefined)
  ) {
    return false;
  }
  if (
    desired.tcpConfig !== undefined &&
    !tcpConfigEquals(desired.tcpConfig, observed.tcpConfig ?? undefined)
  ) {
    return false;
  }
  return true;
};

/**
 * Compare only the http_config fields the user actually specified —
 * Cloudflare fills the rest with plan/type-dependent defaults we should
 * not fight.
 */
const httpConfigEquals = (
  desired: HttpConfig,
  observed: NonNullable<ObservedHealthcheck["httpConfig"]> | undefined,
): boolean => {
  if (observed === undefined) return false;
  if (
    desired.allowInsecure !== undefined &&
    desired.allowInsecure !== (observed.allowInsecure ?? false)
  ) {
    return false;
  }
  if (
    desired.expectedBody !== undefined &&
    desired.expectedBody !== (observed.expectedBody ?? "")
  ) {
    return false;
  }
  if (
    desired.expectedCodes !== undefined &&
    !arrayEqualsUnordered(desired.expectedCodes, observed.expectedCodes ?? [])
  ) {
    return false;
  }
  if (
    desired.followRedirects !== undefined &&
    desired.followRedirects !== (observed.followRedirects ?? false)
  ) {
    return false;
  }
  if (desired.method !== undefined && desired.method !== observed.method) {
    return false;
  }
  if (desired.path !== undefined && desired.path !== observed.path) {
    return false;
  }
  if (desired.port !== undefined && desired.port !== observed.port) {
    return false;
  }
  if (
    desired.header !== undefined &&
    !headerEquals(desired.header, observed.header)
  ) {
    return false;
  }
  return true;
};

const headerEquals = (
  desired: Record<string, string[]>,
  observed: Record<string, unknown> | null | undefined,
): boolean => {
  const obs = observed ?? {};
  const keys = Object.keys(desired);
  if (keys.length !== Object.keys(obs).length) return false;
  return keys.every((k) => {
    const o = obs[k];
    return (
      Array.isArray(o) && arrayEqualsUnordered(desired[k] ?? [], o.map(String))
    );
  });
};

const tcpConfigEquals = (
  desired: TcpConfig,
  observed: NonNullable<ObservedHealthcheck["tcpConfig"]> | undefined,
): boolean => {
  if (observed === undefined) return false;
  if (
    desired.method !== undefined &&
    desired.method !== (observed.method ?? "connection_established")
  ) {
    return false;
  }
  if (desired.port !== undefined && desired.port !== observed.port) {
    return false;
  }
  return true;
};

const toAttributes = (
  observed: ObservedHealthcheck,
  zoneId: string,
): Attributes | undefined => {
  if (!observed.id || !observed.name || !observed.address || !observed.type) {
    return undefined;
  }
  return {
    healthcheckId: observed.id,
    zoneId,
    name: observed.name,
    address: observed.address,
    type: observed.type as Type,
    status: (observed.status ?? "unknown") as Status,
    failureReason: observed.failureReason ?? undefined,
    suspended: observed.suspended ?? false,
    interval: observed.interval ?? 60,
    retries: observed.retries ?? 2,
    timeout: observed.timeout ?? 5,
    createdOn: observed.createdOn ?? undefined,
    modifiedOn: observed.modifiedOn ?? undefined,
  };
};
