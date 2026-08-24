import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.MagicTransit.SiteLan" as const;
type TypeId = typeof TypeId;

/**
 * NAT configuration for a Magic WAN site LAN.
 */
export interface MagicSiteLanNat {
  /** A valid CIDR notation representing an IP range. */
  staticPrefix?: string;
}

/**
 * A subnet routed behind a Magic WAN site LAN.
 */
export interface MagicSiteLanRoutedSubnet {
  /** A valid IPv4 address for the subnet's next hop. */
  nextHop: string;
  /** A valid CIDR notation representing an IP range. */
  prefix: string;
  /** Optional NAT configuration for the routed subnet. */
  nat?: MagicSiteLanNat;
}

/**
 * Static addressing configuration for a Magic WAN site LAN. If the site is
 * not in high availability mode this is optional (DHCP is used when
 * omitted); in HA mode it is required along with a secondary address.
 */
export interface MagicSiteLanStaticAddressing {
  /** A valid CIDR notation representing the LAN address. */
  address: string;
  /** Secondary address, required when the site is in HA mode. */
  secondaryAddress?: string;
  /** Virtual address shared by HA connector pairs. */
  virtualAddress?: string;
  /** DHCP relay configuration. */
  dhcpRelay?: {
    /** List of DHCP server addresses. */
    serverAddresses?: string[];
  };
  /** DHCP server configuration. */
  dhcpServer?: {
    /** End of the DHCP address pool. */
    dhcpPoolEnd?: string;
    /** Start of the DHCP address pool. */
    dhcpPoolStart?: string;
    /** A single DNS server address. */
    dnsServer?: string;
    /** DNS server addresses. */
    dnsServers?: string[];
    /** Mapping of MAC addresses to IP addresses. */
    reservations?: Record<string, unknown>;
  };
}

export interface MagicSiteLanProps {
  /**
   * The site this LAN belongs to. Changing it triggers a replacement.
   */
  siteId: string;
  /**
   * The physical port number on the connector this LAN is attached to.
   */
  physport: number;
  /**
   * The name of the LAN. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * VLAN ID. Use zero for untagged.
   * @default 0
   */
  vlanTag?: number;
  /**
   * Mark true to use this LAN for HA probing. Only works for sites with
   * HA turned on; only one LAN can be the ha_link. Create-only — changing
   * it triggers a replacement.
   */
  haLink?: boolean;
  /**
   * Mark true to use this LAN for source-based breakout traffic.
   */
  isBreakout?: boolean;
  /**
   * Mark true to use this LAN for source-based prioritized traffic.
   */
  isPrioritized?: boolean;
  /**
   * NAT configuration for the LAN.
   */
  nat?: MagicSiteLanNat;
  /**
   * Subnets routed behind this LAN.
   */
  routedSubnets?: MagicSiteLanRoutedSubnet[];
  /**
   * Static addressing configuration; omit to use DHCP.
   */
  staticAddressing?: MagicSiteLanStaticAddressing;
  /**
   * Bond identifier when the LAN is part of a link bond.
   */
  bondId?: number;
}

export interface MagicSiteLanAttributes {
  /** Cloudflare-assigned identifier of the LAN. */
  lanId: string;
  /** The site the LAN belongs to. */
  siteId: string;
  /** The Cloudflare account the LAN belongs to. */
  accountId: string;
  /** The name of the LAN. */
  name: string;
  /** The physical port number. */
  physport: number | undefined;
  /** The VLAN ID (zero for untagged). */
  vlanTag: number | undefined;
  /** Whether this LAN is the HA probing link. */
  haLink: boolean | undefined;
}

export type MagicSiteLan = Resource<
  TypeId,
  MagicSiteLanProps,
  MagicSiteLanAttributes,
  never,
  Providers
>;

