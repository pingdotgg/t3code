import * as emailAuth from "@distilled.cloud/cloudflare/email-auth";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type Reference } from "../Zone/index.ts";
import { listAllZones } from "../Zone/lookup.ts";

export type DmarcReportsStatus =
  | "missing-dmarc-report"
  | "multiple-dmarc-reports"
  | "missing-dmarc-rua"
  | "cname-on-dmarc-record"
  | "unauthorized-reporting-domain";

export type DmarcReportsProps = {
  /**
   * Apex zone to manage DMARC reports for. Accepts a zone id, a zone name
   * (`example.com`), or a `{ zoneId, name? }` object. The zone's DNS must be
   * hosted on Cloudflare. Changing the zone replaces the resource.
   */
  zone: Reference;
  /**
   * Whether DMARC reports are enabled on the zone. Enabling makes
   * Cloudflare add its RUA address to the zone's `_dmarc` record.
   *
   * @default true
   */
  enabled?: boolean;
};

export type DmarcReports = Resource<
  "Cloudflare.Email.DmarcReports",
  DmarcReportsProps,
  {
    /** Zone identifier. */
    zoneId: string;
    /** Whether DMARC reports are enabled on the zone. */
    enabled: boolean;
    /**
     * Prefix of the Cloudflare RUA address that receives aggregate reports
     * (32-char hex string).
     */
    ruaPrefix: string | undefined;
    /**
     * DMARC configuration problem, if any. `undefined` when DMARC is
     * correctly configured.
     */
    status: DmarcReportsStatus | undefined;
  },
  never,
  Providers
>;

type DmarcReportsAttributes = DmarcReports["Attributes"];

const toAttributes = (
  zoneId: string,
  result: emailAuth.GetDmarcReportResponse,
): DmarcReportsAttributes => ({
  zoneId,
  enabled: result.enabled ?? false,
  ruaPrefix: result.ruaPrefix ?? undefined,
  status: result.status ?? undefined,
});

/**
 * Enables Cloudflare [DMARC Management](https://developers.cloudflare.com/dmarc-management/)
 * on an apex zone. Cloudflare receives the zone's aggregate DMARC reports
 * and shows which sources send mail as your domain.
 *
 * Enabling adds Cloudflare's RUA address to the zone's `_dmarc` TXT record
 * (creating the record when it is missing). Disabling or destroying the
 * resource only turns reporting off; it never deletes the zone or any DNS
 * record.
 *
 * ### Enabling DMARC reports
 * **Example:** Enable on a zone you own
 * ```typescript
 * const dmarc = yield* Cloudflare.Email.DmarcReports("Dmarc", {
 *   zone: "example.com",
 * });
 * ```
 *
 * **Example:** Keep the resource but turn reporting off
 * ```typescript
 * const dmarc = yield* Cloudflare.Email.DmarcReports("Dmarc", {
 *   zone: "example.com",
 *   enabled: false,
 * });
 * ```
 *
 * @resource
 * @product Email
 * @category Email
 */
export const DmarcReports = Resource<DmarcReports>("Cloudflare.Email.DmarcReports");

const resolve = Effect.fn(function* (zone: Reference) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* resolveZoneId({
    accountId,
    zone,
    hostname: typeof zone === "string" ? zone : (zone.name ?? ""),
  });
});

export const DmarcReportsProvider = () =>
  Provider.succeed(DmarcReports, {
    nuke: { singleton: true },
    stables: ["zoneId"],
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // DMARC report settings are a per-zone singleton with no account-wide
      // enumeration API: read the settings in every zone.
      const allZones = yield* listAllZones(accountId);
      return yield* Effect.forEach(
        allZones,
        (zone) =>
          emailAuth
            .getDmarcReport({ zoneId: zone.id })
            .pipe(Effect.map((result) => toAttributes(zone.id, result))),
        { concurrency: 10 },
      );
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!output) return undefined;
      if (!isResolved(news)) return undefined;
      const zoneId = yield* resolve(news.zone);
      if (zoneId !== output.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output?.zoneId) return undefined;
      const result = yield* emailAuth.getDmarcReport({
        zoneId: output.zoneId,
      });
      return toAttributes(output.zoneId, result);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const zoneId = output?.zoneId ?? (yield* resolve(news.zone));
      const desired = news.enabled ?? true;

      // Observe — the zone's settings always exist; only `enabled` is ours.
      const observed = yield* emailAuth.getDmarcReport({ zoneId });
      if ((observed.enabled ?? false) === desired) {
        return toAttributes(zoneId, observed);
      }

      // Sync — enabling also makes Cloudflare upsert the RUA address into
      // the `_dmarc` record; that DNS side effect is expected.
      const result = yield* emailAuth.patchDmarcReport({
        zoneId,
        enabled: desired,
      });
      return toAttributes(zoneId, result);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Only turn reporting off. Never touch the zone or its DNS records.
      const observed = yield* emailAuth.getDmarcReport({
        zoneId: output.zoneId,
      });
      if (!observed.enabled) return;
      yield* emailAuth.patchDmarcReport({
        zoneId: output.zoneId,
        enabled: false,
      });
    }),
  });
