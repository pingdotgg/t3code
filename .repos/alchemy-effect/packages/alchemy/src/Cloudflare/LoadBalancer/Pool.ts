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

const TypeId = "Cloudflare.LoadBalancer.Pool" as const;
type TypeId = typeof TypeId;

/**
 * A single origin server within a Load Balancing pool.
 */
export interface PoolOrigin {
  /**
   * The IP address (IPv4 or IPv6) or publicly-resolvable hostname of the
   * origin server.
   */
  address: string;
  /**
   * A human-identifiable name for the origin.
   */
  name?: string;
  /**
   * Whether to enable (the default) this origin within the pool.
   * @default true
   */
  enabled?: boolean;
  /**
   * Relative weight of this origin (`0`–`1`) for traffic distribution.
   * @default 1
   */
  weight?: number;
  /**
   * The port to override the standard port for this origin.
   */
  port?: number;
  /**
   * Request headers to send to this origin — typically a `Host` header.
   */
  header?: { host?: ReadonlyArray<string> };
  /**
   * Whether to flatten a CNAME `address` to its final IP.
   */
  flattenCname?: boolean;
  /**
   * The virtual network subnet the origin belongs to (private origins).
   */
  virtualNetworkId?: string;
}

/**
 * Load shedding configuration for a pool.
 */
export interface PoolLoadShedding {
  /** Percent (0–100) of new (non-affine) traffic to shed. @default 0 */
  defaultPercent?: number;
  /** Policy for shedding new traffic. @default "random" */
  defaultPolicy?: "random" | "hash";
  /** Percent (0–100) of session-affine traffic to shed. @default 0 */
  sessionPercent?: number;
  /** Policy for shedding session-affine traffic. */
  sessionPolicy?: "hash";
}

/**
 * Filters pool/origin health notifications by resource type or health
 * status.
 */
export interface PoolNotificationFilter {
  origin?: { disable?: boolean; healthy?: boolean };
  pool?: { disable?: boolean; healthy?: boolean };
}

export interface PoolProps {
  /**
   * A short name (tag) for the pool. Only alphanumeric characters, hyphens,
   * and underscores are allowed. If omitted, a unique name is generated
   * from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The list of origins within this pool. Traffic directed at this pool is
   * balanced across all currently healthy origins.
   */
  origins: ReadonlyArray<PoolOrigin>;
  /**
   * A human-readable description of the pool.
   */
  description?: string;
  /**
   * Whether to enable (the default) or disable this pool. Disabled pools
   * receive no traffic and are excluded from health checks.
   * @default true
   */
  enabled?: boolean;
  /**
   * The ID of the Monitor to use for checking the health of origins within
   * this pool. Mutually exclusive with `monitorGroup`.
   */
  monitor?: string;
  /**
   * The ID of the Monitor Group to use for checking the health of origins
   * within this pool. Mutually exclusive with `monitor`.
   */
  monitorGroup?: string;
  /**
   * The minimum number of origins that must be healthy for this pool to
   * serve traffic.
   * @default 1
   */
  minimumOrigins?: number;
  /**
   * The latitude of the data center containing this pool's origins, in
   * decimal degrees. Must be set together with `longitude`.
   */
  latitude?: number;
  /**
   * The longitude of the data center containing this pool's origins, in
   * decimal degrees. Must be set together with `latitude`.
   */
  longitude?: number;
  /**
   * Load shedding policies and percentages for the pool.
   */
  loadShedding?: PoolLoadShedding;
  /**
   * How origins are selected for new sessions / traffic without session
   * affinity.
   * @default { policy: "random" }
   */
  originSteering?: {
    policy?:
      | "random"
      | "hash"
      | "least_outstanding_requests"
      | "least_connections";
  };
  /**
   * Filter pool and origin health notifications by resource type or health
   * status.
   */
  notificationFilter?: PoolNotificationFilter;
  /**
   * Deprecated upstream — the email address to send health status
   * notifications to. Prefer Cloudflare's centralized notification service.
   */
  notificationEmail?: string;
}

