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

const TypeId = "Cloudflare.MagicTransit.SiteWan" as const;
type TypeId = typeof TypeId;

/**
 * Static addressing configuration for a Magic WAN site WAN — omit to use
 * DHCP. Submit `secondaryAddress` when the site is in high availability
 * mode.
 */
export interface MagicSiteWanStaticAddressing {
  /** A valid CIDR notation representing the WAN address. */
  address: string;
  /** A valid IPv4 address for the WAN gateway. */
  gatewayAddress: string;
  /** Secondary address, required when the site is in HA mode. */
  secondaryAddress?: string;
}

export interface MagicSiteWanProps {
  /**
   * The site this WAN belongs to. Changing it triggers a replacement.
   */
  siteId: string;
  /**
   * The physical port number on the connector this WAN is attached to.
   */
  physport: number;
  /**
   * The name of the WAN. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Priority of the WAN for traffic load balancing. Lower is preferred.
   */
  priority?: number;
  /**
   * VLAN ID. Use zero for untagged.
   * @default 0
   */
  vlanTag?: number;
  /**
   * Static addressing configuration; omit to use DHCP.
   */
  staticAddressing?: MagicSiteWanStaticAddressing;
}

export interface MagicSiteWanAttributes {
  /** Cloudflare-assigned identifier of the WAN. */
  wanId: string;
  /** The site the WAN belongs to. */
  siteId: string;
  /** The Cloudflare account the WAN belongs to. */
  accountId: string;
  /** The name of the WAN. */
  name: string;
  /** The physical port number. */
  physport: number | undefined;
  /** Priority of the WAN for traffic load balancing. */
  priority: number | undefined;
  /** The VLAN ID (zero for untagged). */
  vlanTag: number | undefined;
  /** Magic WAN health-check rate for tunnels created on this link. */
  healthCheckRate: string | undefined;
}

export type MagicSiteWan = Resource<
  TypeId,
  MagicSiteWanProps,
  MagicSiteWanAttributes,
  never,
  Providers
>;

/**
 * A WAN attached to a Magic WAN site — describes an uplink on a Magic WAN
 * Connector port (addressing, VLAN, load-balancing priority). Cloudflare
 * automatically creates IPsec tunnels over each WAN.
 *
 * Requires a Magic WAN subscription — accounts without it receive a typed
 * `MagicWanUnauthorized` error (Cloudflare code 1025).
 *
 * `siteId` is create-only — changing it triggers a replacement. Everything
 * else is updated in place.
 * @resource
 * @product Magic Transit
 * @category Network
 * @section Creating a WAN
 * @example DHCP uplink
 * ```typescript
 * const wan = yield* Cloudflare.MagicTransit.MagicSiteWan("hq-wan", {
 *   siteId: site.siteId,
 *   physport: 1,
 * });
 * ```
 *
 * @example Static uplink with priority
 * ```typescript
 * const wan = yield* Cloudflare.MagicTransit.MagicSiteWan("hq-wan", {
 *   siteId: site.siteId,
 *   physport: 1,
 *   priority: 10,
 *   staticAddressing: {
 *     address: "203.0.113.10/24",
 *     gatewayAddress: "203.0.113.1",
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-wan/configuration/connector/
 */
export const MagicSiteWan = Resource<MagicSiteWan>(TypeId);

/**
 * Returns true if the given value is a MagicSiteWan resource.
 */
