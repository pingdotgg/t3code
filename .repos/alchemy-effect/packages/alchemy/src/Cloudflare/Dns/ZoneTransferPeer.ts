import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.DNS.ZoneTransferPeer" as const;
type TypeId = typeof TypeId;

export interface ZoneTransferPeerProps {
  /**
   * Human-readable name of the peer. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   *
   * Mutable — updated in place (PUT).
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * IPv4/IPv6 address of the primary or secondary nameserver, depending
   * on what zone this peer is linked to. For primary (outgoing) zones
   * this is the secondary nameserver Cloudflare will NOTIFY; for
   * secondary (incoming) zones it is the primary Cloudflare transfers
   * from.
   *
   * Mutable — updated in place (PUT).
   */
  ip?: string;
  /**
   * DNS port of the primary or secondary nameserver.
   *
   * Mutable — updated in place (PUT).
   * @default 53
   */
  port?: number;
  /**
   * TSIG used to authenticate zone transfers with this peer. Reference
   * a {@link ZoneTransferTsig} via its `tsigId` attribute.
   *
   * Mutable — updated in place (PUT).
   */
  tsigId?: string;
  /**
   * Use the IXFR (incremental) transfer protocol instead of AXFR. Only
   * applicable to secondary zones.
   *
   * Mutable — updated in place (PUT).
   * @default false
   */
  ixfrEnable?: boolean;
}

export interface ZoneTransferPeerAttributes {
  /** Identifier of the peer. */
  peerId: string;
  /** The Cloudflare account the peer belongs to. */
  accountId: string;
  /** Human-readable name of the peer. */
  name: string;
  /** Nameserver IP, if configured. */
  ip: string | undefined;
  /** Nameserver DNS port, if configured. */
  port: number | undefined;
  /** TSIG used to authenticate transfers, if configured. */
  tsigId: string | undefined;
  /** Whether IXFR transfers are enabled. */
  ixfrEnable: boolean | undefined;
}

export type ZoneTransferPeer = Resource<
  TypeId,
  ZoneTransferPeerProps,
  ZoneTransferPeerAttributes,
  never,
  Providers
>;

/**
 * A Secondary DNS zone-transfer peer
 * (`/accounts/{account_id}/secondary_dns/peers`) — an external
 * nameserver Cloudflare exchanges zone transfers with. Link peers to a
 * zone via {@link ZoneTransferIncoming} (secondary zones) or
 * {@link ZoneTransferOutgoing} (primary zones).
 *
 * Requires the Secondary DNS (zone transfer) entitlement on the
 * account. Cloudflare's create API only accepts a name; the provider
 * follows up with an update when `ip`, `port`, `tsigId`, or
 * `ixfrEnable` are declared, all of which remain mutable in place.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Creating a Peer
 * @example Primary nameserver to transfer from
 * ```typescript
 * const peer = yield* Cloudflare.DNS.ZoneTransferPeer("Primary", {
 *   ip: "192.0.2.53",
 *   port: 53,
 * });
 * ```
 *
 * @example Peer with TSIG authentication
 * ```typescript
 * const tsig = yield* Cloudflare.DNS.ZoneTransferTsig("TransferKey", {
 *   algo: "hmac-sha512.",
 *   secret: Redacted.make(process.env.TSIG_SECRET!),
 * });
 * const peer = yield* Cloudflare.DNS.ZoneTransferPeer("Primary", {
 *   ip: "192.0.2.53",
 *   tsigId: tsig.tsigId,
 *   ixfrEnable: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/dns/zone-setups/zone-transfers/
 */
export const ZoneTransferPeer = Resource<ZoneTransferPeer>(TypeId, {
  aliases: ["Cloudflare.Dns.ZoneTransferPeer"],
});

/**
 * Returns true if the given value is a ZoneTransferPeer resource.
 */
