import * as rum from "@distilled.cloud/cloudflare/rum";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Rum.Site" as const;
type TypeId = typeof TypeId;

export type SiteProps = {
  /**
   * The hostname to measure, for gray-clouded sites (sites that are not
   * proxied through Cloudflare). Embed the produced `snippet` (or the
   * `siteToken`) in the page yourself.
   *
   * Exactly one of `host` or `zoneTag` must be provided. Switching between
   * the two identity models triggers a replacement; changing the hostname
   * itself is an in-place update.
   */
  host?: string;
  /**
   * The zone identifier, for orange-clouded sites (zones proxied through
   * Cloudflare). Web Analytics attaches to the zone, and `autoInstall` can
   * inject the measurement snippet at the edge. Changing this property
   * triggers a replacement.
   */
  zoneTag?: string;
  /**
   * If enabled, the JavaScript measurement snippet is automatically
   * injected for orange-clouded sites — no manual embed needed.
   * @default false
   */
  autoInstall?: boolean;
  /**
   * Enables or disables RUM measurement. Only valid when `autoInstall` is
   * `true`.
   * @default true
   */
  enabled?: boolean;
  /**
   * If enabled, the JavaScript snippet will not be injected for visitors
   * from the EU.
   * @default false
   */
  lite?: boolean;
};

export type SiteAttributes = {
  /**
   * The Web Analytics site identifier. Stable for the lifetime of the site.
   */
  siteTag: string;
  /**
   * The Web Analytics site token used by the JavaScript beacon.
   */
  siteToken: string;
  /**
   * Encoded JavaScript snippet to embed in pages of gray-clouded sites.
   */
  snippet: string | undefined;
  /**
   * The identifier of the site's implicit ruleset. Rules that include or
   * exclude traffic from measurement live under this ruleset.
   */
  rulesetId: string | undefined;
  /**
   * The Cloudflare account the site belongs to.
   */
  accountId: string;
  /**
   * The measured hostname (gray-clouded sites only).
   */
  host: string | undefined;
  /**
   * The zone identifier (orange-clouded sites only).
   */
  zoneTag: string | undefined;
  /**
   * Whether the JavaScript snippet is automatically injected for
   * orange-clouded sites.
   */
  autoInstall: boolean;
  /**
   * When the site was created.
   */
  created: string | undefined;
};

