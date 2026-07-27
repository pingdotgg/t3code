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

const TypeId = "Cloudflare.MagicTransit.Site" as const;
type TypeId = typeof TypeId;

/**
 * Geographic location of a Magic WAN site.
 */
export interface MagicSiteLocation {
  /** Latitude of the site. */
  lat?: string;
  /** Longitude of the site. */
  lon?: string;
}

export interface MagicSiteProps {
  /**
   * The name of the site. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * An optional description of the site.
   */
  description?: string;
  /**
   * Magic WAN Connector identifier tag to associate with this site.
   */
  connectorId?: string;
  /**
   * Secondary Magic WAN Connector identifier tag. Used when high
   * availability mode is on.
   */
  secondaryConnectorId?: string;
  /**
   * Site high availability mode. If true, the site can have two connectors
   * and runs in high availability mode. Create-only — changing it triggers
   * a replacement.
   * @default false
   */
  haMode?: boolean;
  /**
   * Location of the site in latitude and longitude.
   */
  location?: MagicSiteLocation;
}

export interface MagicSiteAttributes {
  /** Cloudflare-assigned identifier of the site. */
  siteId: string;
  /** The Cloudflare account the site belongs to. */
  accountId: string;
  /** The name of the site. */
  name: string;
  /** The site description, if set. */
  description: string | undefined;
  /** The associated connector id, if set. */
  connectorId: string | undefined;
  /** The associated secondary connector id, if set. */
  secondaryConnectorId: string | undefined;
  /** Whether the site runs in high availability mode. */
  haMode: boolean | undefined;
  /** Location of the site, if set. */
  location: MagicSiteLocation | undefined;
}

export type MagicSite = Resource<
  TypeId,
  MagicSiteProps,
  MagicSiteAttributes,
  never,
  Providers
>;

/**
 * A Magic WAN site — represents a physical or logical network location
 * (typically backed by a Magic WAN Connector appliance) under which LANs,
 * WANs, and ACLs are configured.
 *
 * Requires a Magic WAN subscription — accounts without it receive a typed
 * `MagicWanUnauthorized` error (Cloudflare code 1025).
 *
 * `haMode` is create-only — changing it triggers a replacement. Everything
 * else is updated in place.
 * @resource
 * @product Magic Transit
 * @category Network
 * @section Creating a site
 * @example Basic site
 * ```typescript
 * const site = yield* Cloudflare.MagicTransit.MagicSite("hq", {
 *   description: "Headquarters",
 *   location: { lat: "37.7749", lon: "-122.4194" },
 * });
 * ```
 *
 * @example Site with LAN and WAN
 * ```typescript
 * const site = yield* Cloudflare.MagicTransit.MagicSite("hq", {});
 *
 * const wan = yield* Cloudflare.MagicTransit.MagicSiteWan("hq-wan", {
 *   siteId: site.siteId,
 *   physport: 1,
 * });
 *
 * const lan = yield* Cloudflare.MagicTransit.MagicSiteLan("hq-lan", {
 *   siteId: site.siteId,
 *   physport: 2,
 *   vlanTag: 0,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-wan/configuration/connector/
 */
export const MagicSite = Resource<MagicSite>(TypeId);

/**
 * Returns true if the given value is a MagicSite resource.
 */