export const isZoneTransferPeer = (value: unknown): value is ZoneTransferPeer =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ZoneTransferPeerProvider = () =>
  Provider.succeed(ZoneTransferPeer, {
    stables: ["peerId", "accountId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection (pattern b) — secondary_dns peers
      // live under the account, not a zone. Exhaustively paginate and
      // hydrate each row into the exact `read` Attributes shape.
      return yield* dns.listZoneTransferPeers.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((peer) => toAttributes(peer, accountId)),
          ),
        ),
      );
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.peerId) {
        const observed = yield* getPeer(acct, output.peerId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the
      // deterministic physical name. Peers carry no ownership markers,
      // so gate takeover behind adoption.
      const name = yield* createPeerName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? Unowned(toAttributes(match, acct)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createPeerName(id, news.name);
      // Inputs are resolved to concrete values by Plan.
      const desired = {
        name,
        ip: news.ip as string | undefined,
        port: news.port,
        tsigId: news.tsigId as string | undefined,
        ixfrEnable: news.ixfrEnable,
      };

      // Observe — the id cached on `output` is a hint, not a guarantee.
      let observed = output?.peerId
        ? yield* getPeer(output.accountId ?? accountId, output.peerId)
        : undefined;
      const acct = observed ? (output?.accountId ?? accountId) : accountId;

      if (!observed) {
        // Ensure — Cloudflare's create only accepts `name`; the
        // connection settings are applied by the sync step below.
        observed = yield* dns.createZoneTransferPeer({ accountId, name });
      }

      // Sync — PUT with the full desired body; skip the call when no
      // declared field differs from the observed cloud state.
      const dirty =
        observed.name !== desired.name ||
        (desired.ip !== undefined && undef(observed.ip) !== desired.ip) ||
        (desired.port !== undefined && undef(observed.port) !== desired.port) ||
        (desired.tsigId !== undefined &&
          undef(observed.tsigId) !== desired.tsigId) ||
        (desired.ixfrEnable !== undefined &&
          undef(observed.ixfrEnable) !== desired.ixfrEnable);

      if (!dirty) {
        return toAttributes(observed, acct);
      }
      const updated = yield* dns.updateZoneTransferPeer({
        accountId: acct,
        peerId: observed.id,
        name: desired.name,
        ip: desired.ip ?? undef(observed.ip),
        port: desired.port ?? undef(observed.port),
        tsigId: desired.tsigId ?? undef(observed.tsigId),
        ixfrEnable: desired.ixfrEnable ?? undef(observed.ixfrEnable),
      });
      return toAttributes(updated, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns
        .deleteZoneTransferPeer({
          accountId: output.accountId,
          peerId: output.peerId,
        })
        .pipe(Effect.catchTag("PeerNotFound", () => Effect.void));
    }),
  });

type ObservedPeer =
  | dns.GetZoneTransferPeerResponse
  | dns.CreateZoneTransferPeerResponse
  | dns.UpdateZoneTransferPeerResponse;

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

/** Read a peer by id, mapping "gone" (404) to `undefined`. */
const getPeer = (accountId: string, peerId: string) =>
  dns
    .getZoneTransferPeer({ accountId, peerId })
    .pipe(Effect.catchTag("PeerNotFound", () => Effect.succeed(undefined)));

/**
 * Find a peer by exact name. Names are not unique on Cloudflare's side;
 * pick the lexicographically-first id for determinism.
 */
const findByName = (accountId: string, name: string) =>
  dns.listZoneTransferPeers.items({ accountId }).pipe(
    Stream.filter((p) => p.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => a.id.localeCompare(b.id))
        .at(0),
    ),
  );

const createPeerName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  peer: ObservedPeer,
  accountId: string,
): ZoneTransferPeerAttributes => ({
  peerId: peer.id,
  accountId,
  name: peer.name,
  // Cloudflare returns "" / 0 for unset ip/port on freshly-created
  // peers — normalize those to undefined.
  ip: undef(peer.ip) || undefined,
  port: undef(peer.port) || undefined,
  tsigId: undef(peer.tsigId) || undefined,
  ixfrEnable: undef(peer.ixfrEnable),
});
