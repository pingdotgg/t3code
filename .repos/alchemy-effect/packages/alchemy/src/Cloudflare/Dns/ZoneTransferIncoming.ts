import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.DNS.ZoneTransferIncoming" as const;
type TypeId = typeof TypeId;

export interface ZoneTransferIncomingProps {
  /**
   * Secondary zone whose incoming transfer configuration is managed.
   * Stable — the configuration is a per-zone singleton, so changing the
   * zone triggers a replacement.
   */
  zoneId: string;
  /**
   * Zone name (e.g. `example.com.`).
   *
   * Mutable — updated in place (PUT).
   */
  name: string;
  /**
   * Peers (by id) Cloudflare transfers the zone in from. Reference
   * {@link ZoneTransferPeer} resources via their `peerId` attribute.
   *
   * Mutable — updated in place (PUT).
   */
  peers: string[];
  /**
   * How often (seconds) the secondary zone auto-refreshes regardless of
   * DNS NOTIFY.
   *
   * Mutable — updated in place (PUT).
   */
  autoRefreshSeconds: number;
}

export interface ZoneTransferIncomingAttributes {
  /** Zone whose incoming transfer configuration is managed. */
  zoneId: string;
  /** Identifier of the configuration (mirrors the zone id). */
  id: string | undefined;
  /** Zone name. */
  name: string | undefined;
  /** Peer ids the zone transfers in from. */
  peers: string[];
  /** Auto-refresh interval in seconds. */
  autoRefreshSeconds: number | undefined;
  /** SOA serial of the most recent transfer. */
  soaSerial: number | undefined;
  /** When the zone was last checked. */
  checkedTime: string | undefined;
  /** When the configuration was created. */
  createdTime: string | undefined;
  /** When the configuration was last modified. */
  modifiedTime: string | undefined;
}

export type ZoneTransferIncoming = Resource<
  TypeId,
  ZoneTransferIncomingProps,
  ZoneTransferIncomingAttributes,
  never,
  Providers
>;

/**
 * The incoming zone-transfer configuration of a secondary zone
 * (`/zones/{zone_id}/secondary_dns/incoming`) — links the zone to the
 * {@link ZoneTransferPeer | peers} Cloudflare transfers it in from and
 * sets the auto-refresh interval.
 *
 * Requires the Secondary DNS (zone transfer) entitlement, and the zone
 * must be created with `type: "secondary"`. The configuration is a
 * per-zone singleton: `zoneId` is the identity (replacement on change),
 * everything else is mutable in place.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Configuring incoming transfers
 * @example Transfer a secondary zone in from a primary
 * ```typescript
 * const peer = yield* Cloudflare.DNS.ZoneTransferPeer("Primary", {
 *   ip: "192.0.2.53",
 *   port: 53,
 * });
 * yield* Cloudflare.DNS.ZoneTransferIncoming("Incoming", {
 *   zoneId: zone.zoneId,
 *   name: "example.com.",
 *   peers: [peer.peerId],
 *   autoRefreshSeconds: 86400,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/dns/zone-setups/zone-transfers/setup/
 */
export const ZoneTransferIncoming = Resource<ZoneTransferIncoming>(TypeId, {
  aliases: ["Cloudflare.Dns.ZoneTransferIncoming"],
});

/**
 * Returns true if the given value is a ZoneTransferIncoming resource.
 */
export const isZoneTransferIncoming = (
  value: unknown,
): value is ZoneTransferIncoming =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ZoneTransferIncomingProvider = () =>
  Provider.succeed(ZoneTransferIncoming, {
    stables: ["zoneId", "id", "createdTime"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this per-zone singleton — enumerate
      // every zone and read its incoming transfer config. Only
      // secondary zones with a configured transfer have one, so skip
      // the rest (`IncomingZoneTransferNotFound`).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          getIncoming(zoneId).pipe(
            Effect.map((observed) =>
              observed === undefined
                ? undefined
                : toAttributes(observed, zoneId),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is ZoneTransferIncomingAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as ZoneTransferIncomingProps;
      const n = news as ZoneTransferIncomingProps;
      // zoneId is the resource's identity (per-zone singleton).
      // Input<string> — compare only once concrete.
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof n.zoneId === "string" &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (!zoneId) return undefined;
      const observed = yield* getIncoming(zoneId);
      if (observed === undefined) return undefined;
      const attrs = toAttributes(observed, zoneId);
      // The configuration carries no ownership markers. With no prior
      // state, gate takeover of an existing configuration behind
      // adoption.
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs are resolved to concrete values by Plan.
      const zoneId = news.zoneId as string;
      const peers = news.peers as string[];

      // Observe — singleton keyed by the zone itself.
      const observed = yield* getIncoming(zoneId);

      if (!observed) {
        // Ensure — first-time link of the zone to its peers.
        const created = yield* dns.createZoneTransferIncoming({
          zoneId,
          name: news.name,
          peers,
          autoRefreshSeconds: news.autoRefreshSeconds,
        });
        return toAttributes(created, zoneId);
      }

      // Sync — PUT with the full desired body; skip the call when the
      // observed configuration already matches.
      const dirty =
        undef(observed.name) !== news.name ||
        undef(observed.autoRefreshSeconds) !== news.autoRefreshSeconds ||
        !samePeers(observed.peers ?? [], peers);
      if (!dirty) {
        return toAttributes(observed, zoneId);
      }
      const updated = yield* dns.updateZoneTransferIncoming({
        zoneId,
        name: news.name,
        peers,
        autoRefreshSeconds: news.autoRefreshSeconds,
      });
      return toAttributes(updated, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns
        .deleteZoneTransferIncoming({ zoneId: output.zoneId })
        .pipe(
          Effect.catchTag("IncomingZoneTransferNotFound", () => Effect.void),
        );
    }),
  });

type ObservedIncoming =
  | dns.GetZoneTransferIncomingResponse
  | dns.CreateZoneTransferIncomingResponse
  | dns.UpdateZoneTransferIncomingResponse;

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

/** Read the incoming configuration, mapping "not linked" to undefined. */
const getIncoming = (zoneId: string) =>
  dns
    .getZoneTransferIncoming({ zoneId })
    .pipe(
      Effect.catchTag("IncomingZoneTransferNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

const samePeers = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const toAttributes = (
  incoming: ObservedIncoming,
  zoneId: string,
): ZoneTransferIncomingAttributes => ({
  zoneId,
  id: undef(incoming.id),
  name: undef(incoming.name),
  peers: [...(undef(incoming.peers) ?? [])],
  autoRefreshSeconds: undef(incoming.autoRefreshSeconds),
  soaSerial: undef(incoming.soaSerial),
  checkedTime: undef(incoming.checkedTime),
  createdTime: undef(incoming.createdTime),
  modifiedTime: undef(incoming.modifiedTime),
});
