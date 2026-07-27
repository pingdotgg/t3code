import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.MagicTransit.StaticRoute" as const;
type TypeId = typeof TypeId;

/**
 * Scope of an ECMP static route — restricts the route to specific
 * Cloudflare colos or regions.
 */
export interface MagicStaticRouteScope {
  /** List of colo names the route applies to. */
  coloNames?: string[];
  /** List of colo regions the route applies to. */
  coloRegions?: string[];
}

export interface MagicStaticRouteProps {
  /**
   * IP prefix in CIDR notation that this route matches.
   */
  prefix: string;
  /**
   * The next-hop IP address for the static route — typically a Magic
   * tunnel's customer-side interface address.
   */
  nexthop: string;
  /**
   * Priority of the static route. Lower values are preferred.
   * @default 100
   */
  priority?: number;
  /**
   * An optional human-provided description of the static route.
   */
  description?: string;
  /**
   * Optional weight for ECMP routes.
   */
  weight?: number;
  /**
   * Used only for ECMP routes — restrict the route to colos/regions.
   */
  scope?: MagicStaticRouteScope;
}

export interface MagicStaticRouteAttributes {
  /** Cloudflare-assigned identifier of the static route. */
  routeId: string;
  /** The Cloudflare account the route belongs to. */
  accountId: string;
  /** IP prefix in CIDR notation. */
  prefix: string;
  /** The next-hop IP address. */
  nexthop: string;
  /** Priority of the static route. */
  priority: number;
  /** The route description, if set. */
  description: string | undefined;
  /** ECMP weight, if set. */
  weight: number | undefined;
  /** ECMP scope, if set. */
  scope: MagicStaticRouteScope | undefined;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type MagicStaticRoute = Resource<
  TypeId,
  MagicStaticRouteProps,
  MagicStaticRouteAttributes,
  never,
  Providers
>;

/**
 * A Magic Transit / Magic WAN static route — steers traffic for a prefix
 * to a next-hop (usually a Magic tunnel interface address).
 *
 * Requires a Magic Transit or Magic WAN subscription on the account —
 * accounts that are not onboarded receive a typed
 * `MagicTransitNotOnboarded` error (Cloudflare code 1012).
 *
 * All properties are mutable in place via PUT. A route's practical
 * identity is the `(prefix, nexthop, priority)` triple — when state is
 * lost, `read` scans for a matching route and reports it as `Unowned` so
 * takeover is gated behind `--adopt`.
 * @resource
 * @product Magic Transit
 * @category Network
 * @section Creating a static route
 * @example Route a prefix over a GRE tunnel
 * ```typescript
 * const tunnel = yield* Cloudflare.MagicTransit.GreTunnel("office", {
 *   name: "office-gre-1",
 *   cloudflareGreEndpoint: "203.0.113.1",
 *   customerGreEndpoint: "198.51.100.1",
 *   interfaceAddress: "10.213.0.8/31",
 * });
 *
 * yield* Cloudflare.MagicTransit.MagicStaticRoute("office-route", {
 *   prefix: "10.100.0.0/24",
 *   nexthop: "10.213.0.9",
 *   priority: 100,
 * });
 * ```
 *
 * @example ECMP route scoped to a region
 * ```typescript
 * yield* Cloudflare.MagicTransit.MagicStaticRoute("ecmp-route", {
 *   prefix: "10.100.0.0/24",
 *   nexthop: "10.213.0.9",
 *   priority: 100,
 *   weight: 50,
 *   scope: { coloRegions: ["ENAM"] },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-transit/how-to/configure-static-routes/
 */
export const MagicStaticRoute = Resource<MagicStaticRoute>(TypeId);

/**
 * Returns true if the given value is a MagicStaticRoute resource.
 */
export const isMagicStaticRoute = (value: unknown): value is MagicStaticRoute =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

const DEFAULT_PRIORITY = 100;

export const MagicStaticRouteProvider = () =>
  Provider.succeed(MagicStaticRoute, {
    stables: ["routeId", "accountId", "createdOn"],

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.routeId) {
        const observed = yield* getRoute(acct, output.routeId);
        if (observed) return toAttributes(observed, acct);
      }
      // Cold read — match on the (prefix, nexthop, priority) triple.
      // Routes carry no ownership markers; report as Unowned so takeover
      // is gated behind the adopt policy.
      const prefix = output?.prefix ?? olds?.prefix;
      const nexthop =
        output?.nexthop ??
        (olds?.nexthop !== undefined && isResolved(olds.nexthop)
          ? olds.nexthop
          : undefined);
      if (prefix && nexthop) {
        const priority = output?.priority ?? olds?.priority ?? DEFAULT_PRIORITY;
        const observed = yield* findRoute(acct, prefix, nexthop, priority);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const nexthop = news.nexthop as string;
      const priority = news.priority ?? DEFAULT_PRIORITY;

      // Observe — the id on `output` is a hint; fall back to scanning for
      // the identity triple when it is gone.
      let observed = output?.routeId
        ? yield* getRoute(accountId, output.routeId)
        : undefined;
      if (!observed) {
        observed = yield* findRoute(accountId, news.prefix, nexthop, priority);
      }

      // Ensure — create when missing.
      if (!observed) {
        const created = yield* magicTransit.createRoute({
          accountId,
          prefix: news.prefix,
          nexthop,
          priority,
          description: news.description,
          weight: news.weight,
          scope: news.scope,
        });
        return toAttributes(created, accountId);
      }

      // Sync — diff observed cloud state against desired; full PUT, skip
      // on no-op.
      const dirty =
        observed.prefix !== news.prefix ||
        observed.nexthop !== nexthop ||
        observed.priority !== priority ||
        (news.description !== undefined &&
          (observed.description ?? undefined) !== news.description) ||
        (news.weight !== undefined &&
          (observed.weight ?? undefined) !== news.weight) ||
        scopeDirty(observed.scope, news.scope);
      if (dirty) {
        const updated = yield* magicTransit.updateRoute({
          accountId,
          routeId: observed.id,
          prefix: news.prefix,
          nexthop,
          priority,
          description: news.description,
          weight: news.weight,
          scope: news.scope,
        });
        observed =
          updated.modifiedRoute ??
          (yield* getRoute(accountId, observed.id)) ??
          observed;
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* magicTransit
        .deleteRoute({
          accountId: output.accountId,
          routeId: output.routeId,
        })
        .pipe(Effect.catchTag("RouteNotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection — the list API already returns the full
      // route shape, so each item maps directly to the `read` Attributes.
      return yield* magicTransit.listRoutes({ accountId }).pipe(
        Effect.map((response) =>
          (response.routes ?? []).map((route) =>
            toAttributes(route, accountId),
          ),
        ),
        // Accounts without a Magic Transit / Magic WAN subscription can't
        // enumerate routes — treat as empty rather than failing the list.
        Effect.catchTag("MagicTransitNotOnboarded", () => Effect.succeed([])),
      );
    }),
  });

interface ObservedRoute {
  id: string;
  nexthop: string;
  prefix: string;
  priority: number;
  description?: string | null;
  weight?: number | null;
  scope?: {
    coloNames?: string[] | null;
    coloRegions?: string[] | null;
  } | null;
  createdOn?: string | null;
  modifiedOn?: string | null;
}

/**
 * Read a route by id, mapping "gone" (`RouteNotFound`, Cloudflare error
 * code 1020) to `undefined`.
 */
const getRoute = (accountId: string, routeId: string) =>
  magicTransit.getRoute({ accountId, routeId }).pipe(
    Effect.map((r): ObservedRoute | undefined => r.route ?? undefined),
    Effect.catchTag("RouteNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a route by its (prefix, nexthop, priority) identity triple.
 */
const findRoute = (
  accountId: string,
  prefix: string,
  nexthop: string,
  priority: number,
) =>
  magicTransit
    .listRoutes({ accountId })
    .pipe(
      Effect.map((r): ObservedRoute | undefined =>
        (r.routes ?? []).find(
          (route) =>
            route.prefix === prefix &&
            route.nexthop === nexthop &&
            route.priority === priority,
        ),
      ),
    );

const sameList = (
  a: string[] | null | undefined,
  b: string[] | undefined,
): boolean =>
  [...(a ?? [])].sort().join(",") === [...(b ?? [])].sort().join(",");

const scopeDirty = (
  observed: ObservedRoute["scope"],
  desired: MagicStaticRouteScope | undefined,
): boolean => {
  if (desired === undefined) return false;
  return (
    !sameList(observed?.coloNames, desired.coloNames) ||
    !sameList(observed?.coloRegions, desired.coloRegions)
  );
};

const toAttributes = (
  route: ObservedRoute,
  accountId: string,
): MagicStaticRouteAttributes => ({
  routeId: route.id,
  accountId,
  prefix: route.prefix,
  nexthop: route.nexthop,
  priority: route.priority,
  description: route.description ?? undefined,
  weight: route.weight ?? undefined,
  scope: route.scope
    ? {
        coloNames: route.scope.coloNames ?? undefined,
        coloRegions: route.scope.coloRegions ?? undefined,
      }
    : undefined,
  createdOn: route.createdOn ?? undefined,
  modifiedOn: route.modifiedOn ?? undefined,
});
