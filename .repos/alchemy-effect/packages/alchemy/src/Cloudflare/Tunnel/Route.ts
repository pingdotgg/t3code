import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type RouteProps = {
  /**
   * UUID of the `cfd_tunnel` this route attaches to.
   *
   * Stable -- changing the tunnel triggers replacement.
   */
  tunnelId: string;
  /**
   * Private IPv4 or IPv6 range exposed through the tunnel, in CIDR notation
   * (e.g. `10.4.0.0/16`).
   *
   * Stable -- changing the CIDR triggers replacement.
   *
   * Declared as a plain `string` (not `string`) so it is statically
   * knowable inside `diff`.
   */
  network: string;
  /**
   * Optional human-readable note attached to the route.
   *
   * Mutable -- changes are applied in place via PATCH.
   */
  comment?: string;
  /**
   * Optional Tunnel Virtual Network UUID. Use to disambiguate overlapping
   * CIDRs that live in separate virtual networks.
   *
   * Stable -- changing the virtual network triggers replacement.
   */
  virtualNetworkId?: string;
  /**
   * Whether to adopt an existing route with the same network (and virtual
   * network, when set) on the same tunnel if one is already present.
   *
   * @default false
   */
  adopt?: boolean;
};

export type Route = Resource<
  "Cloudflare.Tunnel.Route",
  RouteProps,
  {
    /**
     * UUID of the route, assigned by Cloudflare.
     */
    routeId: string;
    /**
     * The CIDR exposed through the tunnel.
     */
    network: string;
    /**
     * UUID of the tunnel this route attaches to.
     */
    tunnelId: string;
    /**
     * Cloudflare account that owns the route.
     */
    accountId: string;
    /**
     * Human-readable note attached to the route, if any.
     */
    comment: string | undefined;
    /**
     * UUID of the Tunnel Virtual Network the route lives in, if any.
     */
    virtualNetworkId: string | undefined;
    /**
     * RFC 3339 timestamp of when the route was created (as reported by
     * Cloudflare), if available.
     */
    createdAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Tunnel Route attaches a private CIDR to a `cfd_tunnel` so that
 * WARP clients (and other Zero Trust egress paths) can reach private IPs
 * through the tunnel.
 * @resource
 * @product Tunnels
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Route
 * @example Basic route
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel.Tunnel("MyTunnel");
 * const route = yield* Cloudflare.Tunnel.Route("PrivateNet", {
 *   tunnelId: tunnel.tunnelId,
 *   network: "10.4.0.0/16",
 * });
 * ```
 *
 * @example Route with a comment and explicit virtual network
 * ```typescript
 * const route = yield* Cloudflare.Tunnel.Route("DcRoute", {
 *   tunnelId: tunnel.tunnelId,
 *   network: "10.50.0.0/16",
 *   comment: "Datacenter A private subnet",
 *   virtualNetworkId: vnet.id,
 *   adopt: true,
 * });
 * ```
 */
export const Route = Resource<Route>("Cloudflare.Tunnel.Route", {
  aliases: ["Cloudflare.TunnelRoute"],
});

export const RouteProvider = () =>
  Provider.succeed(Route, {
    stables: [
      "routeId",
      "accountId",
      "tunnelId",
      "network",
      "virtualNetworkId",
    ],
    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      if (!isResolved(news)) return undefined;
      const acct = output?.accountId ?? accountId;
      if (acct !== accountId) {
        return { action: "replace" } as const;
      }
      if (output?.network !== undefined && output.network !== news.network) {
        return { action: "replace" } as const;
      }
      if (olds.network !== undefined && olds.network !== news.network) {
        return { action: "replace" } as const;
      }
      const oldTunnelId = output?.tunnelId ?? olds.tunnelId;
      if (oldTunnelId !== undefined && oldTunnelId !== news.tunnelId) {
        return { action: "replace" } as const;
      }
      // virtualNetworkId is auto-assigned by Cloudflare when omitted
      // (every account has a "default" virtual network that absorbs
      // routes without an explicit assignment). If the caller didn't
      // ask for a specific vnet (`news.virtualNetworkId === undefined`),
      // they're delegating to CF — don't force a replace just because
      // CF auto-assigned one. Only mark replace when the caller has
      // EXPLICITLY chosen a vnet and it differs from what's deployed.
      if (
        news.virtualNetworkId !== undefined &&
        (output?.virtualNetworkId ?? olds.virtualNetworkId) !==
          news.virtualNetworkId
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const acct = output?.accountId ?? accountId;
      const tunnelId = news.tunnelId;
      const network = news.network;
      const virtualNetworkId = news.virtualNetworkId;

      // Observe — cached id first, then an account-wide list scan by
      // network so we recover from out-of-band deletes, partial state
      // writes, or a route left attached to another tunnel.
      let observed = yield* observe(
        acct,
        network,
        virtualNetworkId,
        output?.routeId,
      );

      // Ensure — create when missing. Cloudflare returns a generic
      // conflict on duplicate (network, tunnel, vnet) tuples; on any
      // such race re-observe and either adopt or rethrow.
      if (!observed) {
        // Cloudflare returns an untagged generic error on a
        // duplicate (network, tunnel, vnet) tuple. distilled
        // surfaces it as the untyped Cloudflare error bucket,
        // so we can't `catchTag` -- we narrow by re-observing
        // and only swallowing the error when adoption is
        // requested AND a matching route actually exists.
        const createdOrAdopted = yield* zeroTrust
          .createNetworkRoute({
            accountId: acct,
            network,
            tunnelId,
            comment: news.comment,
            virtualNetworkId,
          })
          .pipe(
            Effect.catch((err) =>
              Effect.gen(function* () {
                if (!news.adopt) return yield* Effect.fail(err);
                const existing = yield* observe(
                  acct,
                  network,
                  virtualNetworkId,
                  undefined,
                );
                if (!existing) return yield* Effect.fail(err);
                // Sentinel: undefined means "adoption path; use re-observed value".
                return undefined;
              }),
            ),
          );
        observed = createdOrAdopted
          ? toObserved(createdOrAdopted)
          : yield* observe(acct, network, virtualNetworkId, undefined);
      }

      if (!observed) {
        return yield* Effect.die(
          `Route create returned no id for network ${network} on tunnel ${tunnelId}`,
        );
      }

      // Sync — `comment` is mutable, and an adopted route may be
      // attached to a different tunnel (the account-wide network
      // uniqueness means we adopt whatever route owns the CIDR) so we
      // repoint `tunnelId` too. Skip the PATCH entirely on no-op so we
      // avoid churn on every reconcile. Clearing a comment must send
      // `""` explicitly — omitting every body field produces an empty
      // PATCH body which Cloudflare rejects with a JSON parse error.
      const desiredComment = news.comment ?? "";
      const needsComment = (observed.comment ?? "") !== desiredComment;
      const needsTunnel = observed.tunnelId !== tunnelId;
      if (needsComment || needsTunnel) {
        const patched = yield* zeroTrust.patchNetworkRoute({
          accountId: acct,
          routeId: observed.id,
          ...(needsComment ? { comment: desiredComment } : {}),
          ...(needsTunnel ? { tunnelId } : {}),
        });
        observed = {
          id: patched.id ?? observed.id,
          network: normalize(patched.network) ?? observed.network,
          tunnelId: normalize(patched.tunnelId) ?? observed.tunnelId,
          virtualNetworkId:
            normalize(patched.virtualNetworkId) ?? observed.virtualNetworkId,
          comment: normalize(patched.comment),
          createdAt: normalize(patched.createdAt) ?? observed.createdAt,
        };
      }

      return {
        routeId: observed.id,
        network: observed.network ?? network,
        tunnelId: observed.tunnelId ?? tunnelId,
        accountId: acct,
        comment: observed.comment,
        virtualNetworkId: observed.virtualNetworkId ?? virtualNetworkId,
        createdAt: observed.createdAt,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteNetworkRoute({
          accountId: output.accountId,
          routeId: output.routeId,
        })
        .pipe(
          // Idempotent delete: distilled doesn't tag NotFound on
          // teamnet/routes/{id}, so we swallow read-side failure
          // wholesale. A "delete a deleted route" is not an error.
          Effect.catch(() => Effect.succeed(undefined)),
        );
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection: enumerate every Zero Trust network
      // route in the account, exhaustively paginating. Drop soft-deleted
      // routes and anything missing an id, then hydrate into the exact
      // `read` Attributes shape so each element is delete-ready.
      return yield* zeroTrust.listNetworkRoutes
        .pages({ accountId, isDeleted: false })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .filter(
                  (r): r is typeof r & { id: string } =>
                    r.id != null && !r.deletedAt,
                )
                .map((r) => ({
                  routeId: r.id,
                  network: normalize(r.network) ?? "",
                  tunnelId: normalize(r.tunnelId) ?? "",
                  accountId,
                  comment: normalize(r.comment),
                  virtualNetworkId: normalize(r.virtualNetworkId),
                  createdAt: normalize(r.createdAt),
                })),
            ),
          ),
        );
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const acct = output?.accountId ?? accountId;
      const tunnelId = output?.tunnelId ?? olds?.tunnelId;
      const network = output?.network ?? olds?.network;
      const virtualNetworkId =
        output?.virtualNetworkId ?? olds?.virtualNetworkId;
      if (!tunnelId || !network) return undefined;
      const observed = yield* observe(
        acct,
        network,
        virtualNetworkId,
        output?.routeId,
      );
      if (!observed) return undefined;
      return {
        routeId: observed.id,
        network: observed.network ?? network,
        tunnelId: observed.tunnelId ?? tunnelId,
        accountId: acct,
        comment: observed.comment,
        virtualNetworkId: observed.virtualNetworkId ?? virtualNetworkId,
        createdAt: observed.createdAt,
      };
    }),
  });

// Route networks are unique per virtual network across the WHOLE
// account (Cloudflare rejects a duplicate CIDR with a Conflict no
// matter which tunnel it's attached to), so the scan must NOT be
// scoped to a tunnel — otherwise a route left on another tunnel is
// invisible to observation and the create Conflict is unrecoverable.
const findRouteByNetwork = (
  accountId: string,
  network: string,
  virtualNetworkId: string | undefined,
) =>
  zeroTrust.listNetworkRoutes
    .items({
      accountId,
      isDeleted: false,
      // subset + superset of the same CIDR == exact match
      networkSubset: network,
      networkSuperset: network,
    })
    .pipe(
      Stream.filter(
        (r) =>
          !r.deletedAt &&
          r.network === network &&
          (virtualNetworkId === undefined ||
            r.virtualNetworkId === virtualNetworkId),
      ),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
      // The distilled cloudflare SDK only tags transport-shaped
      // errors (Unauthorized / 5xx / TooManyRequests / parse
      // errors) on this endpoint -- there's no `NotFound` or
      // `Forbidden` tag to discriminate on. Mirror the
      // canonical `Tunnel.ts` template: swallow read-side
      // errors so observation falls through to "missing" and
      // the ensure step can recover.
      Effect.catch(() => Effect.succeed(undefined)),
    );

const toObserved = (r: {
  id?: string | null;
  network?: string | null;
  tunnelId?: string | null;
  virtualNetworkId?: string | null;
  comment?: string | null;
  createdAt?: string | null;
  deletedAt?: string | null;
}): ObservedRoute | undefined =>
  r.id
    ? {
        id: r.id,
        network: normalize(r.network),
        tunnelId: normalize(r.tunnelId),
        virtualNetworkId: normalize(r.virtualNetworkId),
        comment: normalize(r.comment),
        createdAt: normalize(r.createdAt),
      }
    : undefined;

const observe = Effect.fn(function* (
  acct: string,
  network: string,
  virtualNetworkId: string | undefined,
  routeId: string | undefined,
) {
  if (routeId) {
    // See `findRouteByNetwork` -- distilled doesn't tag
    // NotFound on this endpoint, so we tolerate any read
    // error and fall through to the list scan.
    const raw = yield* zeroTrust
      .getNetworkRoute({ accountId: acct, routeId })
      .pipe(Effect.catch((_: unknown) => Effect.succeed(undefined)));
    const got = raw ? toObserved(raw) : undefined;
    if (got) return got;
  }
  const match = yield* findRouteByNetwork(acct, network, virtualNetworkId);
  if (!match) return undefined;
  return toObserved(match);
});

type ObservedRoute = {
  id: string;
  network: string | undefined;
  tunnelId: string | undefined;
  virtualNetworkId: string | undefined;
  comment: string | undefined;
  createdAt: string | undefined;
};

const normalize = (v: string | null | undefined): string | undefined =>
  v == null ? undefined : v;