/**
 * A LAN attached to a Magic WAN site — describes a local network segment
 * behind a Magic WAN Connector port (VLAN, addressing, routed subnets,
 * NAT).
 *
 * Requires a Magic WAN subscription — accounts without it receive a typed
 * `MagicWanUnauthorized` error (Cloudflare code 1025).
 *
 * `siteId` and `haLink` are create-only — changing either triggers a
 * replacement. Everything else is updated in place.
 * @resource
 * @product Magic Transit
 * @category Network
 * @section Creating a LAN
 * @example Untagged LAN with DHCP
 * ```typescript
 * const lan = yield* Cloudflare.MagicTransit.MagicSiteLan("hq-lan", {
 *   siteId: site.siteId,
 *   physport: 2,
 *   vlanTag: 0,
 * });
 * ```
 *
 * @example LAN with static addressing and a routed subnet
 * ```typescript
 * const lan = yield* Cloudflare.MagicTransit.MagicSiteLan("hq-lan", {
 *   siteId: site.siteId,
 *   physport: 2,
 *   vlanTag: 10,
 *   staticAddressing: { address: "192.168.10.1/24" },
 *   routedSubnets: [
 *     { prefix: "10.10.0.0/24", nextHop: "192.168.10.254" },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-wan/configuration/connector/
 */
export const MagicSiteLan = Resource<MagicSiteLan>(TypeId);

/**
 * Returns true if the given value is a MagicSiteLan resource.
 */
export const isMagicSiteLan = (value: unknown): value is MagicSiteLan =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const MagicSiteLanProvider = () =>
  Provider.succeed(MagicSiteLan, {
    stables: ["lanId", "siteId", "accountId"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return undefined;
      // LANs cannot move between sites.
      if (
        typeof olds.siteId === "string" &&
        typeof news.siteId === "string" &&
        olds.siteId !== news.siteId
      ) {
        return { action: "replace" } as const;
      }
      // ha_link is create-only — the update API has no such field.
      if ((olds.haLink ?? false) !== (news.haLink ?? false)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const siteId =
        output?.siteId ??
        (typeof olds?.siteId === "string" ? olds.siteId : undefined);
      if (!siteId) return undefined;

      if (output?.lanId) {
        const observed = yield* getLan(acct, siteId, output.lanId);
        if (observed) return toAttributes(observed, siteId, acct);
      }
      // Cold read — match the deterministic physical name. LANs carry no
      // ownership markers; report as Unowned so takeover is gated behind
      // the adopt policy.
      const name = yield* createLanName(id, olds?.name);
      const observed = yield* findByName(acct, siteId, name);
      if (observed) return Unowned(toAttributes(observed, siteId, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const siteId = news.siteId as string;
      const name = yield* createLanName(id, news.name);

      // Observe — the id on `output` is a hint; fall back to a name scan.
      let observed = output?.lanId
        ? yield* getLan(accountId, siteId, output.lanId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, siteId, name);
      }

      // Ensure — create when missing. The create API returns the site's
      // LAN list; pick the created LAN by name.
      if (!observed) {
        const created = yield* magicTransit.createSiteLan({
          accountId,
          siteId,
          name,
          physport: news.physport,
          vlanTag: news.vlanTag,
          haLink: news.haLink,
          isBreakout: news.isBreakout,
          isPrioritized: news.isPrioritized,
          nat: news.nat,
          routedSubnets: news.routedSubnets,
          staticAddressing: news.staticAddressing,
          bondId: news.bondId,
        });
        observed =
          created.result.find((lan) => lan.name === name) ??
          created.result.at(0);
        if (!observed) {
          // Defensive: converge via the list if the create response shape
          // is unexpected.
          observed = yield* findByName(accountId, siteId, name);
        }
        if (observed) return toAttributes(observed, siteId, accountId);
        return yield* Effect.fail(
          new Error(`Magic WAN site LAN ${name} not visible after create`),
        );
      }

      // Sync — the update API is a PUT; send the full desired state, but
      // skip the call entirely on a no-op of the observable fields.
      const dirty =
        (observed.name ?? undefined) !== name ||
        (observed.physport ?? undefined) !== news.physport ||
        (news.vlanTag !== undefined &&
          (observed.vlanTag ?? undefined) !== news.vlanTag) ||
        (news.isBreakout !== undefined &&
          (observed.isBreakout ?? false) !== news.isBreakout) ||
        (news.isPrioritized !== undefined &&
          (observed.isPrioritized ?? false) !== news.isPrioritized) ||
        (news.nat !== undefined &&
          (observed.nat?.staticPrefix ?? undefined) !==
            news.nat.staticPrefix) ||
        (news.routedSubnets !== undefined &&
          !sameRoutedSubnets(observed.routedSubnets, news.routedSubnets)) ||
        (news.staticAddressing !== undefined &&
          (observed.staticAddressing?.address ?? undefined) !==
            news.staticAddressing.address) ||
        (news.bondId !== undefined &&
          (observed.bondId ?? undefined) !== news.bondId);
      if (dirty) {
        const updated = yield* magicTransit.updateSiteLan({
          accountId,
          siteId,
          lanId: observed.id!,
          name,
          physport: news.physport,
          vlanTag: news.vlanTag,
          isBreakout: news.isBreakout,
          isPrioritized: news.isPrioritized,
          nat: news.nat,
          routedSubnets: news.routedSubnets,
          staticAddressing: news.staticAddressing,
          bondId: news.bondId,
        });
        observed = { ...updated, id: updated.id ?? observed.id };
      }

      return toAttributes(observed, siteId, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* magicTransit
        .deleteSiteLan({
          accountId: output.accountId,
          siteId: output.siteId,
          lanId: output.lanId,
        })
        .pipe(Effect.catchTag("SiteLanNotFound", () => Effect.void));
    }),

    // LANs are sub-resources keyed by their parent Magic WAN site, which is
    // not enumerable by LAN. Fan out: list every account-scoped site, then
    // exhaustively paginate the LANs of each site (bounded concurrency) and
    // hydrate into the same Attributes shape `read` returns. Accounts (or
    // individual sites) without Magic WAN entitlement reject with the typed
    // `MagicWanUnauthorized` (Cloudflare code 1025) — nothing to enumerate,
    // so skip → [].
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const siteIds = yield* magicTransit.listSites.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .map((site) => site.id)
              .filter((id): id is string => typeof id === "string"),
          ),
        ),
        Effect.catchTag("MagicWanUnauthorized", () =>
          Effect.succeed([] as string[]),
        ),
      );

      const rows = yield* Effect.forEach(
        siteIds,
        (siteId) =>
          magicTransit.listSiteLans.pages({ accountId, siteId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((lan) =>
                  toAttributes(lan, siteId, accountId),
                ),
              ),
            ),
            Effect.catchTag("MagicWanUnauthorized", () =>
              Effect.succeed([] as MagicSiteLanAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );

      return rows.flat();
    }),
  });