export interface PoolAttributes {
  /** Cloudflare-assigned pool identifier. */
  poolId: string;
  /** The Cloudflare account the pool belongs to. */
  accountId: string;
  /** Pool name. */
  name: string;
  /** Whether the pool is enabled. */
  enabled: boolean;
  /** Resolved monitor id attached to the pool, if any. */
  monitor: string | undefined;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type Pool = Resource<
  TypeId,
  PoolProps,
  PoolAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Load Balancing pool — an account-scoped group of origin
 * servers that Load Balancers route traffic to. Pools optionally reference
 * a {@link Monitor} for active health checking.
 *
 * Requires the Load Balancing subscription on the account; without it, pool
 * creation fails with the typed `PoolAccessFailed` error.
 * @resource
 * @product Load Balancers
 * @category Performance & Reliability
 * @section Creating a Pool
 * @example Pool with one origin
 * ```typescript
 * const pool = yield* Cloudflare.LoadBalancer.Pool("ApiPool", {
 *   origins: [{ name: "origin-1", address: "203.0.113.10" }],
 * });
 * ```
 *
 * @example Health-checked pool
 * ```typescript
 * const monitor = yield* Cloudflare.LoadBalancer.Monitor("ApiMonitor", {
 *   type: "https",
 *   path: "/health",
 *   expectedCodes: "2xx",
 * });
 *
 * const pool = yield* Cloudflare.LoadBalancer.Pool("ApiPool", {
 *   origins: [
 *     { name: "origin-1", address: "203.0.113.10", weight: 0.7 },
 *     { name: "origin-2", address: "203.0.113.11", weight: 0.3 },
 *   ],
 *   monitor: monitor.monitorId,
 *   minimumOrigins: 1,
 * });
 * ```
 *
 * @section Using with a Load Balancer
 * @example Pool as default and fallback
 * ```typescript
 * yield* Cloudflare.LoadBalancer.LoadBalancer("ApiLb", {
 *   zoneId: zone.zoneId,
 *   name: "api.example.com",
 *   defaultPools: [pool.poolId],
 *   fallbackPool: pool.poolId,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/load-balancing/pools/
 */
export const Pool = Resource<Pool>(TypeId);

/**
 * Returns true if the given value is a Pool resource.
 */
export const isPool = (value: unknown): value is Pool =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const PoolProvider = () =>
  Provider.succeed(Pool, {
    stables: ["poolId", "accountId", "createdOn"],

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

      if (output?.poolId) {
        const observed = yield* getPool(acct, output.poolId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // pool name. Pools carry no ownership marker, so the match is
      // reported as Unowned and the engine gates takeover behind --adopt.
      const name = yield* createPoolName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (match?.id) {
        const observed = yield* getPool(acct, match.id);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* loadBalancers.listPools.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map(
              (pool): PoolAttributes => ({
                poolId: pool.id ?? "",
                accountId,
                name: pool.name ?? "",
                enabled: pool.enabled ?? true,
                monitor: pool.monitor ?? undefined,
                createdOn: pool.createdOn ?? undefined,
                modifiedOn: pool.modifiedOn ?? undefined,
              }),
            ),
          ),
        ),
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createPoolName(id, news.name);
      const body = buildBody(news, name);

      // 1. Observe — output.poolId is a cache hint; a 404 falls through
      //    to "missing" and we recreate.
      const observed = output?.poolId
        ? yield* getPool(output.accountId ?? accountId, output.poolId)
        : undefined;

      // 2. Ensure — missing: create with the full desired body.
      if (!observed?.id) {
        const created = yield* loadBalancers.createPool({
          accountId,
          ...body,
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — the update endpoint is a PUT requiring name + origins;
      //    diff observed against desired and skip the call on a no-op.
      if (!poolDirty(observed, body)) {
        return toAttributes(observed, accountId);
      }
      const updated = yield* loadBalancers.updatePool({
        accountId,
        poolId: observed.id,
        ...body,
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A pool still referenced by a Load Balancer cannot be deleted — the
      // engine deletes the LB first, but eventual consistency may lag, so
      // retry the typed PoolInUse tag with bounded backoff.
      yield* loadBalancers
        .deletePool({
          accountId: output.accountId,
          poolId: output.poolId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "PoolInUse",
            schedule: Schedule.max([
              Schedule.exponential("1 second"),
              Schedule.recurs(6),
            ]),
          }),
          Effect.catchTag("PoolNotFound", () => Effect.void),
        );
    }),
  });

type ObservedPool =
  | loadBalancers.GetPoolResponse
  | loadBalancers.CreatePoolResponse
  | loadBalancers.UpdatePoolResponse;

/**
 * Read a pool by id, mapping "gone" (`PoolNotFound`, HTTP 404 code 1001)
 * to `undefined`.
 */
const getPool = (accountId: string, poolId: string) =>
  loadBalancers
    .getPool({ accountId, poolId })
    .pipe(Effect.catchTag("PoolNotFound", () => Effect.succeed(undefined)));

/**
 * Find a pool by exact name. If several pools carry the same name, pick
 * the oldest for determinism.
 */
const findByName = (accountId: string, name: string) =>
  loadBalancers.listPools.items({ accountId }).pipe(
    Stream.filter((p) => p.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => (a.createdOn ?? "").localeCompare(b.createdOn ?? ""))
        .at(0),
    ),
  );

const createPoolName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const buildBody = (news: PoolProps, name: string) => ({
  name,
  origins: news.origins.map((o) => ({
    address: o.address,
    name: o.name,
    enabled: o.enabled,
    weight: o.weight,
    port: o.port,
    header:
      o.header === undefined
        ? undefined
        : {
            host:
              o.header.host === undefined
                ? undefined
                : Array.from(o.header.host),
          },
    flattenCname: o.flattenCname,
    // Inputs are resolved to concrete strings by Plan.
    virtualNetworkId: o.virtualNetworkId as string | undefined,
  })),
  description: news.description,
  enabled: news.enabled,
  monitor: news.monitor as string | undefined,
  monitorGroup: news.monitorGroup as string | undefined,
  minimumOrigins: news.minimumOrigins,
  latitude: news.latitude,
  longitude: news.longitude,
  loadShedding: news.loadShedding,
  originSteering: news.originSteering,
  notificationFilter: news.notificationFilter,
  notificationEmail: news.notificationEmail,
});

/**
 * Compare desired (explicitly set) fields against observed cloud state.
 * Unset desired fields defer to whatever the cloud already has.
 */
const poolDirty = (
  observed: ObservedPool,
  body: ReturnType<typeof buildBody>,
): boolean => {
  const scalarDirty = (
    desired: string | number | boolean | undefined,
    actual: string | number | boolean | null | undefined,
  ) => desired !== undefined && desired !== (actual ?? undefined);

  const desiredOrigins = body.origins.map(normalizeOrigin);
  const observedOrigins = (observed.origins ?? []).map((o) =>
    normalizeOrigin({
      address: o.address ?? "",
      name: o.name ?? undefined,
      enabled: o.enabled ?? undefined,
      weight: o.weight ?? undefined,
      port: o.port ?? undefined,
      header:
        o.header == null
          ? undefined
          : { host: o.header.host == null ? undefined : [...o.header.host] },
      flattenCname: o.flattenCname ?? undefined,
      virtualNetworkId: o.virtualNetworkId ?? undefined,
    }),
  );

  return (
    (observed.name ?? "") !== body.name ||
    JSON.stringify(desiredOrigins) !== JSON.stringify(observedOrigins) ||
    scalarDirty(body.description, observed.description) ||
    scalarDirty(body.enabled, observed.enabled) ||
    scalarDirty(body.monitor, observed.monitor) ||
    scalarDirty(body.monitorGroup, observed.monitorGroup) ||
    scalarDirty(body.minimumOrigins, observed.minimumOrigins) ||
    scalarDirty(body.latitude, observed.latitude) ||
    scalarDirty(body.longitude, observed.longitude) ||
    scalarDirty(body.notificationEmail, observed.notificationEmail) ||
    (body.loadShedding !== undefined &&
      JSON.stringify(body.loadShedding) !==
        JSON.stringify(observed.loadShedding ?? {})) ||
    (body.originSteering !== undefined &&
      JSON.stringify(body.originSteering) !==
        JSON.stringify(observed.originSteering ?? {})) ||
    (body.notificationFilter !== undefined &&
      JSON.stringify(body.notificationFilter) !==
        JSON.stringify(observed.notificationFilter ?? {}))
  );
};

/**
 * Normalize an origin to its API defaults so desired-vs-observed
 * comparison is stable.
 */
const normalizeOrigin = (o: {
  address: string;
  name?: string;
  enabled?: boolean;
  weight?: number;
  port?: number;
  header?: { host?: string[] };
  flattenCname?: boolean;
  virtualNetworkId?: string;
}) => ({
  address: o.address,
  name: o.name ?? "",
  enabled: o.enabled ?? true,
  weight: o.weight ?? 1,
  port: o.port ?? 0,
  host: o.header?.host ?? [],
  flattenCname: o.flattenCname ?? false,
  virtualNetworkId: o.virtualNetworkId ?? "",
});

const toAttributes = (
  pool: ObservedPool,
  accountId: string,
): PoolAttributes => ({
  poolId: pool.id ?? "",
  accountId,
  name: pool.name ?? "",
  enabled: pool.enabled ?? true,
  monitor: pool.monitor ?? undefined,
  createdOn: pool.createdOn ?? undefined,
  modifiedOn: pool.modifiedOn ?? undefined,
});
