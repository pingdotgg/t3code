import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.DNS.ZoneTransferOutgoing" as const;
type TypeId = typeof TypeId;

export interface ZoneTransferOutgoingProps {
  /**
   * Primary zone whose outgoing transfer configuration is managed.
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
   * Peers (by id) Cloudflare NOTIFYs and serves AXFR/IXFR to.
   * Reference {@link ZoneTransferPeer} resources via their `peerId`
   * attribute.
   *
   * Mutable — updated in place (PUT).
   */
  peers: string[];
  /**
   * Whether outgoing transfers are enabled for the zone. Mapped to the
   * dedicated enable/disable endpoints, separate from the
   * configuration's CRUD.
   *
   * Mutable — toggled in place.
   * @default true
   */
  enabled?: boolean;
}

export interface ZoneTransferOutgoingAttributes {
  /** Zone whose outgoing transfer configuration is managed. */
  zoneId: string;
  /** Identifier of the configuration (mirrors the zone id). */
  id: string | undefined;
  /** Zone name. */
  name: string | undefined;
  /** Peer ids the zone is served to. */
  peers: string[];
  /** Whether outgoing transfers are enabled. */
  enabled: boolean;
  /** SOA serial of the most recent transfer. */
  soaSerial: number | undefined;
  /** When the zone was last transferred out. */
  lastTransferredTime: string | undefined;
  /** When the zone was last checked. */
  checkedTime: string | undefined;
  /** When the configuration was created. */
  createdTime: string | undefined;
}

export type ZoneTransferOutgoing = Resource<
  TypeId,
  ZoneTransferOutgoingProps,
  ZoneTransferOutgoingAttributes,
  never,
  Providers
>;

/**
 * The outgoing zone-transfer configuration of a primary zone
 * (`/zones/{zone_id}/secondary_dns/outgoing`) — links the zone to the
 * {@link ZoneTransferPeer | peers} Cloudflare NOTIFYs and serves
 * AXFR/IXFR to, and toggles transfers on or off via the dedicated
 * enable/disable endpoints.
 *
 * Requires the Secondary DNS (zone transfer) entitlement on the zone.
 * The configuration is a per-zone singleton: `zoneId` is the identity
 * (replacement on change), everything else is mutable in place.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Configuring outgoing transfers
 * @example Serve a primary zone to an external secondary
 * ```typescript
 * const peer = yield* Cloudflare.DNS.ZoneTransferPeer("Secondary", {
 *   ip: "192.0.2.53",
 *   port: 53,
 * });
 * yield* Cloudflare.DNS.ZoneTransferOutgoing("Outgoing", {
 *   zoneId: zone.zoneId,
 *   name: "example.com.",
 *   peers: [peer.peerId],
 * });
 * ```
 *
 * @example Configure transfers but keep them disabled
 * ```typescript
 * yield* Cloudflare.DNS.ZoneTransferOutgoing("Outgoing", {
 *   zoneId: zone.zoneId,
 *   name: "example.com.",
 *   peers: [peer.peerId],
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/dns/zone-setups/zone-transfers/setup/
 */
export const ZoneTransferOutgoing = Resource<ZoneTransferOutgoing>(TypeId, {
  aliases: ["Cloudflare.Dns.ZoneTransferOutgoing"],
});

/**
 * Returns true if the given value is a ZoneTransferOutgoing resource.
 */
