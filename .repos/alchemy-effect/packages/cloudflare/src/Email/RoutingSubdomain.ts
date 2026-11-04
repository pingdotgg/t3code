import * as dns from "@distilled.cloud/cloudflare/dns";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const RoutingSubdomainTypeId = "Cloudflare.Email.RoutingSubdomain" as const;
type RoutingSubdomainTypeId = typeof RoutingSubdomainTypeId;

export interface RoutingSubdomainProps {
  /**
   * Zone the subdomain belongs to. Email Routing must be enabled on the zone
   * (see {@link Routing}).
   *
   * Stable — moving the subdomain to another zone triggers a replacement.
   */
  zoneId: string;
  /**
   * The fully-qualified subdomain to receive mail on (e.g.
   * `in.example.com`). Must be within the zone.
   *
   * Stable — a rename is a delete + create.
   */
  name: string;
}

export interface RoutingSubdomainAttributes {
  /** Zone the subdomain belongs to. */
  zoneId: string;
  /** The subdomain receiving mail. */
  name: string;
  /** The Email Routing MX hosts the subdomain's records point at. */
  mx: string[];
}

export type RoutingSubdomain = Resource<
  RoutingSubdomainTypeId,
  RoutingSubdomainProps,
  RoutingSubdomainAttributes,
  never,
  Providers
>;

/**
 * Extends Email Routing on a zone to one of its subdomains, so literal
 * routing rules (see {@link Rule}) can match addresses on it, as the
 * dashboard's Email Routing > Settings > Subdomains does. Cloudflare adds and
 * locks the subdomain's MX and SPF records. Catch-all rules stay apex-only.
 *
 * Deleting it unlocks and removes the subdomain's Email Routing records
 * only. It never disables Email Routing on the zone: the zone-level
 * `DELETE /email/routing/dns` takes no subdomain and would turn routing off
 * for the apex too.
 *
 * Safety: Email Routing records carry no ownership markers. When there is no
 * prior state, `read` reports a subdomain that already routes mail as
 * `Unowned`, so the engine refuses to take it over unless `--adopt` (or
 * `adopt(true)`) is set.
 *
 * ### Receiving on a subdomain
 * **Example:** Route `docs@in.example.com` to a Worker
 * ```typescript
 * const routing = yield* Cloudflare.Email.Routing("Routing", {
 *   zone: "example.com",
 * });
 * yield* Cloudflare.Email.RoutingSubdomain("Inbound", {
 *   zoneId: routing.zoneId,
 *   name: "in.example.com",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/email-service/configuration/subdomains/
 *
 * @resource
 * @product Email
 * @category Email
 */
export const RoutingSubdomain = Resource<RoutingSubdomain>(RoutingSubdomainTypeId);

/**
 * Returns true if the given value is a RoutingSubdomain resource.
 */
export const isRoutingSubdomain = (value: unknown): value is RoutingSubdomain =>
  Predicate.hasProperty(value, "Type") && value.Type === RoutingSubdomainTypeId;

export const RoutingSubdomainProvider = () =>
  Provider.succeed(RoutingSubdomain, {
    stables: ["zoneId", "name"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No API lists routing subdomains: a subdomain routes mail when it has
      // Email Routing MX records, so scan each zone's MX records for names
      // other than the apex.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          dns.listRecords.items({ zoneId: zone.id, type: "MX" }).pipe(
            Stream.filter((record) => isRoutingMx(record.content) && record.name !== zone.name),
            Stream.runCollect,
            Effect.map((chunk) => groupByName(zone.id, Array.from(chunk))),
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!output || !isResolved(news)) return undefined;
      if (news.zoneId !== output.zoneId || news.name !== output.name) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? olds?.zoneId;
      const name = output?.name ?? olds?.name;
      if (!zoneId || !name) return undefined;
      const mx = yield* routingMxOf(zoneId, name);
      if (mx.length === 0) return undefined;
      const observed = { zoneId, name, mx };
      return output ? observed : Unowned(observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const zoneId = news.zoneId;
      // Observe, then ensure: a subdomain already routing mail needs nothing.
      const existing = yield* routingMxOf(zoneId, news.name);
      if (existing.length > 0) return { zoneId, name: news.name, mx: existing };
      yield* emailRouting.createDns({ zoneId, name: news.name });
      return { zoneId, name: news.name, mx: yield* routingMxOf(zoneId, news.name) };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, name } = output;
      // Unlock the subdomain's records, then remove the Email Routing ones at
      // this exact name. Idempotent: nothing left to remove is success.
      yield* emailRouting
        .patchDns({ zoneId, name })
        .pipe(Effect.catchTag("EmailRoutingSubdomainNotFound", () => Effect.void));
      const records = yield* dns.listRecords.items({ zoneId, name: { exact: name } }).pipe(
        Stream.filter(
          (record) =>
            (record.type === "MX" && isRoutingMx(record.content)) ||
            (record.type === "TXT" && isRoutingSpf(record.content)),
        ),
        Stream.runCollect,
      );
      yield* Effect.forEach(
        Array.from(records),
        (record) => dns.deleteRecord({ zoneId, dnsRecordId: record.id }),
        { concurrency: 3, discard: true },
      );
    }),
  });

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/** Email Routing's inbound hosts: `route1.mx.cloudflare.net` to `route3`. */
const isRoutingMx = (content: string | null | undefined) =>
  /^route\d+\.mx\.cloudflare\.net\.?$/iu.test(content ?? "");

/** The SPF record Email Routing adds beside its MX records. */
const isRoutingSpf = (content: string | null | undefined) =>
  (content ?? "").includes("include:_spf.mx.cloudflare.net");

const routingMxOf = (zoneId: string, name: string) =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type: "MX" }).pipe(
    Stream.filter((record) => isRoutingMx(record.content)),
    Stream.map((record) => record.content ?? ""),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).sort()),
  );

const groupByName = (
  zoneId: string,
  records: ReadonlyArray<{ readonly name: string; readonly content?: string | null }>,
): RoutingSubdomainAttributes[] => {
  const byName = new Map<string, string[]>();
  for (const record of records) {
    byName.set(record.name, [...(byName.get(record.name) ?? []), record.content ?? ""]);
  }
  return [...byName].map(([name, mx]) => ({ zoneId, name, mx: mx.sort() }));
};
