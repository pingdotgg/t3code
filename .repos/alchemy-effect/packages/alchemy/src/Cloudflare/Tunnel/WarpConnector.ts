import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Tunnel.WarpConnector" as const;
type TypeId = typeof TypeId;

export interface WarpConnectorProps {
  /**
   * User-friendly name for the WARP Connector tunnel. Tunnel names are
   * unique per account, which makes the name the resource's identity
   * during adoption and state recovery. Changing it replaces the tunnel.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
}

export interface WarpConnectorAttributes {
  /** UUID of the WARP Connector tunnel, assigned by Cloudflare. */
  tunnelId: string;
  /** Cloudflare account that owns the tunnel. */
  accountId: string;
  /** User-friendly name of the tunnel. */
  name: string;
  /**
   * Status of the tunnel: `inactive` (never run), `degraded`, `healthy`,
   * or `down`.
   */
  status: string | undefined;
  /** RFC 3339 timestamp of when the tunnel was created. */
  createdAt: string | undefined;
  /**
   * Connector token used to run the WARP Connector on a host
   * (`warp-cli connector new <token>`). Sensitive — stored redacted.
   */
  token: Redacted.Redacted<string>;
}

export type WarpConnector = Resource<
  TypeId,
  WarpConnectorProps,
  WarpConnectorAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare WARP Connector tunnel — a software site-to-site connector
 * that extends a private network into Cloudflare Zero Trust without
 * running `cloudflared`.
 *
 * The resource manages the tunnel record itself (CRUD); a WARP Connector
 * host joins it at runtime using the `token` attribute. Pair with
 * {@link Route} to route private CIDRs through the connector and
 * {@link VirtualNetwork} to isolate overlapping address space.
 * @resource
 * @product Tunnels
 * @category Cloudflare One (Zero Trust)
 * @section Creating a WARP Connector
 * @example Basic WARP Connector tunnel
 * ```typescript
 * const connector = yield* Cloudflare.Tunnel.WarpConnector("SiteA", {
 *   name: "site-a-connector",
 * });
 * // Provision the host with: warp-cli connector new <Redacted.value(connector.token)>
 * ```
 *
 * @example Route a private network through the connector
 * ```typescript
 * yield* Cloudflare.Tunnel.Route("SiteANet", {
 *   tunnelId: connector.tunnelId,
 *   network: "10.8.0.0/16",
 * });
 * ```
 *
 * @section Renaming
 * @example Replace with a new name
 * ```typescript
 * // Renaming creates a new tunnel with a new tunnelId.
 * const connector = yield* Cloudflare.Tunnel.WarpConnector("SiteA", {
 *   name: "site-a-connector-v2",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/warp-connector/
 */
export const WarpConnector = Resource<WarpConnector>(TypeId);

/**
 * Returns true if the given value is a WarpConnector resource.
 */
export const isWarpConnector = (value: unknown): value is WarpConnector =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const WarpConnectorProvider = () =>
  Provider.succeed(WarpConnector, {
    stables: ["tunnelId", "accountId", "createdAt"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      if (isResolved(news) && olds !== undefined && olds.name !== news.name) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path — refresh by the cached id.
      if (output?.tunnelId) {
        const observed = yield* getConnector(acct, output.tunnelId);
        if (observed) return yield* toAttributes(observed, acct);
      }

      // Cold read — tunnel names are unique per account, so an exact name
      // match is the resource's identity. WARP Connector tunnels carry no
      // ownership markers, so gate adoption behind Unowned.
      const name = yield* resolveName(id, olds?.name ?? output?.name);
      const match = yield* findByName(acct, name);
      if (match) return Unowned(yield* toAttributes(match, acct));
      return undefined;
    }),

    // Account collection: the dedicated `/accounts/{id}/warp_connector`
    // endpoint already scopes to warp_connector tunnels. Paginate
    // exhaustively, drop soft-deleted tunnels (match `read`), then hydrate
    // each live tunnel into the exact `read` Attributes shape (token
    // included). A tunnel deleted out from under us between the list and the
    // token fetch surfaces as a typed TunnelNotFound — skip it.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = yield* zeroTrust.listTunnelWarpConnectors
        .pages({ accountId, isDeleted: false })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).filter(
                (t): t is ObservedConnector & { id: string } =>
                  !t.deletedAt && typeof t.id === "string",
              ),
            ),
          ),
        );
      const rows = yield* Effect.forEach(
        observed,
        (t) =>
          toAttributes(t, accountId).pipe(
            Effect.map(Option.some),
            Effect.catchTag("TunnelNotFound", () =>
              Effect.succeed(Option.none<WarpConnectorAttributes>()),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []));
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* resolveName(id, news.name);

      // 1. Observe — the cached id is a hint, not a guarantee.
      let observed = output?.tunnelId
        ? yield* getConnector(accountId, output.tunnelId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure — create when missing. Tunnel names are unique per
      //    account, so a racing create surfaces as DuplicateTunnelName
      //    (code 1013): converge by re-reading the tunnel that won.
      if (!observed) {
        observed = yield* zeroTrust
          .createTunnelWarpConnector({ accountId, name })
          .pipe(
            Effect.catchTag("DuplicateTunnelName", (error) =>
              findByName(accountId, name).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.succeed(existing) : Effect.fail(error),
                ),
              ),
            ),
          );
      }

      // 3. Sync — rename via PATCH only when the observed name differs.
      if ((observed.name ?? undefined) !== name) {
        observed = yield* zeroTrust.patchTunnelWarpConnector({
          accountId,
          tunnelId: observed.id!,
          name,
        });
      }

      return yield* toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deleting requires all connector sessions to be down — true for
      // tunnels never joined by a host. A missing tunnel (TunnelNotFound,
      // code 1002) means we're done.
      yield* zeroTrust
        .deleteTunnelWarpConnector({
          accountId: output.accountId,
          tunnelId: output.tunnelId,
        })
        .pipe(Effect.catchTag("TunnelNotFound", () => Effect.void));
    }),
  });

interface ObservedConnector {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  createdAt?: string | null;
  deletedAt?: string | null;
}

/**
 * Read a WARP Connector tunnel by id, mapping "gone" (`TunnelNotFound`,
 * Cloudflare error code 1002) and soft-deleted tunnels to `undefined`.
 */
const getConnector = (accountId: string, tunnelId: string) =>
  zeroTrust.getTunnelWarpConnector({ accountId, tunnelId }).pipe(
    Effect.map((t): ObservedConnector | undefined =>
      t.deletedAt ? undefined : t,
    ),
    Effect.catchTag("TunnelNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a live WARP Connector tunnel by exact name. Tunnel names are
 * unique per account so at most one live tunnel can match.
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust.listTunnelWarpConnectors
    .items({ accountId, name, isDeleted: false })
    .pipe(
      Stream.filter(
        (t): t is ObservedConnector & { id: string } =>
          t.name === name && !t.deletedAt && typeof t.id === "string",
      ),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, lowercase: true });
  });

const toAttributes = Effect.fn(function* (
  tunnel: ObservedConnector,
  accountId: string,
) {
  const token = yield* zeroTrust.getTunnelWarpConnectorToken({
    accountId,
    tunnelId: tunnel.id!,
  });
  return {
    tunnelId: tunnel.id!,
    accountId,
    name: tunnel.name ?? "",
    status: tunnel.status ?? undefined,
    createdAt: tunnel.createdAt ?? undefined,
    token: Redacted.make(token),
  } satisfies WarpConnectorAttributes;
});
