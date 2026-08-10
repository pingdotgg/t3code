import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Tunnel.HostnameRoute" as const;
type TypeId = typeof TypeId;

export interface HostnameRouteProps {
  /**
   * The hostname to route through the tunnel (e.g.
   * `app.internal.example.com`). Unique per account. Mutable — updated
   * in place via PATCH.
   */
  hostname: string;
  /**
   * UUID of the `cfd_tunnel` that traffic for the hostname egresses
   * through. Mutable — updated in place via PATCH.
   */
  tunnelId: string;
  /**
   * Optional human-readable note attached to the route. Mutable.
   */
  comment?: string;
}

export type HostnameRouteAttributes = {
  /** API UUID of the hostname route. */
  hostnameRouteId: string;
  /** Account that owns the route. */
  accountId: string;
  /** The hostname routed through the tunnel. */
  hostname: string;
  /** UUID of the tunnel the hostname routes to. */
  tunnelId: string;
  /** Human-readable note attached to the route, if any. */
  comment: string | undefined;
  /** RFC 3339 timestamp of when the route was created, if reported. */
  createdAt: string | undefined;
};

export type HostnameRoute = Resource<
  TypeId,
  HostnameRouteProps,
  HostnameRouteAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust **hostname route** — routes traffic for a
 * private hostname through a `cfd_tunnel`, so WARP clients can reach
 * internal apps by name without publishing a public DNS record.
 *
 * All fields (hostname, tunnel, comment) are mutable in place via PATCH.
 * @resource
 * @product Tunnels
 * @category Cloudflare One (Zero Trust)
 * @section Creating a hostname route
 * @example Route an internal hostname through a tunnel
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel.Tunnel("MyTunnel");
 * const route = yield* Cloudflare.Tunnel.HostnameRoute("AppRoute", {
 *   hostname: "app.internal.example.com",
 *   tunnelId: tunnel.tunnelId,
 * });
 * ```
 *
 * @example Add a comment
 * ```typescript
 * const route = yield* Cloudflare.Tunnel.HostnameRoute("AppRoute", {
 *   hostname: "app.internal.example.com",
 *   tunnelId: tunnel.tunnelId,
 *   comment: "Internal wiki behind the datacenter tunnel",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/cloudflared/
 */
export const HostnameRoute = Resource<HostnameRoute>(TypeId);

/**
 * Returns true if the given value is a HostnameRoute resource.
 */
export const isHostnameRoute = (value: unknown): value is HostnameRoute =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const HostnameRouteProvider = () =>
  Provider.succeed(HostnameRoute, {
    stables: ["hostnameRouteId", "accountId"],

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.hostnameRouteId) {
        const observed = yield* observeRoute(acct, output.hostnameRouteId);
        return observed ? toAttributes(observed, acct) : undefined;
      }

      // Cold lookup: hostnames are unique per account, but the route
      // carries no ownership markers — brand the match `Unowned`.
      const hostname = olds?.hostname;
      if (hostname === undefined) return undefined;
      const match = yield* findByHostname(acct, hostname);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — cached id is a hint; fall back to a hostname scan so
      //    a crashed prior run converges. A hostname scan also surfaces a
      //    leftover/foreign route squatting on the hostname, which the sync
      //    step below re-routes to our tunnel.
      let observed: ObservedRoute | undefined = output?.hostnameRouteId
        ? yield* observeRoute(accountId, output.hostnameRouteId)
        : undefined;
      if (!observed) {
        observed = yield* findByHostname(accountId, news.hostname);
      }

      // 2. Ensure — create when missing, tolerating the "already routed to
      //    another tunnel" race: a concurrent create won, or a leftover route
      //    not yet visible to our scan owns the hostname. Re-observe (the list
      //    is eventually consistent right after the conflicting create) so the
      //    sync step takes the squatting route over.
      if (!observed) {
        observed = yield* zeroTrust
          .createNetworkHostnameRoute({
            accountId,
            hostname: news.hostname,
            tunnelId: news.tunnelId,
            ...(news.comment !== undefined ? { comment: news.comment } : {}),
          })
          .pipe(
            Effect.catchTag("HostnameRouteAlreadyRouted", (conflict) =>
              findByHostname(accountId, news.hostname).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("1 second"),
                  until: (route) => route !== undefined,
                  times: 5,
                }),
                Effect.flatMap((route) =>
                  route ? Effect.succeed(route) : Effect.fail(conflict),
                ),
              ),
            ),
          );
      }

      // 3. Sync — PATCH only when the observed state differs (this is also how
      //    a taken-over foreign route gets re-routed to our tunnel).
      const dirty =
        (observed.hostname ?? "") !== news.hostname ||
        (observed.tunnelId ?? "") !== news.tunnelId ||
        (observed.comment || undefined) !== news.comment;
      if (!dirty) {
        return toAttributes(observed, accountId);
      }
      const updated = yield* zeroTrust.patchNetworkHostnameRoute({
        accountId,
        hostnameRouteId: observed.id!,
        hostname: news.hostname,
        tunnelId: news.tunnelId,
        comment: news.comment ?? "",
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteNetworkHostnameRoute({
          accountId: output.accountId,
          hostnameRouteId: output.hostnameRouteId,
        })
        .pipe(Effect.catchTag("HostnameRouteNotFound", () => Effect.void));
    }),

    // Account collection — hostname routes are enumerated account-wide via
    // the Zero Trust list API. Paginate exhaustively, drop tombstoned/idless
    // rows, and hydrate each into the exact `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listNetworkHostnameRoutes
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .filter((r) => r.id != null && r.deletedAt == null)
                .map((r) => toAttributes(r, accountId)),
            ),
          ),
        );
    }),
  });

/**
 * Structural shape shared by get/list/create/patch responses.
 */
type ObservedRoute = {
  id?: string | null;
  comment?: string | null;
  createdAt?: string | null;
  deletedAt?: string | null;
  hostname?: string | null;
  tunnelId?: string | null;
};

/**
 * Read a hostname route by id, mapping "gone" (404 or a tombstoned
 * `deletedAt`) to `undefined`.
 */
const observeRoute = (accountId: string, hostnameRouteId: string) =>
  zeroTrust.getNetworkHostnameRoute({ accountId, hostnameRouteId }).pipe(
    Effect.map((route) => (route.deletedAt != null ? undefined : route)),
    Effect.catchTag("HostnameRouteNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a live hostname route by exact hostname (unique per account).
 */
const findByHostname = (accountId: string, hostname: string) =>
  zeroTrust
    .listNetworkHostnameRoutes({ accountId })
    .pipe(
      Effect.map((list) =>
        (list.result ?? []).find(
          (r) => r.hostname === hostname && r.id != null && r.deletedAt == null,
        ),
      ),
    );

const toAttributes = (
  route: ObservedRoute,
  accountId: string,
): HostnameRouteAttributes => ({
  hostnameRouteId: route.id ?? "",
  accountId,
  hostname: route.hostname ?? "",
  tunnelId: route.tunnelId ?? "",
  comment: route.comment || undefined,
  createdAt: route.createdAt ?? undefined,
});
