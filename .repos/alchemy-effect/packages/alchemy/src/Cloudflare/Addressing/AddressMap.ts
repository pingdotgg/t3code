import * as addressing from "@distilled.cloud/cloudflare/addressing";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Addressing.AddressMap" as const;
type TypeId = typeof TypeId;

/**
 * A zone or account membership on an Address Map. Zones (or whole accounts)
 * listed here are assigned the IPs on the map. A zone membership takes
 * priority over an account membership.
 */
export interface AddressMapMembership {
  /**
   * The zone id (for `kind: "zone"`) or account id (for `kind: "account"`)
   * to assign the map's IPs to.
   *
   * Note: due to the shape of the Cloudflare API, account memberships can
   * only target the account that owns the Address Map.
   */
  identifier: string;
  /**
   * Whether the membership targets a zone or a whole account.
   */
  kind: "zone" | "account";
}

export interface AddressMapProps {
  /**
   * An optional description used to describe the types of IPs or zones on
   * the map. Mutable — patched in place.
   */
  description?: string;
  /**
   * Whether the Address Map is enabled. Cloudflare's DNS will not respond
   * with the map's IP addresses until the map is enabled. Mutable.
   * @default false
   */
  enabled?: boolean;
  /**
   * Default SNI to present to legacy TLS clients that do not send the TLS
   * server name indicator. Mutable — patch-only (set in a post-create sync
   * step).
   */
  defaultSni?: string;
  /**
   * The set of IPs on the Address Map. Mutable — synced per-IP via
   * PUT/DELETE against observed cloud state.
   * @default []
   */
  ips?: string[];
  /**
   * Zones and accounts assigned IPs on this Address Map. Mutable — synced
   * per-membership via PUT/DELETE against observed cloud state.
   * @default []
   */
  memberships?: AddressMapMembership[];
}

export interface AddressMapAttributes {
  /** Cloudflare-assigned identifier of the Address Map. */
  addressMapId: string;
  /** The Cloudflare account the Address Map belongs to. */
  accountId: string;
  /**
   * If `false`, the Address Map cannot be deleted via the API (true for
   * Cloudflare-managed maps).
   */
  canDelete: boolean;
  /**
   * If `false`, the IPs on the Address Map cannot be modified via the API
   * (true for Cloudflare-managed maps).
   */
  canModifyIps: boolean;
  /** The map's description, if set. */
  description: string | undefined;
  /** Whether the Address Map is enabled. */
  enabled: boolean;
  /** Default SNI presented to legacy TLS clients, if set. */
  defaultSni: string | undefined;
  /** The set of IPs currently on the Address Map. */
  ips: string[];
  /** Zone/account memberships currently on the Address Map. */
  memberships: { identifier: string; kind: "zone" | "account" }[];
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedAt: string | undefined;
}

