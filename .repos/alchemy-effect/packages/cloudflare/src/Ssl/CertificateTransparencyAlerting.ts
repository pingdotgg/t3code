import * as zones from "@distilled.cloud/cloudflare/zones";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Ssl.CertificateTransparencyAlerting" as const;
type TypeId = typeof TypeId;

export type CertificateTransparencyAlertingProps = {
  /**
   * Zone whose Certificate Transparency alerting is managed. Stable —
   * changing the zone triggers a replacement (the old zone's subscription
   * is restored to what it was before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Cloudflare emails an alert when a certificate is issued for
   * one of the zone's hostnames. Cloudflare leaves it off for a new zone.
   * @default true
   */
  enabled?: boolean;
  /**
   * Addresses that receive the alerts (at most 100). When omitted, the
   * zone's stored recipients are left as they are.
   */
  emails?: string[];
};

export type CertificateTransparencyAlertingAttributes = {
  /** Zone the subscription belongs to. */
  zoneId: string;
  /** Whether CT alerting is enabled for the zone. */
  enabled: boolean;
  /** The zone's alert recipients. */
  emails: string[];
  /** `enabled` before Alchemy first managed the subscription. */
  initialEnabled: boolean;
  /** `emails` before Alchemy first managed the subscription. */
  initialEmails: string[];
};

export type CertificateTransparencyAlerting = Resource<
  TypeId,
  CertificateTransparencyAlertingProps,
  CertificateTransparencyAlertingAttributes,
  never,
  Providers
>;

/**
 * Certificate Transparency alerting for a Cloudflare zone ("Certificate
 * Transparency Monitoring" in the dashboard, `/zones/{zone_id}/ct/alerting`
 * in the API): Cloudflare watches the public Certificate Transparency logs
 * and emails the listed recipients when a certificate is issued for one of
 * the zone's hostnames. Certificates Cloudflare issues itself are filtered
 * out.
 *
 * The subscription is a zone singleton, so this resource never creates or
 * deletes anything physical. Reconcile patches it when the observed state
 * differs from the props; destroy restores the state observed before
 * Alchemy first managed it.
 * ### Monitoring certificate issuance
 * **Example:** Email the security team on every new certificate
 * ```typescript
 * yield* Cloudflare.Ssl.CertificateTransparencyAlerting("CtAlerting", {
 *   zoneId: zone.zoneId,
 *   emails: ["security@example.com"],
 * });
 * ```
 *
 * **Example:** Turn alerting off for a zone
 * ```typescript
 * yield* Cloudflare.Ssl.CertificateTransparencyAlerting("CtAlerting", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://blog.cloudflare.com/certificate-transparency-monitoring-ga/
 *
 * @resource
 * @product SSL/TLS
 * @category SSL/TLS & Certificates
 */
export const CertificateTransparencyAlerting = Resource<CertificateTransparencyAlerting>(TypeId);

/**
 * Returns true if the given value is a CertificateTransparencyAlerting resource.
 */
export const isCertificateTransparencyAlerting = (
  value: unknown,
): value is CertificateTransparencyAlerting =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

const observe = (zoneId: string) =>
  zones.getCtAlerting({ zoneId }).pipe(Effect.catchTag("InvalidRoute", () => Effect.undefined));

const recipients = (
  observed: zones.GetCtAlertingResponse | zones.PatchCtAlertingResponse,
): string[] => [...(observed.emails ?? [])];

const sameRecipients = (a: readonly string[], b: readonly string[]) => {
  const sortedB = [...b].sort();
  return a.length === b.length && [...a].sort().every((email, i) => email === sortedB[i]);
};

export const CertificateTransparencyAlertingProvider = () =>
  Provider.succeed(CertificateTransparencyAlerting, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialEnabled", "initialEmails"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          observe(zoneId).pipe(
            Effect.map((observed) => {
              if (observed === undefined) return undefined;
              const emails = recipients(observed);
              return {
                zoneId,
                enabled: observed.enabled,
                emails,
                initialEnabled: observed.enabled,
                initialEmails: emails,
              };
            }),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is CertificateTransparencyAlertingAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldZoneId =
        output?.zoneId ?? (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (oldZoneId !== undefined && typeof news.zoneId === "string" && oldZoneId !== news.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* observe(zoneId);
      if (observed === undefined) return undefined;
      const emails = recipients(observed);
      return {
        zoneId,
        enabled: observed.enabled,
        emails,
        initialEnabled: output?.initialEnabled ?? observed.enabled,
        initialEmails: output?.initialEmails ?? emails,
      };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const zoneId = news.zoneId as string;
      const enabled = news.enabled ?? true;
      const observed = yield* zones.getCtAlerting({ zoneId });
      const emails = recipients(observed);
      const initialEnabled = output?.initialEnabled ?? observed.enabled;
      const initialEmails = output?.initialEmails ?? emails;

      if (
        observed.enabled === enabled &&
        (news.emails === undefined || sameRecipients(news.emails, emails))
      ) {
        return {
          zoneId,
          enabled: observed.enabled,
          emails,
          initialEnabled,
          initialEmails,
        };
      }
      const patched = yield* zones.patchCtAlerting({
        zoneId,
        enabled,
        ...(news.emails === undefined ? {} : { emails: news.emails }),
      });
      return {
        zoneId,
        enabled: patched.enabled,
        emails: recipients(patched),
        initialEnabled,
        initialEmails,
      };
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      const { zoneId, initialEnabled, initialEmails } = output;
      const observed = yield* observe(zoneId);
      if (observed === undefined) return;
      const managedEmails = olds?.emails !== undefined;
      if (
        observed.enabled === initialEnabled &&
        (!managedEmails || sameRecipients(recipients(observed), initialEmails))
      ) {
        return;
      }
      yield* zones
        .patchCtAlerting({
          zoneId,
          enabled: initialEnabled,
          ...(managedEmails ? { emails: initialEmails } : {}),
        })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });
