import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Tunnel.VirtualNetwork" as const;
type TypeId = typeof TypeId;

export interface VirtualNetworkProps {
  /**
   * User-friendly name for the virtual network. Names are unique per
   * account, which makes the name the resource's identity during adoption
   * and state recovery. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Optional remark describing the virtual network. Mutable — patched
   * in place.
   *
   * @default ""
   */
  comment?: string;
  /**
   * If `true`, this virtual network is the default for the account. Only
   * one default exists per account — promoting a network demotes the
   * previous default. Mutable — patched in place.
   *
   * @default false
   */
  isDefaultNetwork?: boolean;
}

export interface VirtualNetworkAttributes {
  /** UUID of the virtual network, assigned by Cloudflare. */
  virtualNetworkId: string;
  /** Cloudflare account that owns the virtual network. */
  accountId: string;
  /** User-friendly name of the virtual network. */
  name: string;
  /** Remark describing the virtual network. */
  comment: string;
  /** Whether this virtual network is the account default. */
  isDefaultNetwork: boolean;
  /** RFC 3339 timestamp of when the virtual network was created. */
  createdAt: string;
}

export type VirtualNetwork = Resource<
  TypeId,
  VirtualNetworkProps,
  VirtualNetworkAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Virtual Network — an isolated routing namespace
 * for Cloudflare Tunnel private networks.
 *
 * Virtual networks let you run overlapping CIDR ranges side by side: each
 * {@link Route} can target a `virtualNetworkId`, and WARP clients
 * switch between virtual networks to choose which copy of `10.0.0.0/8`
 * they see. Every account starts with a single `default` virtual network.
 *
 * Name and comment are mutable in place. Deleting a virtual network
 * requires that no routes reference it — express that relationship by
 * passing `vnet.virtualNetworkId` into your `Route`s so destroy
 * ordering is correct.
 * @resource
 * @product Tunnels
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Virtual Network
 * @example Basic virtual network
 * ```typescript
 * const vnet = yield* Cloudflare.Tunnel.VirtualNetwork("Staging", {
 *   comment: "staging private network",
 * });
 * ```
 *
 * @example Route a tunnel CIDR through the virtual network
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel.Tunnel("MyTunnel");
 * yield* Cloudflare.Tunnel.Route("StagingNet", {
 *   tunnelId: tunnel.tunnelId,
 *   network: "10.4.0.0/16",
 *   virtualNetworkId: vnet.virtualNetworkId,
 * });
 * ```
 *
 * @section Default network
 * @example Promote a virtual network to the account default
 * ```typescript
 * // Only one default per account — promoting demotes the previous one.
 * const vnet = yield* Cloudflare.Tunnel.VirtualNetwork("Primary", {
 *   isDefaultNetwork: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/cloudflared/tunnel-virtual-networks/
 */
export const VirtualNetwork = Resource<VirtualNetwork>(TypeId);

/**
 * Returns true if the given value is a VirtualNetwork resource.
 */
export const isVirtualNetwork = (value: unknown): value is VirtualNetwork =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const VirtualNetworkProvider = () =>
  Provider.succeed(VirtualNetwork, {
    stables: ["virtualNetworkId", "accountId", "createdAt"],

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // name / comment / isDefaultNetwork all converge via PATCH.
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path — refresh by the cached id.
      if (output?.virtualNetworkId) {
        const observed = yield* getVnet(acct, output.virtualNetworkId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold read — names are unique per account, so an exact name match
      // is the resource's identity. Virtual networks carry no ownership
      // markers, so report the match as Unowned to gate adoption.
      const name = yield* resolveName(id, olds?.name ?? output?.name);
      const match = yield* findByName(acct, name);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* resolveName(id, news.name);

      // 1. Observe — the cached id is a hint, not a guarantee.
      let observed = output?.virtualNetworkId
        ? yield* getVnet(accountId, output.virtualNetworkId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure — create when missing. Names are unique per account, so
      //    a racing create surfaces as VirtualNetworkConflict (code 1014):
      //    converge by re-reading the network that won the race.
      if (!observed) {
        const created = yield* zeroTrust
          .createNetworkVirtualNetwork({
            accountId,
            name,
            comment: news.comment,
            isDefaultNetwork: news.isDefaultNetwork,
          })
          .pipe(
            Effect.catchTag("VirtualNetworkConflict", (error) =>
              findByName(accountId, name).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.succeed(existing) : Effect.fail(error),
                ),
              ),
            ),
          );
        observed = created;
      }

      // 3. Sync — diff observed cloud state against desired and PATCH only
      //    the delta; skip the call entirely on a no-op. `isDefaultNetwork`
      //    is never patched to false here — demotion happens implicitly
      //    when another network is promoted (Cloudflare rejects an explicit
      //    demote of the only default).
      const desired = {
        name,
        comment: news.comment ?? observed.comment,
        isDefaultNetwork: news.isDefaultNetwork ?? observed.isDefaultNetwork,
      };
      const dirty =
        observed.name !== desired.name ||
        observed.comment !== desired.comment ||
        observed.isDefaultNetwork !== desired.isDefaultNetwork;
      if (dirty) {
        observed = yield* zeroTrust.patchNetworkVirtualNetwork({
          accountId,
          virtualNetworkId: observed.id,
          name: desired.name,
          comment: desired.comment,
          // Only send the promote; never an explicit demote.
          ...(desired.isDefaultNetwork && !observed.isDefaultNetwork
            ? { isDefaultNetwork: true }
            : {}),
        });
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deleting a vnet with routes still attached fails — routes that
      // reference `virtualNetworkId` as an Input get correct destroy
      // ordering, so by the time we run the routes are gone. A missing
      // vnet (VirtualNetworkNotFound, code 1046) means we're done.
      yield* zeroTrust
        .deleteNetworkVirtualNetwork({
          accountId: output.accountId,
          virtualNetworkId: output.virtualNetworkId,
        })
        .pipe(Effect.catchTag("VirtualNetworkNotFound", () => Effect.void));
    }),

    // Account-scoped collection: virtual networks are listed per account.
    // Exhaustively paginate and filter out soft-deleted networks to match
    // `read`/`findByName`, hydrating each into the `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listNetworkVirtualNetworks
        .pages({ accountId, isDeleted: false })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .filter((v) => !v.deletedAt)
                // The account's default virtual network can't be deleted
                // ("it is the default virtual network"); never enumerate it
                // for account-wide teardown.
                .filter((v) => !v.isDefaultNetwork)
                .map(
                  (v): VirtualNetworkAttributes => ({
                    virtualNetworkId: v.id,
                    accountId,
                    name: v.name,
                    comment: v.comment,
                    isDefaultNetwork: v.isDefaultNetwork,
                    createdAt: v.createdAt,
                  }),
                ),
            ),
          ),
        );
    }),
  });

type ObservedVnet = zeroTrust.GetNetworkVirtualNetworkResponse;

/**
 * Read a virtual network by id, mapping "gone" (`VirtualNetworkNotFound`,
 * Cloudflare error code 1046) and soft-deleted networks to `undefined`.
 */
const getVnet = (accountId: string, virtualNetworkId: string) =>
  zeroTrust.getNetworkVirtualNetwork({ accountId, virtualNetworkId }).pipe(
    Effect.map((v): ObservedVnet | undefined => (v.deletedAt ? undefined : v)),
    Effect.catchTag("VirtualNetworkNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a live virtual network by exact name. Names are unique per account
 * so at most one live network can match.
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust.listNetworkVirtualNetworks
    .items({ accountId, name, isDeleted: false })
    .pipe(
      Stream.filter((v): v is ObservedVnet => v.name === name && !v.deletedAt),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, lowercase: true });
  });

const toAttributes = (
  vnet: ObservedVnet,
  accountId: string,
): VirtualNetworkAttributes => ({
  virtualNetworkId: vnet.id,
  accountId,
  name: vnet.name,
  comment: vnet.comment,
  isDefaultNetwork: vnet.isDefaultNetwork,
  createdAt: vnet.createdAt,
});