export const isMagicSite = (value: unknown): value is MagicSite =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const MagicSiteProvider = () =>
  Provider.succeed(MagicSite, {
    stables: ["siteId", "accountId", "haMode"],

    // Account collection — Magic WAN sites are account-scoped and enumerated
    // via the paginated list API. Accounts without a Magic WAN subscription
    // reject with the typed `MagicWanUnauthorized` (code 1025) → return [].
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* magicTransit.listSites.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((site) => toAttributes(site, accountId)),
          ),
        ),
        Effect.catchTag("MagicWanUnauthorized", () =>
          Effect.succeed<MagicSiteAttributes[]>([]),
        ),
      );
    }),

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return undefined;
      // haMode is create-only — the update API has no such field.
      if ((olds.haMode ?? false) !== (news.haMode ?? false)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.siteId) {
        const observed = yield* getSite(acct, output.siteId);
        if (observed) return toAttributes(observed, acct);
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Sites carry no ownership markers; report as
      // Unowned so takeover is gated behind the adopt policy.
      const name = yield* createSiteName(id, olds?.name);
      const observed = yield* findByName(acct, name);
      if (observed) return Unowned(toAttributes(observed, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createSiteName(id, news.name);
      // Inputs have been resolved to concrete strings by Plan.
      const connectorId = news.connectorId as string | undefined;
      const secondaryConnectorId = news.secondaryConnectorId as
        | string
        | undefined;

      // Observe — the id on `output` is a hint; fall back to a name scan.
      let observed = output?.siteId
        ? yield* getSite(accountId, output.siteId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // Ensure — create when missing.
      if (!observed) {
        const created = yield* magicTransit.createSite({
          accountId,
          name,
          description: news.description,
          connectorId,
          secondaryConnectorId,
          haMode: news.haMode,
          location: news.location,
        });
        return toAttributes(
          { ...created, id: created.id ?? undefined },
          accountId,
        );
      }

      // Sync — diff observed cloud state against desired; skip on no-op.
      const dirty =
        (observed.name ?? undefined) !== name ||
        (news.description !== undefined &&
          (observed.description ?? undefined) !== news.description) ||
        (connectorId !== undefined &&
          (observed.connectorId ?? undefined) !== connectorId) ||
        (secondaryConnectorId !== undefined &&
          (observed.secondaryConnectorId ?? undefined) !==
            secondaryConnectorId) ||
        locationDirty(observed.location, news.location);
      if (dirty) {
        const updated = yield* magicTransit.updateSite({
          accountId,
          siteId: observed.id!,
          name,
          description: news.description,
          connectorId,
          secondaryConnectorId,
          location: news.location,
        });
        observed = { ...updated, id: updated.id ?? observed.id };
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* magicTransit
        .deleteSite({
          accountId: output.accountId,
          siteId: output.siteId,
        })
        .pipe(Effect.catchTag("SiteNotFound", () => Effect.void));
    }),
  });

interface ObservedSite {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  connectorId?: string | null;
  secondaryConnectorId?: string | null;
  haMode?: boolean | null;
  location?: { lat?: string | null; lon?: string | null } | null;
}

/**
 * Read a site by id, mapping "gone" (`SiteNotFound`, HTTP 404) to
 * `undefined`.
 */
const getSite = (accountId: string, siteId: string) =>
  magicTransit.getSite({ accountId, siteId }).pipe(
    Effect.map((s): ObservedSite | undefined => s),
    Effect.catchTag("SiteNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a site by exact name. Site names are not enforced unique on
 * Cloudflare's side, so pick the first match deterministically by id.
 */
const findByName = (accountId: string, name: string) =>
  magicTransit.listSites({ accountId }).pipe(
    Effect.map((r): ObservedSite | undefined =>
      r.result
        .filter((s) => s.name === name)
        .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
        .at(0),
    ),
  );

const createSiteName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const locationDirty = (
  observed: ObservedSite["location"],
  desired: MagicSiteLocation | undefined,
): boolean => {
  if (desired === undefined) return false;
  return (
    (desired.lat !== undefined &&
      (observed?.lat ?? undefined) !== desired.lat) ||
    (desired.lon !== undefined && (observed?.lon ?? undefined) !== desired.lon)
  );
};

const toAttributes = (
  site: ObservedSite,
  accountId: string,
): MagicSiteAttributes => ({
  siteId: site.id ?? "",
  accountId,
  name: site.name ?? "",
  description: site.description ?? undefined,
  connectorId: site.connectorId ?? undefined,
  secondaryConnectorId: site.secondaryConnectorId ?? undefined,
  haMode: site.haMode ?? undefined,
  location: site.location
    ? {
        lat: site.location.lat ?? undefined,
        lon: site.location.lon ?? undefined,
      }
    : undefined,
});