interface ObservedLan {
  id?: string | null;
  name?: string | null;
  physport?: number | null;
  vlanTag?: number | null;
  haLink?: boolean | null;
  isBreakout?: boolean | null;
  isPrioritized?: boolean | null;
  nat?: { staticPrefix?: string | null } | null;
  routedSubnets?:
    | {
        nextHop: string;
        prefix: string;
        nat?: { staticPrefix?: string | null } | null;
      }[]
    | null;
  staticAddressing?: { address: string } | null;
  bondId?: number | null;
}

/**
 * Read a LAN by id, mapping "gone" (`SiteLanNotFound`, HTTP 404) to
 * `undefined`.
 */
const getLan = (accountId: string, siteId: string, lanId: string) =>
  magicTransit.getSiteLan({ accountId, siteId, lanId }).pipe(
    Effect.map((lan): ObservedLan | undefined => lan),
    Effect.catchTag("SiteLanNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a LAN by exact name within a site. Names are not enforced unique;
 * pick the first match deterministically by id.
 */
const findByName = (accountId: string, siteId: string, name: string) =>
  magicTransit.listSiteLans({ accountId, siteId }).pipe(
    Effect.map((r): ObservedLan | undefined =>
      r.result
        .filter((lan) => lan.name === name)
        .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
        .at(0),
    ),
  );

const createLanName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const sameRoutedSubnets = (
  observed: ObservedLan["routedSubnets"],
  desired: MagicSiteLanRoutedSubnet[],
): boolean => {
  const key = (s: { prefix: string; nextHop: string }) =>
    `${s.prefix}>${s.nextHop}`;
  return (
    [...(observed ?? [])].map(key).sort().join(",") ===
    [...desired].map(key).sort().join(",")
  );
};

const toAttributes = (
  lan: ObservedLan,
  siteId: string,
  accountId: string,
): MagicSiteLanAttributes => ({
  lanId: lan.id ?? "",
  siteId,
  accountId,
  name: lan.name ?? "",
  physport: lan.physport ?? undefined,
  vlanTag: lan.vlanTag ?? undefined,
  haLink: lan.haLink ?? undefined,
});