export const isMagicSiteWan = (value: unknown): value is MagicSiteWan =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const MagicSiteWanProvider = () =>
  Provider.succeed(MagicSiteWan, {
    stables: ["wanId", "siteId", "accountId"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return undefined;
      // WANs cannot move between sites.
      if (
        typeof olds.siteId === "string" &&
        typeof news.siteId === "string" &&
        olds.siteId !== news.siteId
      ) {
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

      if (output?.wanId) {
        const observed = yield* getWan(acct, siteId, output.wanId);
        if (observed) return toAttributes(observed, siteId, acct);
      }
      // Cold read — match the deterministic physical name. WANs carry no
      // ownership markers; report as Unowned so takeover is gated behind
      // the adopt policy.
      const name = yield* createWanName(id, olds?.name);
      const observed = yield* findByName(acct, siteId, name);
      if (observed) return Unowned(toAttributes(observed, siteId, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const siteId = news.siteId as string;
      const name = yield* createWanName(id, news.name);

      // Observe — the id on `output` is a hint; fall back to a name scan.
      let observed = output?.wanId
        ? yield* getWan(accountId, siteId, output.wanId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, siteId, name);
      }

      // Ensure — create when missing. The create API returns the site's
      // WAN list; pick the created WAN by name.
      if (!observed) {
        const created = yield* magicTransit.createSiteWan({
          accountId,
          siteId,
          name,
          physport: news.physport,
          priority: news.priority,
          vlanTag: news.vlanTag,
          staticAddressing: news.staticAddressing,
        });
        observed =
          created.result.find((wan) => wan.name === name) ??
          created.result.at(0) ??
          (yield* findByName(accountId, siteId, name));
        if (observed) return toAttributes(observed, siteId, accountId);
        return yield* Effect.fail(
          new Error(`Magic WAN site WAN ${name} not visible after create`),
        );
      }

      // Sync — the update API is a PUT; send the full desired state, but
      // skip the call entirely on a no-op of the observable fields.
      const dirty =
        (observed.name ?? undefined) !== name ||
        (observed.physport ?? undefined) !== news.physport ||
        (news.priority !== undefined &&
          (observed.priority ?? undefined) !== news.priority) ||
        (news.vlanTag !== undefined &&
          (observed.vlanTag ?? undefined) !== news.vlanTag) ||
        staticAddressingDirty(observed.staticAddressing, news.staticAddressing);
      if (dirty) {
        const updated = yield* magicTransit.updateSiteWan({
          accountId,
          siteId,
          wanId: observed.id!,
          name,
          physport: news.physport,
          priority: news.priority,
          vlanTag: news.vlanTag,
          staticAddressing: news.staticAddressing,
        });
        observed = { ...updated, id: updated.id ?? observed.id };
      }

      return toAttributes(observed, siteId, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* magicTransit
        .deleteSiteWan({
          accountId: output.accountId,
          siteId: output.siteId,
          wanId: output.wanId,
        })
        .pipe(Effect.catchTag("SiteWanNotFound", () => Effect.void));
    }),

    // Parent fan-out: WANs are sub-resources keyed by site, and there is no
    // account-wide WAN enumeration API. Enumerate every Magic site (account
    // scope), then list WANs per site with bounded concurrency, paginating
    // each list exhaustively. Magic WAN-gated accounts (and partial-scope
    // tokens) reject these routes with the typed `MagicWanUnauthorized`
    // (code 1025) / `Forbidden` tags — treat those as "nothing to list".
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const siteIds = yield* magicTransit.listSites.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).flatMap((site) => (site.id ? [site.id] : [])),
          ),
        ),
        Effect.catchTag(["MagicWanUnauthorized", "Forbidden"], () =>
          Effect.succeed([] as string[]),
        ),
      );

      const rows = yield* Effect.forEach(
        siteIds,
        (siteId) =>
          magicTransit.listSiteWans.pages({ accountId, siteId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((wan) =>
                  toAttributes(wan, siteId, accountId),
                ),
              ),
            ),
            // Site vanished or became inaccessible mid-enumeration — skip it.
            Effect.catchTag(["MagicWanUnauthorized", "Forbidden"], () =>
              Effect.succeed([] as MagicSiteWanAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );

      return rows.flat();
    }),
  });

interface ObservedWan {
  id?: string | null;
  name?: string | null;
  physport?: number | null;
  priority?: number | null;
  vlanTag?: number | null;
  healthCheckRate?: string | null;
  staticAddressing?: {
    address: string;
    gatewayAddress: string;
    secondaryAddress?: string | null;
  } | null;
}

/**
 * Read a WAN by id, mapping "gone" (`SiteWanNotFound`, HTTP 404) to
 * `undefined`.
 */
const getWan = (accountId: string, siteId: string, wanId: string) =>
  magicTransit.getSiteWan({ accountId, siteId, wanId }).pipe(
    Effect.map((wan): ObservedWan | undefined => wan),
    Effect.catchTag("SiteWanNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a WAN by exact name within a site. Names are not enforced unique;
 * pick the first match deterministically by id.
 */
const findByName = (accountId: string, siteId: string, name: string) =>
  magicTransit.listSiteWans({ accountId, siteId }).pipe(
    Effect.map((r): ObservedWan | undefined =>
      r.result
        .filter((wan) => wan.name === name)
        .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
        .at(0),
    ),
  );

const createWanName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const staticAddressingDirty = (
  observed: ObservedWan["staticAddressing"],
  desired: MagicSiteWanStaticAddressing | undefined,
): boolean => {
  if (desired === undefined) return false;
  return (
    (observed?.address ?? undefined) !== desired.address ||
    (observed?.gatewayAddress ?? undefined) !== desired.gatewayAddress ||
    (desired.secondaryAddress !== undefined &&
      (observed?.secondaryAddress ?? undefined) !== desired.secondaryAddress)
  );
};

const toAttributes = (
  wan: ObservedWan,
  siteId: string,
  accountId: string,
): MagicSiteWanAttributes => ({
  wanId: wan.id ?? "",
  siteId,
  accountId,
  name: wan.name ?? "",
  physport: wan.physport ?? undefined,
  priority: wan.priority ?? undefined,
  vlanTag: wan.vlanTag ?? undefined,
  healthCheckRate: wan.healthCheckRate ?? undefined,
});