export const isZoneTransferOutgoing = (
  value: unknown,
): value is ZoneTransferOutgoing =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ZoneTransferOutgoingProvider = () =>
  Provider.succeed(ZoneTransferOutgoing, {
    stables: ["zoneId", "id", "createdTime"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The outgoing transfer config is a per-zone singleton with no
      // account-wide enumeration API — walk every zone and read its
      // config. Most zones have none (or lack the Secondary DNS
      // entitlement); skip those via the typed not-found/not-allowed
      // tags rather than failing the whole enumeration.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          getOutgoing(zoneId).pipe(
            Effect.catchTag("OutgoingZoneTransfersNotAllowed", () =>
              Effect.succeed(undefined),
            ),
            Effect.flatMap((observed) =>
              observed === undefined
                ? Effect.succeed(undefined)
                : getEnabled(zoneId).pipe(
                    Effect.map((enabled) =>
                      toAttributes(observed, zoneId, enabled),
                    ),
                  ),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is ZoneTransferOutgoingAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as ZoneTransferOutgoingProps;
      const n = news as ZoneTransferOutgoingProps;
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
      const observed = yield* getOutgoing(zoneId);
      if (observed === undefined) return undefined;
      const enabled = yield* getEnabled(zoneId);
      const attrs = toAttributes(observed, zoneId, enabled);
      // The configuration carries no ownership markers. With no prior
      // state, gate takeover of an existing configuration behind
      // adoption.
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs are resolved to concrete values by Plan.
      const zoneId = news.zoneId as string;
      const peers = news.peers as string[];
      const desiredEnabled = news.enabled ?? true;

      // Observe — singleton keyed by the zone itself.
      let observed = yield* getOutgoing(zoneId);

      if (!observed) {
        // Ensure — first-time link of the zone to its peers.
        observed = yield* dns.createZoneTransferOutgoing({
          zoneId,
          name: news.name,
          peers,
        });
      } else {
        // Sync — PUT with the full desired body; skip the call when the
        // observed configuration already matches.
        const dirty =
          undef(observed.name) !== news.name ||
          !samePeers(observed.peers ?? [], peers);
        if (dirty) {
          observed = yield* dns.updateZoneTransferOutgoing({
            zoneId,
            name: news.name,
            peers,
          });
        }
      }

      // Sync enabled state — the enable/disable toggle lives on its own
      // endpoints; diff the observed status and only call on a delta.
      const observedEnabled = yield* getEnabled(zoneId);
      if (observedEnabled !== desiredEnabled) {
        yield* desiredEnabled
          ? dns.enableZoneTransferOutgoing({ zoneId, body: {} })
          : dns.disableZoneTransferOutgoing({ zoneId, body: {} });
      }

      return toAttributes(observed, zoneId, desiredEnabled);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns.deleteZoneTransferOutgoing({ zoneId: output.zoneId }).pipe(
        Effect.catchTag("OutgoingZoneTransferNotFound", () => Effect.void),
        // Cloudflare answers DELETE on a zone without the outgoing
        // entitlement (or with no configuration) with a 401 — if we
        // could never have created it, there is nothing to delete.
        Effect.catchTag("OutgoingZoneTransfersNotAllowed", () => Effect.void),
      );
    }),
  });

type ObservedOutgoing =
  | dns.GetZoneTransferOutgoingResponse
  | dns.CreateZoneTransferOutgoingResponse
  | dns.UpdateZoneTransferOutgoingResponse;

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

/** Read the outgoing configuration, mapping "not linked" to undefined. */
const getOutgoing = (zoneId: string) =>
  dns
    .getZoneTransferOutgoing({ zoneId })
    .pipe(
      Effect.catchTag("OutgoingZoneTransferNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

/** Observe the enable/disable toggle (reported as e.g. "Enabled"). */
const getEnabled = (zoneId: string) =>
  dns
    .getZoneTransferOutgoingStatus({ zoneId })
    .pipe(Effect.map((status) => status.toLowerCase().startsWith("enabled")));

const samePeers = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const toAttributes = (
  outgoing: ObservedOutgoing,
  zoneId: string,
  enabled: boolean,
): ZoneTransferOutgoingAttributes => ({
  zoneId,
  id: undef(outgoing.id),
  name: undef(outgoing.name),
  peers: [...(undef(outgoing.peers) ?? [])],
  enabled,
  soaSerial: undef(outgoing.soaSerial),
  lastTransferredTime: undef(outgoing.lastTransferredTime),
  checkedTime: undef(outgoing.checkedTime),
  createdTime: undef(outgoing.createdTime),
});