export type Site = Resource<
  TypeId,
  SiteProps,
  SiteAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Web Analytics (RUM) site.
 *
 * A site measures real-user performance for either a plain hostname
 * (gray-clouded — embed the produced `snippet` yourself) or a Cloudflare
 * zone (orange-clouded — set `autoInstall` to inject the snippet at the
 * edge). The site is identified by its auto-assigned `siteTag`; `host` and
 * `autoInstall` are mutable in place, while switching between `host` and
 * `zoneTag` identity models (or changing `zoneTag`) triggers a replacement.
 *
 * Web Analytics is available on free accounts.
 * @resource
 * @product RUM
 * @category Observability & Analytics
 * @section Measuring a hostname
 * @example Gray-clouded site (manual snippet embed)
 * ```typescript
 * const site = yield* Cloudflare.Rum.Site("Analytics", {
 *   host: "example.com",
 * });
 *
 * // Embed in your HTML — contains the site token:
 * const snippet = site.snippet;
 * ```
 *
 * @section Measuring a zone
 * @example Orange-clouded site with automatic snippet injection
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Zone", { name: "example.com" });
 *
 * yield* Cloudflare.Rum.Site("ZoneAnalytics", {
 *   zoneTag: zone.zoneId,
 *   autoInstall: true,
 * });
 * ```
 *
 * @example Skip injection for EU visitors
 * ```typescript
 * yield* Cloudflare.Rum.Site("ZoneAnalytics", {
 *   zoneTag: zone.zoneId,
 *   autoInstall: true,
 *   lite: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/web-analytics/
 */
export const Site = Resource<Site>(TypeId);

/**
 * Returns true if the given value is a Site resource.
 */
export const isSite = (value: unknown): value is Site =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SiteProvider = () =>
  Provider.succeed(Site, {
    stables: ["siteTag", "siteToken", "accountId", "rulesetId", "created"],

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const o = olds as SiteProps;
      const n = news as SiteProps;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Switching between host-based (gray-clouded) and zone-based
      // (orange-clouded) measurement changes the site's identity model.
      if ((o.zoneTag === undefined) !== (n.zoneTag === undefined)) {
        return { action: "replace" } as const;
      }
      // zoneTag is Input<string>; compare only once both are concrete.
      if (
        typeof o.zoneTag === "string" &&
        typeof n.zoneTag === "string" &&
        o.zoneTag !== n.zoneTag
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by our persisted site tag.
      if (output?.siteTag) {
        const observed = yield* getSite(acct, output.siteTag);
        if (observed) return toAttributes(observed, acct);
      }

      // Adoption path: a site measuring the same host/zone may already
      // exist. Web Analytics sites carry no ownership markers (and
      // Cloudflare happily creates duplicates), so we cannot prove we
      // created it — brand it `Unowned` so the engine refuses to take
      // over unless `adopt` is set.
      const host = output?.host ?? olds?.host;
      const zoneTag =
        output?.zoneTag ??
        (typeof olds?.zoneTag === "string" ? olds.zoneTag : undefined);
      if (host !== undefined || zoneTag !== undefined) {
        const match = yield* findSite(acct, host, zoneTag);
        if (match) return Unowned(toAttributes(match, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const zoneTag = news.zoneTag as string | undefined;

      // 1. Observe — the siteTag cached on `output` is a hint, not a
      //    guarantee: a missing site falls through to create.
      let observed = output?.siteTag
        ? yield* getSite(output.accountId ?? accountId, output.siteTag)
        : undefined;

      // 2. Ensure — create when missing. Cloudflare allows duplicate
      //    sites for the same host/zone, so there is no AlreadyExists
      //    race to tolerate. The create response omits `snippet` and
      //    `ruleset`, so re-read the full site state afterwards (riding
      //    out read-after-write lag on the freshly minted siteTag).
      if (!observed) {
        const created = yield* rum.createSiteInfo({
          accountId,
          host: news.host,
          zoneTag,
          autoInstall: news.autoInstall,
        });
        const siteTag = created.siteTag ?? "";
        observed = yield* rum.getSiteInfo({ accountId, siteId: siteTag }).pipe(
          Effect.retry({
            while: (e) => e._tag === "SiteNotFound",
            schedule: Schedule.exponential("250 millis"),
            times: 5,
          }),
        );
        // Greenfield with no post-create settings to apply — done.
        if (news.enabled === undefined && news.lite === undefined) {
          return toAttributes(observed, accountId);
        }
      }

      // 3. Sync — diff observed cloud state against desired. The update
      //    API is a PUT that requires the full body (host/zoneTag/
      //    autoInstall must be re-sent). `enabled` and `lite` are write-
      //    only (never echoed back by the API), so they are applied
      //    whenever specified — observation cannot prove them converged.
      const dirty =
        (news.host !== undefined && observed.host !== news.host) ||
        (observed.autoInstall ?? false) !== (news.autoInstall ?? false) ||
        news.enabled !== undefined ||
        news.lite !== undefined;
      if (!dirty) {
        return toAttributes(observed, accountId);
      }

      const updated = yield* rum.updateSiteInfo({
        accountId,
        siteId: observed.siteTag ?? "",
        host: news.host,
        zoneTag,
        autoInstall: news.autoInstall,
        enabled: news.enabled,
        lite: news.lite,
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* rum
        .deleteSiteInfo({
          accountId: output.accountId,
          siteId: output.siteTag,
        })
        .pipe(Effect.catchTag("SiteNotFound", () => Effect.void));
    }),

    // Account collection: Web Analytics sites are enumerated account-wide
    // via the paginated site-info list. Hydrate each row into the exact
    // `read` Attributes shape — the list response carries the same fields
    // (siteTag/siteToken/snippet/ruleset/host) so no per-item re-read is
    // needed.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* rum.listSiteInfos.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((site) => toAttributes(site, accountId)),
          ),
        ),
      );
    }),
  });

type ObservedSite =
  | rum.GetSiteInfoResponse
  | rum.UpdateSiteInfoResponse
  | rum.ListSiteInfosResponse["result"][number];

/**
 * Read a site by tag, mapping "gone" (`SiteNotFound`, Cloudflare error code
 * 10015 `web_analytics.configuration.api.notFound`) to `undefined`.
 */
const getSite = (accountId: string, siteTag: string) =>
  rum.getSiteInfo({ accountId, siteId: siteTag }).pipe(
    Effect.map((site): ObservedSite | undefined => site),
    Effect.catchTag("SiteNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a site measuring the given host (gray-clouded) or zone
 * (orange-clouded). Cloudflare allows several sites for the same target, so
 * pick the oldest for determinism.
 */
const findSite = (
  accountId: string,
  host: string | undefined,
  zoneTag: string | undefined,
) =>
  rum.listSiteInfos.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter(
          (site) =>
            (host !== undefined && site.host === host) ||
            (zoneTag !== undefined && site.ruleset?.zoneTag === zoneTag),
        )
        .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""))
        .at(0),
    ),
  );

const toAttributes = (
  site: ObservedSite,
  accountId: string,
): SiteAttributes => ({
  siteTag: site.siteTag ?? "",
  siteToken: site.siteToken ?? "",
  snippet: site.snippet ?? undefined,
  rulesetId: site.ruleset?.id ?? undefined,
  accountId,
  host: site.host ?? undefined,
  zoneTag: site.ruleset?.zoneTag ?? undefined,
  autoInstall: site.autoInstall ?? false,
  created: site.created ?? undefined,
});