export type AddressMap = Resource<
  TypeId,
  AddressMapProps,
  AddressMapAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Address Map — assigns account-owned or Cloudflare-assigned
 * static IPs to zones (BYOIP / Enterprise static IPs).
 *
 * Requires the BYOIP add-on or Cloudflare-assigned static IPs on the
 * account; without the entitlement every mutating call fails with the typed
 * `FeatureNotEnabled` error (`address_maps_not_enabled_on_account`).
 * @resource
 * @product Addressing
 * @category Network
 * @section Creating an Address Map
 * @example Disabled map with a description
 * ```typescript
 * const map = yield* Cloudflare.Addressing.AddressMap("static-ips", {
 *   description: "static ingress IPs",
 *   enabled: false,
 * });
 * ```
 *
 * @example Map with IPs and zone memberships
 * ```typescript
 * const map = yield* Cloudflare.Addressing.AddressMap("ingress", {
 *   description: "ingress",
 *   enabled: true,
 *   ips: ["192.0.2.1"],
 *   memberships: [{ identifier: zone.zoneId, kind: "zone" }],
 * });
 * ```
 *
 * @section Legacy TLS clients
 * @example Default SNI for clients without SNI
 * ```typescript
 * const map = yield* Cloudflare.Addressing.AddressMap("legacy", {
 *   enabled: true,
 *   defaultSni: "example.com",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/byoip/address-maps/
 */
export const AddressMap = Resource<AddressMap>(TypeId);

/**
 * Returns true if the given value is an AddressMap resource.
 */
export const isAddressMap = (value: unknown): value is AddressMap =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const AddressMapProvider = () =>
  Provider.succeed(AddressMap, {
    stables: [
      "addressMapId",
      "accountId",
      "canDelete",
      "canModifyIps",
      "createdAt",
    ],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The account-scoped list endpoint omits `ips` and `memberships`,
      // so enumerate ids exhaustively, then hydrate each into the exact
      // `read` shape via `getAddressMap` (typed per-item not-found).
      const ids = yield* addressing.listAddressMaps.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).flatMap((m) => (m.id ? [m.id] : [])),
          ),
        ),
      );
      const rows = yield* Effect.forEach(
        ids,
        (addressMapId) =>
          getMap(accountId, addressMapId).pipe(
            Effect.map((observed) =>
              observed ? toAttributes(observed, accountId) : undefined,
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is AddressMapAttributes => row !== undefined,
      );
    }),

    read: Effect.fn(function* ({ output }) {
      // Address Maps have no name field to match on, so there is no
      // reliable cold-lookup — lost state is treated as gone and the
      // engine recreates.
      if (!output?.addressMapId) return undefined;
      const observed = yield* getMap(output.accountId, output.addressMapId);
      return observed ? toAttributes(observed, output.accountId) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // 1. Observe — the map id cached on `output` is a hint, not a
      //    guarantee: a missing map falls through to create.
      let observed = output?.addressMapId
        ? yield* getMap(acct, output.addressMapId)
        : undefined;

      // 2. Ensure — create with the full desired body (ips + memberships
      //    are accepted inline on create). `defaultSni` is patch-only and
      //    handled by the sync step below.
      if (!observed) {
        const created = yield* addressing.createAddressMap({
          accountId,
          description: news.description,
          enabled: news.enabled ?? false,
          ips: desiredIps(news),
          memberships: desiredMemberships(news),
        });
        if (!created.id) {
          return yield* Effect.fail(
            new Error("Cloudflare did not return an Address Map id"),
          );
        }
        // Re-observe so every sync step diffs against authoritative state.
        observed = yield* getMap(accountId, created.id);
        if (!observed) {
          return yield* Effect.fail(
            new Error("Address Map disappeared right after creation"),
          );
        }
      }

      const addressMapId = observed.id!;

      // 3a. Sync scalar fields (description / enabled / defaultSni) —
      //     skip the patch entirely on a no-op.
      const scalarDirty =
        (news.description ?? "") !== (observed.description ?? "") ||
        (news.enabled ?? false) !== (observed.enabled ?? false) ||
        (news.defaultSni !== undefined &&
          news.defaultSni !== (observed.defaultSni ?? undefined));
      if (scalarDirty) {
        yield* addressing.patchAddressMap({
          accountId: acct,
          addressMapId,
          description: news.description ?? "",
          enabled: news.enabled ?? false,
          defaultSni: news.defaultSni,
        });
      }

      // 3b. Sync IPs — diff observed cloud IPs against desired, apply
      //     only the per-IP delta.
      const observedIps = (observed.ips ?? []).flatMap((ip) =>
        ip.ip ? [ip.ip] : [],
      );
      const wantedIps = desiredIps(news);
      for (const ip of wantedIps) {
        if (!observedIps.includes(ip)) {
          yield* addressing.putAddressMapIp({
            accountId: acct,
            addressMapId,
            ipAddress: ip,
            body: {},
          });
        }
      }
      for (const ip of observedIps) {
        if (!wantedIps.includes(ip)) {
          yield* addressing.deleteAddressMapIp({
            accountId: acct,
            addressMapId,
            ipAddress: ip,
          });
        }
      }

      // 3c. Sync memberships — same observed-vs-desired delta, routed to
      //     the zone/account variant per membership kind.
      const observedMemberships = narrowMemberships(observed.memberships);
      const wantedMemberships = desiredMemberships(news);
      for (const m of wantedMemberships) {
        const present = observedMemberships.some(
          (o) => o.identifier === m.identifier && o.kind === m.kind,
        );
        if (!present) {
          yield* m.kind === "zone"
            ? addressing.putAddressMapZone({
                accountId: acct,
                addressMapId,
                zoneId: m.identifier,
                body: {},
              })
            : addressing.putAddressMapAccount({
                accountId: acct,
                addressMapId,
                body: {},
              });
        }
      }
      for (const m of observedMemberships) {
        const wanted = wantedMemberships.some(
          (w) => w.identifier === m.identifier && w.kind === m.kind,
        );
        if (!wanted) {
          yield* m.kind === "zone"
            ? addressing.deleteAddressMapZone({
                accountId: acct,
                addressMapId,
                zoneId: m.identifier,
              })
            : addressing.deleteAddressMapAccount({
                accountId: acct,
                addressMapId,
              });
        }
      }

      // 4. Return — re-read so the persisted attributes reflect the final
      //    converged cloud state.
      const final = yield* getMap(acct, addressMapId);
      if (!final) {
        return yield* Effect.fail(
          new Error("Address Map disappeared during reconcile"),
        );
      }
      return toAttributes(final, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloudflare-managed maps cannot (and must not) be deleted.
      if (output.canDelete === false) return;
      yield* addressing
        .deleteAddressMap({
          accountId: output.accountId,
          addressMapId: output.addressMapId,
        })
        .pipe(Effect.catchTag("AddressMapNotFound", () => Effect.void));
    }),
  });

/**
 * Read an Address Map by id, mapping "gone" (`AddressMapNotFound`,
 * Cloudflare error code 1000 `not_found`) to `undefined`.
 */
const getMap = (accountId: string, addressMapId: string) =>
  addressing
    .getAddressMap({ accountId, addressMapId })
    .pipe(
      Effect.catchTag("AddressMapNotFound", () => Effect.succeed(undefined)),
    );

/** Desired IPs — inputs have been resolved to concrete strings by Plan. */
const desiredIps = (news: AddressMapProps): string[] =>
  (news.ips ?? []).map((ip) => ip as string);

/** Desired memberships with inputs resolved to concrete strings. */
const desiredMemberships = (
  news: AddressMapProps,
): { identifier: string; kind: "zone" | "account" }[] =>
  (news.memberships ?? []).map((m) => ({
    identifier: m.identifier as string,
    kind: m.kind,
  }));

/**
 * Narrow distilled memberships (whose `kind` is widened to an open string
 * union) down to the closed `"zone" | "account"` literals, dropping any
 * membership without an identifier or with an unknown kind.
 */
const narrowMemberships = (
  memberships:
    | readonly {
        identifier?: string | null;
        kind?: string | null;
      }[]
    | null
    | undefined,
): { identifier: string; kind: "zone" | "account" }[] =>
  (memberships ?? []).flatMap(
    (m): { identifier: string; kind: "zone" | "account" }[] => {
      if (!m.identifier) return [];
      if (m.kind === "zone") {
        return [{ identifier: m.identifier, kind: "zone" }];
      }
      if (m.kind === "account") {
        return [{ identifier: m.identifier, kind: "account" }];
      }
      return [];
    },
  );

const toAttributes = (
  map: addressing.GetAddressMapResponse,
  accountId: string,
): AddressMapAttributes => ({
  addressMapId: map.id ?? "",
  accountId,
  canDelete: map.canDelete ?? true,
  canModifyIps: map.canModifyIps ?? true,
  description: map.description ?? undefined,
  enabled: map.enabled ?? false,
  defaultSni: map.defaultSni ?? undefined,
  ips: (map.ips ?? []).flatMap((ip) => (ip.ip ? [ip.ip] : [])),
  memberships: narrowMemberships(map.memberships),
  createdAt: map.createdAt ?? undefined,
  modifiedAt: map.modifiedAt ?? undefined,
});
